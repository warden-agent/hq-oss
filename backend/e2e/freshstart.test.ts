// Fresh start end to end (see harness.ts): an agent asked for its handoff note writes it (a note over the cap is refused), its
// session ends and a new one takes over from the note, the git status and the approved plan; HQ writes the note when the agent
// doesn't; the context limit warns or fresh-starts; switching away parks a repo's agents and coming back resumes them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
// The file's HQ waits HQ's usual time for a handoff note. It waited 2 s, and on Linux the notes the tests write raced HQ's own one: moves that
// type to agents (park, resume, a restart's) take a few seconds there, and HQ ended an agent a test still counted on (Bug 389's Linux run).
before(async () => { hq = await startHq(); await hq.api('settings', { key: 'concurrency_cap', value: 20 }) })
let quick: Hq | undefined
after(async () => { await hq?.stop(); await quick?.stop() })
/** Runs `fn` on a second test HQ that writes the note itself 2 s after its request is in: for the tests of HQ's note when none comes. */
async function quickNotes(fn: () => Promise<void>): Promise<void> {
  const main = hq
  if (!quick) { quick = await startHq({ env: { HQ_FRESH_START_TIMEOUT_S: '2' } }); await quick.api('settings', { key: 'concurrency_cap', value: 20 }) }
  hq = quick; try { await fn() } finally { hq = main }
}

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

test('no note in time: HQ writes one, and a parked ticket waits for Resume', () => quickNotes(async () => {
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
}))

// Bug 196: HQ's note from the first clear stayed as if the TPM had written it, so the second clear archived it again and the third
// TPM was told the TPM before it waits on a dialog.
test("Bug 196: a second clear with no note from the TPM gets HQ's new note, not the first clear's", () => quickNotes(async () => {
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
}))

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

