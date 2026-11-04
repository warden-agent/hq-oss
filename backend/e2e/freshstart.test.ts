// Fresh start end to end (see harness.ts): an agent asked for its handoff note writes it (a note over the cap is refused), its
// session ends and a new one takes over from the note, the git status and the approved plan; HQ writes the note when the agent
// doesn't; the context limit warns or fresh-starts; switching away parks a repo's agents and coming back resumes them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startHq, waitFor, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_FRESH_START_TIMEOUT_S: '2' } }); await hq.api('settings', { key: 'concurrency_cap', value: 20 }) })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ dir: string; repo: any; f: any; tpm: any }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f, tpm }
}
const ticket = async (f: any, title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const agent = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const live = async (t: any) => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status !== 'exited')
const prompt = async (id: string) => fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'prompt.md'), 'utf8')
const repoRow = async (id: string) => (await hq.state()).repos.find((r: any) => r.id === id)
/** An engineer on `t` whose plan the user approved: the ticket is implementing. */
async function building(t: any, plan = 'Plan: write hello.txt, then test it.'): Promise<any> {
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await agent(eng.id))?.status === 'working')
  const b = (await hq.modNext(eng.id)).batch; await hq.modEvent(eng.id, { kind: 'batch_received', id: b.id }) // the launch prompt
  await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  const held = hq.hook(eng.id, exitPlanMode(plan))
  const rv = await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  await hq.api(`reviews/${rv.id}/answer`, { verdict: 'approve' }); await held
  await waitFor('implementing', async () => (await tk(t)).status === 'implementing')
  return eng
}

test('settings take only the offered choices', async () => {
  for (const [key, bad, good] of [['context_limit', 5, 100_000], ['context_action', 'sometimes', 'auto'], ['after_fresh_start', 'later', 'wait']] as const) {
    const r = await hq.api('settings', { key, value: bad }); assert.equal(r.status, 400); assert.match(r.json.error, /must be one of/)
    assert.equal((await hq.api('settings', { key, value: good })).status, 200)
  }
  for (const [key, value] of [['context_limit', 150_000], ['context_action', 'warn'], ['after_fresh_start', 'continue']] as const) await hq.api('settings', { key, value })
})

test('fresh start: the note is capped, the engineer is replaced, and the new one gets the note, git status and plan', async () => {
  const { f } = await setup('fresh-engineer')
  const t = await ticket(f, 'Hello'); const eng = await building(t, 'Plan: write hello.txt (PLAN-MARKER).')
  const wt = (await tk(t)).worktree_path; fs.writeFileSync(path.join(wt, 'hello.txt'), 'half done\n')
  await hq.api(`agents/${eng.id}/message`, { body: 'A note for whoever has the ticket.', reason: 'fyi' }) // waits; moves to the new engineer

  const r = await hq.api(`agents/${eng.id}/fresh-start`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  const ask = (await hq.state()).messages.find((m: any) => m.to_id === eng.id && m.reason === 'fresh_start')
  assert.equal(ask.delivery_method, 'tmux') // typed after Escape: a mod prompt would be dropped
  assert.match(ask.body, /nobody rejected it/)
  assert.deepEqual(await hq.modNext(eng.id), {}) // the other message waits for the new session

  const long = await hq.mcp(eng.id, 'write_handoff_note', { text: 'x'.repeat(2501) })
  assert.equal(long.isError, true); assert.match(long.text, /2,501 characters; the limit is 2,500/)
  const ok = await hq.mcp(eng.id, 'write_handoff_note', { text: '## Where I stopped\n- hello.txt half written (NOTE-MARKER)' })
  assert.equal(ok.isError, false); assert.match(ok.text, /ends this session/)

  // Its row exists a moment before the ticket points at it, so wait for both: the test used to read that gap now and then
  const next = await waitFor('the new engineer', async () => { const a = await live(t); return a?.id !== eng.id && (await tk(t)).assignee_agent_id === a?.id && a })
  assert.equal((await agent(eng.id)).status, 'exited')
  const p = await prompt(next.id)
  assert.match(p, /taking over ticket/); assert.match(p, /NOTE-MARKER/); assert.match(p, /\?\? hello\.txt/); assert.match(p, /PLAN-MARKER/)
  assert.equal((await tk(t)).status, 'implementing'); assert.equal((await tk(t)).assignee_agent_id, next.id); assert.equal((await tk(t)).parked_at, null)
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'workspaces', f.id, 'tickets', t.key, 'HANDOFF.md'), 'utf8'), /NOTE-MARKER/)
  assert.ok((await hq.state()).messages.find((m: any) => m.to_id === next.id && m.body === 'A note for whoever has the ticket.'))
  assert.equal((await hq.state()).attention.filter((a: any) => a.agent_id === eng.id && !a.resolved_at && /exited/.test(a.kind)).length, 0)
})

