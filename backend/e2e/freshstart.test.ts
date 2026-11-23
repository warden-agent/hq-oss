// Fresh start end to end (see harness.ts): an agent asked for its handoff note writes it (a note over the cap is refused), its
// session ends and a new one takes over from the note, the git status and the approved plan; HQ writes the note when the agent
// doesn't; the context limit warns or fresh-starts; switching away parks a repo's agents and coming back resumes them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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

  await hq.hook(eng.id, { hook_event_name: 'PreToolUse', tool_name: 'mcp__hq__write_handoff_note', tool_input: {} }) // its last activity line (Bug 122)
  await waitFor('the activity line', async () => (await agent(eng.id))?.activity === 'Calling hq.write_handoff_note')
  const long = await hq.mcp(eng.id, 'write_handoff_note', { text: 'x'.repeat(2501) })
  assert.equal(long.isError, true); assert.match(long.text, /2,501 characters; the limit is 2,500/)
  const ok = await hq.mcp(eng.id, 'write_handoff_note', { text: '## Where I stopped\n- hello.txt half written (NOTE-MARKER)' })
  assert.equal(ok.isError, false); assert.match(ok.text, /ends this session/)

  // Its row exists a moment before the ticket points at it, so wait for both: the test used to read that gap now and then
  const next = await waitFor('the new engineer', async () => { const a = await live(t); return a?.id !== eng.id && (await tk(t)).assignee_agent_id === a?.id && a })
  assert.equal((await agent(eng.id)).status, 'exited')
  // Bug 122: the old one is not still "Calling hq.write_handoff_note" beside the new one, and the menu can say it was replaced
  assert.deepEqual([(await agent(eng.id)).activity ?? null, (await agent(eng.id)).ended_why], [null, 'fresh_start'])
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