// Bug 442: after a fresh start, a plain Stop of the new engineer and Resume handed the third engineer the first one's note as "the previous
// engineer's handoff note", though the second had worked since. A note is handed on once: the next engineer gets one only from the session
// it takes over from (it wrote it, or HQ wrote it as it ended); the TPM keeps an older note (the project's memory, Bug 52), labelled as such.
test('Bug 442: a handoff note is handed on once: Resume after a plain Stop gets none; a note the next session writes is handed on', async () => {
  const { f } = await setup('b442fresh')
  const t = await ticket(f, 'Once'); const e1 = await building(t, 'Plan: write once.txt (B442-PLAN).')
  const ended = (id: string) => waitFor('it ended', async () => (await agent(id)).status === 'exited')
  const next = (not: string[]) => waitFor('the next engineer', async () => {
    const a = await live(t); return a && !not.includes(a.id) && (await tk(t)).assignee_agent_id === a.id && a })
  const resume = async () => { const r = await hq.api(`tickets/${t.id}/resume`, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.id as string }
  assert.equal((await hq.api(`agents/${e1.id}/fresh-start`, {})).status, 200)
  assert.equal((await hq.mcp(e1.id, 'write_handoff_note', { text: '## Where I stopped\n- B442-FIRST-NOTE' })).isError, false)
  const e2 = await next([e1.id]); assert.match(await prompt(e2.id), /B442-FIRST-NOTE/) // the session it was written for gets it
  // the user stops it in its Agent tab: no note; Resume
  assert.equal((await hq.api(`agents/${e2.id}/stop`, {})).status, 200); await ended(e2.id)
  const e3 = await resume(), p3 = await prompt(e3)
  assert.doesNotMatch(p3, /B442-FIRST-NOTE/)
  assert.match(p3, /## The previous engineer's handoff note\n\(none: the last engineer's session ended without writing one\. Git below/)
  assert.match(p3, /The previous engineer's session ended; nothing from it carries over/) // not "for a fresh start": it was stopped
  assert.match(p3, /B442-PLAN/) // the approved plan is still handed on
  const started = (await hq.api(`events?agent=${e3}`)).json.filter((e: any) => e.kind === 'ticket.resumed')
  assert.deepEqual(started.map((e: any) => JSON.parse(e.payload).note), [false]) // and the TPM isn't told it left a note
  // stopped twice: still none
  assert.equal((await hq.api(`agents/${e3}/stop`, {})).status, 200); await ended(e3)
  const e4 = await resume(); assert.doesNotMatch(await prompt(e4), /B442-FIRST-NOTE/); assert.match(await prompt(e4), /\(none: the last engineer's/)
  // what it must not catch: a note this session writes (here without a fresh start asking) is the next one's, also after a plain Stop
  assert.equal((await hq.mcp(e4, 'write_handoff_note', { text: '## Where I stopped\n- B442-FOURTH-NOTE' })).isError, false)
  assert.equal((await hq.api(`agents/${e4}/stop`, {})).status, 200); await ended(e4)
  const e5 = await resume(); assert.match(await prompt(e5), /B442-FOURTH-NOTE/); assert.doesNotMatch(await prompt(e5), /\(none: the last/)
  // and a fresh start of that one hands its own note on, never the older one
  assert.equal((await hq.api(`agents/${e5}/fresh-start`, {})).status, 200)
  assert.equal((await hq.mcp(e5, 'write_handoff_note', { text: '## Where I stopped\n- B442-FIFTH-NOTE' })).isError, false)
  const e6 = await next([e1.id, e2.id, e3, e4, e5]); assert.match(await prompt(e6.id), /B442-FIFTH-NOTE/)
  assert.doesNotMatch(await prompt(e6.id), /B442-FOURTH-NOTE/)
})

test('Bug 442: a TPM started after a plain Stop gets the older TPM note labelled as an earlier session\'s', async () => {
  const { repo, tpm } = await setup('b442tpm')
  const tpmBack = (old: string) => waitFor('the TPM back', async () => {
    const id = (await repoRow(repo.id)).tpm_agent_id; return id && id !== old && (await agent(id))?.status === 'working' ? id as string : null })
  assert.equal((await hq.api(`agents/${tpm.id}/fresh-start`, { then: 'continue' })).status, 200)
  assert.equal((await hq.mcp(tpm.id, 'write_handoff_note', { text: '## What the user wants\n- B442-TPM-NOTE' })).isError, false)
  const t2 = await tpmBack(tpm.id), p2 = await prompt(t2)
  assert.match(p2, /The previous TPM's handoff note \(HQ's ticket list above is the truth for statuses\):\n## What the user wants\n- B442-TPM-NOTE/)
  assert.equal((await hq.api(`agents/${t2}/stop`, {})).status, 200)
  await waitFor('it ended', async () => (await agent(t2)).status === 'exited')
  const r = await hq.api(`repos/${repo.id}/restart-tpm`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  const p3 = await prompt(r.json.id)
  assert.match(p3, new RegExp(`The handoff note an earlier TPM session left on \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\. The last session \\(${t2}\\) ended without writing one, `
    + 'so what this says is in flight or next may be out of date[^\\n]*\\n## What the user wants\\n- B442-TPM-NOTE'))
  assert.doesNotMatch(p3, /The previous TPM's handoff note/)
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
  await hq.mcp(eng.id, 'write_handoff_note', { text: 'B350-WAIT' })
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

/** Bug 369: the switch away from `repo` is asked for, and the backend goes down while the park is still asking (one agent after the other,
 *  typing into each terminal: a few seconds each): once one of `ids` has its request, and before all of them have. Then it comes back.
 *  The ones not asked yet, as the database said while it was down. */
async function downMidPark(repo: any, ids: string[], meanwhile = async (): Promise<unknown> => null): Promise<string[]> {
  const away = hq.api(`repos/${repo.id}/park`, {}).catch(() => null) // goes with the backend
  await waitFor('the first request', async () => { const s = await hq.state(); return ids.some((id) => s.agents.find((a: any) => a.id === id)?.fresh_start_at) })
  await meanwhile() // Bug 402: what the user does while the park still asks (a switch straight back)
  await hq.down(); await away
  return whileDown(() => {
    const db = hq.db({ readOnly: true }); let unasked: string[]
    try { unasked = ids.filter((id) => !(db.prepare('SELECT fresh_start_at FROM agents WHERE id = ?').get(id) as any).fresh_start_at) } finally { db.close() }
    assert.ok(unasked.length, 'the park was over before the backend went down: this test checked nothing'); return unasked
  })
}
/** `check` with the backend down, then it comes back, also when a check fails: the tests after it need it (a failed Bug 402 check left it down,
 *  and the next four tests failed with it). */
async function whileDown<T>(check: () => T): Promise<T> { try { return check() } finally { await hq.up() } }
/** The note of each of `ids` still writing one (a note that came in already ended its session). */
async function notes(ids: string[], text: string): Promise<void> {
  for (const id of ids) {
    if ((await agent(id)).fresh_start_at) await hq.mcp(id, 'write_handoff_note', { text }).catch(async (e) => { if ((await agent(id)).status !== 'exited') throw e })
  }
}
const switchAsked = async (id: string) => (await asksTo(id)).some((m: any) => /The user switched to another project in HQ/.test(m.body))
/** Whether the agent's Events say HQ asked it for the switch's note ("Asked for its handoff note: you switched projects"). */
const switchLine = async (id: string) => (await hq.api(`events?agent=${id}`)).json
  .some((e: any) => e.kind === 'fresh_start.requested' && JSON.parse(e.payload).then === 'switch')
/** The payloads of `repo`'s "parked" lines (repo.parked), each written once a park is over. */
const parkedLines = (repo: any): any[] => {
  const db = hq.db({ readOnly: true })
  try { return (db.prepare("SELECT payload FROM events WHERE kind = 'repo.parked'").all() as any[]).map((e) => JSON.parse(e.payload)).filter((p) => p.repo === repo.id) }
  finally { db.close() }
}
test('Bug 369: a restart in the middle of a switch away finishes the park: the agents it hadn\'t asked yet are asked, none keeps working', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, f, tpm } = await setup('b369x')
  const t1 = await ticket(f, 'One'); const e1 = await building(t1)
  const t2 = await ticket(f, 'Two'); const e2 = await building(t2)
  const ids = [tpm.id, e1.id, e2.id], unasked = await downMidPark(repo, ids)
  for (const id of ids) await waitFor(`${id} asked for the switch's note`, () => switchAsked(id)) // in its terminal too, and its Events say so
  for (const id of unasked) await waitFor(`${id}'s Events line`, () => switchLine(id)) // written once the request is typed
  await notes(ids, 'B369X')
  await waitFor('all parked', async () => (await tk(t1)).parked_at && (await tk(t2)).parked_at && (await repoRow(repo.id)).tpm_parked_at, 20_000)
  assert.equal(await live(t1), undefined); assert.equal(await live(t2), undefined)
  // Bug 438: the park is over once it has typed its last request, which can be after the notes are in and the work parked: waited for, not
  // asserted at once. Its mark goes before its line is written (parkNow).
  await waitFor("the restart's park recorded", () => parkedLines(repo).some((p) => p.again))
  assert.equal((await repoRow(repo.id)).parking_at, null)
  const back = await hq.api(`repos/${repo.id}/resume`, {}); assert.equal(back.json.resumed.length, 3, JSON.stringify(back.json))
  await waitFor('the engineers back', async () => (await live(t1)) && (await live(t2)))
})

test('Bug 369 with Bug 350: switching straight back after the restart: every agent picks up from its note, nothing stays parked', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, f, tpm } = await setup('b369y')
  const t1 = await ticket(f, 'One'); const e1 = await building(t1)
  const t2 = await ticket(f, 'Two'); const e2 = await building(t2)
  const ids = [tpm.id, e1.id, e2.id], unasked = await downMidPark(repo, ids)
  const back = await hq.api(`repos/${repo.id}/resume`, {}) // waits for the park the restart finishes, then tells each
  assert.equal(back.status, 200); assert.equal(back.json.resumed.length, 3, JSON.stringify(back.json))
  for (const id of unasked) assert.ok(await switchLine(id)) // the park reached them first (the words of a request not typed yet are the resume's now)
  await notes(ids, 'B369Y')
  const fresh = async (t: any, old: string) => { const a = await live(t); return a && a.id !== old && (await tk(t)).assignee_agent_id === a.id }
  await waitFor('everyone back', async () => (await fresh(t1, e1.id)) && (await fresh(t2, e2.id)) && (await repoRow(repo.id)).tpm_agent_id !== tpm.id, 20_000)
  assert.equal((await tk(t1)).parked_at, null); assert.equal((await tk(t2)).parked_at, null); assert.equal((await repoRow(repo.id)).tpm_parked_at, null)
})

test('Bug 369, what it must not catch: after a switch away and back, a restart parks nothing', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, tpm } = await setup('b369z')
  assert.equal((await hq.api(`repos/${repo.id}/park`, {})).json.parked.length, 1); assert.equal((await repoRow(repo.id)).parking_at, null)
  await hq.api(`repos/${repo.id}/resume`, {}); await notes([tpm.id], 'B369Z')
  const next = await waitFor('the TPM back', async () => { const id = (await repoRow(repo.id)).tpm_agent_id; return id !== tpm.id && (await agent(id))?.status === 'working' && id })
  await hq.restart() // a park would have asked it before the backend answers anything: parkNow's first request is recorded before its first wait
  assert.deepEqual(await asksTo(next), []); assert.equal((await agent(next)).status, 'working'); assert.equal((await repoRow(repo.id)).tpm_parked_at, null)
})

/** Bug 389: a project switched away from, all of its work parked from the notes: the TPM and `n` engineers building. */
async function parkedAll(name: string, n: number): Promise<{ repo: any; tpm: any; ts: any[]; engs: any[] }> {
  const { repo, f, tpm } = await setup(name), ts: any[] = [], engs: any[] = []
  for (let i = 1; i <= n; i++) { const t = await ticket(f, `Part ${i}`); ts.push(t); engs.push(await building(t)) }
  assert.equal((await hq.api(`repos/${repo.id}/park`, {})).json.parked.length, n + 1)
  await notes([tpm.id, ...engs.map((e) => e.id)], name.toUpperCase())
  await waitFor('all parked', async () => (await repoRow(repo.id)).tpm_parked_at && (await Promise.all(ts.map(tk))).every((t) => t.parked_at), 20_000)
  return { repo, tpm, ts, engs }
}
/** The project's live TPMs and each ticket's live engineers: one each once it is all back, never two. */
async function running(repoId: string, ts: any[]): Promise<{ tpms: number; engineers: number[] }> {
  const s = await hq.state(), on = (a: any) => a.status !== 'exited'
  return { tpms: s.agents.filter((a: any) => a.role === 'tpm' && a.repo_id === repoId && on(a)).length,
    engineers: ts.map((t) => s.agents.filter((a: any) => a.role === 'engineer' && a.ticket_id === t.id && on(a)).length) }
}
/** Everything parked is back: the TPM and an engineer on each ticket, one each, from the notes; nothing marked parked or being resumed. */
async function allBack(repo: any, tpm: any, ts: any[]): Promise<void> {
  await waitFor('everyone back', async () => { const r = await repoRow(repo.id), all = await Promise.all(ts.map(tk))
    return !r.tpm_parked_at && r.tpm_agent_id !== tpm.id && r.resuming_at === null && all.every((t) => !t.parked_at && t.assignee_agent_id) }, 20_000)
  for (const t of ts) await waitFor(`${t.key ?? t.id}'s engineer`, () => live(t))
  assert.deepEqual(await running(repo.id, ts), { tpms: 1, engineers: ts.map(() => 1) })
  assert.match(await prompt((await repoRow(repo.id)).tpm_agent_id), new RegExp(repo.name.toUpperCase()))
}
/** The end of a Bug 389 test: its project's sessions stop, so the tests after it still find free engineer slots (20 at most: the parallel limit and
 *  the test HQ's 200 engineer ports) once these tests have started several engineers each. */
async function stopAll(repoId: string): Promise<void> {
  for (const a of (await hq.state()).agents.filter((x: any) => x.repo_id === repoId && x.status !== 'exited')) await hq.api(`agents/${a.id}/stop`, {})
  await waitFor('its sessions ended', async () => !(await hq.state()).agents.some((x: any) => x.repo_id === repoId && x.status !== 'exited'))
}
test('Bug 397: an agent whose terminal goes while the switch away asks for notes is skipped; the park asks the rest and is recorded', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, f, tpm } = await setup('b397x')
  const t1 = await ticket(f, 'One'); const e1 = await building(t1)
  const t2 = await ticket(f, 'Two'); const e2 = await building(t2) // asked after e1: the park goes through them in the order they started
  hq.tmux('kill-session', '-t', (await agent(e1.id)).tmux_session) // its process dies without a SessionEnd: to HQ it still works
  assert.equal((await agent(e1.id)).status, 'working')
  const r = await hq.api(`repos/${repo.id}/park`, {})
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.parked.length, 3, JSON.stringify(r.json)); assert.deepEqual(r.json.left, [])
  assert.ok(await switchAsked(e2.id)); assert.ok(await switchLine(e2.id)) // the one after it was asked too
  assert.equal((await repoRow(repo.id)).parking_at, null)
  const parkedLine = (await hq.api('events?limit=50')).json.find((e: any) => e.kind === 'repo.parked' && JSON.parse(e.payload).repo === repo.id)
  assert.equal(JSON.parse(parkedLine.payload).parked.length, 3)
  assert.ok((await hq.api(`events?agent=${e1.id}`)).json.some((e: any) => e.kind === 'backend.error' && JSON.parse(e.payload).server === 'typing'))
  // its session ends (the terminal check would find it gone; here Stop, so the test needn't wait a minute): HQ writes its note and parks its work
  assert.equal((await hq.api(`agents/${e1.id}/stop`, {})).status, 200)
  await notes([tpm.id, e2.id], 'B397X')
  await waitFor('all parked', async () => (await tk(t1)).parked_at && (await tk(t2)).parked_at && (await repoRow(repo.id)).tpm_parked_at, 30_000)
  const db = hq.db({ readOnly: true })
  try { assert.match((db.prepare("SELECT text FROM docs WHERE scope = ? AND key = 'note'").get(`resume:ticket:${t1.id}`) as any).text, /didn't leave a note/) }
  finally { db.close() }
  assert.equal(await live(t1), undefined); assert.equal(await live(t2), undefined)
})

/** Bug 402: the backend is down; the marks of the switches away and back it had asked for, as the database says. */
const marks = (repo: any): { parking_at: number | null; resuming_at: number | null } => {
  const db = hq.db({ readOnly: true }); try { return db.prepare('SELECT parking_at, resuming_at FROM repos WHERE id = ?').get(repo.id) as any } finally { db.close() }
}
test('Bug 402: switching straight back while the park still asks, then a restart: the park finishes, then the resume; nothing stays parked', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, f, tpm } = await setup('b402x')
  const t1 = await ticket(f, 'One'); const e1 = await building(t1)
  const t2 = await ticket(f, 'Two'); const e2 = await building(t2)
  const ids = [tpm.id, e1.id, e2.id]
  let back: Promise<unknown> = Promise.resolve()
  const unasked = await downMidPark(repo, ids, async () => {
    back = hq.api(`repos/${repo.id}/resume`, {}).catch(() => null) // the page's switch back: waits behind the park (inTurn), goes with the backend
    await waitFor('the switch back recorded', async () => (await repoRow(repo.id)).resuming_at, 10_000) // asked for, not begun
    assert.ok((await repoRow(repo.id)).parking_at, 'the switch back was recorded only once the park was over')
  })
  await back
  const m = marks(repo); assert.ok(m.parking_at && m.resuming_at && m.parking_at < m.resuming_at, JSON.stringify(m))
  for (const id of unasked) await waitFor(`${id}'s Events line`, () => switchLine(id)) // the park finished first
  // the park types to the ones it hadn't asked, then the resume to all three: a few seconds each (Bug 438), as long as in the mirror below
  await waitFor('the resume over', async () => { const r = await repoRow(repo.id); return r.parking_at === null && r.resuming_at === null }, 30_000)
  for (const id of ids) assert.equal((await agent(id)).fresh_start_then, 'continue', id) // then the resume told each a new session takes over
  await notes(ids, 'B402X')
  const fresh = async (t: any, old: string) => { const a = await live(t); return a && a.id !== old && (await tk(t)).assignee_agent_id === a.id }
  await waitFor('everyone back', async () => (await fresh(t1, e1.id)) && (await fresh(t2, e2.id)) && (await repoRow(repo.id)).tpm_agent_id !== tpm.id, 20_000)
  assert.equal((await tk(t1)).parked_at, null); assert.equal((await tk(t2)).parked_at, null); assert.equal((await repoRow(repo.id)).tpm_parked_at, null)
  await stopAll(repo.id)
})

// The resume must still be under way when the switch away comes, and when the backend goes down. Starting parked agents is too quick for that
// (on Linux the TPM and four engineers were all back before the test's park request landed), so here the resume tells agents still writing the
// switch's notes that a new session takes over (Bug 350): it types into each terminal in turn (Escape, then a second and a half), seconds in all.
test('Bug 402, the mirror: switching away while coming back is still under way, then a restart: the resume finishes, then the park', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, f, tpm } = await setup('b402y'), ts: any[] = [], engs: any[] = []
  for (const n of ['One', 'Two', 'Three']) { const t = await ticket(f, n); ts.push(t); engs.push(await building(t)) }
  const ids = [tpm.id, ...engs.map((e) => e.id)]
  try {
    assert.equal((await hq.api(`repos/${repo.id}/park`, {})).json.parked.length, 4) // each asked for the switch's note; none written yet
    const back = hq.api(`repos/${repo.id}/resume`, {}).catch(() => null) // goes with the backend
    await waitFor('the resume telling the first', async () => (await Promise.all(ids.map(agent))).some((a) => a.fresh_start_then === 'continue'))
    const away = hq.api(`repos/${repo.id}/park`, {}).catch(() => null) // waits behind the resume
    await waitFor('the switch away recorded', async () => (await repoRow(repo.id)).parking_at)
    await hq.down(); await back; await away
    await whileDown(() => {
      const m = marks(repo); assert.ok(m.parking_at && m.resuming_at && m.resuming_at < m.parking_at, JSON.stringify(m))
      const db = hq.db({ readOnly: true }); let told: number
      try { told = ids.filter((id) => (db.prepare('SELECT fresh_start_then FROM agents WHERE id = ?').get(id) as any).fresh_start_then === 'switch').length }
      finally { db.close() }
      assert.ok(told, 'the resume was over before the backend went down: this test checked nothing')
    })
    await waitFor('both over', async () => { const r = await repoRow(repo.id); return r.parking_at === null && r.resuming_at === null }, 30_000)
    for (const id of ids) assert.equal((await agent(id)).fresh_start_then, 'switch', id) // the resume told each to carry on, then the park parked each again
    await notes(ids, 'B402Y')
    await waitFor('all parked', async () => (await repoRow(repo.id)).tpm_parked_at && (await Promise.all(ts.map(tk))).every((t) => t.parked_at), 20_000)
    assert.deepEqual(await running(repo.id, ts), { tpms: 0, engineers: ts.map(() => 0) })
  } finally { await stopAll(repo.id) } // a failed check leaves no engineer taking a slot from the tests after it
})

