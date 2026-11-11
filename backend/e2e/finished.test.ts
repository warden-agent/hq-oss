// Finished tickets end to end (local repos): a spec the TPM changes after a ticket is finished goes back to an engineer and can't
// merge until it's built; and a finished ticket's engineer stops once its turn has ended (it isn't kept, with its memory, until the
// merge), so whatever sends the ticket back later starts a fresh one on the same branch. The tests act as the TPM and the engineers
// (fake Claude Code); see harness.ts.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
// A finished engineer stops 0.3 s after its turn ends here (2 s for real), and the backstop looks every second (every minute for real).
before(async () => { hq = await startHq({ env: { HQ_FINISHED_STOP_MS: '300', HQ_FINISHED_TICK_S: '1' } }) })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ dir: string; repo: any; f: any; tpm: string }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f, tpm: f.tpm_agent_id }
}
const ticket = async (f: any, title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
const launch = (t: any) => hq.api(`tickets/${t.id}/launch`, {})
const engineers = async (t: any) => (await hq.state()).agents.filter((a: any) => a.role === 'engineer' && a.ticket_id === t.id)
const liveEngineer = (t: any, not?: string) => waitFor(`an engineer on ${t.key}`, async () => (await engineers(t)).find((a: any) => a.status === 'working' && a.id !== not))
const wtOf = (dir: string, t: any) => path.join(dir, '.claude', 'worktrees', t.key)
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const notices = async (t: any, kind: string) => (await hq.state()).attention.filter((a: any) => a.ticket_id === t.id && a.kind === kind)
const fix = (t: any) => hq.api(`tickets/${t.id}/fix-conflicts`, {})
const merge = (t: any) => hq.api(`tickets/${t.id}/merge`, {})
const sent = async (from: string, to: string) => (await hq.state()).messages.filter((m: any) => m.from_id === from && m.to_id === to)
const spec = (tpm: string, t: any, change: { spec?: string; title?: string }) => hq.mcp(tpm, 'update_ticket_spec', { key: t.key, ...change })
/** The engineer's last steps: commit `text` as version.txt, write the handoff, call open_pr. */
async function finish(eng: any, wt: string, text: string): Promise<{ text: string; isError: boolean }> {
  fs.writeFileSync(path.join(wt, 'version.txt'), text); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', `version: ${text.trim().split('\n').at(-1)}`)
  assert.equal((await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
  const r = await hq.mcp(eng.id, 'open_pr', { title: 'Add a line', body: 'Adds a line.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  return r
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const agent = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const turnEnds = (id: string) => hq.hook(id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
const stopped = (e: any) => waitFor(`${e.id} to stop`, async () => (await agent(e.id)).status === 'exited', 8000)
/** Still there, as `status`, after longer than the stop's delay and its backstop take here: HQ is keeping it. */
const kept = async (e: any, status: string) => { await wait(1600); assert.equal((await agent(e.id)).status, status) }
const sessions = () => hq.tmux('list-sessions', '-F', '#{session_name}').split('\n')
/** Why HQ stopped it. */
const why = async (e: any) => JSON.parse((await hq.api(`events?agent=${e.id}`)).json.find((x: any) => x.kind === 'agent.stopped').payload).reason
const prompt = (id: string) => fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'prompt.md'), 'utf8')
const gone = (e: any, t: any, next: string) => `${t.key} is finished and its engineer (${e.id}) has stopped, so nobody would read this. Nothing was sent. ${next}`

test('a spec changed after the ticket is finished goes back to its engineer, and the ticket waits for the change', async () => {
  const { dir, f, tpm } = await setup('s1')
  const t = await ticket(f, 'Orders'); await launch(t); const e = await liveEngineer(t)
  await finish(e, wtOf(dir, t), 'v1\norders\n')
  // A new title alone (or the spec it already has) changes nothing that was built: saved, nothing goes back, nobody is told.
  let r = await spec(tpm, t, { title: 'Order list' }); assert.equal(r.text, 'Updated.')
  r = await spec(tpm, t, { spec: 'Orders.' }); assert.equal(r.text, 'Updated.')
  let now = await tk(t); assert.deepEqual([now.status, now.title, now.spec, now.fixing], ['pr_ready', 'Order list', 'Orders.', null])
  assert.equal((await sent(tpm, e.id)).length + (await sent('hq', e.id)).length, 0)
  // The spec changes: the ticket goes back to its engineer, with the new spec and title saved.
  r = await spec(tpm, t, { spec: 'Orders, newest first.', title: 'Orders by date' }); assert.equal(r.isError, false, r.text)
  assert.equal(r.text, `Updated. T-01 was already finished, so HQ told its engineer (${e.id}) to build the change. It can't be merged until that's done; HQ tells you when it is.`)
  now = await tk(t); assert.deepEqual([now.status, now.fixing, now.spec, now.title, now.assignee_agent_id], ['resolving', 'changes', 'Orders, newest first.', 'Orders by date', e.id])
  const told = await sent('hq', e.id); assert.equal(told.length, 1)
  assert.match(told[0].body, /^HQ: the TPM changed the spec of T-01 after it was finished\. It isn't merged yet; it waits for the change\. Build it now, in your worktree:\n1\. Call get_ticket/)
  assert.equal((await engineers(t)).length, 1)
  const head = sh(dir, 'rev-parse', 'HEAD'), refused = await merge(t)
  assert.equal(refused.status, 409); assert.equal(refused.json.error, "T-01's engineer is building the change to its spec; merge it once that's done.")
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head)
  assert.match((await fix(t)).json.error, /is already building the change to its spec$/) // the button isn't there while it works; the API says why
  // A second change while the first is being built: the engineer is told the usual way; it's still the same job.
  r = await spec(tpm, t, { spec: 'Orders, newest first, ten a page.' }); assert.equal(r.text, 'Updated.')
  assert.equal((await sent('hq', e.id)).filter((m: any) => /^HQ: the TPM updated T-01's spec\. Call get_ticket to read it\.$/.test(m.body)).length, 1)
  assert.match((await hq.mcp(e.id, 'get_ticket')).text, /Orders, newest first, ten a page\./)
  // The engineer builds it and finishes again: ready to merge, with the TPM told what happened (and no "conflicts fixed").
  const done = await finish(e, wtOf(dir, t), 'v1\norders, newest first\n'); assert.match(done.text, /^Done\. The user merges/)
  now = await tk(t); assert.deepEqual([now.status, now.fixing, now.pr_state], ['pr_ready', null, 'local'])
  assert.equal((await notices(t, 'conflicts_fixed')).length + (await notices(t, 'change_stalled')).length, 0)
  assert.ok((await sent('hq', tpm)).some((m: any) => m.body === "HQ: T-01's engineer built the change to its spec (hq/s1/T-01-orders). The user merges it from HQ; you'll be told when it merges."))
  assert.equal((await merge(t)).status, 200)
  assert.equal(fs.readFileSync(path.join(dir, 'version.txt'), 'utf8'), 'v1\norders, newest first\n')
})

test("a change HQ can't send back changes nothing; with no engineer left a fresh one builds it, and Build the change starts another if that one stops", async () => {
  const { dir, repo, f, tpm } = await setup('s2')
  const t = await ticket(f, 'Invoices'); await launch(t); const e = await liveEngineer(t)
  await finish(e, wtOf(dir, t), 'v1\ninvoices\n')
  // Its engineer's terminal is gone and HQ hasn't noticed yet: the change is refused whole, so finished work never sits under a spec it doesn't match.
  hq.tmux('kill-session', '-t', `hq-${e.id}`)
  let r = await spec(tpm, t, { spec: 'Invoices with totals.', title: 'Invoice totals' }); assert.equal(r.isError, true)
  assert.equal(r.text, `T-01 is already finished, and HQ couldn't send it back to an engineer for this change: its engineer (${e.id}) can't be reached right now.`
    + ' Nothing was changed. Try again in a minute, or create a new ticket for the change.')
  let now = await tk(t); assert.deepEqual([now.status, now.fixing, now.spec, now.title], ['pr_ready', null, 'Invoices.', 'Invoices'])
  // Its engineer has stopped: a fresh one starts on the same branch and worktree with the change's instructions, no plan to review.
  await hq.api(`agents/${e.id}/stop`, {})
  r = await spec(tpm, t, { spec: 'Invoices with totals.' }); assert.equal(r.isError, false, r.text)
  const e2 = await liveEngineer(t, e.id)
  assert.equal(r.text, `Updated. T-01 was already finished, so HQ started an engineer (${e2.id}) to build the change. It can't be merged until that's done; HQ tells you when it is.`)
  now = await tk(t); assert.deepEqual([now.status, now.fixing, now.spec, now.assignee_agent_id, now.worktree_path], ['resolving', 'changes', 'Invoices with totals.', e2.id, wtOf(dir, t)])
  assert.match(prompt(e2.id), /^You are the engineer for ticket T-01 \(S\): Invoices\. Its work was finished and is committed on branch hq\/s2\/T-01-invoices in your worktree /)
  assert.match(prompt(e2.id), /get_ticket has the handoff so far\.\n\nHQ: the TPM changed the spec of T-01 after it was finished\./)
  assert.equal(e2.in_plan_mode, 0); assert.equal((await hq.state()).reviews.filter((x: any) => x.ticket_id === t.id).length, 0)
  assert.ok((await sent('hq', tpm)).some((m: any) => m.body.startsWith(`HQ: engineer ${e2.id} started on T-01 to build the change to its spec (branch hq/s2/T-01-invoices).`)))
  // That engineer stops before it's built: the user is told once, with the button that starts another.
  await hq.api(`agents/${e2.id}/stop`, {}); await hq.api(`repos/${repo.id}/sync`, {})
  const n = await waitFor('the stopped-engineer notice', async () => (await notices(t, 'change_stalled'))[0])
  assert.equal(n.detail, 'T-01: its engineer stopped while building the change to its spec. Press Build the change to start another.')
  assert.equal((await notices(t, 'fix_stalled')).length + (await notices(t, 'merge_conflict')).length, 0)
  assert.equal((await merge(t)).status, 409)
  const again = await fix(t); assert.equal(again.status, 200, JSON.stringify(again.json)); assert.equal(again.json.via, 'launch')
  const e3 = await liveEngineer(t, e2.id); assert.equal(e3.id, again.json.engineer)
  assert.match(prompt(e3.id), /HQ: the TPM changed the spec of T-01 after it was finished\./); assert.doesNotMatch(prompt(e3.id), /conflict|git merge/)
  assert.equal((await notices(t, 'change_stalled')).length, 0)
  now = await tk(t); assert.deepEqual([now.status, now.fixing, now.assignee_agent_id], ['resolving', 'changes', e3.id])
  // It builds the change: finished again, and it merges.
  await finish(e3, wtOf(dir, t), 'v1\ninvoices with totals\n')
  now = await tk(t); assert.deepEqual([now.status, now.fixing], ['pr_ready', null])
  assert.equal((await merge(t)).status, 200)
})

test('an engineer whose ticket is finished stops once its turn has ended; the ticket, its worktree and its branch stay, and nobody is alerted', async () => {
  const { dir, repo, f, tpm } = await setup('s3')
  const t = await ticket(f, 'Orders'), t2 = await ticket(f, 'Invoices'); await launch(t); await launch(t2)
  const e = await liveEngineer(t), e2 = await liveEngineer(t2)
  // A turn that ends before the ticket is finished changes nothing: that engineer is still needed.
  await turnEnds(e.id); await kept(e, 'idle')
  // It finishes in the middle of a turn: it stays until the turn has ended (its last words reach its terminal), then it goes.
  await hq.hook(e.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Carry on.' })
  await finish(e, wtOf(dir, t), 'v1\norders\n'); await kept(e, 'working'); assert.ok(sessions().includes(`hq-${e.id}`))
  const before = (await hq.state()).attention.map((a: any) => a.id)
  await turnEnds(e.id); await stopped(e)
  assert.equal(await why(e), 'finished'); assert.ok(!sessions().includes(`hq-${e.id}`), 'its terminal is gone')
  // The ticket is as finished as it was: same engineer on record, worktree and branch in place, and nothing new asks for the user.
  await hq.api(`repos/${repo.id}/sync`, {}); await wait(300)
  const now = await tk(t); assert.deepEqual([now.status, now.assignee_agent_id, now.worktree_path, now.branch], ['pr_ready', e.id, wtOf(dir, t), 'hq/s3/T-01-orders'])
  assert.equal(fs.readFileSync(path.join(wtOf(dir, t), 'version.txt'), 'utf8'), 'v1\norders\n'); assert.ok(sh(dir, 'rev-parse', '--verify', 'hq/s3/T-01-orders'))
  assert.deepEqual((await hq.state()).attention.filter((a: any) => !before.includes(a.id)).map((a: any) => a.detail), [])
  // Nobody reads its messages any more. Whoever writes to it hears that, and what to do instead, not "Unknown recipient".
  let r = await hq.mcp(tpm, 'send_message', { to: e.id, reason: 'fyi', body: 'One more thing.' }); assert.equal(r.isError, true)
  assert.equal(r.text, gone(e, t, 'To change T-01, call update_ticket_spec: HQ starts an engineer to build the change.'))
  const was = (await tk(t2)).status
  r = await hq.mcp(e2.id, 'send_message', { to: e.id, reason: 'question', body: 'Which port do you use?' }); assert.equal(r.isError, true)
  assert.equal(r.text, gone(e, t, 'Its work is on branch hq/s3/T-01-orders; ask the TPM for anything else.'))
  assert.equal((await tk(t2)).status, was); assert.equal((await sent(tpm, e.id)).length + (await sent(e2.id, e.id)).length, 0)
  // An engineer whose ticket isn't finished is left alone when its turn ends.
  await turnEnds(e2.id); await kept(e2, 'idle')
  // Merging needs no engineer: the work lands and the worktree goes.
  assert.equal((await merge(t)).status, 200); assert.equal(fs.readFileSync(path.join(dir, 'version.txt'), 'utf8'), 'v1\norders\n')
  await waitFor('its worktree to go', () => !fs.existsSync(wtOf(dir, t)))
})

test('a finished engineer with something left to do is kept: a helper of its own, a message on its way, a person in its terminal', async () => {
  const { dir, f } = await setup('s4')
  const t = await ticket(f, 'Orders'); await launch(t); const e = await liveEngineer(t)
  const first = (await hq.modNext(e.id)).batch; await hq.modEvent(e.id, { kind: 'batch_received', id: first.id }) // its launch prompt
  await hq.hook(e.id, { hook_event_name: 'UserPromptSubmit', prompt: first.text })
  await finish(e, wtOf(dir, t), 'v1\norders\n')
  // Bug 94: a helper it started in the background still runs when its turn ends. It is working, so it stays.
  await hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'Check the docs' },
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'h1', description: 'Check the docs' } })
  await turnEnds(e.id); await kept(e, 'working')
  // The user writes to it, then the helper ends: it is idle, but the message hasn't reached it yet, so it stays to read it.
  assert.equal((await hq.api(`agents/${e.id}/message`, { body: 'Is the list sorted?', reason: 'fyi' })).status, 200)
  await hq.hook(e.id, { hook_event_name: 'SubagentStop', agent_id: 'h1' }); await kept(e, 'idle')
  // Handed to its session, not started yet (the prompt that sets it working comes a moment later): it stays.
  const b = (await hq.modNext(e.id)).batch; assert.match(b.text, /Is the list sorted\?/); await hq.modEvent(e.id, { kind: 'batch_received', id: b.id })
  await kept(e, 'idle')
  await hq.hook(e.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text }); assert.equal((await agent(e.id)).status, 'working')
  // A person is in its terminal when the turn ends: it stays for as long as they hold it, and goes once they let go.
  await hq.api(`agents/${e.id}/takeover`, { locked: true }); await turnEnds(e.id); await kept(e, 'idle')
  await hq.api(`agents/${e.id}/takeover`, { locked: false }); await stopped(e); assert.equal(await why(e), 'finished')
  const now = await tk(t); assert.deepEqual([now.status, now.assignee_agent_id], ['pr_ready', e.id])
})

/** Runs `fn` against a second HQ started with `env`; the tests' own HQ is back afterwards. */
async function otherHq(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const main = hq
  hq = await startHq({ env })
  try { await fn() } finally { await hq.stop(); hq = main }
}

test("the wait after its turn ends is each engineer's own: the backstop and another agent's turn don't cut it short", async () => {
  // Here the wait is 2.5 s and the backstop looks every second (for real: 2 s and every minute).
  await otherHq({ HQ_FINISHED_STOP_MS: '2500', HQ_FINISHED_TICK_S: '1' }, async () => {
    const { dir, f, tpm } = await setup('s7')
    const t = await ticket(f, 'Orders'); await launch(t); const e = await liveEngineer(t)
    await finish(e, wtOf(dir, t), 'v1\norders\n')
    // The TPM's turn ends 1.2 s before the engineer's, so the look that follows it comes 1.3 s into the engineer's wait, like two looks of the backstop.
    await turnEnds(tpm); await wait(1200); await turnEnds(e.id)
    await stopped(e); assert.equal(await why(e), 'finished'); assert.equal((await tk(t)).status, 'pr_ready')
    // Measured on HQ's own clock, so a slow machine can't fail it: from the end of its turn to its stop took the whole wait
    const evs = (await hq.api(`events?agent=${e.id}`)).json, at = (kind: string): number => evs.find((x: any) => x.kind === kind).created_at
    assert.ok(at('agent.stopped') - at('hook.Stop') >= 2400, `stopped ${at('agent.stopped') - at('hook.Stop')} ms after its turn ended`)
  })
})

/** Runs `fn` against a second HQ whose `tmux kill-session` takes two seconds, so "its engineer is being stopped" lasts long enough
 *  to act in the middle of it. The stand-in only waits; then the real tmux runs with the very same arguments. */
async function slowStops(fn: () => Promise<void>): Promise<void> {
  const real = process.env.PATH!.split(':').map((d) => path.join(d, 'tmux')).find((p) => fs.existsSync(p)); assert.ok(real, 'tmux is installed')
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-slow-tmux-'))
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\ncase " $* " in *" kill-session "*) sleep 2;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 })
  const env = { PATH: `${bin}:${process.env.PATH}`, HQ_FINISHED_STOP_MS: '100', HQ_FINISHED_TICK_S: '3600', HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500' }
  try { await otherHq(env, fn) } finally { fs.rmSync(bin, { recursive: true, force: true }) }
}

test('a ticket that comes back while its engineer is being stopped gets a fresh one: Fix conflicts and a changed spec, never "can\'t be reached"', async () => {
  await slowStops(async () => {
    const { dir, f, tpm } = await setup('s5')
    const t1 = await ticket(f, 'Orders'), t2 = await ticket(f, 'Invoices'); await launch(t1); await launch(t2)
    const e1 = await liveEngineer(t1), e2 = await liveEngineer(t2)
    await finish(e1, wtOf(dir, t1), 'v1\norders\n'); await finish(e2, wtOf(dir, t2), 'v1\ninvoices\n')
    assert.equal((await merge(t1)).status, 200); await waitFor('T-02 flagged', async () => (await tk(t2)).conflict_files === '["version.txt"]')
    // Its turn ends and HQ starts stopping it (two seconds here). In the middle of that the TPM writes to it and the user presses Fix conflicts.
    await turnEnds(e2.id); await wait(500); assert.equal((await agent(e2.id)).status, 'idle')
    const said = await hq.mcp(tpm, 'send_message', { to: e2.id, reason: 'fyi', body: 'T-01 merged.' })
    assert.equal(said.text, gone(e2, t2, 'To change T-02, call update_ticket_spec: HQ starts an engineer to build the change.'))
    const r = await fix(t2); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.via, 'launch')
    const e3 = await liveEngineer(t2, e2.id); assert.equal(r.json.engineer, e3.id)
    assert.equal((await agent(e2.id)).status, 'exited'); assert.equal(await why(e2), 'finished')
    assert.match(prompt(e3.id), /HQ: main has moved on since you finished T-02\. T-01 merged first, and now hq\/s5\/T-02-invoices conflicts with main in version\.txt\./)
    assert.equal((await sent('hq', e2.id)).length + (await sent(tpm, e2.id)).length, 0) // nothing went to the one that was leaving
    let now = await tk(t2); assert.deepEqual([now.status, now.fixing, now.assignee_agent_id, now.worktree_path], ['resolving', null, e3.id, wtOf(dir, t2)])
    // The fresh engineer merges main in and finishes. When its turn ends it stops too, and the ticket merges.
    try { sh(wtOf(dir, t2), 'merge', '--no-edit', 'main') } catch { /* the conflict */ }
    await finish(e3, wtOf(dir, t2), 'v1\norders\ninvoices\n'); now = await tk(t2); assert.deepEqual([now.status, now.conflict_files], ['pr_ready', null])
    await turnEnds(e3.id); await stopped(e3); assert.equal(await why(e3), 'finished')
    assert.equal((await merge(t2)).status, 200); assert.equal(fs.readFileSync(path.join(dir, 'version.txt'), 'utf8'), 'v1\norders\ninvoices\n')
    // The same for a spec the TPM changes just as the finished ticket's engineer is on its way out.
    const t3 = await ticket(f, 'Totals'); await launch(t3); const e4 = await liveEngineer(t3)
    await finish(e4, wtOf(dir, t3), 'v1\norders\ninvoices\ntotals\n')
    await turnEnds(e4.id); await wait(500); assert.equal((await agent(e4.id)).status, 'idle')
    const changed = await spec(tpm, t3, { spec: 'Totals, with tax.' }); assert.equal(changed.isError, false, changed.text)
    const e5 = await liveEngineer(t3, e4.id)
    assert.equal(changed.text, `Updated. T-03 was already finished, so HQ started an engineer (${e5.id}) to build the change. It can't be merged until that's done; HQ tells you when it is.`)
    assert.equal((await agent(e4.id)).status, 'exited'); assert.equal(await why(e4), 'finished')
    now = await tk(t3); assert.deepEqual([now.status, now.fixing, now.spec, now.assignee_agent_id], ['resolving', 'changes', 'Totals, with tax.', e5.id])
  })
})