test('no fresh start while a plan waits for review', async () => {
  const { f } = await setup('fresh-review')
  const t = await ticket(f, 'Wait'); const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await agent(eng.id))?.status === 'working')
  const held = hq.hook(eng.id, exitPlanMode('Plan.')); await waitFor('plan_review', async () => (await tk(t)).status === 'plan_review')
  const r = await hq.api(`agents/${eng.id}/fresh-start`, {}); assert.equal(r.status, 409); assert.match(r.json.error, /waiting for your review/)
  const rv = (await hq.state()).reviews.find((x: any) => x.ticket_id === t.id && x.status === 'open'); await hq.api(`reviews/${rv.id}/answer`, { verdict: 'approve' }); await held
})

test('no fresh start, and no typed Urgent, while the agent waits on a dialog', async () => {
  const { f } = await setup('fresh-dialog')
  const t = await ticket(f, 'Dialog'); const eng = await building(t)
  await hq.hook(eng.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  await waitFor('blocked', async () => (await agent(eng.id)).status === 'blocked')
  const r = await hq.api(`agents/${eng.id}/fresh-start`, {}); assert.equal(r.status, 409); assert.match(r.json.error, /dialog/)
  const m = (await hq.api(`agents/${eng.id}/message`, { body: 'Stop that.', urgent: true })).json
  assert.equal((await hq.state()).messages.find((x: any) => x.id === m.id).delivery_method, null) // left for the mod, not typed into the dialog
})

test('no note in time: HQ writes one, and a parked ticket waits for Resume', async () => {
  const { f } = await setup('fresh-fallback')
  const t = await ticket(f, 'Quiet'); const eng = await building(t)
  assert.equal((await hq.api(`agents/${eng.id}/fresh-start`, { then: 'park' })).status, 200)
  await waitFor('the fallback', async () => (await tk(t)).parked_at, 20_000)
  assert.equal((await agent(eng.id)).status, 'exited'); assert.equal(await live(t), undefined)
  const note = (await hq.api(`docs?scope=${encodeURIComponent(`resume:ticket:${t.id}`)}`)).json[0].text
  assert.match(note, /Written by HQ/)
  const r = await hq.api(`tickets/${t.id}/resume`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(await prompt(r.json.id), /Written by HQ/); assert.equal((await tk(t)).parked_at, null)
})

test('context limit: one warning past the limit; with auto, a fresh start once the step ends', async () => {
  const { f } = await setup('fresh-context')
  const t = await ticket(f, 'Big'); const eng = await building(t)
  const measure = (id: string, tokens: number) => hq.modEvent(id, { kind: 'session.measure', usage: { context: { tokens, percent: 10 } } })
  await measure(eng.id, 90_000) // under the engineer's 100k (TPM 150k)
  assert.equal((await hq.state()).attention.filter((a: any) => a.kind === 'context_high' && a.agent_id === eng.id).length, 0)
  await measure(eng.id, 120_000); await measure(eng.id, 125_000)
  const warn = (await hq.state()).attention.filter((a: any) => a.kind === 'context_high' && a.agent_id === eng.id && !a.resolved_at)
  assert.equal(warn.length, 1); assert.match(warn[0].detail, /120k of context \(limit 100k\)/)
  assert.equal((await agent(eng.id)).fresh_start_at, null)

  await hq.api('settings', { key: 'context_action', value: 'auto' })
  await measure(eng.id, 130_000)
  assert.ok((await agent(eng.id)).fresh_start_at)
  const b = (await hq.modNext(eng.id)).batch; assert.match(b.text, /Fresh start/) // after_turn: the mod delivers it when idle
  assert.doesNotMatch(b.text, /interrupted/)
  await hq.api('settings', { key: 'context_action', value: 'warn' })
})

test('a TPM fresh start briefs the new TPM with the note', async () => {
  const { repo, tpm } = await setup('fresh-tpm')
  assert.equal((await hq.api(`agents/${tpm.id}/fresh-start`, { then: 'continue' })).status, 200)
  const over = await hq.mcp(tpm.id, 'write_handoff_note', { text: 'y'.repeat(5001) }); assert.match(over.text, /limit is 5,000/)
  assert.equal((await hq.mcp(tpm.id, 'write_handoff_note', { text: '## What the user wants\n- TPM-NOTE-MARKER' })).isError, false)
  const next = await waitFor('the new TPM', async () => { const id = (await repoRow(repo.id)).tpm_agent_id; return id !== tpm.id ? id : null })
  assert.match(await prompt(next), /TPM-NOTE-MARKER/); assert.match(await prompt(next), /^You are taking over as the TPM of project "fresh-tpm"/)
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'workspaces', `repo-${repo.id}`, 'tpm', 'HANDOFF.md'), 'utf8'), /TPM-NOTE-MARKER/)
})