test('Bug 389: a restart in the middle of coming back to a project finishes the resume: the agents it hadn\'t started yet start, none twice', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, tpm, ts } = await parkedAll('b389x', 4)
  const back = hq.api(`repos/${repo.id}/resume`, {}).catch(() => null) // goes with the backend
  // the resume starts the TPM first, then one engineer after the other: down once the TPM is back, while engineers are still parked
  await waitFor('the TPM back', async () => !(await repoRow(repo.id)).tpm_parked_at, 20_000)
  await hq.down(); await back
  await whileDown(() => {
    const db = hq.db({ readOnly: true }); let still: number, mark: unknown
    try {
      still = ts.filter((t) => (db.prepare('SELECT parked_at FROM tickets WHERE id = ?').get(t.id) as any).parked_at).length
      mark = (db.prepare('SELECT resuming_at FROM repos WHERE id = ?').get(repo.id) as any).resuming_at
    } finally { db.close() }
    assert.ok(still, 'the resume was over before the backend went down: this test checked nothing')
    assert.ok(mark, 'the resume under way is recorded')
  })
  await allBack(repo, tpm, ts)
  await stopAll(repo.id)
})

/** Bug 389: the last backend went down right after it marked a coming back to `repo` under way (repos.resuming_at), before it started anyone. */
async function downAfterMark(repo: any): Promise<void> {
  await hq.down()
  await whileDown(() => { const db = hq.db(); try { db.prepare('UPDATE repos SET resuming_at = ? WHERE id = ?').run(Date.now(), repo.id) } finally { db.close() } })
}
test('Bug 389: a coming back recorded but not begun when HQ went down is done at start-up', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, tpm, ts } = await parkedAll('b389y', 1)
  await downAfterMark(repo)
  await allBack(repo, tpm, ts)
  await stopAll(repo.id)
})