test('auto mode: a finished ticket whose tests fail on main goes to a fresh engineer once its own has stopped, and is not parked', async () => {
  await slowStops(async () => {
    const dir = hq.repo('s6'), wt = (t: any) => wtOf(dir, t)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 's6', private: true, scripts: { start: 'node server.js', test: 'node --test' } }))
    fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), "require('node:test').test('ok',()=>{})\n")
    sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
    const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 's6', request: 'Build s6' })).json
    await waitFor('the TPM', async () => (await agent(f.tpm_agent_id))?.status === 'working')
    assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
    const until = (t: any, status: string) => waitFor(`${t.key} to be ${status}`, async () => (await tk(t)).status === status, 30_000)
    /** What an engineer does on auto: plan (HQ approves it), write `files`, commit, open_pr. */
    const work = async (t: any, e: any, files: Record<string, string>) => {
      assert.equal((await hq.hook(e.id, exitPlanMode(`Plan for ${t.key}`))).hookSpecificOutput.decision.behavior, 'allow')
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(wt(t), name), text)
      sh(wt(t), 'add', '.'); sh(wt(t), 'commit', '-qm', t.title); assert.equal((await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
      const r = await hq.mcp(e.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
    }
    const t1 = await ticket(f, 'Server'), t2 = await ticket(f, 'Screen'); await turnEnds(f.tpm_agent_id)
    const e1 = await liveEngineer(t1), e2 = await liveEngineer(t2)
    await work(t2, e2, { 'screen.js': 'exports.read=(i)=>i.expiresOn\n', 'test/join.test.js': "const t=require('node:test'),a=require('node:assert'),fs=require('fs');"
      + "t.test('join',()=>{if(!fs.existsSync(__dirname+'/../items.js'))return;a.equal(require('../screen').read(require('../items').item()),'2027')})\n" })
    await until(t2, 'merged'); await turnEnds(f.tpm_agent_id) // alone it passes: no server yet
    // T-01 finishes and its engineer's turn ends at once, so HQ is stopping it (or has) when the tests fail on main: a fresh engineer gets them.
    await work(t1, e1, { 'items.js': "exports.item=()=>({expiryDate:'2027'})\n" }); await turnEnds(e1.id)
    await until(t1, 'resolving'); const e3 = await liveEngineer(t1, e1.id)
    const now = await tk(t1); assert.deepEqual([now.fixing, now.auto_parked_why, now.assignee_agent_id], ['tests', null, e3.id])
    assert.equal((await agent(e1.id)).status, 'exited'); assert.equal(await why(e1), 'finished')
    assert.match(prompt(e3.id), /^You are the engineer for ticket T-01 \(S\): Server\. Its work is committed on branch hq\/s6\/T-01-server[\s\S]*fails its tests[\s\S]*join/)
    assert.equal((await sent('hq', e1.id)).filter((m: any) => /fails its tests/.test(m.body)).length, 0)
    assert.equal((await hq.state()).attention.filter((a: any) => a.ticket_id === t1.id).length, 0)
    // It fixes them and the ticket merges, as if the first engineer had stayed.
    sh(wt(t1), 'merge', '--no-edit', 'main'); fs.writeFileSync(path.join(wt(t1), 'items.js'), "exports.item=()=>({expiresOn:'2027'})\n")
    sh(wt(t1), 'add', '.'); sh(wt(t1), 'commit', '-qm', 'same name'); await hq.mcp(e3.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
    const pr = await hq.mcp(e3.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone' }); assert.equal(pr.isError, false, pr.text)
    await until(t1, 'merged'); assert.equal((await tk(t1)).auto_tries, 1)
  })
})