test('switching away parks the repo; coming back resumes it', async () => {
  const { repo, f, tpm } = await setup('fresh-park')
  const t = await ticket(f, 'Park'); const eng = await building(t)
  const r = await hq.api(`repos/${repo.id}/park`, {}); assert.deepEqual(r.json.left, []); assert.equal(r.json.parked.length, 2)
  await hq.mcp(eng.id, 'write_handoff_note', { text: 'ENG-PARK' }); await hq.mcp(tpm.id, 'write_handoff_note', { text: 'TPM-PARK' })
  await waitFor('both parked', async () => (await tk(t)).parked_at && (await repoRow(repo.id)).tpm_parked_at)
  assert.equal((await agent(eng.id)).status, 'exited'); assert.equal((await agent(tpm.id)).status, 'exited')
  const back = await hq.api(`repos/${repo.id}/resume`, {}); assert.equal(back.json.resumed.length, 2, JSON.stringify(back.json))
  const e2 = await waitFor('the engineer back', () => live(t)); assert.match(await prompt(e2.id), /ENG-PARK/)
  const rr = await repoRow(repo.id); assert.equal(rr.tpm_parked_at, null); assert.notEqual(rr.tpm_agent_id, tpm.id); assert.match(await prompt(rr.tpm_agent_id), /TPM-PARK/)
})

test("the project's TPM is parked and comes back even when every feature is done (Bug 52: no done-TPM stop)", async () => {
  const { repo, f, tpm } = await setup('fresh-done')
  const t = await ticket(f, 'Done already')
  execFileSync('sqlite3', [path.join(hq.hqHome, 'hq.sqlite'), `UPDATE tickets SET status = 'merged' WHERE id = '${t.id}'`])
  const r = await hq.api(`repos/${repo.id}/park`, {}); assert.deepEqual(r.json.stopped, []); assert.equal(r.json.parked.length, 1)
  await hq.mcp(tpm.id, 'write_handoff_note', { text: 'DONE-PARK' })
  await waitFor('parked', async () => (await repoRow(repo.id)).tpm_parked_at)
  const back = await hq.api(`repos/${repo.id}/resume`, {}); assert.deepEqual(back.json.resumed, ['TPM'])
  assert.match(await prompt((await repoRow(repo.id)).tpm_agent_id), /DONE-PARK/)
})

test('context meters keep their last measurement across an HQ restart', async () => {
  const { tpm } = await setup('fresh-restart')
  await hq.modEvent(tpm.id, { kind: 'session.measure', usage: { context: { tokens: 77_000, percent: 8 } } })
  await waitFor('measured', async () => (await agent(tpm.id))?.context_tokens === 77_000)
  await hq.restart()
  assert.equal((await agent(tpm.id)).context_tokens, 77_000)
})