// Seen on Linux only: the backend went down in the middle of starting an engineer for the resume, after its session began and before the ticket
// recorded it, and the resume run again at start-up started a second engineer on that ticket. The same can happen to the TPM.
test('Bug 389: a session the last backend started for the resume but never recorded takes over: no second TPM or engineer starts', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  const { repo, tpm, ts, engs } = await parkedAll('b389w', 1)
  assert.equal((await hq.api(`repos/${repo.id}/resume`, {})).json.resumed.length, 2)
  await allBack(repo, tpm, ts)
  const t = await tk(ts[0]), eng = await agent(t.assignee_agent_id), next = await agent((await repoRow(repo.id)).tpm_agent_id)
  await hq.down() // as the last backend left it had it gone down just after starting those two: ticket and repo still say parked, the slot is the launch's
  await whileDown(() => {
    const db = hq.db()
    try {
      db.prepare('UPDATE tickets SET assignee_agent_id = ?, parked_at = ? WHERE id = ?').run(engs[0].id, eng.started_at - 1000, t.id)
      db.prepare('UPDATE worker_slots SET agent_id = ? WHERE agent_id = ?').run(`pending-${t.id}`, eng.id)
      db.prepare('UPDATE repos SET tpm_agent_id = ?, tpm_parked_at = ?, resuming_at = ? WHERE id = ?').run(tpm.id, next.started_at - 1000, Date.now(), repo.id)
    } finally { db.close() }
  })
  await waitFor('the resume over', async () => { const r = await repoRow(repo.id); return r.resuming_at === null && !r.tpm_parked_at && !(await tk(t)).parked_at })
  assert.equal((await tk(t)).assignee_agent_id, eng.id); assert.equal((await repoRow(repo.id)).tpm_agent_id, next.id)
  assert.deepEqual(await running(repo.id, ts), { tpms: 1, engineers: [1] })
  const ro = hq.db({ readOnly: true })
  try { assert.equal((ro.prepare('SELECT agent_id FROM worker_slots WHERE agent_id IN (?, ?)').all(eng.id, `pending-${t.id}`) as any[]).map((r) => r.agent_id).join(), eng.id) }
  finally { ro.close() }
  await stopAll(repo.id)
})