test('Bug 72: an API error is no dialog: its reason is kept, Urgent is typed, and a fresh start goes ahead', async () => {
  const { f } = await setup('fresh-api-error')
  const t = await ticket(f, 'Errored'); const eng = await building(t)
  await hq.hook(eng.id, { hook_event_name: 'StopFailure', error: 'API Error: 529 overloaded' })
  await waitFor('blocked by the error', async () => { const a = await agent(eng.id); return a.status === 'blocked' && a.blocked_why === 'api_error' })
  assert.equal((await agent(eng.id)).activity ?? null, null) // its turn is over: no "Thinking" left in the Agents menu
  const m = (await hq.api(`agents/${eng.id}/message`, { body: 'Try that again.', urgent: true })).json
  assert.equal((await hq.state()).messages.find((x: any) => x.id === m.id).delivery_method, 'tmux') // it sits at its prompt: typed, as for an idle agent
  const r = await hq.api(`agents/${eng.id}/fresh-start`, { then: 'park' }); assert.equal(r.status, 200, JSON.stringify(r.json))
  await hq.mcp(eng.id, 'write_handoff_note', { text: '## Where I stopped\n- an API error' })
  await waitFor('parked', async () => (await tk(t)).parked_at)
  // a dialog that comes after it is a dialog again
  const t2 = await ticket(f, 'Errored then asked'); const eng2 = await building(t2)
  await hq.hook(eng2.id, { hook_event_name: 'StopFailure', error: 'overloaded' })
  await hq.hook(eng2.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  assert.equal((await agent(eng2.id)).blocked_why, 'dialog')
  const r2 = await hq.api(`agents/${eng2.id}/fresh-start`, {}); assert.equal(r2.status, 409); assert.match(r2.json.error, /dialog/)
})

test('no note in time: HQ writes one, and a parked ticket waits for Resume', async () => {
  const { f } = await setup('fresh-fallback')
  const t = await ticket(f, 'Quiet'); const eng = await building(t)
  const pre = (tool: string, tool_input: object, extra: object = {}) => hq.hook(eng.id, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input, ...extra })
  await pre('Edit', { file_path: 'hello.txt', old_string: 'a', new_string: 'b' }); await pre('Read', { file_path: 'hello.txt' })
  await pre('Grep', { pattern: 'helper-search' }, { agent_id: 'helper-1' }) // a helper's call: not the engineer's own step
  assert.equal((await hq.api(`agents/${eng.id}/fresh-start`, { then: 'park' })).status, 200)
  await waitFor('the fallback', async () => (await tk(t)).parked_at, 20_000)
  assert.equal((await agent(eng.id)).status, 'exited'); assert.equal(await live(t), undefined)
  const note = (await hq.api(`docs?scope=${encodeURIComponent(`resume:ticket:${t.id}`)}`)).json[0].text
  assert.match(note, /Written by HQ/)
  assert.match(note, /oldest first:\n(- .*\n)*- Edit \{"file_path":"hello.txt",[^\n]*\n- Read \{"file_path":"hello.txt"\}\n## Watch out/) // Bug 101
  assert.doesNotMatch(note, /none recorded|helper-search/)
  const r = await hq.api(`tickets/${t.id}/resume`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(await prompt(r.json.id), /Written by HQ/); assert.equal((await tk(t)).parked_at, null)
})

// Bug 196: HQ's note from the first clear stayed as if the TPM had written it, so the second clear archived it again and the third
// TPM was told the TPM before it waits on a dialog.
test("Bug 196: a second clear with no note from the TPM gets HQ's new note, not the first clear's", async () => {
  const { repo, tpm } = await setup('fresh-clear-twice')
  const tpmBack = (old: string) => waitFor('the TPM back', async () => {
    const id = (await repoRow(repo.id)).tpm_agent_id; return id && id !== old && (await agent(id))?.status === 'working' ? id as string : null }, 40_000)
  const handoffs = () => { const base = path.join(hq.hqHome, 'archive', 'fresh-clear-twice')
    return fs.readdirSync(base).sort().map((d) => fs.readFileSync(path.join(base, d, 'tpm', 'HANDOFF.md'), 'utf8')) }
  await hq.hook(tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  await waitFor('on a dialog', async () => (await agent(tpm.id)).status === 'blocked')
  const r1 = await hq.api(`repos/${repo.id}/clear`, {}); assert.equal(r1.status, 200, JSON.stringify(r1.json)); assert.equal(r1.json.noting.length, 0)
  const second = await tpmBack(tpm.id)
  assert.match(await prompt(second), /didn't leave a note: the project was cleared while it waited on a dialog in its terminal/) // Bug 261's words
  const r2 = await hq.api(`repos/${repo.id}/clear`, {}); assert.equal(r2.status, 200, JSON.stringify(r2.json)); assert.equal(r2.json.noting.length, 1)
  const third = await tpmBack(second) // the second TPM never writes its note: HQ writes one when the time is up
  const [first, then] = handoffs()
  assert.match(first!, /waited on a dialog/); assert.match(then!, /^\(Written by HQ: the TPM didn't leave a note: none came within/)
  assert.doesNotMatch(then!, /dialog/)
  assert.match(await prompt(third), /didn't leave a note: none came within/); assert.doesNotMatch(await prompt(third), /dialog/)
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
  for (const a of [eng, tpm]) { // Bug 308: asked as a switch of projects, not as a fresh start
    assert.equal((await agent(a.id)).fresh_start_then, 'switch')
    const ask = (await hq.state()).messages.find((m: any) => m.to_id === a.id && m.reason === 'fresh_start')
    assert.match(ask.body, /The user switched to another project in HQ/); assert.doesNotMatch(ask.body, /fresh start/i)
  }
  await hq.mcp(eng.id, 'write_handoff_note', { text: 'ENG-PARK' }); await hq.mcp(tpm.id, 'write_handoff_note', { text: 'TPM-PARK' })
  await waitFor('both parked', async () => (await tk(t)).parked_at && (await repoRow(repo.id)).tpm_parked_at)
  assert.equal((await agent(eng.id)).status, 'exited'); assert.equal((await agent(tpm.id)).status, 'exited')
  const back = await hq.api(`repos/${repo.id}/resume`, {}); assert.equal(back.json.resumed.length, 2, JSON.stringify(back.json))
  const e2 = await waitFor('the engineer back', () => live(t)); assert.match(await prompt(e2.id), /ENG-PARK/)
  const rr = await repoRow(repo.id); assert.equal(rr.tpm_parked_at, null); assert.notEqual(rr.tpm_agent_id, tpm.id); assert.match(await prompt(rr.tpm_agent_id), /TPM-PARK/)
})

test('Bug 339: switching away while a fresh start is writing its note parks that agent too: no new session starts in the project left', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' }) // "A new session picks up right away"
  const { repo, f } = await setup('b339x')
  const t = await ticket(f, 'Switch'); const eng = await building(t)
  assert.equal((await hq.api(`agents/${eng.id}/fresh-start`, {})).status, 200)
  assert.equal((await agent(eng.id)).fresh_start_then, 'continue')
  const r = await hq.api(`repos/${repo.id}/park`, {}); assert.deepEqual(r.json.left, []); assert.equal(r.json.parked.length, 2)
  assert.equal((await agent(eng.id)).fresh_start_then, 'switch') // what its box says now: "you switched projects · writing its handoff note…"
  const asks = (await hq.state()).messages.filter((m: any) => m.to_id === eng.id && m.reason === 'fresh_start') // and its terminal (Bug 338's retarget)
  assert.equal(asks.length, 2); assert.ok(asks.some((m: any) => /^This replaces HQ's earlier request[^]*The user switched to another project in HQ/.test(m.body)))
  await hq.mcp(eng.id, 'write_handoff_note', { text: 'B339-NOTE' })
  await waitFor('parked', async () => (await tk(t)).parked_at && (await agent(eng.id)).status === 'exited')
  assert.equal(await live(t), undefined); assert.equal((await agent(eng.id)).ended_why, 'parked')
  const back = await hq.api(`repos/${repo.id}/resume`, {}); assert.ok(back.json.resumed.includes(t.key), JSON.stringify(back.json))
  const e2 = await waitFor('the engineer back', () => live(t)); assert.match(await prompt(e2.id), /B339-NOTE/)
})

test('Bug 339: a note that comes in while the switch still asks the project\'s other agents for theirs parks its work too', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, f, tpm } = await setup('b339r')
  const t1 = await ticket(f, 'Older'); const e1 = await building(t1)
  const t2 = await ticket(f, 'Newer'); const e2 = await building(t2)
  assert.equal((await hq.api(`agents/${e2.id}/fresh-start`, {})).status, 200)
  const parking = hq.api(`repos/${repo.id}/park`, {}) // asks the TPM and T-01 first (by start), typing into each terminal
  await hq.mcp(e2.id, 'write_handoff_note', { text: 'B339R-NOTE' }) // its note comes in meanwhile
  await waitFor('T-02 ended', async () => (await agent(e2.id)).status === 'exited')
  const r = await parking; assert.equal(r.json.parked.length, 3, JSON.stringify(r.json))
  await hq.mcp(e1.id, 'write_handoff_note', { text: 'B339R-1' }); await hq.mcp(tpm.id, 'write_handoff_note', { text: 'B339R-TPM' })
  await waitFor('all parked', async () => (await tk(t1)).parked_at && (await tk(t2)).parked_at && (await repoRow(repo.id)).tpm_parked_at)
  assert.equal(await live(t2), undefined); assert.equal(await live(t1), undefined); assert.equal((await agent(e2.id)).ended_why, 'parked')
  // and the switch's words reached it too, unless its note was in first (then nothing more is asked)
  assert.ok((await asksTo(e2.id)).length >= 1)
})

test('Bug 339: a switch away while a fresh start\'s new session is still starting parks that session too', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, f, tpm } = await setup('b339s')
  const t = await ticket(f, 'Starting'); const eng = await building(t)
  assert.equal((await hq.api(`agents/${eng.id}/fresh-start`, {})).status, 200)
  await hq.mcp(eng.id, 'write_handoff_note', { text: 'B339S-NOTE' })
  // the old session has ended and its fresh start is over: the new one is on its way (often not running yet)
  for (const end = Date.now() + 10_000; ;) { // polled without a pause: the window is the new session's start
    const a = await agent(eng.id); if (a.status === 'exited' && !a.fresh_start_at) break
    if (Date.now() > end) throw new Error('timed out waiting for the old one done')
  }
  const r = await hq.api(`repos/${repo.id}/park`, {}); assert.equal(r.status, 200)
  const next = await waitFor('the new session', async () => (await hq.state()).agents.find((a: any) => a.ticket_id === t.id && a.id !== eng.id))
  if ((await agent(next.id)).fresh_start_at) await hq.mcp(next.id, 'write_handoff_note', { text: 'B339S-NEXT' }) // running by the park: asked as usual
  await hq.mcp(tpm.id, 'write_handoff_note', { text: 'B339S-TPM' })
  await waitFor('parked', async () => (await tk(t)).parked_at && (await agent(next.id)).status === 'exited' && (await repoRow(repo.id)).tpm_parked_at)
  assert.equal(await live(t), undefined); assert.equal((await agent(next.id)).ended_why, 'parked')
  const back = await hq.api(`repos/${repo.id}/resume`, {}); assert.ok(back.json.resumed.includes(t.key), JSON.stringify(back.json))
  const e3 = await waitFor('the engineer back', () => live(t)); assert.match(await prompt(e3.id), /B339S-(NOTE|NEXT)/)
})

test('Bug 339, what it must not catch: switching away from a project being cleared leaves its note requests a Clear\'s', async () => {
  const { repo, f, tpm } = await setup('b339y')
  const t = await ticket(f, 'Clear'); const eng = await building(t)
  assert.equal((await hq.api(`repos/${repo.id}/clear`, {})).status, 200)
  await hq.api(`repos/${repo.id}/park`, {})
  for (const a of [eng, tpm]) assert.equal((await agent(a.id)).fresh_start_then, 'clear')
  await hq.mcp(eng.id, 'write_handoff_note', { text: 'B339-CLEAR' }); await hq.mcp(tpm.id, 'write_handoff_note', { text: 'B339-CLEAR-TPM' })
  await waitFor('cleared', async () => !(await repoRow(repo.id)).clearing_at && (await agent(eng.id)) === undefined, 20_000)
  assert.equal((await repoRow(repo.id)).tpm_parked_at, null)
})

const asksTo = async (id: string) => (await hq.state()).messages.filter((m: any) => m.to_id === id && m.reason === 'fresh_start')
test('Bug 350: switching straight back before the notes are in: each agent picks up from its note once it is in, nothing stays parked', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, f, tpm } = await setup('b350x')
  const t = await ticket(f, 'Back'); const eng = await building(t)
  const away = hq.api(`repos/${repo.id}/park`, {}) // the switch away asks one agent after the other, a few seconds each
  await waitFor('the first request', async () => (await agent(eng.id)).fresh_start_at || (await agent(tpm.id)).fresh_start_at)
  const back = await hq.api(`repos/${repo.id}/resume`, {}) // straight back: waits for the park, then tells both
  assert.equal((await away).json.parked.length, 2); assert.equal(back.json.resumed.length, 2, JSON.stringify(back.json))
  for (const a of [eng, tpm]) {
    assert.equal((await agent(a.id)).fresh_start_then, 'continue')
    const asks = await asksTo(a.id); assert.equal(asks.length, 2) // and its terminal (retarget): the switch's request, then this one
    assert.ok(asks.some((m: any) => !/^This replaces/.test(m.body) && /The user switched to another project/.test(m.body)))
    assert.ok(asks.some((m: any) => /^This replaces HQ's earlier request[^]*Fresh start: this session/.test(m.body)))
  }
  await hq.mcp(eng.id, 'write_handoff_note', { text: 'B350-ENG' }); await hq.mcp(tpm.id, 'write_handoff_note', { text: 'B350-TPM' })
  const e2 = await waitFor('the engineer back', async () => { const a = await live(t); return a?.id !== eng.id && (await tk(t)).assignee_agent_id === a?.id && a })
  assert.match(await prompt(e2.id), /B350-ENG/)
  const t2 = await waitFor('the TPM back', async () => { const id = (await repoRow(repo.id)).tpm_agent_id; return id !== tpm.id ? id : null })
  assert.match(await prompt(t2), /B350-TPM/)
  assert.equal((await tk(t)).parked_at, null); assert.equal((await repoRow(repo.id)).tpm_parked_at, null)
  assert.deepEqual([(await agent(eng.id)).ended_why, (await agent(tpm.id)).ended_why], ['fresh_start', 'fresh_start'])
})

test('Bug 350, what it must not catch: a switch away again parks once more; a fresh start waiting for Resume stays so', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'wait' })
  const { repo, f, tpm } = await setup('b350y')
  const t = await ticket(f, 'Wait'); const eng = await building(t)
  assert.equal((await hq.api(`agents/${eng.id}/fresh-start`, {})).status, 200); assert.equal((await agent(eng.id)).fresh_start_then, 'park')
  await hq.api(`repos/${repo.id}/park`, {}); await hq.api(`repos/${repo.id}/resume`, {})
  assert.deepEqual([(await agent(eng.id)).fresh_start_then, (await agent(tpm.id)).fresh_start_then], ['park', 'continue'])
  await hq.api(`repos/${repo.id}/park`, {}) // away again before the notes: the TPM waits for the user to come back once more
  assert.equal((await agent(tpm.id)).fresh_start_then, 'switch')
  const now = (await agent(tpm.id)).fresh_start_msg // the request it has now, in its terminal too
  assert.match((await asksTo(tpm.id)).find((m: any) => m.id === now).body, /^This replaces HQ's earlier request[^]*The user switched to another project/)
  // The engineer's note may be HQ's by now: this file's HQ waits only 2 s for a note once the request is in, and the three moves above type
  // to the TPM (a few seconds on a slow machine). Either way its work is parked, which is what this checks.
  if ((await agent(eng.id)).status !== 'exited') await hq.mcp(eng.id, 'write_handoff_note', { text: 'B350-WAIT' }).catch(async (e) => {
    if ((await agent(eng.id)).status !== 'exited') throw e })
  await hq.mcp(tpm.id, 'write_handoff_note', { text: 'B350-AWAY' })
  await waitFor('both parked', async () => (await tk(t)).parked_at && (await repoRow(repo.id)).tpm_parked_at)
  assert.equal(await live(t), undefined)
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
})

test('Bug 350: auto turned on while the switch\'s notes are still being written: they pick up once in, as with a parked TPM', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'wait' }) // so the switch back itself didn't ask HQ to resume (App.tsx)
  const { repo, tpm } = await setup('b350z')
  await hq.api(`repos/${repo.id}/park`, {}); assert.equal((await agent(tpm.id)).fresh_start_then, 'switch')
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  assert.equal((await agent(tpm.id)).fresh_start_then, 'continue')
  await hq.api(`repos/${repo.id}/auto`, { on: false }); await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
})

test("the project's TPM is parked and comes back even when every feature is done (Bug 52: no done-TPM stop)", async () => {
  const { repo, f, tpm } = await setup('fresh-done')
  const t = await ticket(f, 'Done already')
  const db = hq.db(); try { db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run('merged', t.id) } finally { db.close() } // not the sqlite3 command: Linux CI has none
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