test('Bug 389, what it must not catch: with "Wait until I press Resume" the parked work stays parked after the restart; a finished resume starts nobody again', async () => {
  await hq.api('settings', { key: 'after_fresh_start', value: 'wait' }) // the user chose it during the resume, before HQ went down
  const { repo, tpm, ts } = await parkedAll('b389z', 1)
  await downAfterMark(repo)
  // cleared at start-up without a resume: one would mark it again (resumeNow) until it ended, with the engineer and the TPM started
  await waitFor('the mark gone', async () => (await repoRow(repo.id)).resuming_at === null)
  assert.ok((await tk(ts[0])).parked_at); assert.ok((await repoRow(repo.id)).tpm_parked_at); assert.deepEqual(await running(repo.id, ts), { tpms: 0, engineers: [0] })
  await hq.api('settings', { key: 'after_fresh_start', value: 'continue' })
  assert.equal((await hq.api(`repos/${repo.id}/resume`, {})).json.resumed.length, 2) // the switch back the page asks for with the setting off
  await allBack(repo, tpm, ts)
  await hq.restart() // nothing under way: nobody starts again
  assert.equal((await repoRow(repo.id)).resuming_at, null); assert.deepEqual(await running(repo.id, ts), { tpms: 1, engineers: [1] })
  await stopAll(repo.id)
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
