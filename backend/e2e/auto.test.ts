// Auto mode end to end: the tests act as the TPM and the engineers (fake Claude Code; see harness.ts) and press nothing a user
// would press. Plans are approved, ready tickets start when the TPM's turn ends, finished tickets are tested on main in the real
// sandbox and merged; failures go back to their engineer, then park; a broken main gets a repair ticket of HQ's, and stops the project
// only if that can't work; the switch goes off cleanly.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, pending, type Hq } from './harness.ts'
import { WebSocket } from 'ws'
import { diffCheckWords } from '../src/checks.ts'
import { slotWindow } from '../src/slotports.ts'

let hq: Hq
const prompt = (id: string) => fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'prompt.md'), 'utf8') // what the agent was started with
// HQ_LOOK_RUNNER: no browser here; HQ's look at the app (a project with start steps) runs fake-look.mjs in its place, in the same sandbox. The UI tester's
// browser is never started either (fake-claude.mjs drives its host itself), so any program will do for it
// HQ_SCENARIO_RUNNER: a finding's replay (scenario.ts) runs fake-scenario.mjs in place of the scripted browser, under the real recorder
const ENV = { HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500', HQ_LOOK_RUNNER: path.join(import.meta.dirname, 'fake-look.mjs'),
  HQ_UITEST_BROWSER_EXE: '/usr/bin/false', HQ_SCENARIO_RUNNER: path.join(import.meta.dirname, 'fake-scenario.mjs') }
beforeEach(async () => { hq = await startHq({ env: ENV }) })
afterEach(async () => { await hq?.stop() })

const PASS = "require('node:test').test('ok',()=>{})\n"
/** A project with `npm test` and one passing test, its TPM running and auto mode on. */
async function project(name: string, o: { tests?: boolean; auto?: boolean; branch?: string } = {}) {
  const dir = hq.repo(name)
  if (o.branch) sh(dir, 'branch', '-m', o.branch) // Bug 210: a project whose default branch isn't main
  if (o.tests !== false) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { start: 'node server.js', test: 'node --test' } }))
    fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), PASS); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  }
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  if (o.auto !== false) assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  return { dir, repo, f, tpm }
}
type P = Awaited<ReturnType<typeof project>>
const ticket = async (p: P, title: string, deps: string[] = []) => (await hq.api('tickets', { featureId: p.f.id, title, size: 'S', spec: `${title}.`, depends_on: deps })).json
const turnEnds = (p: P) => hq.hook(p.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Split done.' })
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const repoNow = async (p: P) => (await hq.state()).repos.find((r: any) => r.id === p.repo.id)
const runs = async (p: P) => (await hq.state()).autoRuns.filter((r: any) => r.repo_id === p.repo.id)
const engineer = (t: any, not?: string) => waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id &&
  a.status === 'working' && a.id !== not))
const wt = (p: P, t: any) => path.join(p.dir, '.claude', 'worktrees', t.key)
/** Bug 206: the "came back" lines of an engineer's Events tab. */
const cameBack = async (id: string): Promise<string[]> => ((await hq.api(`agents/${id}/events`)).json.events as any[]).map((x) => x.text).filter((x) => / came back: /.test(x))
/** Waits for `t` to reach `status`; a time-out says where it was instead (Bug 113: a CI failure that never said which wait it was). */
const until = async (t: any, status: string, ms = 15_000) => { let last = 'not found'
  try { return await waitFor(`${t.key} to be ${status}`, async () => { const x = await tk(t); last = x ? `${x.status}${x.auto_parked_why ? `, parked: ${x.auto_parked_why}` : ''}` : 'gone'
    return x?.status === status ? x : null }, ms) } catch (e) { throw new Error(`${(e as Error).message} (it is ${last})`) } }
/** Bug 162: what the engineer ran last before its handoff, as Claude Code's hook reports it. With auto off, open_pr needs the project's test command run. */
const ranTests = (e: any) => hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `toolu_${e.id}_${Date.now()}` })
/** `leftOut`: the "## Tests left out" section a repair's body needs (Bug 142); any ticket may have it. */
async function openPr(e: any, leftOut = 'Nothing'): Promise<void> {
  await ranTests(e); await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e.id, 'open_pr', { title: 'Done', body: `Done.\n\n## Deviations from approved plan\nNone\n\n## Tests left out\n${leftOut}`,
    feature_map_unchanged: true }) // the map: featuremap.test.ts
  assert.equal(r.isError, false, r.text)
}
/** What an engineer does: plan (no one approves it but HQ), write `files`, commit, open_pr. */
async function work(p: P, t: any, e: any, files: Record<string, string>): Promise<void> {
  const held = await hq.hook(e.id, exitPlanMode(`Plan for ${t.key}`))
  assert.equal(held.hookSpecificOutput.decision.behavior, 'allow')
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(wt(p, t), f)), { recursive: true }); fs.writeFileSync(path.join(wt(p, t), f), text) }
  sh(wt(p, t), 'add', '.'); sh(wt(p, t), 'commit', '-qm', t.title); await openPr(e)
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** The auto loop has been round again since the test's last action: twice, so one whole pass began after it, and HQ's own test runs have
 *  ended (`false`: one is held back on purpose). For "nothing more happens", where a test used to sleep and then look. */
const looked = (runsEnd = true) => hq.beats('auto', 2, runsEnd ? {} : { runs: 'leave' })

// Bug 106: while HQ runs its own tests the page is told, so the board can say so. HELD is a test command that waits until the test lets it go, with a file in the
// run's own checkout: the one folder both the test and the sandboxed run can reach, on a Mac and under bubblewrap. Bug 113: it orders runs without timing.
const HELD = 'until [ -f go ]; do sleep 0.1; done'
const shown = async (p: P): Promise<string> => (await hq.state()).testRuns.filter((r: any) => r.repo_id === p.repo.id).map((r: any) => `${r.ticket_id ?? 'no ticket'}:${r.what}:${r.state}`).join(' ')
const onPage = (p: P, want: string) => waitFor(`the page to say "${want}"`, async () => (await shown(p)) === want, 20_000)
const letGo = (p: P) => waitFor("the run's checkout", () => {
  const dir = path.join(p.dir, '.claude', 'worktrees'), [d] = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith('hq-test-')) : []
  if (!d) return false
  fs.writeFileSync(path.join(dir, d, 'go'), ''); return true
})

const MARK = `sleep 58.${process.pid}`, stuckRun = () => execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').some((l) => l.startsWith(MARK)) // no path on its command line
/** A finished ticket whose test never ends, running now. */
async function testRunning(name: string): Promise<P> {
  const p = await project(name), t = await ticket(p, 'Thing')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: MARK })).status, 200)
  await turnEnds(p); await work(p, t, await engineer(t), { 'thing.js': '1\n' })
  await waitFor('the test run', () => stuckRun(), 15_000); return p
}
test('Bug 69: a test HQ stopped in the middle of a test run leaves nothing running', async () => {
  await testRunning('stopped'); await hq.stop()
  await waitFor('the test run to end', () => !stuckRun(), 3000)
})
/** The pids of the runs under way now: the next start tests the ticket again with the same command, so the old run is told apart by its pids. */
const stuckPids = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter((l) => l.split(/\s+/).slice(1).join(' ')
  .startsWith(MARK)).map((l) => Number(l.split(/\s+/)[0]))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
test('Bug 69: a backend killed outright can\'t stop its test run, so the next start does', async () => {
  const p = await testRunning('killed'), old = stuckPids(); assert.ok(old.length)
  const pid = execFileSync('lsof', ['-ti', `tcp:${hq.ports.ui}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]!
  process.kill(Number(pid), 'SIGKILL'); await wait(300) // real-time: a run that died with its backend would do so within moments of the kill, and nothing would show it but its pids
  if (process.platform === 'darwin') assert.ok(old.some(alive), 'it outlives the backend, or this proves nothing') // Linux's sandbox dies with its parent
  await hq.restart()
  await waitFor('the old test run to end', () => !old.some(alive), 5000)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200) // and the new one with it (Bug 89)
  await waitFor('the new one to end', () => !stuckRun(), 5000)
})
const tested = async () => ((await hq.api('events?limit=500')).json as any[]).filter((e) => e.kind === 'auto.tested' || e.kind === 'auto.main_checked')
test('Bug 89: auto off during the check of main ends that run at once, with no result; on again checks main afresh', async () => {
  const p = await project('offmain'); await ticket(p, 'One')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: MARK })).status, 200); await turnEnds(p)
  await waitFor('the check of main', () => stuckRun(), 15_000)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  await waitFor('the run to end', () => !stuckRun(), 5000); await looked()
  assert.deepEqual(await tested(), [], 'no result: not a failure, not a repair'); assert.equal((await runs(p))[0].status, 'off'); assert.deepEqual(await repairs(p), [])
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: '' })).status, 200); assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const c = await waitFor('a new check', async () => (await checks())[0], 15_000); assert.equal(c.result, 'pass')
})
test('Bug 89: auto off while a finished ticket is tested ends the run; the ticket isn\'t sent back, and on again tests it afresh', async () => {
  const p = await project('offticket'), t = await ticket(p, 'Thing')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: `if [ -f thing.js ]; then ${MARK}; fi` })).status, 200); await turnEnds(p)
  await waitFor('main checked', async () => (await checks())[0]); await work(p, t, await engineer(t), { 'thing.js': '1\n' })
  await waitFor('the ticket\'s test', () => stuckRun(), 15_000); const old = stuckPids()
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200); assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  await waitFor('the old run to end', () => !old.some(alive), 5000)
  await waitFor('a fresh test of it', () => stuckPids().some((x) => !old.includes(x)), 15_000)
  assert.equal((await tested()).filter((e) => e.kind === 'auto.tested').length, 0, 'the stopped run said nothing')
  const now = await tk(t); assert.equal(now.status, 'pr_ready'); assert.equal(now.auto_tries, 0, 'not sent back to its engineer')
})
test('Bug 163: a TPM started after auto mode went off is told it\'s off, and that earlier talk of HQ testing was from auto mode', async () => {
  const p = await project('offstart'), repo = p.repo.id
  const fromHq = async (id: string) => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === id).map((m: any) => m.body).join('\n')
  assert.match(await fromHq(p.tpm.id),
    /HQ: the user turned auto mode on for this project\. From now on HQ starts ready tickets when your turn ends, approves plans, tests finished tickets on main, merges them/)
  await hq.hook(p.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'HQ ran the tests before each merge.' }) // said while auto was on
  assert.equal((await hq.api(`repos/${repo}/auto`, { on: false })).status, 200) // a running TPM is told, in the same words as a new one
  assert.match(await fromHq(p.tpm.id), /HQ: the user turned auto mode off\. From now on the user starts tickets, approves plans and merges from HQ, and HQ runs no tests before a merge\./)
  assert.equal((await hq.api(`repos/${repo}/auto`, { on: true })).status, 200)
  await hq.api(`agents/${p.tpm.id}/stop`, {}); await waitFor('the TPM to stop', async () => (await hq.state()).agents.find((a: any) => a.id === p.tpm.id)?.status === 'exited')
  assert.equal((await hq.api(`repos/${repo}/auto`, { on: false })).status, 200) // no TPM to tell
  const off = await hq.api(`repos/${repo}/message`, { body: 'Is auto mode on?' }); assert.equal(off.status, 200, JSON.stringify(off.json))
  const said = prompt(off.json.agent.id)
  assert.match(said, /- TPM: HQ ran the tests before each merge\./) // its history still says so
  assert.match(said, /Auto mode is off for this project: the user starts tickets, approves plans and merges from HQ, and HQ runs no tests before a merge\./)
  assert.match(said, /If earlier messages or the handoff note say HQ starts, tests or merges tickets by itself, that was while auto mode was on\./)
  assert.doesNotMatch(said, /Auto mode is on/)
  await hq.api(`agents/${off.json.agent.id}/stop`, {})
  await waitFor('the second TPM to stop', async () => (await hq.state()).agents.find((a: any) => a.id === off.json.agent.id)?.status === 'exited')
  assert.equal((await hq.api(`repos/${repo}/auto`, { on: true })).status, 200)
  const on = await hq.api(`repos/${repo}/message`, { body: 'And now?' }); assert.equal(on.status, 200, JSON.stringify(on.json))
  assert.match(prompt(on.json.agent.id), /Auto mode is on for this project: HQ starts ready tickets when your turn ends, approves plans, tests finished tickets on main/)
  assert.doesNotMatch(prompt(on.json.agent.id), /Auto mode is off/)
})
test('Bug 210: in a project whose default branch is master, HQ tells the TPM master, when auto goes on and on a new TPM\'s board', async () => {
  const p = await project('oldbase', { branch: 'master' }), t = await ticket(p, 'Thing')
  assert.equal((await repoNow(p)).default_branch, 'master')
  const fromHq = (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === p.tpm.id).map((m: any) => m.body).join('\n')
  assert.match(fromHq, /HQ: the user turned auto mode on for this project\. From now on HQ starts ready tickets when your turn ends, approves plans, tests finished tickets on master,/)
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: `if [ -f thing.js ]; then ${MARK}; fi` })).status, 200); await turnEnds(p)
  await waitFor('master checked', async () => (await checks())[0]); await work(p, t, await engineer(t), { 'thing.js': '1\n' })
  await waitFor('the ticket\'s test', () => stuckRun(), 15_000) // finished, and HQ is testing it: it stays that way while the new TPM starts
  await hq.api(`agents/${p.tpm.id}/stop`, {}); await waitFor('the TPM to stop', async () => (await hq.state()).agents.find((a: any) => a.id === p.tpm.id)?.status === 'exited')
  const fresh = await hq.api(`repos/${p.repo.id}/restart-tpm`, {}); assert.equal(fresh.status, 200, JSON.stringify(fresh.json))
  const said = prompt(fresh.json.id)
  assert.match(said, /Auto mode is on for this project: HQ starts ready tickets when your turn ends, approves plans, tests finished tickets on master, merges them/)
  assert.match(said, new RegExp(`  - ${t.key} \\(S\\) Thing: finished; HQ tests it on master and merges it · branch `))
  assert.doesNotMatch(said, /\bmain\b/)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200); await waitFor('the test run to end', () => !stuckRun(), 5000)
  await hq.api(`agents/${fresh.json.id}/stop`, {})
})
test('Bug 115: a project auto mode stops ends its test run at once, frees the turn an engineer waits for, and Resume tests afresh', async () => {
  const p = await project('stoprun'), t = await ticket(p, 'Thing'), t2 = await ticket(p, 'Other')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: `if [ -f thing.js ]; then ${MARK}; fi` })).status, 200); await turnEnds(p)
  const e2 = await engineer(t2); await waitFor('main checked', async () => (await checks())[0]); await work(p, t, await engineer(t), { 'thing.js': '1\n' })
  await waitFor('the ticket\'s test', () => stuckRun(), 15_000); const old = stuckPids()
  const use = { tool_name: 'Bash', tool_use_id: 'toolu_115', tool_input: { command: 'npm test' } }
  const theirs = hq.hook(e2.id, { hook_event_name: 'PreToolUse', ...use })
  await waitFor('its box to say it waits its turn', async () => /^Waiting its turn/.test((await hq.state()).agents.find((a: any) => a.id === e2.id)?.activity ?? ''))
  assert.ok(await pending(theirs), 'the engineer waits behind HQ\'s run')
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  assert.match(await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why), /The TPM needs you/)
  await waitFor('the run to end', () => !old.some(alive), 5000); assert.deepEqual(await theirs, {}, 'its turn now')
  await hq.hook(e2.id, { hook_event_name: 'PostToolUse', ...use }); await looked()
  assert.equal((await tested()).filter((e) => e.kind === 'auto.tested').length, 0, 'the stopped run said nothing')
  const now = await tk(t); assert.equal(now.status, 'pr_ready'); assert.equal(now.auto_tries, 0, 'not sent back to its engineer')
  await hq.api(`agents/${p.tpm.id}/stop`, {}) // the dialog is over (Bug 62)
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: '' })).status, 200)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-resume`, {})).status, 200); await until(t, 'merged', 30_000)
  assert.deepEqual((await tested()).filter((e) => e.kind === 'auto.tested').map((e) => JSON.parse(e.payload).result), ['pass'], 'tested from the start')
})
test('Bug 115: a stop during the check of main ends that run with no result, and Resume checks main again', async () => {
  const p = await project('stopmain'); await ticket(p, 'One')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: MARK })).status, 200); await turnEnds(p)
  await waitFor('the check of main', () => stuckRun(), 15_000)
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why); await waitFor('the run to end', () => !stuckRun(), 5000); await looked()
  assert.deepEqual(await tested(), [], 'no result: not a failure, not a repair'); assert.deepEqual(await repairs(p), []); assert.equal((await runs(p))[0].main_checked, null)
  await hq.api(`agents/${p.tpm.id}/stop`, {}); assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: '' })).status, 200)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-resume`, {})).status, 200)
  const c = await waitFor('a new check', async () => (await checks())[0], 15_000); assert.equal(c.result, 'pass')
})
test('Bug 152: Clear project ends the check of main at once, while the TPM still writes its note, and nothing follows from it', async () => {
  const p = await project('clearrun'); await ticket(p, 'One')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: MARK })).status, 200); await turnEnds(p)
  await waitFor('the check of main', () => stuckRun(), 15_000)
  const r = await hq.api(`repos/${p.repo.id}/clear`, {}); assert.equal(r.status, 200); assert.equal(r.json.done, false, 'the clear waits for the TPM\'s note')
  await waitFor('the run to end', () => !stuckRun(), 2000); await looked()
  assert.deepEqual(await tested(), [], 'no result: not a failure, not a repair'); assert.deepEqual(await repairs(p), [])
  assert.ok((await repoNow(p)).clearing_at, 'the clear is still under way: the run didn\'t wait for it to finish')
})

test('a machine that can\'t sandbox the tests says so before anything starts: no switch, no run, no tokens', async () => {
  await hq.stop(); hq = await startHq({ env: { HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500', HQ_SANDBOX_BIN: 'hq-no-such-sandbox' } })
  const p = await project('nosandbox', { auto: false })
  const check = (await hq.api(`repos/${p.repo.id}/auto-check`, {})).json; assert.match(check.sandbox, /bubblewrap|sandbox/)
  const r = await hq.api(`repos/${p.repo.id}/auto`, { on: true }); assert.equal(r.status, 409); assert.equal(r.json.error, check.sandbox)
  await ticket(p, 'Nothing'); await turnEnds(p); await looked()
  assert.equal((await repoNow(p)).auto_mode, 0); assert.equal((await runs(p)).length, 0)
  assert.equal((await hq.state()).agents.filter((a: any) => a.role === 'engineer').length, 0)
})

test('a request runs to the end with nobody pressing anything: starts after the split, plan on record, tested, merged, summed up', async () => {
  const p = await project('all')
  const t1 = await ticket(p, 'Orders'), t2 = await ticket(p, 'Invoices', [t1.key])
  await looked(); assert.equal((await hq.state()).agents.filter((a: any) => a.role === 'engineer').length, 0, 'nothing starts while the TPM is splitting')
  await turnEnds(p)
  const e1 = await engineer(t1); await work(p, t1, e1, { 'orders.txt': 'r\n' })
  await until(t1, 'merged')
  assert.ok(fs.existsSync(path.join(p.dir, 'orders.txt')), 'the work is on main')
  // Bug 126: the merged ticket says what HQ ran on it and how it ended, with the output a click away, and its TPM hears the same
  const m = JSON.parse((await tk(t1)).merge_test)
  const noApp = { ran: 'skipped', quiet: true, why: 'HQ has no start steps for this project (press Launch app once, and it looks before every merge after that)' }
  assert.deepEqual({ ...m, ms: 0, at: 0 }, { ran: 'pass', test: 'npm test', counts: { passed: 1, failed: 0, skipped: 0 }, ms: 0, on: 'main', at: 0, look: noApp }); assert.ok(m.ms > 0)
  const out = (await hq.api(`docs?scope=${encodeURIComponent(`ticket:${t1.id}`)}`)).json.find((d: any) => d.key === 'merge_test_output')
  assert.match(out.text, /ℹ pass 1/)
  const heard = (await hq.state()).messages.find((x: any) => x.to_id === p.tpm.id && x.body.startsWith(`HQ: ${t1.key} merged.`))
  assert.match(heard.body, new RegExp(`^HQ: ${t1.key} merged\\. HQ's tests passed on main first \\(\`npm test\`: 1 passed, (\\d+|under 1) s\\)\\.`))
  const review = (await hq.state()).reviews.find((r: any) => r.ticket_id === t1.id); assert.equal(review.closed_reason, 'approve'); assert.match(review.plan_text ?? `Plan for ${t1.key}`, /Plan for/)
  await waitFor('the first engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id)?.status === 'exited')
  await turnEnds(p) // the TPM heard the merge and answered
  const e2 = await engineer(t2); await work(p, t2, e2, { 'invoices.txt': 's\n' })
  await until(t2, 'merged')
  await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`${t1.key}: Orders \\(tests passed: 1 passed, (\\d+|under 1) s\\)`))
  assert.match(r.summary, new RegExp(`${t2.key}: Invoices`)); assert.ok(r.start_sha && r.end_sha && r.start_sha !== r.end_sha)
  assert.doesNotMatch(r.summary, /Worth a look|app/) // nothing to open here, and that isn't news for every ticket
  assert.equal(fs.existsSync(path.join(hq.home, 'fake-checks.jsonl')), false, 'tickets with no criteria: no reader was asked anything')
  assert.ok((await hq.state()).attention.some((a: any) => a.kind === `auto_finished:${p.repo.id}`))
  assert.equal(sh(p.dir, 'status', '--porcelain'), ''); assert.equal(sh(p.dir, 'worktree', 'list').split('\n').filter((l) => l.includes('hq-test')).length, 0)
})

test('Bug 105: the request that asked to leave plan mode is reported after HQ approved the plan, and no model alarm is raised', async () => {
  const p = await project('late'), OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5'
  const t = (await hq.api('tickets', { featureId: p.f.id, title: 'Reports', size: 'M', spec: 'Reports.' })).json // M: it plans on one model and builds on another
  await turnEnds(p); const e = await engineer(t); assert.equal(e.model_alias, 'opusplan')
  const step = (model: string, tools: string[]) => hq.modEvent(e.id, { kind: 'turn.step', model, agentId: null, usageModel: model, tools }) // one request, as the mod reports it
  const alarms = async () => (await hq.state()).attention.filter((a: any) => a.agent_id === e.id && a.kind.startsWith('model_')).map((a: any) => a.detail)
  await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, permission_mode: 'plan' }); await step(OPUS, ['Read'])
  // The order Claude Code sent these in each time the alarm was false: the call's hooks, HQ's approval, and only then the request that made the call
  await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: `Plan for ${t.key}` }, permission_mode: 'plan' })
  assert.equal((await hq.hook(e.id, exitPlanMode(`Plan for ${t.key}`))).hookSpecificOutput.decision.behavior, 'allow')
  await step(OPUS, ['Write', 'ExitPlanMode'])
  await hq.hook(e.id, { hook_event_name: 'PostModelSwitch', from_model: OPUS, to_model: SONNET, source: 'auto', requested_model: null })
  await hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_response: { plan: 'x' }, permission_mode: 'acceptEdits' })
  await step(SONNET, ['Edit'])
  const s = await hq.state(); assert.deepEqual(await alarms(), []); assert.deepEqual(s.settings.paused_roles ?? [], [])
  assert.equal(s.agents.find((a: any) => a.id === e.id).model_live, SONNET)
  await step(OPUS, ['Edit']) // building on the planning model is still an alarm
  assert.deepEqual(await alarms(), [`engineer ${e.id}: main-loop request on ${OPUS}, expected sonnet`])
})
test('Bug 141: an engineer set to haiku plans on Sonnet and builds on Haiku, with no model alarm, and the next engineer still starts', async () => {
  const p = await project('cheap'), SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5'
  const models = { tpm: 'opus', architect: 'opus', engineer_s: 'haiku', engineer_ml: 'opusplan', launcher: 'sonnet', tester: 'sonnet' } // S tickets on haiku
  assert.equal((await hq.api('settings', { key: 'models', value: models })).status, 200)
  const t = await ticket(p, 'Labels'); await turnEnds(p); const e = await engineer(t); assert.equal(e.model_alias, 'haiku')
  const step = (model: string, tools: string[]) => hq.modEvent(e.id, { kind: 'turn.step', model, agentId: null, usageModel: model, tools })
  const alarms = async () => (await hq.state()).attention.filter((a: any) => a.kind.startsWith('model_')).map((a: any) => a.detail)
  // What the real 2.1.322 sent for `--model haiku --permission-mode plan` (a throwaway spike): every planning request on Sonnet,
  // the plan allowed, then a switch to Haiku of its own (source auto) 20 ms later, and every request after that on Haiku
  await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, permission_mode: 'plan' }); await step(SONNET, ['Read'])
  await hq.hook(e.id, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: `Plan for ${t.key}` }, permission_mode: 'plan' })
  await step(SONNET, ['ExitPlanMode'])
  assert.equal((await hq.hook(e.id, exitPlanMode(`Plan for ${t.key}`))).hookSpecificOutput.decision.behavior, 'allow')
  await hq.hook(e.id, { hook_event_name: 'PostModelSwitch', from_model: SONNET, to_model: HAIKU, source: 'auto', requested_model: null })
  await hq.hook(e.id, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_response: { plan: 'x' }, permission_mode: 'acceptEdits' })
  await step(HAIKU, ['Edit'])
  const s = await hq.state(); assert.deepEqual(await alarms(), []); assert.deepEqual(s.settings.paused_roles ?? [], [])
  assert.equal(s.agents.find((a: any) => a.id === e.id).model_live, HAIKU)
  const t2 = await ticket(p, 'Badges'); await turnEnds(p); const e2 = await engineer(t2) // the engineer role isn't paused: the next ticket gets one
  assert.equal(e2.model_alias, 'haiku')
  // Any other switch Claude Code makes by itself still pauses the role: here the first engineer goes back to Sonnet while it builds
  await hq.hook(e.id, { hook_event_name: 'PostModelSwitch', from_model: HAIKU, to_model: SONNET, source: 'auto', requested_model: null })
  assert.deepEqual(await alarms(), [`engineer ${e.id}: model switched ${HAIKU} → ${SONNET} (source auto); role paused`])
  assert.deepEqual((await hq.state()).settings.paused_roles, ['engineer'])
})
test('tickets that pass alone but fail together go back to their engineer, and the fix merges', async () => {
  const p = await project('mismatch')
  const t1 = await ticket(p, 'Server'), t2 = await ticket(p, 'Screen'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2)
  await work(p, t2, e2, { 'screen.js': "exports.read=(i)=>i.expiresOn\n",
    'test/join.test.js': "const t=require('node:test'),a=require('node:assert'),fs=require('fs');t.test('join',()=>{if(!fs.existsSync(__dirname+'/../items.js'))return;"
      + "a.equal(require('../screen').read(require('../items').item()),'2027')})\n" })
  await until(t2, 'merged') // alone it passes: no server yet
  await turnEnds(p)
  await work(p, t1, e1, { 'items.js': "exports.item=()=>({expiryDate:'2027'})\n" })
  await until(t1, 'resolving')
  const told = await waitFor('HQ to tell the engineer', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e1.id && /fails its tests/.test(m.body)))
  assert.match(told.body, /join/); assert.equal(fs.readFileSync(path.join(p.dir, 'version.txt'), 'utf8'), 'v1\n')
  sh(wt(p, t1), 'merge', '--no-edit', 'main'); fs.writeFileSync(path.join(wt(p, t1), 'items.js'), "exports.item=()=>({expiresOn:'2027'})\n"); sh(wt(p, t1), 'add', '.');
    sh(wt(p, t1), 'commit', '-qm', 'same name'); await openPr(e1)
  await until(t1, 'merged')
  assert.equal((await tk(t1)).auto_tries, 1)
})

test('Bug 84: a ticket sent back for its tests says so, and an engineer that takes over gets what they printed, not conflict instructions', async () => {
  const p = await project('testsback')
  const t1 = await ticket(p, 'Server'), t2 = await ticket(p, 'Screen'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2)
  await work(p, t2, e2, { 'screen.js': "exports.read=(i)=>i.expiresOn\n",
    'test/join.test.js': "const t=require('node:test'),a=require('node:assert'),fs=require('fs');t.test('join',()=>{if(!fs.existsSync(__dirname+'/../items.js'))return;"
      + "a.equal(require('../screen').read(require('../items').item()),'2027')})\n" })
  await until(t2, 'merged'); await turnEnds(p)
  await work(p, t1, e1, { 'items.js': "exports.item=()=>({expiryDate:'2027'})\n" })
  await until(t1, 'resolving'); assert.equal((await tk(t1)).fixing, 'tests')
  await hq.api(`agents/${e1.id}/stop`, {}) // gone before it fixed them: auto mode starts another
  const e3 = await engineer(t1, e1.id)
  assert.match(prompt(e3.id), /It was fixing its tests on main; HQ's instructions for that are below\.[\s\S]*fails its tests[\s\S]*join/)
  assert.doesNotMatch(prompt(e3.id), /conflict/i); assert.equal((await tk(t1)).fixing, 'tests')
  assert.deepEqual(await cameBack(e1.id), [`${t1.key} came back: its tests fail`]) // Bug 206
  sh(wt(p, t1), 'merge', '--no-edit', 'main'); fs.writeFileSync(path.join(wt(p, t1), 'items.js'), "exports.item=()=>({expiresOn:'2027'})\n"); sh(wt(p, t1), 'add', '.')
  sh(wt(p, t1), 'commit', '-qm', 'same name'); await openPr(e3)
  await until(t1, 'merged'); assert.equal((await tk(t1)).fixing, null)
  const aboutIt = (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === p.tpm.id && m.body.includes(t1.key)).map((m: any) => m.body).join('\n')
  assert.doesNotMatch(aboutIt, /conflict/i, aboutIt)
})

test('a ticket that can\'t be fixed is parked and the others carry on; what waits on it is listed; Try again gives it another go', async () => {
  const p = await project('park')
  const bad = await ticket(p, 'Broken'), good = await ticket(p, 'Fine'), behind = await ticket(p, 'After broken', [bad.key]); await turnEnds(p)
  const eb = await engineer(bad), eg = await engineer(good)
  await work(p, bad, eb, { 'test/bad.test.js': "require('node:test').test('bad',()=>{throw new Error('nope')})\n" })
  for (let i = 0; i < 2; i++) { await until(bad, 'resolving'); await hq.modNext(eb.id).catch(() => {}); await openPr(eb) }
  const parked = await waitFor('the ticket to park', async () => (await tk(bad))?.auto_parked_why)
  assert.match(parked, /still fail/); assert.ok((await hq.state()).attention.some((a: any) => a.kind === 'auto_parked' && a.ticket_id === bad.id))
  await work(p, good, eg, { 'fine.txt': 'ok\n' }); await until(good, 'merged'); await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, /Parked, needs you/); assert.match(r.summary, new RegExp(`${behind.key}: After broken`)); assert.equal((await tk(behind)).status, 'queued')
  assert.equal((await hq.api(`tickets/${bad.id}/auto-retry`, {})).status, 200)
  await until(bad, 'resolving') // tested again, sent back again
})

const BROKEN = "require('node:test').test('main',()=>{throw new Error('main is broken')})\n"
/** Someone commits a failing test straight to main. */
const breakMain = (p: P, name = 'main'): void => {
  fs.writeFileSync(path.join(p.dir, 'test', `${name}.test.js`), BROKEN); sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', `break ${name}`)
}
const repairs = async (p: P): Promise<any[]> => { const fs0 = (await hq.state()).features.filter((f: any) => f.repo_id === p.repo.id).map((f: any) => f.id)
  return (await hq.state()).tickets.filter((t: any) => t.repairs_main && fs0.includes(t.feature_id)).sort((x: any, y: any) => x.created_at - y.created_at) }
const repair = (p: P, n = 1) => waitFor(`repair ${n}`, async () => (await repairs(p))[n - 1])
/** What Claude Code's hook says of a Bash command once it's over. With no `error` it ran; "Exit code N" ran and failed; any other error is a refusal. */
const bash = (e: any, command: string, error?: string) => hq.hook(e.id, { hook_event_name: error ? 'PostToolUseFailure' : 'PostToolUse', tool_name: 'Bash',
  tool_input: { command }, ...(error ? { error } : { tool_response: { stdout: '', stderr: '' } }) })
/** A repair engineer runs its new test command, as it must (Bug 83), then proposes it. */
const propose = async (e: any, command: string, left_out: string) => { await bash(e, command); return hq.mcp(e.id, 'propose_test_command', { command, left_out }) }

test('a broken main repairs itself: HQ opens the ticket, others keep building, nothing else merges until it is in, then everything lands', async () => {
  const p = await project('broken')
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p)
  assert.equal((await repoNow(p)).auto_stopped_why, null, 'it does not stop')
  assert.match(await waitFor('the note', async () => (await repoNow(p)).auto_waiting), /Fixing main's tests \(.+\)\. Nothing merges/)
  assert.equal((await tk(t1)).status, 'pr_ready'); assert.equal((await tk(t1)).auto_tries, 0, 'not the ticket\'s fault')
  assert.match(r.spec, /main is broken/); assert.match(r.spec, /Reach the internet/); assert.equal(r.repairs_main, sh(p.dir, 'rev-parse', 'main'))
  const toTpm = await waitFor('the TPM to hear', async () => (await hq.state()).messages.find((m: any) => m.to_id === p.tpm.id && /opened .+ to repair/.test(m.body)))
  assert.match(toTpm.body, /Don't open another/)
  await work(p, t2, e2, { 'two.txt': '2\n' }); await looked() // finished during the repair: it waits, and it isn't blamed
  assert.equal((await tk(t2)).status, 'pr_ready'); assert.equal((await tk(t2)).auto_tries, 0); assert.equal((await repairs(p)).length, 1, 'one repair for one broken main')
  const er = await engineer(r); await work(p, r, er, { 'test/main.test.js': PASS })
  await until(r, 'merged'); await until(t1, 'merged'); await until(t2, 'merged')
  assert.equal((await repoNow(p)).auto_waiting, null); assert.equal((await tk(r)).auto_tries, 0); await turnEnds(p)
  await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
})

test('Bug 108: what the TPM writes for HQ\'s repair ticket goes under HQ\'s spec, never in its place', async () => {
  const p = await project('kept', { auto: false }); breakMain(p)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const shelf = await ticket(p, 'Shelf'), r = await repair(p), under = /^Added to .+ as "From the TPM", under HQ's own spec, which stays as it is/
  const spec = (t: any, a: { spec?: string; title?: string; user_asked?: boolean }) => hq.mcp(p.tpm.id, 'update_ticket_spec', { key: t.key, ...a })
  const tpmPart = async () => { const s: string = (await tk(r)).spec; assert.ok(s.startsWith(`${r.spec}\n\n## From the TPM\n`), s.slice(-300)); return s.slice(r.spec.length) }
  const toTpm = await waitFor('the TPM to hear', async () => (await hq.state()).messages.find((m: any) => m.to_id === p.tpm.id && /opened .+ to repair/.test(m.body)))
  assert.match(toTpm.body, /Its spec is HQ's and stays as it is/)
  // Nobody is on it yet. A whole new spec and a new title: HQ's spec and title stay, and the TPM hears what became of each
  const first = await spec(r, { spec: '## What\nOnly the offline tests matter to the user.', title: 'Mine now' }); assert.equal(first.isError, false, first.text)
  assert.match(first.text, under); assert.match(first.text, /and so does its title\. It takes the place of anything you added before\. Nobody has started on .+ yet; its engineer gets it/)
  assert.match(await tpmPart(), /HQ's steps and rules above still hold\.\n\n## What\nOnly the offline tests matter to the user\.$/); assert.equal((await tk(r)).title, r.title)
  // A title alone, or nothing to add: refused, and nothing changes
  for (const a of [{ title: 'Mine now' }, { spec: '  ' }]) { const no = await spec(r, a); assert.equal(no.isError, true); assert.match(no.text, /its spec and title stay/) }
  assert.equal((await tk(r)).title, r.title); assert.match(await tpmPart(), /offline tests/)
  // The TPM's own ticket is still the TPM's to rewrite
  assert.equal((await spec(shelf, { spec: 'A pine shelf.', title: 'Pine shelf' })).text, `Updated. Nobody has started on ${shelf.key} yet; its engineer gets the new spec and title when it starts.`)
  assert.deepEqual([(await tk(shelf)).title, (await tk(shelf)).spec], ['Pine shelf', 'A pine shelf.'])
  // The repair's engineer starts with both parts
  await turnEnds(p); const er = await engineer(r)
  assert.match(prompt(er.id), /Don't delete or weaken a test/); assert.match(prompt(er.id), /## From the TPM\n.+\n\n## What\nOnly the offline tests/)
  // A second text takes the place of the first, and only of that; the engineer on the ticket is told where to look
  const second = await spec(r, { spec: 'Leave the date tests alone.' }); assert.match(second.text, under); assert.match(second.text, /added before\.$/)
  const part = await tpmPart(); assert.ok(part.endsWith('\n\nLeave the date tests alone.')); assert.ok(!part.includes('offline')); assert.equal(part.split('## From the TPM').length, 2)
  await waitFor('the engineer to be told', async () => (await hq.state()).messages.find((m: any) => m.to_id === er.id && /^HQ: the TPM added to .+ spec, under "From the TPM"/.test(m.body)))
  // Bug 168: the same text again changes nothing, and the engineer isn't told twice
  const toEr = async () => (await hq.state()).messages.filter((m: any) => m.to_id === er.id && /^HQ: the TPM added to/.test(m.body)).length
  assert.equal(await toEr(), 1); assert.equal((await spec(r, { spec: ' Leave the date tests alone.\n' })).text, `${r.key} already says that: nothing changed.`)
  assert.equal(await toEr(), 1); assert.ok((await tpmPart()).endsWith('\n\nLeave the date tests alone.'))
  const got = (await hq.mcp(er.id, 'get_ticket')).text; assert.match(got, /Reach the internet/); assert.match(got, /Leave the date tests alone\.\n\n## Handoff so far/)
  // Finished and not merged yet (auto is off by then): it goes back to its engineer for the TPM's text, HQ's spec still on top
  assert.equal((await hq.hook(er.id, exitPlanMode('Plan'))).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  fs.writeFileSync(path.join(wt(p, r), 'test', 'main.test.js'), PASS); sh(wt(p, r), 'add', '.'); sh(wt(p, r), 'commit', '-qm', 'fix'); await openPr(er); await until(r, 'pr_ready')
  const late = await spec(r, { spec: 'Keep the slow test too.', user_asked: true }); assert.equal(late.isError, false, late.text)
  assert.match(late.text, under); assert.match(late.text, new RegExp(`added before\\. ${r.key} was already finished, so HQ told its engineer \\(${er.id}\\) to build the change\\.`))
  assert.equal((await tk(r)).status, 'resolving'); assert.ok((await tpmPart()).endsWith('\n\nKeep the slow test too.'))
})

const checks = async () => ((await hq.api('events?limit=500')).json as any[]).filter((e) => e.kind === 'auto.main_checked').map((e) => JSON.parse(e.payload))
test('Bug 70: a run tests main as it starts, so a broken main opens its repair before any ticket finishes', async () => {
  const p = await project('early', { auto: false }); breakMain(p)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const t1 = await ticket(p, 'One'), r = await repair(p)
  assert.notEqual((await tk(t1)).status, 'pr_ready'); assert.equal((await repoNow(p)).auto_stopped_why, null); assert.match(r.spec, /main's own tests fail/)
  assert.equal((await checks()).at(-1).result, 'fail')
  await hq.hook(p.tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Split done.' })
  const er = await engineer(r); assert.equal((await repairs(p)).length, 1); await work(p, r, er, { 'test/main.test.js': PASS }); await until(r, 'merged')
  const e1 = await engineer(t1); await work(p, t1, e1, { 'one.txt': '1\n' }); await until(t1, 'merged')
  assert.equal((await repairs(p)).length, 1, 'one repair, however many tickets'); assert.equal((await checks()).length, 1, 'once per run')
})

test('Bug 70: a healthy main is checked once, and a restart doesn\'t check it again', async () => {
  const p = await project('healthy'), t1 = await ticket(p, 'One'); await turnEnds(p)
  const c = await waitFor('the check', async () => (await checks())[0]); assert.equal(c.result, 'pass')
  const run0 = await waitFor('the run to record it', async () => (await runs(p)).find((r: any) => r.main_checked)); assert.equal(run0.main_checked, sh(p.dir, 'rev-parse', 'main'))
  await engineer(t1); await hq.restart(); await looked()
  assert.equal((await checks()).length, 1); assert.deepEqual(await repairs(p), [])
})

test('Bug 273: HQ\'s own runs give the tests a PORT of their own, never an engineer\'s, so a server on `$PORT || <taken port>` passes; after a restart too', async () => {
  const taken = net.createServer(); await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r)) // the user's app, another HQ's run
  const held = (taken.address() as net.AddressInfo).port
  try {
    const p = await project('ports', { auto: false })
    fs.writeFileSync(path.join(p.dir, 'srv.js'), `const fs = require('fs'), s = require('http').createServer((q, r) => r.end('ok'))
s.on('error', (e) => { console.error('server: ' + e.message); process.exit(1) })
s.listen(Number(process.env.PORT || ${held}), '127.0.0.1', () => { fs.writeFileSync('port.txt', JSON.stringify([process.env.PORT, process.env.HQ_PORT_BASE, process.env.DB_NAME]))
  const t = setInterval(() => { if (fs.existsSync('go')) { clearInterval(t); s.close(); console.log('served') } }, 100) })\n`)
    sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'server test')
    assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'node srv.js' })).status, 200)
    assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
    const w = slotWindow(hq.ports.ui), inWindow = (n: number) => n >= w[0] && n + 9 <= w[1] && (n - w[0]) % 10 === 0
    const dir = path.join(p.dir, '.claude', 'worktrees')
    /** What the held run's server was told, once it listens; the file goes, so the next run's is new. */
    const told = () => waitFor('the run\'s server', () => {
      const d = fs.existsSync(dir) ? fs.readdirSync(dir).find((x) => x.startsWith('hq-test-') && fs.existsSync(path.join(dir, x, 'port.txt'))) : undefined
      if (!d) return null
      const f = path.join(dir, d, 'port.txt'), [port, base, db] = JSON.parse(fs.readFileSync(f, 'utf8')) as string[]; fs.rmSync(f); return { port: Number(port), base, db }
    }, 20_000)
    const engPort = (id: string) => Number(/export PORT='(\d+)'/.exec(fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'launch.sh'), 'utf8'))?.[1])
    const t1 = await ticket(p, 'One'); await turnEnds(p)
    const main = await told(), e1 = await engineer(t1) // main's own check, while the engineer works
    assert.ok(inWindow(main.port), `${main.port} in ${w}`); assert.notEqual(main.port, held)
    assert.deepEqual([main.base, main.db], [String(main.port), `hq_test_${main.port}`]); assert.notEqual(main.port, engPort(e1.id), 'never the engineer\'s block')
    await letGo(p); await waitFor('the check', async () => (await checks())[0]); assert.equal((await checks())[0].result, 'pass')
    await work(p, t1, e1, { 'one.txt': '1\n' })
    const first = await told(); assert.ok(inWindow(first.port)); assert.notEqual(first.port, held)
    await hq.restart() // mid-run: the run is killed, and the block isn't lost with it
    const again = await told(); assert.ok(inWindow(again.port)); assert.notEqual(again.port, held)
    await letGo(p); await until(t1, 'merged', 30_000)
    assert.equal(JSON.parse((await tk(t1)).merge_test).ran, 'pass')
    const out = (await hq.api(`docs?scope=${encodeURIComponent(`ticket:${t1.id}`)}`)).json.find((d: any) => d.key === 'merge_test_output'); assert.match(out.text, /served/)
    assert.equal(((await hq.api('events?limit=500')).json as any[]).filter((e) => e.kind === 'testrun.no_ports').length, 0)
  } finally { taken.close() }
})

test('Bug 70: no tests stays quiet at the start of a run: the first ticket often adds them', async () => {
  const p = await project('notests', { tests: false }), t1 = await ticket(p, 'One'); await turnEnds(p); await engineer(t1)
  const c = await waitFor('the check', async () => (await checks())[0]); assert.equal(c.result, 'no_tests')
  assert.equal((await repoNow(p)).auto_waiting, null); assert.equal((await repoNow(p)).auto_stopped_why, null); assert.deepEqual(await repairs(p), [])
})

test('Bug 70: one flaky failure opens no repair: the check runs twice before it does', async () => {
  const p = await project('flaky', { auto: false })
  // Fails once, then passes. The marker sits in the package cache: the one folder two sandboxed runs share, on a Mac and on Linux (whose runs get a /tmp of their own).
  fs.writeFileSync(path.join(p.dir, 'test', 'flaky.test.js'), `const fs = require('node:fs'), f = process.env.npm_config_cache + '-flaky-' + ${JSON.stringify(path.basename(hq.root))}
require('node:test').test('sometimes', () => { if (fs.existsSync(f)) fs.unlinkSync(f); else { fs.writeFileSync(f, 'x'); throw new Error('flaked') } })\n`)
  sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'a flaky test')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200); const t1 = await ticket(p, 'One'); await turnEnds(p)
  const c = await waitFor('the check', async () => (await checks())[0], 15_000); assert.equal(c.result, 'pass'); assert.deepEqual(await repairs(p), []); assert.ok(t1)
})

test('Bug 70: a repair already open isn\'t opened twice, and a repair goes past the parallel limit', async () => {
  await hq.api('settings', { key: 'concurrency_cap', value: 1 })
  const p = await project('full', { auto: false }), t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'); breakMain(p)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200); await turnEnds(p); await engineer(t1)
  const r = await repair(p), er = await engineer(r) // one engineer is busy and the limit is one, and the repair starts anyway
  assert.equal((await tk(t2)).status, 'queued', 'an ordinary ticket still waits for a slot'); assert.ok(er)
  await looked(); assert.equal((await repairs(p)).length, 1)
})

test('Bug 62: a TPM that has gone can\'t stop the project again on Resume with its old dialog alert', async () => {
  const p = await project('gone'); await ticket(p, 'One')
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why)
  await hq.api(`agents/${p.tpm.id}/stop`, {}) // its session is over, and its dialog with it
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-resume`, {})).status, 200); await looked()
  assert.equal((await repoNow(p)).auto_stopped_why, null)
})

// Bug 246: while auto mode is stopped the user starts and merges tickets from the board until Resume (Bug 193), so that is what HQ tells the TPM, the engineer
// and the user. Then Resume: HQ starts and merges again, and says so.
test('Bug 246: while auto mode is stopped, a finished ticket and a merge are told as the user\'s to move on; after Resume, HQ\'s again', async () => {
  const p = await project('stopwords'), t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two', ['T-01']), t3 = await ticket(p, 'Three', ['T-02'])
  await turnEnds(p); const e1 = await engineer(t1)
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why)
  const toTpm = async (): Promise<string[]> => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === p.tpm.id).map((m: any) => m.body) // newest first
  const before = (await toTpm()).length
  assert.equal((await hq.hook(e1.id, exitPlanMode('Plan for T-01'))).hookSpecificOutput.decision.behavior, 'allow', 'plans are still approved while stopped')
  fs.writeFileSync(path.join(wt(p, t1), 'one.txt'), '1\n'); sh(wt(p, t1), 'add', '.'); sh(wt(p, t1), 'commit', '-qm', 'one')
  await ranTests(e1); await hq.mcp(e1.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e1.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone\n\n## Tests left out\nNothing', feature_map_unchanged: true })
  const branch = (await tk(t1)).branch
  assert.equal(r.text, `Done. The user merges ${branch} into main from HQ. You're done: stop now.`)
  assert.equal((await toTpm())[0], `HQ: T-01 is finished (${branch}). The user merges it into main from HQ; you'll be told when it merges.`)
  assert.equal((await hq.api(`tickets/${t1.id}/merge`, {})).status, 200) // the board's Merge into main, while stopped
  await until(t1, 'merged')
  const merged = await waitFor('the TPM told of the merge', async () => (await toTpm()).find((b) => b.startsWith('HQ: T-01 merged.')))
  assert.equal(merged, 'HQ: T-01 merged. The user merged it with Merge, which runs no tests: HQ did not test it as it merged. Ready now: T-02. The user starts them from HQ.')
  const notice = async () => (await hq.state()).attention.find((a: any) => a.kind === 'merged' && a.ticket_id === t1.id && !a.resolved_at)
  assert.match((await notice())?.detail ?? '',
    /Ready now: T-02\. Start it with Start under Your turn, or Launch engineer on its box\. Or press Resume on the "Auto mode stopped" bar and HQ starts it\.$/,
    'the user hears it too, as on the board, with the buttons\' names (Bug 264)')
  const stopped = (await toTpm()).slice(0, (await toTpm()).length - before)
  assert.ok(!stopped.some((b) => /HQ (tests|starts|merges)/.test(b)), stopped.join('\n'))
  // Resume: the dialog is seen to, and HQ starts T-02 by itself; its merge is HQ's, and the TPM hears that HQ starts what is ready next
  for (const a of (await hq.state()).attention.filter((x: any) => x.kind === 'dialog' && !x.resolved_at)) await hq.api(`attention/${a.id}/resolve`, {})
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-resume`, {})).status, 200); await turnEnds(p) // its turn after the dialog ends
  const e2 = await engineer(t2); await waitFor('the "Ready now" notice to go', async () => !(await notice()))
  await work(p, t2, e2, { 'two.txt': '2\n' })
  assert.equal((await toTpm()).find((b) => b.startsWith('HQ: T-02 is finished')), `HQ: T-02 is finished (${(await tk(t2)).branch}). HQ tests it on main and merges it; you'll be told when it merges.`)
  await until(t2, 'merged', 30_000)
  assert.match(await waitFor('the TPM told of the merge', async () => (await toTpm()).find((b) => b.startsWith('HQ: T-02 merged.'))), /Ready now: T-03\. HQ starts them\.$/)
  await engineer(t3)
})
// Bug 279: the TPM's last word was "Nothing new starts or merges until the user resumes it" until a merge came, as Resume told it nothing
test('Bug 279: Resume tells the TPM once that auto mode is running again; a second press, or nothing to resume, says nothing', async () => {
  const p = await project('resumed'), t = await ticket(p, 'One'), repo = p.repo.id
  const toTpm = async (): Promise<string[]> => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === p.tpm.id).map((m: any) => m.body) // newest first
  const resumed = async () => (await toTpm()).filter((b) => b.startsWith('HQ: the user resumed auto mode'))
  const NOTE = "HQ: the user resumed auto mode, so it's running again. From now on HQ starts ready tickets when your turn ends, approves plans, tests finished tickets on main, "
    + 'merges them and fixes conflicts. Finish each split before you end your turn. If what stopped it is still there, it stops again and HQ tells you.'
  const resume = async () => assert.equal((await hq.api(`repos/${repo}/auto-resume`, {})).status, 200)
  await resume(); assert.deepEqual(await resumed(), [], 'nothing was stopped')
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why)
  assert.match((await toTpm())[0], /^HQ: auto mode stopped: The TPM needs you: .*Nothing new starts or merges until the user resumes it\.$/)
  // Resume with the dialog still open: the note, then HQ looks again and stops again, and the TPM's last word says so
  const stops = (await toTpm()).filter((b) => b.startsWith('HQ: auto mode stopped')).length
  await resume(); await waitFor('the second stop', async () => (await toTpm()).filter((b) => b.startsWith('HQ: auto mode stopped')).length > stops)
  assert.deepEqual(await resumed(), [NOTE]); assert.match((await toTpm())[0], /^HQ: auto mode stopped: The TPM needs you/)
  // the dialog seen to, Resume pressed twice at once: one note, and HQ starts the ticket by itself again
  for (const a of (await hq.state()).attention.filter((x: any) => x.kind === 'dialog' && !x.resolved_at)) await hq.api(`attention/${a.id}/resolve`, {})
  await Promise.all([resume(), resume()]); await turnEnds(p); await engineer(t)
  assert.equal((await repoNow(p)).auto_stopped_why, null); assert.deepEqual(await resumed(), [NOTE, NOTE])
  const said = await toTpm(); assert.ok(said.indexOf(NOTE) < said.findIndex((b) => b.startsWith('HQ: auto mode stopped')), 'its last word on the mode: running again')
  await resume(); assert.deepEqual(await resumed(), [NOTE, NOTE], 'nothing to resume a second time')
  // off and on again: the switch's own two notes, no Resume note
  assert.equal((await hq.api(`repos/${repo}/auto`, { on: false })).status, 200); assert.equal((await hq.api(`repos/${repo}/auto`, { on: true })).status, 200)
  const two = (await toTpm()).slice(0, 2).sort() // the same millisecond can't order them
  assert.match(two[0]!, /^HQ: the user turned auto mode off\./); assert.match(two[1]!, /^HQ: the user turned auto mode on for this project\. From now on /)
  await resume(); assert.deepEqual(await resumed(), [NOTE, NOTE])
})
test('Bug 114: a stuck alert left on a finished ticket\'s engineer that has stopped doesn\'t get it replaced when auto goes on', async () => {
  const p = await project('stale-stuck', { auto: false }); const t = await ticket(p, 'One'); await turnEnds(p)
  await hq.api(`tickets/${t.id}/launch`, {}); const e = await engineer(t)
  const held = hq.hook(e.id, exitPlanMode(`Plan for ${t.key}`)) // auto is off: the user approves the plan
  const rv = await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  await hq.api(`reviews/${rv.id}/answer`, { verdict: 'approve', by: 'user' }); await held
  fs.writeFileSync(path.join(wt(p, t), 'one.txt'), '1\n'); sh(wt(p, t), 'add', '.'); sh(wt(p, t), 'commit', '-qm', 'one'); await openPr(e)
  await hq.hook(e.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  await waitFor('the finished engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === e.id)?.status === 'exited', 8000)
  const db = hq.db() // an alert from before the fix: HQ now clears it as the engineer stops
  try {
    db.prepare("INSERT INTO needs_attention(id, agent_id, ticket_id, kind, detail, created_at) VALUES ('att-stale', ?, ?, 'stuck', 'eng: no events for 12 min', ?)").run(e.id, t.id, Date.now())
  } finally { db.close() }
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  await until(t, 'merged')
  assert.deepEqual((await hq.state()).agents.filter((a: any) => a.role === 'engineer' && a.ticket_id === t.id).map((a: any) => a.id), [e.id], 'no replacement engineer')
  assert.ok(!(await hq.state()).attention.some((a: any) => a.id === 'att-stale'))
})

test('Bug 62: a dialog answered before HQ looks again doesn\'t park the engineer or stop the project; one still open does', async () => {
  await hq.api('settings', { key: 'concurrency_cap', value: 3 })
  const p = await project('answered'), t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'), t3 = await ticket(p, 'Three'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2), e3 = await engineer(t3)
  const ask = (a: any, message: string) => hq.hook(a.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message })
  const parks = async (t: any, why: RegExp) => assert.match(await waitFor(`${t.key} to park`, async () => (await tk(t)).auto_parked_why), why)
  // Answered at once, and no hook says so. Bug 93: the answer goes in the session file before the alert, timed after it (as if
  // answered just after), because a look of HQ's between the alert and a rewrite of the file rightly sees the dialog still open.
  const later = Date.now() + 60_000
  await hq.session(e1.id, 'busy', later); await ask(e1, 'Allow this?')
  await hq.session(p.tpm.id, 'idle', later); await ask(p.tpm, 'Allow this too?')
  // A dialog still open parks its ticket as before, and is the proof that HQ looked, in place of a fixed wait. The look that parks t2
  // has the two answered notices too, and the one that parks t3 starts only once that look is over.
  await hq.session(e2.id, 'waiting'); await ask(e2, 'Allow that?'); await parks(t2, /Allow that\?/)
  await hq.session(e3.id, 'waiting'); await ask(e3, 'And that?'); await parks(t3, /And that\?/)
  assert.equal((await tk(t1)).auto_parked_why, null); assert.equal((await repoNow(p)).auto_stopped_why, null)
  // Nothing more on e1 here: a new dialog of e1's could land in the middle of a look, which can't be timed from here. That race
  // (Bug 117: a look parked t1 with the replaced notice's words) is covered step by step in src/readnotices.test.ts.
})

test('a repair that keeps failing stops the project with the reason, and Resume looks again', async () => {
  const p = await project('unfixable')
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r); await work(p, r, er, { 'nothing.txt': 'x\n' })
  for (let i = 0; i < 2; i++) { await until(r, 'resolving'); await hq.modNext(er.id).catch(() => {}); await openPr(er) }
  const why = await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why)
  assert.match(why, /couldn't repair the tests/); assert.match(why, /still fail/); assert.equal((await tk(t1)).status, 'pr_ready')
  assert.equal(fs.existsSync(path.join(p.dir, 'one.txt')), false, 'no untested code on main')
  const t3 = await ticket(p, 'Three'); await turnEnds(p); await looked(); assert.equal((await tk(t3)).status, 'queued', 'nothing new starts')
  fs.rmSync(path.join(p.dir, 'test', 'main.test.js')); sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'fix main')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-resume`, {})).status, 200)
  await until(t1, 'merged'); await engineer(t3)
})

test('a third broken main in one run stops and asks, instead of opening repairs forever', async () => {
  const p = await project('again')
  await ticket(p, 'Holds the run open'); await turnEnds(p); await waitFor('the run', async () => (await runs(p)).find((x: any) => x.status === 'running'))
  for (let i = 1; i <= 2; i++) {
    const t = await ticket(p, `Round ${i}`); await turnEnds(p)
    const e = await engineer(t); breakMain(p, `m${i}`); await work(p, t, e, { [`r${i}.txt`]: 'x\n' })
    const r = await repair(p, i), er = await engineer(r); await work(p, r, er, { [`test/m${i}.test.js`]: PASS })
    await until(r, 'merged'); await until(t, 'merged'); await turnEnds(p)
  }
  const t = await ticket(p, 'Round 3'); await turnEnds(p)
  const e = await engineer(t); breakMain(p, 'm3'); await work(p, t, e, { 'r3.txt': 'x\n' })
  const why = await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why)
  assert.match(why, /still fail after 2 repairs/); assert.equal((await repairs(p)).length, 2)
})

test('a restart mid-repair carries on: no second repair, and the repair still lands first', async () => {
  const p = await project('restart')
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r); await hq.restart(); await looked()
  assert.equal((await repairs(p)).length, 1); assert.equal((await tk(t1)).status, 'pr_ready'); assert.match((await repoNow(p)).auto_waiting, /Fixing/)
  await work(p, r, er, { 'test/main.test.js': PASS }); await until(r, 'merged'); await until(t1, 'merged')
})

test('a test command is the whole repair: HQ tries it, takes it on auto, closes the ticket and lists it in the summary', async () => {
  const p = await project('command')
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r)
  assert.equal((await hq.mcp(e1.id, 'propose_test_command', { command: 'true', left_out: 'all' })).isError, true, 'repair tickets only')
  assert.equal((await propose(er, 'node -e "process.exit(1)"', 'x')).isError, false)
  await waitFor('the refusal', async () => (await hq.state()).messages.find((m: any) => m.to_id === er.id && /didn't pass/.test(m.body)))
  assert.equal((await repoNow(p)).test_cmd, null, 'a failing command changes nothing')
  assert.equal((await propose(er, 'node --test test/ok.test.js', 'test/main.test.js')).isError, false)
  await waitFor('the new command', async () => (await repoNow(p)).test_cmd); await until(r, 'cancelled'); await until(t1, 'merged'); await turnEnds(p)
  const run = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(run.summary, /## Test command changed/); assert.match(run.summary, /node --test test\/ok\.test\.js/); assert.match(run.summary, /Left out: test\/main\.test\.js/)
})

test('Bug 83: a test command is taken only once Claude Code has let the repair engineer run it', async () => {
  const p = await project('ranfirst')
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r)
  const cmd = 'node --test $(ls test/ok.test.js)', ok = 'node --test test/ok.test.js' // both pass in HQ's /bin/sh; Claude Code refuses the first in an engineer's session
  const ask = (command: string) => hq.mcp(er.id, 'propose_test_command', { command, left_out: 'test/main.test.js' })
  const never = await ask(cmd); assert.equal(never.isError, true); assert.match(never.text, /hasn't seen that command run in your session/)
  await bash(er, cmd, `This session is isolated in the worktree ${wt(p, r)}, but this command runs node with a value computed at runtime (command output)`)
  assert.equal((await ask(cmd)).isError, true, 'Claude Code refused it: not a run')
  await bash(e1, cmd); assert.equal((await ask(cmd)).isError, true, "another ticket's engineer ran it, not this one")
  await bash(er, ok.replace('ok', 'other')); assert.equal((await ask(ok)).isError, true, 'it ran something else'); assert.equal((await ask('  ')).isError, true)
  assert.equal((await repoNow(p)).test_cmd, null)
  // What the check must let through: a run inside a longer line, one that ended in an error, and one from before a restart
  await bash(er, `npm run build;  ${ok} 2>&1 | tail -5`, 'Exit code 1\nnpm error Missing script: "build"'); await hq.restart()
  assert.equal((await ask(ok)).isError, false); await waitFor('the new command', async () => (await repoNow(p)).test_cmd === ok)
  await until(r, 'cancelled'); await until(t1, 'merged')
})

/** The test HQ's own database: what its events say, and state only an older HQ would have left there. */
function sql(query: string, ...args: (string | number)[]): any[] {
  const db = hq.db() // waits out HQ's write lock, as HQ's own connection does (Bug 158)
  try { const s = db.prepare(query); return /^select/i.test(query) ? s.all(...args) : (s.run(...args), []) } finally { db.close() }
}
const changes = (): any[] => sql("SELECT payload FROM events WHERE kind = 'auto.test_changed' ORDER BY id").map((e) => JSON.parse(e.payload))

test('Bug 109: proposing the command that is already saved changes nothing: the repair lands as code, and no change is recorded', async () => {
  const p = await project('samecmd'), cmd = 'node --test'
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd })).status, 200)
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r)
  const same = await hq.mcp(er.id, 'propose_test_command', { command: ' node  --test\n', left_out: 'nothing' }) // not run first: there's nothing for HQ to try
  assert.equal(same.isError, true); assert.match(same.text, /already the test command HQ runs.*commit that and call open_pr: HQ runs the command on main plus your branch/)
  assert.doesNotMatch(same.text, /HQ kept what you said/, '"nothing" left out: nothing to keep')
  assert.equal((await propose(er, cmd, 'nothing')).isError, true, 'having run it first makes no difference')
  await work(p, r, er, { 'test/main.test.js': PASS }); await until(r, 'merged'); await until(t1, 'merged'); await turnEnds(p) // what the command runs changed, not the command
  const run = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.equal(run.test_change, null); assert.doesNotMatch(run.summary, /Test command changed/); assert.deepEqual(changes(), []); assert.equal((await repoNow(p)).test_cmd, cmd)
  assert.doesNotMatch(run.summary, /Tests a repair left out/, 'Bug 142: "nothing", in the proposal and in the PR, is not listed')
  assert.equal((await hq.state()).messages.some((m: any) => m.to_id === er.id && /your test command/.test(m.body)), false, 'HQ tried nothing')
})

test('Bug 109: with none saved, the command HQ finds is the one it runs; and a change to the same command, recorded before the fix, takes nothing from the run', async () => {
  const p = await project('foundcmd')
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'); await turnEnds(p) // Two keeps the run open
  const e1 = await engineer(t1), e2 = await engineer(t2); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r); assert.equal((await hq.hook(er.id, exitPlanMode('Plan'))).hookSpecificOutput.decision.behavior, 'allow')
  const pkg = path.join(wt(p, r), 'package.json') // the repair changes what `npm test` runs, and proposes `npm test`
  fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace('"node --test"', '"node --test test/ok.test.js"'))
  const same = await propose(er, 'npm test', 'test/main.test.js'); assert.equal(same.isError, true); assert.match(same.text, /already the test command HQ runs/)
  sh(wt(p, r), 'add', '.'); sh(wt(p, r), 'commit', '-qm', 'npm test runs what can pass here'); await openPr(er); await until(r, 'merged'); await until(t1, 'merged')
  assert.equal((await repoNow(p)).test_cmd, null); assert.equal((await runs(p))[0].test_change, null); assert.deepEqual(changes(), [])
  // What an HQ from before the fix left on a run that's still open. It must not count as the run's one change, nor show in its summary.
  sql("UPDATE auto_runs SET test_change = ? WHERE repo_id = ? AND status = 'running'", JSON.stringify({ was: 'npm test', now: 'npm test', left_out: 'old record' }), p.repo.id)
  assert.match((await runs(p))[0].test_change, /old record/)
  for (const [f, text] of [['ok', BROKEN], ['fine', PASS]]) fs.writeFileSync(path.join(p.dir, 'test', `${f}.test.js`), text!)
  sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'break'); await work(p, t2, e2, { 'two.txt': '2\n' })
  const r2 = await repair(p, 2), er2 = await engineer(r2)
  assert.equal((await propose(er2, 'node --test test/fine.test.js', 'test/ok.test.js')).isError, false) // a different command: still taken
  await waitFor('the new command', async () => (await repoNow(p)).test_cmd === 'node --test test/fine.test.js')
  await until(r2, 'cancelled'); await until(t2, 'merged'); await turnEnds(p)
  const run = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.equal((await repoNow(p)).auto_stopped_why, null, 'not a second change')
  assert.match(run.summary, /## Test command changed\n- Was: `the one HQ found`\n- Now: `node --test test\/fine\.test\.js`\n- Left out: test\/ok\.test\.js/)
  assert.doesNotMatch(run.summary, /old record/); assert.deepEqual(changes().map((c) => [c.was, c.now]), [[null, 'node --test test/fine.test.js']])
})

test('Bug 142: a repair that keeps the command and changes what it runs: the summary names what it left out, in its proposal and its PR, after a restart too', async () => {
  const p = await project('leftout')
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r); assert.equal((await hq.hook(er.id, exitPlanMode('Plan'))).hookSpecificOutput.decision.behavior, 'allow')
  const pkg = path.join(wt(p, r), 'package.json') // npm test stops running test/main.test.js
  fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace('"node --test"', '"node --test test/ok.test.js"'))
  const same = await propose(er, 'npm test', 'test/main.test.js, which needs the internet')
  assert.equal(same.isError, true); assert.match(same.text, /already the test command HQ runs.*HQ kept what you said it leaves out.*"## Tests left out"/s)
  sh(wt(p, r), 'add', '.'); sh(wt(p, r), 'commit', '-qm', 'npm test runs what can pass here'); await hq.mcp(er.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  await hq.restart() // kept on the ticket, not in memory
  const bare = await hq.mcp(er.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true })
  assert.equal(bare.isError, true, 'a repair says what it left out'); assert.match(bare.text, /HQ's repair ticket.*"## Tests left out" section in the PR body/)
  const empty = await hq.mcp(er.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Tests left out\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true })
  assert.equal(empty.isError, true, 'an empty section says nothing')
  await openPr(er, 'test/main.test.js: it calls a real website.\n\n## Notes\n- npm test lists its files now')
  await until(r, 'merged'); await until(t1, 'merged'); await turnEnds(p)
  const run = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.equal(run.test_change, null); assert.deepEqual(changes(), []); assert.equal((await repoNow(p)).auto_stopped_why, null)
  const want = `## Tests a repair left out\n- ${r.key}, when it proposed \`npm test\`: test/main.test.js, which needs the internet\n`
    + `- ${r.key}, in its PR: test/main.test.js: it calls a real website.`
  assert.ok(run.summary.endsWith(want), run.summary); assert.doesNotMatch(run.summary, /## Notes/, 'the section ends at the next heading')
})

for (const auto of [true, false]) test(`Bug 109: the user saves the very command HQ is trying (auto ${auto ? 'on' : 'off'}): nothing to ask, record or tell twice`, async () => {
  const p = await project(`meanwhile${auto ? '' : 'off'}`)
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r); if (!auto) assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  // HQ's try of a proposal runs in a checkout named …-cmd: only there does this command wait, until the test lets it go
  const cmd = 'case "$PWD" in *-cmd) while [ ! -e go ]; do sleep 0.1; done;; esac; node --test test/ok.test.js', tried = path.join(p.dir, '.claude', 'worktrees', `hq-test-${r.key}-cmd`)
  assert.equal((await propose(er, cmd, 'test/main.test.js')).isError, false)
  await waitFor("HQ's try to start", () => fs.existsSync(path.join(tried, 'test', 'ok.test.js')), 15_000)
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd })).status, 200); fs.writeFileSync(path.join(tried, 'go'), '') // the user, in the Auto box, meanwhile
  const told = () => hq.state().then((s) => s.messages.filter((m: any) => m.from_id === 'hq' && m.to_id === e2.id && /full test run/.test(m.body)).length)
  if (auto) { await until(r, 'cancelled'); await until(t1, 'merged') } // the command was the whole repair
  else await waitFor('the engineer to hear', async () => (await hq.state()).messages.find((m: any) => m.to_id === er.id && /passed, and the user saved the same one meanwhile/.test(m.body)))
  assert.equal((await repoNow(p)).test_cmd, cmd); assert.equal((await repoNow(p)).test_cmd_proposed, null); assert.deepEqual(changes(), [])
  assert.equal((await hq.state()).attention.some((a: any) => a.kind === `test_cmd_proposed:${p.repo.id}`), false)
  assert.equal((await runs(p)).some((x: any) => x.test_change), false); assert.equal(await told(), 1, 'working engineers hear of the command once, from the save')
})

/** Claude Code's answer to a command it won't run in an engineer's worktree session: its hook's `error` on 2.1.322 for `node --test $(git ls-files test)`. */
const refusal = (worktree: string) => `This session is isolated in the worktree ${worktree}, but this command names git in a form too complex to verify that it stays inside the `
  + "worktree. Refusing to run it — a worktree-isolated session's git operations must target its own worktree. Split it into plain, separate commands and run them from "
  + `${worktree}.`
const cantRun = async (p: P): Promise<any[]> => (await hq.state()).attention.filter((a: any) => a.kind === `test_cmd_refused:${p.repo.id}`)
const refusedNow = async (p: P) => JSON.parse((await repoNow(p)).test_cmd_refused ?? 'null')
/** A command that passes in HQ's own sandbox (/bin/sh). It stands for one Claude Code refuses in an engineer's session: the tests say when it does. */
const HARD = 'node --test $(ls test/*.test.js)'
const setCmd = async (p: P, cmd: string) => assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd })).status, 200)

test('Bug 107: Claude Code refuses the saved test command for an engineer: HQ says so once, and on auto a repair ticket of HQ\'s fixes the command', async () => {
  const p = await project('refused'); await setCmd(p, HARD) // typed in the Auto box: no agent ever ran it
  const t1 = await ticket(p, 'One'); await turnEnds(p); const e1 = await engineer(t1), no = refusal(wt(p, t1))
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200) // off: its engineer carries on, and HQ opens no ticket by itself
  // What must not count: it ran and failed; a longer line (the here-document may be what was refused); another command; the TPM's own session
  await bash(e1, HARD, 'Exit code 1\n✖ a test failed'); await bash(e1, `cat > notes.txt <<'EOF'\nx\nEOF\n${HARD}`, no)
  await bash(e1, 'node --test $(ls test/ok.test.js)', no); await bash(p.tpm, HARD, refusal(p.dir))
  assert.deepEqual(await cantRun(p), []); assert.equal(await refusedNow(p), null)
  // The command itself, the way a real engineer ran it: from its worktree, with the time limit HQ tells engineers to add, its output cut down
  await bash(e1, `cd "${wt(p, t1)}" && ${HARD.replace('--test', '--test --test-force-exit --test-timeout=120000')} 2>&1 | tail -40`, no)
  const [first] = await cantRun(p); assert.match(first.detail, /engineers can't run this project's test command/); assert.ok(first.detail.includes(HARD))
  assert.deepEqual(await refusedNow(p), { cmd: HARD, why: no, by: t1.key })
  await bash(e1, HARD, no); await hq.restart(); await bash(e1, HARD, no)
  assert.deepEqual((await cantRun(p)).map((a) => a.id), [first.id], 'said once, also after a restart')
  // Another command in the Auto box: what HQ knew about the old one goes, and its notice. The old one back: HQ hasn't seen that refused since
  await setCmd(p, 'node --test'); assert.equal(await refusedNow(p), null); assert.deepEqual(await cantRun(p), [])
  await setCmd(p, HARD); assert.deepEqual(await cantRun(p), [])
  await bash(e1, HARD, no); const [second] = await cantRun(p); assert.notEqual(second.id, first.id)
  await hq.api(`attention/${second.id}/resolve`, {}); await bash(e1, HARD, no)
  assert.deepEqual(await cantRun(p), [], 'ticked away: it stays away'); assert.deepEqual(await repairs(p), [], 'auto mode is off')
  // Auto on: one repair ticket for the command, and nothing merges until it's in
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const r = await repair(p); assert.equal(r.repairs_cmd, HARD); assert.equal(r.title, 'Fix the test command')
  assert.match(r.spec, /Claude Code refuses this project's test command/); assert.ok(r.spec.includes(HARD)); assert.ok(r.spec.includes(no)); assert.match(r.spec, /propose_test_command/)
  assert.match(await waitFor('the note', async () => (await repoNow(p)).auto_waiting), /Fixing the test command \(.+\)\. Nothing merges/)
  const toTpm = await waitFor('the TPM to hear', async () => (await hq.state()).messages.find((m: any) => m.to_id === p.tpm.id && /opened .+ to fix the command/.test(m.body)))
  assert.match(toTpm.body, /Don't open another/); assert.equal((await refusedNow(p)).ticket, r.key)
  await work(p, t1, e1, { 'one.txt': '1\n' }); await looked(); assert.equal((await tk(t1)).status, 'pr_ready'); assert.equal((await repairs(p)).length, 1, 'one repair')
  // The repair: the line goes into an npm script on its branch, its engineer runs that and proposes it
  const er = await engineer(r); assert.equal((await hq.hook(er.id, exitPlanMode('Plan'))).hookSpecificOutput.decision.behavior, 'allow')
  const pkg = JSON.parse(fs.readFileSync(path.join(wt(p, r), 'package.json'), 'utf8')); pkg.scripts['test:hq'] = HARD
  fs.writeFileSync(path.join(wt(p, r), 'package.json'), JSON.stringify(pkg)); sh(wt(p, r), 'add', '.'); sh(wt(p, r), 'commit', '-qm', 'the tests as a script')
  await bash(er, HARD, refusal(wt(p, r))) // its first step: it sees the refusal itself. Nothing new to say
  assert.equal((await propose(er, 'npm run test:hq', 'nothing')).isError, false)
  await waitFor('the new command', async () => (await repoNow(p)).test_cmd === 'npm run test:hq')
  assert.equal(await refusedNow(p), null); assert.deepEqual(await cantRun(p), [])
  await openPr(er); await until(r, 'merged'); await until(t1, 'merged'); await turnEnds(p)
  const run = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(run.summary, /## Test command changed/); assert.match(run.summary, /Now: `npm run test:hq`/); assert.equal((await repairs(p)).length, 1)
})

test('Bug 107: a repair of the command that can\'t be done parks and the rest carries on; the command running after all clears what HQ knew', async () => {
  const p = await project('refusedpark'); await setCmd(p, HARD)
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'); await turnEnds(p); const e1 = await engineer(t1), e2 = await engineer(t2)
  await bash(e1, HARD, refusal(wt(p, t1)))
  const r = await repair(p), er = await engineer(r); assert.equal((await cantRun(p)).length, 1)
  assert.equal((await hq.mcp(er.id, 'report_blocked', { reason: 'No script can do this here.' })).isError, false)
  assert.match(await waitFor('the repair to park', async () => (await tk(r))?.auto_parked_why), /No script can do this/)
  await work(p, t1, e1, { 'one.txt': '1\n' }); await until(t1, 'merged') // main is fine and HQ's own test runs: nothing waits for a parked repair of the command
  assert.equal((await repoNow(p)).auto_stopped_why, null, 'the project is not stopped'); assert.equal((await repoNow(p)).auto_waiting, null)
  await bash(e2, HARD, refusal(wt(p, t2))); await looked()
  assert.equal((await repairs(p)).length, 1, 'one repair per command'); assert.equal((await cantRun(p)).length, 1, 'the notice stays')
  await bash(e2, `${HARD} 2>&1 | tail -5`, 'Exit code 1\n✖ a test failed') // Claude Code ran it this time (a newer one refuses less)
  assert.equal(await refusedNow(p), null); assert.deepEqual(await cantRun(p), [])
  await work(p, t2, e2, { 'two.txt': '2\n' }); await until(t2, 'merged')
})

test('a repair needing a code fix and a new command lands; a second change in one run stops and asks', async () => {
  const p = await project('both')
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'); await turnEnds(p) // Two keeps the run open
  const e1 = await engineer(t1), e2 = await engineer(t2); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r); assert.equal((await hq.hook(er.id, exitPlanMode('Plan'))).hookSpecificOutput.decision.behavior, 'allow')
  fs.mkdirSync(path.join(wt(p, r), 'fixed')); fs.writeFileSync(path.join(wt(p, r), 'fixed', 'a.test.js'), PASS)
  sh(wt(p, r), 'add', '.'); sh(wt(p, r), 'commit', '-qm', 'new tests')
  assert.equal((await propose(er, 'node --test fixed/a.test.js', 'test/')).isError, false) // that file is only on the branch
  await waitFor('the save', async () => (await repoNow(p)).test_cmd); await openPr(er); await until(r, 'merged'); await until(t1, 'merged')
  fs.writeFileSync(path.join(p.dir, 'fixed', 'a.test.js'), BROKEN); sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'break')
  await work(p, t2, e2, { 'two.txt': '2\n' })
  const r2 = await repair(p, 2), er2 = await engineer(r2), before = (await repoNow(p)).test_cmd
  assert.equal((await propose(er2, 'true', 'everything')).isError, false)
  const why = await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why)
  assert.match(why, /second change to the test command/); assert.equal((await repoNow(p)).test_cmd, before, 'the tests stay as they were')
})

test('off auto HQ asks: no repair ticket by itself, and a test command waits for the user', async () => {
  const p = await project('manual')
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  assert.equal((await propose(er, 'node --test test/ok.test.js', 'test/main.test.js')).isError, false)
  await waitFor('the question', async () => (await repoNow(p)).test_cmd_proposed); assert.equal((await repoNow(p)).test_cmd, null, 'nothing changes until the user says')
  assert.ok((await hq.state()).attention.some((a: any) => a.kind === `test_cmd_proposed:${p.repo.id}`))
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd-answer`, { use: false })).status, 200)
  assert.equal((await repoNow(p)).test_cmd, null); assert.equal((await repoNow(p)).test_cmd_proposed, null)
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd-answer`, { use: true })).status, 409, 'nothing is waiting')
  assert.equal((await propose(er, 'node --test test/ok.test.js', 'test/main.test.js')).isError, false)
  await waitFor('the question again', async () => (await repoNow(p)).test_cmd_proposed)
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd-answer`, { use: true })).status, 200)
  assert.equal((await repoNow(p)).test_cmd, 'node --test test/ok.test.js')
  const other = await project('nevers', { auto: false }); breakMain(other); const t = await ticket(other, 'Plain'); await turnEnds(other); await looked()
  assert.equal((await repairs(other)).length, 0); assert.equal((await tk(t)).status, 'queued')
})

test('engineers get the project\'s test command: in their launch prompt, and as a message if it changes while they work', async () => {
  const p = await project('told')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'node --test test/ok.test.js' })).status, 200)
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); assert.match(prompt(e1.id), /use it for your full test run instead of the project's usual one: node --test test\/ok\.test\.js/)
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'node --test test/' })).status, 200)
  await waitFor('the engineer to hear', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e1.id && /node --test test\/$/.test(m.body)))
  await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'node --test test/' }); await looked()
  assert.equal((await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === e1.id && /full test run/.test(m.body)).length, 1, 'no change, no message')
  breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const er = await engineer(await repair(p)); assert.doesNotMatch(prompt(er.id), /use it for your full test run/, 'a repair isn\'t told to use the command that failed')
})

/** HQ's notes to `e` that the test command changed (Bug 147: their own reason, so a late one can be dropped). */
const cmdNotes = async (e: any): Promise<any[]> => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === e.id && m.reason === 'test_cmd')
test('Bug 147: a repair\'s new command goes to the engineers at work, not to its own; with code on the repair\'s branch it says to merge main in first', async () => {
  const p = await project('cmdnote')
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'); await turnEnds(p) // Two is still at work when the command changes
  const e1 = await engineer(t1), e2 = await engineer(t2); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await repair(p), er = await engineer(r); assert.equal((await hq.hook(er.id, exitPlanMode('Plan'))).hookSpecificOutput.decision.behavior, 'allow')
  fs.mkdirSync(path.join(wt(p, r), 'fixed')); fs.writeFileSync(path.join(wt(p, r), 'fixed', 'a.test.js'), PASS); sh(wt(p, r), 'add', '.'); sh(wt(p, r), 'commit', '-qm', 'new tests')
  const cmd = 'node --test fixed/a.test.js' // that file is only on the repair's branch
  assert.equal((await propose(er, cmd, 'test/')).isError, false)
  const [note] = await waitFor('the note to Two', async () => { const n = await cmdNotes(e2); return n.length ? n : null }, 15_000)
  assert.ok(note.body.endsWith(`: ${cmd}`), note.body); assert.ok(note.body.includes(`It came with ${r.key}, which isn't in main yet`), note.body)
  assert.equal(note.feature_id, p.f.id, 'Bug 187: with its ticket\'s feature, so Messages shows it with that box picked')
  assert.match(note.body, /just before that run, merge main into your branch \(git merge --no-edit main; merge, never rebase\)/)
  assert.ok(note.body.includes(`${r.key} hasn't merged yet: say so under "Deviations from approved plan" and call open_pr anyway`), note.body)
  const answer = await waitFor('the repair engineer\'s own answer', async () => (await hq.state()).messages.find((m: any) => m.to_id === er.id && /passed and is saved/.test(m.body)))
  assert.ok(answer.feature_id && answer.feature_id === r.feature_id, 'Bug 187: HQ\'s answer is in the repair\'s feature')
  assert.deepEqual(await cmdNotes(er), [], 'not to the engineer whose proposal it was'); assert.deepEqual(await cmdNotes(e1), [], 'nor to one already finished')
  await openPr(er); await until(r, 'merged'); await until(t1, 'merged')
})

test('Bug 147: a note of a new command its engineer hasn\'t read by open_pr is dropped and starts no turn; an engineer still at work gets it', async () => {
  const p = await project('latenote')
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2)
  // Typed in the Auto box while both work (no mod here: what HQ sends waits, as it does for an engineer in the middle of a turn)
  const cmd = 'node --test test/ok.test.js'; await setCmd(p, cmd)
  const [n1] = await waitFor('the notes', async () => { const a = await cmdNotes(e1), b = await cmdNotes(e2); return a.length && b.length ? a : null })
  assert.ok(n1.body.endsWith(`one: ${cmd}`), n1.body); assert.doesNotMatch(n1.body, /It came with|git merge/, 'no repair: nothing to merge in')
  assert.equal((await hq.api(`agents/${e2.id}/message`, { body: 'Also keep the list short.', reason: 'fyi' })).status, 200)
  await work(p, t1, e1, { 'one.txt': '1\n' }) // One's engineer finishes without having read it
  const [late] = await cmdNotes(e1); assert.equal(late.delivery_method, 'dropped'); assert.equal(late.dropped_why, 'finished', 'Bug 187: and why')
  assert.notEqual((await hq.hook(e1.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })).decision, 'block', 'no new turn for it')
  await waitFor('the finished engineer to be stopped', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id && a.status === 'exited'))
  // What it must not catch: an engineer still at work gets its note, and other messages are left alone. No mod here, so its Stop hook
  // hands them out (Bug 103; hq.hook goes on until HQ lets the turn end)
  assert.equal((await hq.hook(e2.id, { hook_event_name: 'Stop', last_assistant_message: 'Working.' })).decision, 'block')
  const read = (await hq.state()).messages.filter((m: any) => m.to_id === e2.id).map((m: any) => `${m.reason}:${m.delivery_method}`).sort()
  assert.deepEqual(read, ['fyi:stop_hook', 'test_cmd:stop_hook'])
  assert.ok((await hq.state()).messages.filter((m: any) => m.to_id === e2.id).every((m: any) => m.dropped_why === null), 'Bug 187: delivered ones have no why')
  await work(p, t2, e2, { 'two.txt': '2\n' }); await until(t1, 'merged'); await until(t2, 'merged')
})

test('tests that freeze are reported as frozen, and the repair is told so', async () => {
  const p = await project('frozen')
  assert.equal((await hq.api('settings', { key: 'test_timeout_min', value: 0.1 })).status, 200)
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1)
  fs.writeFileSync(path.join(p.dir, 'test', 'hang.test.js'), "require('node:test').test('hang',()=>new Promise(()=>{setInterval(()=>{},1000)}))\n")
  sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'hang')
  await work(p, t1, e1, { 'one.txt': '1\n' })
  const r = await waitFor('the repair', async () => (await repairs(p))[0], 30_000)
  assert.match(r.spec, /The tests froze and were stopped after 0\.1 minutes/); assert.equal((await tk(t1)).auto_tries, 0)
})

test('switching auto off and on with main broken says what is happening, never a silent loop', async () => {
  const p = await project('toggle')
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  await waitFor('HQ to see main is broken', async () => { const r = await repoNow(p); return r.auto_stopped_why || r.auto_waiting })
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200); assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const said = await waitFor('HQ to say why nothing merges', async () => { const r = await repoNow(p); return r.auto_stopped_why || r.auto_waiting }, 8_000)
  assert.match(said, /tests/)
})

test('an engineer that reports itself blocked is parked; a dialog on an engineer is parked too', async () => {
  const p = await project('notices')
  const t1 = await ticket(p, 'Blocked'), t2 = await ticket(p, 'Dialog'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2)
  assert.equal((await hq.mcp(e1.id, 'report_blocked', { reason: 'needs a key' })).isError, false)
  assert.match(await waitFor('the blocked ticket to park', async () => (await tk(t1))?.auto_parked_why), /needs a key/)
  await hq.hook(e2.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  assert.match(await waitFor('the dialog ticket to park', async () => (await tk(t2))?.auto_parked_why), /Allow this/)
  // Bug 355: the look that parked them had read the tickets before the park, saw their stopped engineers and started fresh ones
  await looked()
  const resumed = ((await hq.api('events?limit=500')).json as any[]).filter((e) => e.kind === 'ticket.resumed'
    && [t1.id, t2.id].includes(JSON.parse(e.payload).ticket))
  assert.deepEqual(resumed, [], 'nothing starts on a parked ticket')
  const on = (await hq.state()).agents.filter((a: any) => a.role === 'engineer' && [t1.id, t2.id].includes(a.ticket_id)).map((a: any) => `${a.id}:${a.status}`).sort()
  assert.deepEqual(on, [`${e1.id}:exited`, `${e2.id}:exited`].sort(), 'only the parked engineers, stopped')
})

test('a dialog on the TPM stops the project until the user has seen to it', async () => {
  const p = await project('tpmdialog')
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  assert.match(await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why), /The TPM needs you: .*Allow this/)
  assert.ok((await hq.state()).attention.some((a: any) => a.kind === `auto_stopped:${p.repo.id}`))
})

test('Bug 61: Turn off on a stopped project clears its alert for good, and reports what the run built', async () => {
  const p = await project('stopoff')
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'); await turnEnds(p); const e1 = await engineer(t1); await engineer(t2)
  await work(p, t1, e1, { 'one.txt': '1\n' }); await until(t1, 'merged')
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why)
  const has = async (kind: string) => (await hq.state()).attention.some((a: any) => a.kind === `${kind}:${p.repo.id}`)
  assert.ok(await has('auto_stopped'))
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  await looked(); assert.equal(await has('auto_stopped'), false, 'gone, and no sweep brings it back'); assert.ok(await has('auto_finished'), 'the run built something')
  assert.equal((await repoNow(p)).auto_stopped_why, null)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200) // the TPM's dialog is still open: it stops again, with a new alert
  await waitFor('the second stop', async () => (await repoNow(p)).auto_stopped_why); assert.ok(await has('auto_stopped'))
})

test('Bug 61: reading the summary clears the finished alert, the run stays, and the next run alerts again', async () => {
  const p = await project('read')
  const t1 = await ticket(p, 'One'); await turnEnds(p); await work(p, t1, await engineer(t1), { 'one.txt': '1\n' }); await until(t1, 'merged'); await turnEnds(p)
  await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  const row = async () => (await hq.state()).attention.find((a: any) => a.kind === `auto_finished:${p.repo.id}`)
  const first = await waitFor('the alert', row)
  assert.equal((await hq.api(`attention/${first.id}/resolve`, {})).status, 200)
  assert.equal(await row(), undefined); assert.ok((await runs(p))[0].summary, 'the summary is still there to read')
  const t2 = await ticket(p, 'Two'); await turnEnds(p); await work(p, t2, await engineer(t2), { 'two.txt': '2\n' }); await until(t2, 'merged'); await turnEnds(p)
  const next = await waitFor('the next alert', row); assert.notEqual(next.id, first.id)
})

test('Bug 61: Clear project leaves no auto alerts behind', async () => {
  const p = await project('cleared')
  const t1 = await ticket(p, 'One'); await turnEnds(p); await work(p, t1, await engineer(t1), { 'one.txt': '1\n' }); await until(t1, 'merged'); await turnEnds(p)
  await waitFor('the alert', async () => (await hq.state()).attention.find((a: any) => a.kind === `auto_finished:${p.repo.id}`))
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  await waitFor('the stop alert', async () => (await hq.state()).attention.find((a: any) => a.kind === `auto_stopped:${p.repo.id}`))
  const r = await hq.api(`repos/${p.repo.id}/clear`, {}); assert.equal(r.status, 200); assert.equal(r.json.done, true, 'a TPM at a dialog can\'t write a note')
  assert.deepEqual((await hq.state()).attention.filter((a: any) => a.kind.startsWith('auto_')), [])
})

// Bug 221: Clear empties the board; it has nothing to do with auto mode, so auto mode stays as the user left it. The cleared project starts nothing by itself,
// and the next request is built and merged on auto, in a run of its own.
test('Bug 221: Clear keeps auto mode on; nothing starts on the empty board, and the next request is built and merged on auto', async () => {
  const p = await project('keepauto')
  const t1 = await ticket(p, 'One'); await turnEnds(p); await work(p, t1, await engineer(t1), { 'one.txt': '1\n' }); await until(t1, 'merged'); await turnEnds(p)
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' }) // no note to wait for
  const r = await hq.api(`repos/${p.repo.id}/clear`, {}); assert.equal(r.status, 200); assert.equal(r.json.done, true)
  const after = await repoNow(p); assert.equal(after.auto_mode, 1, 'still on'); assert.equal(after.auto_stopped_why, null); assert.equal(after.clearing_at, null)
  await hq.beats('auto', 3) // a few passes of the auto loop on the empty board
  assert.deepEqual(await runs(p), [], 'no run on an empty board'); assert.equal((await hq.state()).agents.filter((a: any) => a.role === 'engineer' && a.status !== 'exited').length, 0)
  const f = (await hq.api('features', { repoId: p.repo.id, title: 'Two', request: 'Build two' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t2 = (await hq.api('tickets', { featureId: f.id, title: 'Two', size: 'S', spec: 'Two.' })).json
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'Split done.' })
  await work(p, t2, await engineer(t2), { 'two.txt': '2\n' }); await until(t2, 'merged')
  assert.equal((await runs(p)).length, 1, 'a run of its own')
})

test('a conflict goes to Fix conflicts by itself', async () => {
  const p = await project('conflict')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: HELD })).status, 200)
  const t1 = await ticket(p, 'A'), t2 = await ticket(p, 'B'); await turnEnds(p)
  await onPage(p, 'no ticket:main:running'); await letGo(p); await waitFor('main checked', async () => (await checks())[0])
  const e1 = await engineer(t1), e2 = await engineer(t2)
  // Bug 113: both are finished before either merges. A's test run is held until B is in too; a 2 s command did this by timing, and once failed on CI.
  await work(p, t1, e1, { 'version.txt': 'v1\na\n' }); await onPage(p, `${t1.id}:ticket:running`)
  await work(p, t2, e2, { 'version.txt': 'v1\nb\n' })
  assert.deepEqual([(await tk(t1)).status, (await tk(t2)).status], ['pr_ready', 'pr_ready'], 'both finished, neither merged')
  await letGo(p); await until(t1, 'merged'); await until(t2, 'resolving') // B's conflict shows before any command runs: nothing to let go
  try { sh(wt(p, t2), 'merge', '--no-edit', 'main') } catch { /* the conflict */ }
  fs.writeFileSync(path.join(wt(p, t2), 'version.txt'), 'v1\na\nb\n'); sh(wt(p, t2), 'add', '.'); sh(wt(p, t2), 'commit', '--no-edit', '-q'); await openPr(e2)
  await onPage(p, `${t2.id}:ticket:running`); await letGo(p)
  await until(t2, 'merged'); assert.equal(fs.readFileSync(path.join(p.dir, 'version.txt'), 'utf8'), 'v1\na\nb\n')
})

test('turning auto off: running work finishes, nothing new starts or merges, and the user is back in charge', async () => {
  const p = await project('off')
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two', [t1.key]); await turnEnds(p)
  const e1 = await engineer(t1)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  const held = hq.hook(e1.id, exitPlanMode('Plan')); const r = await waitFor('the review', async () => (await hq.state()).reviews.find((x: any) => x.ticket_id === t1.id && x.status === 'open'))
  assert.ok(r, 'off: plans wait for the user again'); assert.equal((await hq.api(`reviews/${r.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true); await held
  fs.writeFileSync(path.join(wt(p, t1), 'one.txt'), '1\n'); sh(wt(p, t1), 'add', '.'); sh(wt(p, t1), 'commit', '-qm', 'one'); await openPr(e1)
  await looked(); assert.equal((await tk(t1)).status, 'pr_ready', 'off: finished tickets wait for the user')
  assert.equal((await tk(t2)).status, 'queued'); assert.equal((await runs(p))[0].status, 'off')
  assert.equal((await hq.mcp(p.tpm.id, 'ask_user', { question: 'Dark or light?', choices: ['Dark', 'Light'] })).isError, false, 'off: the TPM asks again')
})

test('on auto the TPM decides product questions itself; only what\'s hard to undo reaches the user, and the summary lists its choices', async () => {
  const p = await project('ask')
  const no = await hq.mcp(p.tpm.id, 'ask_user', { question: 'Dark or light?', choices: ['Dark', 'Light'] })
  assert.equal(no.isError, true); assert.match(no.text, /Decided in auto mode/); assert.equal((await hq.state()).asks.length, 0)
  assert.equal((await hq.mcp(p.tpm.id, 'ask_user', { question: 'Delete the old data?', choices: ['Yes', 'No'], hard_to_undo: true })).isError, false); assert.equal((await hq.state()).asks.length, 1)
  await hq.api(`asks/${(await hq.state()).asks[0].id}/answer`, { answer: 'No' })
  await hq.mcp(p.tpm.id, 'read_inbox') // the TPM reads the answer
  await hq.mcp(p.tpm.id, 'write_feature', { feature: p.f.handle, section: 'Decided in auto mode',
    text: '- Dark theme, it suits the app at night' }) // while splitting, before any ticket opens the run
  const t1 = await ticket(p, 'One'); await turnEnds(p); const e1 = await engineer(t1)
  await work(p, t1, e1, { 'one.txt': '1\n' }); await until(t1, 'merged'); await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, /Decided for you\n- Dark theme/)
})

test('a project with no tests builds but doesn\'t merge, says why, and merges once there\'s a test command', async () => {
  const p = await project('notests', { tests: false })
  const t1 = await ticket(p, 'One'); await turnEnds(p); const e1 = await engineer(t1); await work(p, t1, e1, { 'one.txt': '1\n' })
  const w = await waitFor('the notice', async () => (await repoNow(p)).auto_waiting); assert.match(w, /No tests HQ can run/)
  await looked(); assert.equal((await tk(t1)).status, 'pr_ready')
  const tries = (await hq.api('events?limit=500')).json.filter((e: any) => e.kind === 'auto.tested').length
  assert.equal(tries, 1, 'once: it isn\'t tested again until something changes')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'test -f one.txt' })).status, 200)
  await until(t1, 'merged'); assert.equal((await repoNow(p)).auto_waiting, null)
  assert.deepEqual(await repairs(p), [], 'main fails a command only the ticket satisfies: the ticket\'s own test decides, not a repair (Bug 70)')
})

test('usage: nothing new starts at the limit, and it picks up by itself when usage drops; a restart mid-run carries on', async () => {
  const p = await project('usage')
  const t1 = await ticket(p, 'One'); await hq.modEvent(p.tpm.id, { kind: 'session.measure', usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 90 }] } }); await turnEnds(p)
  const w = await waitFor('the wait', async () => (await repoNow(p)).auto_waiting); assert.match(w, /Waiting for usage/)
  assert.equal((await hq.state()).agents.filter((a: any) => a.role === 'engineer').length, 0)
  await hq.api('settings', { key: 'pause_five_hour_pct', value: 95 }) // what a usage window rolling over does: nothing happens but the timer
  const e1 = await engineer(t1); assert.equal((await repoNow(p)).auto_waiting, null)
  await hq.hook(e1.id, exitPlanMode('Plan')); await hq.restart()
  fs.writeFileSync(path.join(wt(p, t1), 'one.txt'), '1\n'); sh(wt(p, t1), 'add', '.'); sh(wt(p, t1), 'commit', '-qm', 'one'); await openPr(e1)
  await until(t1, 'merged')
})

test('switching away leaves a project on auto running; a manual project still parks', async () => {
  const p = await project('stays'), m = await project('parks', { auto: false })
  assert.deepEqual((await hq.api(`repos/${p.repo.id}/park`, {})).json.parked, [])
  assert.ok((await hq.state()).agents.find((a: any) => a.id === p.tpm.id && a.status !== 'exited'))
  assert.ok((await hq.api(`repos/${m.repo.id}/park`, {})).json.parked.length)
})

test('Undo puts main back with one new commit, keeps the branches, and drops the run from what was built; other work on main refuses it', async () => {
  const p = await project('undo')
  const t1 = await ticket(p, 'One'); await turnEnds(p); const e1 = await engineer(t1); await work(p, t1, e1, { 'one.txt': '1\n' }); await until(t1, 'merged'); await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  const branch = (await tk(t1)).branch
  const f = path.join(p.dir, 'outside.txt'); fs.writeFileSync(f, 'mine\n'); sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'my own work')
  const no = await hq.api(`auto-runs/${r.id}/undo`, {}); assert.equal(no.status, 409); assert.match(no.json.error, /my own work/); assert.ok(fs.existsSync(path.join(p.dir, 'one.txt')))
  sh(p.dir, 'reset', '-q', '--hard', 'HEAD~1')
  assert.equal((await hq.api(`auto-runs/${r.id}/undo`, {})).status, 200)
  assert.equal(fs.existsSync(path.join(p.dir, 'one.txt')), false); assert.equal(sh(p.dir, 'rev-parse', 'main^{tree}'), sh(p.dir, 'rev-parse', `${r.start_sha}^{tree}`))
  assert.match(sh(p.dir, 'log', '-1', '--format=%s'), /Undo auto mode run/); assert.ok(sh(p.dir, 'branch', '--list', branch))
  assert.equal((await tk(t1)).status, 'cancelled'); assert.equal((await runs(p))[0].status, 'undone')
  assert.equal((await hq.state()).attention.some((a: any) => a.kind === `auto_finished:${p.repo.id}`), false)
  assert.equal((await hq.api(`auto-runs/${r.id}/undo`, {})).status, 409)
})

test('an engineer that stops without finishing is replaced, then the ticket is parked, and the run still ends', async () => {
  const p = await project('quiet')
  await hq.api('settings', { key: 'stuck_idle_min', value: 0 })
  const t1 = await ticket(p, 'Quiet'), t2 = await ticket(p, 'Fine'); await turnEnds(p)
  const e2 = await engineer(t2); let e1 = await engineer(t1); const seen = [e1.id]
  await hq.hook(e2.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
  for (let i = 0; i < 2; i++) {
    await hq.hook(e1.id, { hook_event_name: 'Stop', last_assistant_message: 'I think that is enough for now.' })
    e1 = await waitFor('a fresh engineer', async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t1.id && a.status === 'working' &&
      !seen.includes(a.id))); seen.push(e1.id)
  }
  await hq.hook(e1.id, { hook_event_name: 'Stop', last_assistant_message: 'Done talking.' })
  assert.match(await waitFor('the ticket to park', async () => (await tk(t1))?.auto_parked_why), /stopped before finishing/)
  await waitFor('its engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id)?.status === 'exited')
  await work(p, t2, e2, { 'fine.txt': 'ok\n' }); await until(t2, 'merged'); await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished')); assert.match(r.summary, /Parked, needs you/)
})

/** A tab: every test-run patch HQ's WebSocket sends it, oldest first, and its first snapshot. */
async function tab(): Promise<{ runs: () => string[]; first: () => any; close: () => void }> {
  const msgs: any[] = [], token = fs.readFileSync(path.join(hq.hqHome, 'ui-token'), 'utf8').trim()
  const ws = new WebSocket(`ws://127.0.0.1:${hq.ports.ui}/ws`, { headers: { authorization: `Bearer ${token}` } })
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))))
  await new Promise<void>((ok, no) => { ws.once('open', () => ok()); ws.once('error', no) })
  return { runs: () => msgs.filter((m) => m.type === 'patch' && m.entity === 'test_run').map((m) => m.patch === null ? 'gone' : `${m.patch.what}:${m.patch.state}`),
    first: () => msgs.find((m) => m.type === 'snapshot'), close: () => ws.close() }
}
test('Bug 106: the page is told while HQ tests main and then a finished ticket, and each run leaves it when it ends', async () => {
  const p = await project('shown'), t = await ticket(p, 'Thing'), page = await tab()
  try {
    assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: HELD })).status, 200); await turnEnds(p)
    await onPage(p, 'no ticket:main:running'); await letGo(p)
    await waitFor('main checked', async () => (await checks())[0]); assert.equal(await shown(p), '', "main's run is off the page before its result is")
    await work(p, t, await engineer(t), { 'thing.js': '1\n' })
    await onPage(p, `${t.id}:ticket:running`); assert.equal((await tk(t)).status, 'pr_ready')
    const late = await tab() // a page opened in the middle of the run has it from its first snapshot
    try {
      const snap = await waitFor('its snapshot', () => late.first())
      assert.deepEqual(snap.data.testRuns.map((r: any) => [r.repo_id, r.ticket_id, r.what, r.state]), [[p.repo.id, t.id, 'ticket', 'running']])
      assert.ok(snap.data.testRuns[0].since <= Date.now() && snap.data.testRuns[0].since > Date.now() - 60_000)
    } finally { late.close() }
    await letGo(p); await until(t, 'merged'); assert.equal(await shown(p), '')
    await waitFor('the tab to hear both runs end', () => page.runs().length >= 4)
    assert.deepEqual(page.runs(), ['main:running', 'gone', 'ticket:running', 'gone'])
  } finally { page.close() }
})
test('Bug 106: a ticket whose tests fail says so while HQ tests main without it, and the run is gone once the ticket is sent back', async () => {
  const p = await project('shownfail'), t = await ticket(p, 'Thing')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: `${HELD}; [ ! -f thing.js ]` })).status, 200); await turnEnds(p)
  await onPage(p, 'no ticket:main:running'); await letGo(p); await waitFor('main checked', async () => (await checks())[0])
  await work(p, t, await engineer(t), { 'thing.js': '1\n' })
  await onPage(p, `${t.id}:ticket:running`); await letGo(p)
  await onPage(p, `${t.id}:main:running`); assert.equal((await tk(t)).status, 'pr_ready', 'not sent back until HQ knows it was the ticket'); await letGo(p)
  await until(t, 'resolving'); assert.equal(await shown(p), ''); assert.ok((await tk(t)).fixing, 'sent back for its tests')
})
// Bug 143: HQ tested the branch as open_pr left it but merged the branch as it was when the test ended, so a commit made during the test reached main untested
const commit = (p: P, t: any, file: string) => { fs.writeFileSync(path.join(wt(p, t), file), `${file}\n`); sh(wt(p, t), 'add', '.'); sh(wt(p, t), 'commit', '-qm', file) }
test('Bug 143: a commit to a finished ticket\'s branch while HQ tests it is not merged; its engineer is told, and once it calls open_pr again that is tested and merged',
  async () => {
    const p = await project('latecommit'), t = await ticket(p, 'Thing')
    assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: HELD })).status, 200); await turnEnds(p)
    await onPage(p, 'no ticket:main:running'); await letGo(p); await waitFor('main checked', async () => (await checks())[0])
    const e = await engineer(t); await work(p, t, e, { 'thing.js': '1\n' })
    assert.equal((await tk(t)).finished_sha, sh(wt(p, t), 'rev-parse', 'HEAD'), 'open_pr keeps the commit it hands over')
    await onPage(p, `${t.id}:ticket:running`)
    commit(p, t, 'late.txt') // a message reached the engineer after its open_pr, and it acted on it
    await letGo(p); await until(t, 'implementing')
    assert.equal(fs.existsSync(path.join(p.dir, 'thing.js')), false, 'nothing merged'); assert.equal(fs.existsSync(path.join(p.dir, 'late.txt')), false)
    const told = await waitFor('its engineer to be told', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e.id &&
      /commits from after your open_pr/.test(m.body)))
    assert.match(told.body, /call open_pr again\.$/)
    await looked(); assert.equal(await shown(p), '', 'nothing is tested until it calls open_pr again'); assert.equal((await tk(t)).status, 'implementing')
    await openPr(e); assert.equal((await tk(t)).finished_sha, sh(wt(p, t), 'rev-parse', 'HEAD'))
    await onPage(p, `${t.id}:ticket:running`); await letGo(p); await until(t, 'merged')
    assert.equal(fs.readFileSync(path.join(p.dir, 'late.txt'), 'utf8'), 'late.txt\n')
    // The branch's head, asked of the project: HQ removes a merged ticket's worktree (the branch stays), and on Linux it was sometimes gone by here (git ENOENT)
    assert.equal(sh(p.dir, 'log', '-1', '--format=%P', 'main').split(' ')[1], sh(p.dir, 'rev-parse', (await tk(t)).branch))
  })
test('Bug 143: a branch that moved after open_pr, with its engineer stopped, isn\'t tested; a fresh engineer finishes it again, and open_pr again on a finished ticket counts',
  async () => {
    const p = await project('latestop'), t = await ticket(p, 'Thing')
    assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: HELD })).status, 200); await turnEnds(p)
    await onPage(p, 'no ticket:main:running') // main's check holds the next test back: the ticket finishes and its branch moves before HQ gets to it
    const e = await engineer(t); await work(p, t, e, { 'thing.js': '1\n' })
    await hq.hook(e.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    await waitFor('the finished engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === e.id)?.status === 'exited')
    commit(p, t, 'late.txt') // by hand, say
    await letGo(p); await waitFor('main checked', async () => (await checks())[0])
    const e2 = await engineer(t, e.id); assert.equal((await tk(t)).status, 'implementing'); assert.equal(await shown(p), '', 'the moved branch was not tested')
    assert.equal((await hq.state()).messages.some((m: any) => m.to_id === e.id && /after your open_pr/.test(m.body)), false, 'nothing sent to an engineer that has stopped')
    await openPr(e2); await onPage(p, `${t.id}:ticket:running`)
    commit(p, t, 'later.txt') // open_pr again on a finished ticket whose branch moved finishes it again, with the new commit
    const again = await hq.mcp(e2.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true })
    assert.equal(again.isError, false, again.text); assert.doesNotMatch(again.text, /already/); assert.equal((await tk(t)).finished_sha, sh(wt(p, t), 'rev-parse', 'HEAD'))
    const same = await hq.mcp(e2.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true })
    assert.match(same.text, /is already pr_ready; nothing more to do/)
    await letGo(p); await waitFor('the first test to end', async () => (await tested()).filter((x) => x.kind === 'auto.tested').length === 1)
    await onPage(p, `${t.id}:ticket:running`); assert.equal((await tk(t)).status, 'pr_ready', 'tested again, not sent back: open_pr named the new commit')
    assert.equal(fs.existsSync(path.join(p.dir, 'thing.js')), false, 'what the first test ran is not what is there now: not merged')
    await letGo(p); await until(t, 'merged')
    assert.ok(['thing.js', 'late.txt', 'later.txt'].every((f) => fs.existsSync(path.join(p.dir, f))))
  })
test("Bug 106: a run in line behind another project's says it is waiting its turn, and running once its turn comes", async () => {
  const a = await project('ahead'); await ticket(a, 'One')
  assert.equal((await hq.api(`repos/${a.repo.id}/test-cmd`, { cmd: HELD })).status, 200); await turnEnds(a); await onPage(a, 'no ticket:main:running')
  const b = await project('behind'); await ticket(b, 'Two')
  assert.equal((await hq.api(`repos/${b.repo.id}/test-cmd`, { cmd: HELD })).status, 200); await turnEnds(b); await onPage(b, 'no ticket:main:waiting')
  const waitedFrom = (await hq.state()).testRuns.find((r: any) => r.repo_id === b.repo.id).since
  const behind = (await hq.state()).testRuns.find((r: any) => r.repo_id === b.repo.id).behind // Bug 289: the page says behind whom
  assert.equal(behind.length, 1); assert.match(behind[0], /^HQ's test of /)
  assert.equal(await shown(a), 'no ticket:main:running'); await letGo(a)
  await onPage(b, 'no ticket:main:running'); await onPage(a, '') // the first leaves the page once its checkout has gone, a moment after it gave its turn back
  assert.ok((await hq.state()).testRuns.find((r: any) => r.repo_id === b.repo.id).since >= waitedFrom, 'its clock starts again when its turn comes')
  assert.deepEqual((await hq.state()).testRuns.find((r: any) => r.repo_id === b.repo.id).behind, [], 'running: behind nobody')
  await letGo(b); await onPage(b, '')
})

// Acceptance criteria as a list (criteria.ts): the engineer names a test for each at open_pr, HQ checks that with git, then looks for each named test in its own run.
const CRIT = [{ kind: 'backend', text: 'Adding 2 and 3 gives 5.' }, { kind: 'ui', text: 'The total is shown in bold.' }]
const withCriteria = async (p: P, title: string, criteria: unknown[], more: Record<string, unknown> = {}) =>
  (await hq.api('tickets', { featureId: p.f.id, title, size: 'S', spec: `${title}.`, criteria, ...more })).json
const ADD = 'exports.add=(a,b)=>a+b\n', ADD_TEST = "const t=require('node:test'),a=require('node:assert');t.test('adds two numbers',()=>{a.equal(require('../add').add(2,3),5)})\n"
const A1 = { criterion: 'A1', file: 'test/add.test.js', name: 'adds two numbers' }
/** An engineer's work up to open_pr: its plan (on auto HQ approves it), `files`, a commit and the handoff. */
async function build(p: P, t: any, e: any, files: Record<string, string>, o: { plan?: boolean } = {}): Promise<void> {
  if (o.plan !== false) assert.equal((await hq.hook(e.id, exitPlanMode(`Plan for ${t.key}`))).hookSpecificOutput.decision.behavior, 'allow')
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(wt(p, t), f)), { recursive: true }); fs.writeFileSync(path.join(wt(p, t), f), text) }
  sh(wt(p, t), 'add', '.'); sh(wt(p, t), 'commit', '-qm', t.title); await ranTests(e); await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
}
const finish = (e: any, tests?: unknown) => hq.mcp(e.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', ...(tests ? { tests } : {}),
  feature_map_unchanged: true }) // the feature map has its own tests (featuremap.test.ts)
const proofNow = async (t: any) => JSON.parse((await tk(t)).proof ?? 'null')

test('a ticket with acceptance criteria finishes only once each has a test on its branch; HQ finds them in its own run, and the summary lists what has none', async () => {
  const p = await project('criteria'), t = await withCriteria(p, 'Adding', CRIT, { expected_files: ['add.js'] }); await turnEnds(p)
  assert.deepEqual(JSON.parse((await tk(t)).criteria).map((c: any) => `${c.id} ${c.kind}`), ['A1 backend', 'A2 ui'])
  const e = await engineer(t)
  assert.match(prompt(e.id), /## Acceptance criteria\n[^\n]+\n- A1 \(behind the screen\): Adding 2 and 3 gives 5\.\n- A2 \(screen\): The total is shown in bold\.\n/)
  assert.match((await hq.mcp(e.id, 'get_ticket')).text, /- A2 \(screen\): The total is shown in bold\./)
  await build(p, t, e, { 'add.js': ADD, 'style.css': 'b{font-weight:bold}\n', 'test/add.test.js': ADD_TEST })
  const A2 = { criterion: 'A2', cant_test: 'Bold is a matter of looks: this project has no way to render a page.' }
  const refused: [unknown, RegExp][] = [[undefined, /open_pr needs `tests`/], [[A1], /Nothing named for A2/], [[{ ...A1, name: 'adds numbers' }, A2], /has no "adds numbers" in it/],
    [[{ ...A1, file: 'test/ok.test.js', name: 'ok' }, A2], /adds or changes none of the test files you named/]] // the test that was there before the ticket proves nothing new
  for (const [tests, why] of refused) { const r = await finish(e, tests); assert.equal(r.isError, true, r.text); assert.match(r.text, why) }
  assert.equal((await tk(t)).status, 'implementing', 'refused: the ticket is as it was')
  const ok = await finish(e, [A1, A2]); assert.equal(ok.isError, false, ok.text)
  await until(t, 'merged')
  const proof = await proofNow(t)
  assert.deepEqual(proof.tests, [{ ...A1, state: 'passed' }, A2]); assert.deepEqual(proof.flags, { tests_deleted: [], tests_cut: [], outside: ['style.css'] })
  await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`## Worth a look\\n- ${t.key}: A2 has no test: Bold is a matter of looks[^\\n]+\\n- ${t.key}: changed files outside the ones planned for it: style\\.css`))
  // Part 1: nobody was asked about the criteria before work started, so the summary lists them, split by kind, right after what was built
  assert.match(r.summary, new RegExp(`## Built\\n- ${t.key}: Adding [^\\n]+\\n\\n## What each one had to do\\n\\*\\*${t.key}: Adding\\*\\*\\n- On the screen\\n`
    + '  - A2: The total is shown in bold\\.\\n- Behind the screen\\n  - A1: Adding 2 and 3 gives 5\\.\\n\\n## '))
})

test('a named test that HQ\'s run skipped, or never ran, sends the ticket back; fixed, it merges', async () => {
  const p = await project('unproven'), t = await withCriteria(p, 'Adding', CRIT); await turnEnds(p)
  const e = await engineer(t), tests = [A1, { criterion: 'A2', file: 'checks/bold.js', name: 'total is bold' }] // `node --test` never looks in checks/
  await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST.replace("('adds two numbers',", "('adds two numbers',{skip:true},"),
    'checks/bold.js': "require('node:test').test('total is bold',()=>{})\n" })
  assert.equal((await finish(e, tests)).isError, false) // git has nothing against it: both tests are on the branch
  await until(t, 'resolving'); assert.equal((await tk(t)).fixing, 'tests')
  const told = await waitFor('HQ to tell the engineer', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e.id &&
    /didn't run every test you named/.test(m.body)))
  assert.match(told.body, /passes `npm test`, but that run didn't run every test you named for the ticket's criteria, so HQ didn't merge it\./)
  assert.match(told.body, /- A1: "adds two numbers" in test\/add\.test\.js was skipped/)
  assert.match(told.body, /- A2: "total is bold" in checks\/bold\.js never ran\. `npm test` listed other tests and not this one/)
  assert.deepEqual(await cameBack(e.id), [`${t.key} came back: the tests named for its criteria didn't all run`]) // Bug 206
  assert.deepEqual((await proofNow(t)).tests.map((x: any) => x.state), ['skipped', 'not_run']); assert.equal(fs.existsSync(path.join(p.dir, 'add.js')), false, 'not merged')
  const w = wt(p, t); fs.writeFileSync(path.join(w, 'test', 'add.test.js'), ADD_TEST); sh(w, 'mv', 'checks/bold.js', 'test/bold.test.js'); sh(w, 'add', '-A'); sh(w, 'commit', '-qm', 'they run now')
  const same = await finish(e); assert.equal(same.isError, true) // the tests it named last time are checked again, and one has moved
  assert.match(same.text, /A2: there's no checks\/bold\.js on your branch/); assert.equal((await tk(t)).status, 'resolving')
  assert.equal((await finish(e, [A1, { ...tests[1], file: 'test/bold.test.js' }])).isError, false)
  await until(t, 'merged'); assert.deepEqual((await proofNow(t)).tests.map((x: any) => x.state), ['passed', 'passed']); assert.equal((await tk(t)).auto_tries, 1)
})

test('the TPM gives criteria as a list: a ticket without them is refused, and criteria changed after a ticket finished send it back for the new one\'s test', async () => {
  const p = await project('tpmcriteria', { auto: false }), tpm = p.tpm.id
  const no = await hq.mcp(tpm, 'create_ticket', { title: 'Adding', size: 'S', spec: 'Add numbers. Done when add(2, 3) gives 5.' })
  assert.equal(no.isError, true); assert.match(no.text, /^Give "Adding" its acceptance criteria in `criteria`: a list of \{ kind, text \}[\s\S]*Nothing was created\.$/)
  const bad = await hq.mcp(tpm, 'create_ticket', { title: 'Adding', size: 'S', spec: 'x', criteria: [{ kind: 'server', text: 'x' }] })
  assert.match(bad.text, /A1 needs kind "ui" [\s\S]* Nothing was created\.$/); assert.equal((await hq.state()).tickets.length, 0)
  const made = await hq.mcp(tpm, 'create_ticket', { title: 'Adding', size: 'S', spec: 'Add numbers.', criteria: [CRIT[0]] })
  assert.match(made.text, /^Created T-01 in F-1: Adding \(criteria A1\)$/)
  const t = (await hq.state()).tickets.find((x: any) => x.title === 'Adding')
  const file = () => fs.readFileSync(path.join(hq.hqHome, 'workspaces', `repo-${p.repo.id}`, 'tpm', 'features', 'F-1.md'), 'utf8')
  assert.match(file(), /### T-01: Adding\nAdd numbers\.\n\nAcceptance criteria \(backend\):\n- A1: Adding 2 and 3 gives 5\.\n/)
  // Part 1: criteria checkable from outside the code. One naming a file or a function, or too vague, is refused, each with why, and nothing changes
  const words = await hq.mcp(tpm, 'update_ticket_spec', { key: t.key, criteria: [{ id: 'A1', ...CRIT[0] }, { id: 'A2', kind: 'backend', text: 'A line is added to data/sums.json' },
    { id: 'A3', type: 'ui', text: 'The total looks good' }] })
  assert.equal(words.isError, true); assert.match(words.text, /^A2 names a file or path \("data\/sums\.json"\)[^]* A3 is too vague to check \("looks good"\)[^]* Nothing was changed\.$/)
  const call = await hq.mcp(tpm, 'create_ticket', { title: 'Total', size: 'S', spec: 'x', criteria: [{ kind: 'backend', text: 'sum() is called once' }] })
  assert.equal(call.isError, true); assert.match(call.text, /^A1 names code \("sum\(\)"\)[^]* Nothing was created\.$/)
  assert.deepEqual((await hq.state()).tickets.map((x: any) => x.title), ['Adding'])
  assert.equal(JSON.parse((await tk(t)).criteria).length, 1)
  const more = [{ id: 'A1', ...CRIT[0] }, { id: 'A2', kind: 'backend', text: 'Adding "2" and 3 is refused.' }]
  assert.equal((await hq.mcp(tpm, 'update_ticket_spec', { key: t.key, criteria: [more[0]] })).text, `${t.key} already says that: nothing changed.`)
  assert.match((await hq.mcp(tpm, 'update_ticket_spec', { key: t.key, criteria: [] })).text, /keeps at least one acceptance criterion/)
  await hq.api(`tickets/${t.id}/launch`, {}); const e = await engineer(t)
  // engineers can't change criteria: HQ gives them no tool for it, whatever they send
  const mine = await hq.mcp(e.id, 'update_ticket_spec', { key: t.key, criteria: [{ kind: 'backend', text: 'Nothing has to be true.' }], user_asked: true })
    .catch((err: Error) => ({ isError: true, text: err.message })) // an unknown tool: the SDK may answer with an error result or throw
  assert.equal(mine.isError, true); assert.match(mine.text, /update_ticket_spec/); assert.equal(JSON.parse((await tk(t)).criteria).length, 1)
  await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST }, { plan: false })
  assert.equal((await finish(e, [A1])).isError, false); assert.equal((await tk(t)).status, 'pr_ready')
  const r = await hq.mcp(tpm, 'update_ticket_spec', { key: t.key, criteria: more, user_asked: true }) // finished, not merged: the new criterion has to be built
  assert.match(r.text, new RegExp(`^Updated\\. ${t.key} was already finished, so HQ told its engineer \\(${e.id}\\) to build the change\\.`))
  const back = await tk(t); assert.equal(back.status, 'resolving'); assert.equal(back.fixing, 'changes'); assert.match(file(), /- A1: Adding 2 and 3 gives 5\.\n- A2: Adding "2" and 3 is refused\./)
  assert.match((await hq.mcp(e.id, 'get_ticket')).text,
    /- A2 \(behind the screen\): Adding "2" and 3 is refused\.\n\n## The tests you named at your last open_pr\n- A1: test\/add\.test\.js · "adds two numbers"\n/)
  const old = await finish(e); assert.equal(old.isError, true); assert.match(old.text, /Nothing named for A2\./) // last time's tests don't cover the new criterion
  const w = wt(p, t); fs.appendFileSync(path.join(w, 'test', 'add.test.js'), "t.test('refuses text',()=>{})\n"); sh(w, 'add', '.'); sh(w, 'commit', '-qm', 'A2')
  await ranTests(e); await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' }) // Bug 194: the test file changed since the last run
  assert.equal((await finish(e, [A1, { criterion: 'A2', file: 'test/add.test.js', name: 'refuses text' }])).isError, false); assert.equal((await tk(t)).status, 'pr_ready')
})

// Bug 184: a commit that reached the branch after HQ's last look at it and before main moved stayed behind on the branch, and the ticket read merged. A `git` in
// front of the real one on HQ's PATH runs `before-ff` (once) as HQ moves main: the moment that commit has to land in. `late` sets it to commit `file` in t's worktree.
async function mergeHook(run: (late: (p: P, t: any, file: string, text?: string) => void) => Promise<void>): Promise<void> {
  await hq.stop()
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-git-'))), real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const hook = path.join(bin, 'before-ff'), q = JSON.stringify
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" merge --ff-only "*) if [ -f ${q(hook)} ]; then mv ${q(hook)} ${q(`${hook}.ran`)}; `
    + `sh ${q(`${hook}.ran`)}; fi;; esac\nexec ${q(real)} "$@"\n`, { mode: 0o755 })
  hq = await startHq({ env: { ...ENV, PATH: `${bin}:${process.env.PATH}` } })
  const late = (p: P, t: any, file: string, text = 'late\n') => {
    fs.writeFileSync(path.join(bin, `${path.basename(file)}.text`), text)
    fs.writeFileSync(hook, `cd ${q(wt(p, t))} && mkdir -p ${q(path.dirname(file))} && cp ${q(path.join(bin, `${path.basename(file)}.text`))} ${q(file)} && `
      + `${q(real)} add ${q(file)} && ${q(real)} commit -qm ${q(`late: ${file}`)}\n`)
  }
  try { await run(late); assert.ok(fs.existsSync(`${hook}.ran`), 'the commit landed as HQ merged') } finally { await hq.stop(); fs.rmSync(bin, { recursive: true, force: true }) }
}
test('Bug 184: a commit that lands while HQ merges is not left behind: the tested commit is in main, the ticket goes back for the rest, and open_pr again merges it',
  () => mergeHook(async (late) => {
    const p = await project('mergemove'), t = await withCriteria(p, 'Adding', [CRIT[0]]); await turnEnds(p)
    const e = await engineer(t); await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST })
    const first = sh(wt(p, t), 'rev-parse', 'HEAD')
    late(p, t, 'late.txt') // the engineer acts on a late message
    assert.equal((await finish(e, [A1])).isError, false)
    await until(t, 'implementing')
    assert.equal(sh(p.dir, 'log', '-1', '--format=%P', 'main').split(' ')[1], first, 'main has the commit HQ tested')
    assert.ok(fs.existsSync(path.join(p.dir, 'add.js'))); assert.equal(fs.existsSync(path.join(p.dir, 'late.txt')), false, 'and nothing after it')
    const moved = sql("SELECT payload FROM events WHERE kind = 'auto.moved'").map((x) => JSON.parse(x.payload))
    assert.deepEqual(moved.map((x) => [x.finished, x.merged, x.named, x.told]), [[first, true, false, e.id]])
    assert.equal(sql("SELECT 1 FROM events WHERE kind = 'ticket.merged'").length, 0, 'not marked merged with commits left over')
    const told = await waitFor('its engineer to be told', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e.id &&
      /the commit your open_pr handed over \(\w+\) is merged into main/.test(m.body)))
    assert.match(told.body, /got commits after it while it merged, and those aren't in main, so T-\d+ isn't finished yet\..+call open_pr again: HQ tests and merges the rest\.$/)
    assert.equal((await hq.state()).agents.find((a: any) => a.id === e.id).status, 'working', 'its engineer is kept on to finish it')
    const tpm = (await hq.state()).messages.find((m: any) => m.to_id === p.tpm.id && /tested commit/.test(m.body))
    assert.match(tpm.body, new RegExp(`^HQ: ${t.key}'s tested commit \\(${first.slice(0, 7)}\\) is merged into main, but its branch got commits while it merged that aren't in `
      + `main: "\\w+ late: late\\.txt"\\. So ${t.key} is building again: its engineer was told to finish them and call open_pr again`))
    // Its test is in main now, yet it is still this ticket's: open_pr again with the same test isn't refused for naming a file the branch didn't change
    const tip = sh(wt(p, t), 'rev-parse', 'HEAD') // read now: HQ removes the ticket's worktree once it merges (on Linux before the next line runs)
    const again = await finish(e, [A1]); assert.equal(again.isError, false, again.text)
    await until(t, 'merged'); assert.equal(fs.readFileSync(path.join(p.dir, 'late.txt'), 'utf8'), 'late\n')
    assert.equal(sh(p.dir, 'log', '-1', '--format=%P', 'main').split(' ')[1], tip)
    assert.equal(JSON.parse((await tk(t)).proof).tests[0].state, 'passed')
  }))
test('Bug 184: a ticket that came back after a late commit and is then sent back for its tests still counts the test it added in its merged part', () =>
  mergeHook(async (late) => {
    const p = await project('mergeback'), t = await withCriteria(p, 'Adding', [CRIT[0]]); await turnEnds(p)
    const e = await engineer(t); await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST })
    late(p, t, 'test/late.test.js', "require('node:test').test('late',()=>{throw new Error('late is broken')})\n") // a late commit that breaks the tests
    assert.equal((await finish(e, [A1])).isError, false); await until(t, 'implementing')
    const back = await finish(e, [A1]); assert.equal(back.isError, false, back.text) // accepted, tested: the late test fails, main alone passes
    await until(t, 'resolving'); assert.ok((await tk(t)).fixing, 'sent back for its tests')
    await waitFor('HQ to tell the engineer', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e.id && /fails its tests/.test(m.body)))
    sh(wt(p, t), 'merge', '--no-edit', 'main') // as HQ's instructions say, then the fix
    fs.writeFileSync(path.join(wt(p, t), 'test', 'late.test.js'), PASS); sh(wt(p, t), 'add', '.'); sh(wt(p, t), 'commit', '-qm', 'fix late'); await ranTests(e)
    const fixed = await finish(e); assert.equal(fixed.isError, false, fixed.text) // its earlier tests, checked again: test/add.test.js is still the ticket's
    await until(t, 'merged'); assert.ok(fs.existsSync(path.join(p.dir, 'test', 'late.test.js')))
  }))
test('Bug 184: on auto its engineer has stopped by the time a late commit lands: the fresh one and the TPM are told what is merged and what is left', () =>
  mergeHook(async (late) => {
    const p = await project('mergegone'), t = await ticket(p, 'Thing')
    assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: HELD })).status, 200); await turnEnds(p)
    await onPage(p, 'no ticket:main:running'); await letGo(p); await waitFor('main checked', async () => (await checks())[0])
    const e = await engineer(t); await work(p, t, e, { 'thing.js': '1\n' }); const first = sh(wt(p, t), 'rev-parse', 'HEAD')
    await hq.hook(e.id, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    await waitFor('the finished engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === e.id)?.status === 'exited')
    late(p, t, 'late.txt'); await onPage(p, `${t.id}:ticket:running`); await letGo(p) // by hand, say, as HQ merges
    const e2 = await engineer(t, e.id); assert.equal((await tk(t)).status, 'implementing')
    const lateSha = sh(wt(p, t), 'rev-parse', '--short', 'HEAD')
    assert.match(prompt(e2.id), new RegExp(`Its plan is approved \\(below\\) and it was finished once\\. HQ already merged the commit an earlier open_pr handed over `
      + `\\(${first.slice(0, 7)}\\) into main, as it passed HQ's tests: that part of the ticket is done, don't redo it\\. These commits came after it, while it merged, and aren't `
      + `in main yet:\\n- ${lateSha} late: late\\.txt\\nCheck they finish what they started, run the tests, commit, then call open_pr again \\(with the same tests\\): HQ tests `
      + 'them and merges them\\.'))
    const toTpm = (await hq.state()).messages.filter((m: any) => m.to_id === p.tpm.id).map((m: any) => m.body)
    assert.ok(toTpm.some((b: string) => b.startsWith(`HQ: ${t.key}'s tested commit (${first.slice(0, 7)}) is merged into main`) && /a fresh engineer will finish them/.test(b)), toTpm.join('\n'))
    const started = toTpm.find((b: string) => b.startsWith(`HQ: engineer ${e2.id} started on ${t.key}`))
    assert.match(started, /to take over after a fresh start \(branch/, 'no handoff note was left, and the TPM isn\'t told there was one')
    await openPr(e2); await onPage(p, `${t.id}:ticket:running`); await letGo(p); await until(t, 'merged')
    assert.ok(fs.existsSync(path.join(p.dir, 'late.txt')))
  }))

// HQ's look at the app before a merge (smoke.ts). The browser's part is a stand-in here (fake-look.mjs): what it "sees" is the checkout's look.json, so main
// and a ticket's branch each say how their app looks. The real browser, in the real sandbox, is src/smoke.test.ts.
const startCmd = async (p: P, command = 'node server.js') => assert.equal((await hq.api(`previews/${p.repo.id}/command`, { command })).status, 200) // the user's own ⚙ command
const lookOf = async (t: any) => JSON.parse((await tk(t)).merge_test).look
const looks = () => sql("SELECT payload FROM events WHERE kind = 'auto.looked' ORDER BY id").map((e) => JSON.parse(e.payload)).map((l) => `${l.key} ${l.ran}${l.compared ? ' compared' : ''}`)
const onMain = (p: P, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(p.dir, f), text)
  sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'app')
}

test('HQ opens the app before it merges: a clean look is on the merged ticket and in the summary, and the board says so while it looks', async () => {
  const p = await project('look'); onMain(p, { 'look.json': JSON.stringify({ wait: 'go' }) }); await startCmd(p)
  const t = await ticket(p, 'Thing'); await turnEnds(p)
  await waitFor('main checked', async () => (await checks())[0]) // the tests only: the look is for a ticket about to merge
  await work(p, t, await engineer(t), { 'thing.txt': '1\n' })
  await onPage(p, `${t.id}:look:running`); await letGo(p) // the tests passed; the same run is now opening the app
  // Bug 192: merged, the ticket is off the board. The run may already be ending, and the UI tester on the page, before or after this look
  await until(t, 'merged'); assert.match(await shown(p), /^(no ticket:tester:(waiting|running))?$/)
  assert.deepEqual(await lookOf(t), { ran: 'pass', pages: 1, ms: 5, known: 0, offline: [] }); assert.deepEqual(looks(), [`${t.key} pass`]) // a clean app is opened once
  await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`- ${t.key}: Thing \\(tests passed: 1 passed, (\\d+|under 1) s; app opened, 1 page\\)`)); assert.doesNotMatch(r.summary, /Worth a look/)
  assert.equal(await shown(p), '') // the tester, if it ran, was over before the run ended
  assert.equal(sh(p.dir, 'status', '--porcelain'), ''); assert.equal(sh(p.dir, 'worktree', 'list').split('\n').filter((l) => l.includes('hq-test')).length, 0)
})

test('a ticket that breaks a page goes back to its engineer with what HQ saw; what main already had is not held against any ticket', async () => {
  const p = await project('lookfail'); onMain(p, { 'look.json': JSON.stringify({ pages: [{ console: ['old noise'] }] }) }); await startCmd(p)
  const t1 = await ticket(p, 'Quiet'), t2 = await ticket(p, 'Loud'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2)
  await work(p, t1, e1, { 'one.txt': '1\n' }); await until(t1, 'merged')
  assert.deepEqual(await lookOf(t1), { ran: 'pass', pages: 1, ms: 5, known: 1, offline: [] }) // main logs that error too
  await work(p, t2, e2, { 'look.json': JSON.stringify({ pages: [{ console: ['old noise', 'boom from the page'] }, { path: '/list', text: 0, things: 0 }] }) })
  await until(t2, 'resolving'); assert.equal((await tk(t2)).fixing, 'look'); assert.equal(fs.existsSync(path.join(p.dir, 'one.txt')), true)
  const told = await waitFor('HQ to tell the engineer', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e2.id &&
    /the app has problems/.test(m.body)))
  assert.match(told.body, /passes its tests, but the app has problems when HQ opens it with your ticket merged in, so HQ didn't merge it\.\n\n/)
  assert.match(told.body, /merge it\.\n\nHQ started the app the way its preview does \(node server\.js\) and opened its pages in a headless browser\.\n/)
  assert.match(told.body, /The app has 2 problems with it merged in that main doesn't have\.\n- \/: error in the console: boom from the page\n- \/list: the page is blank: /)
  assert.doesNotMatch(told.body, /old noise|fails its tests/); assert.match(told.body, /A real browser can't start in your session/)
  assert.deepEqual(await cameBack(e2.id), [`${t2.key} came back: HQ's look at the app found something wrong`]) // Bug 206: not "tests fail"
  await hq.api(`agents/${e2.id}/stop`, {}) // gone before it fixed it: the next engineer is told the same, and the board never calls it a test failure
  const e3 = await engineer(t2, e2.id)
  assert.match(prompt(e3.id), /It was fixing what went wrong when HQ opened the app with it on main; HQ's instructions for that are below\.[\s\S]*boom from the page/)
  const w = wt(p, t2); sh(w, 'merge', '--no-edit', 'main'); fs.writeFileSync(path.join(w, 'look.json'), JSON.stringify({ pages: [{ console: ['old noise'] }, { path: '/list' }] }))
  sh(w, 'add', '.'); sh(w, 'commit', '-qm', 'no boom'); await openPr(e3)
  await until(t2, 'merged'); assert.deepEqual(await lookOf(t2), { ran: 'pass', pages: 2, ms: 5, known: 1, offline: [] }); assert.equal((await tk(t2)).fixing, null)
  assert.deepEqual(looks(), [`${t1.key} pass compared`, `${t2.key} fail compared`, `${t2.key} pass compared`])
})

test('HQ never holds against a ticket what it couldn\'t look at: an app that doesn\'t start on main either, a look turned off in settings', async () => {
  const p = await project('nolook'), dead = { kind: 'no_start', why: 'its app part stopped (1) while the app was starting', output: 'Error: no database' }
  onMain(p, { 'look.json': JSON.stringify(dead) }); await startCmd(p)
  assert.equal((await hq.api('settings', { key: 'concurrency_cap', value: 3 })).status, 200)
  const t1 = await ticket(p, 'One'), t2 = await ticket(p, 'Two'), t3 = await ticket(p, 'Three'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2), e3 = await engineer(t3)
  const dead1 = { ran: 'skipped', why: "the app doesn't start on main either (its app part stopped (1) while the app was starting)", dead: true }
  await work(p, t1, e1, { 'one.txt': '1\n' }); await until(t1, 'merged'); assert.deepEqual(await lookOf(t1), dead1)
  assert.deepEqual(looks(), [`${t1.key} skipped compared`]) // opened with the ticket, then on main alone: it starts on neither
  await work(p, t3, e3, { 'three.txt': '3\n' }); await until(t3, 'merged'); assert.deepEqual(await lookOf(t3), dead1)
  assert.deepEqual(looks(), [`${t1.key} skipped compared`], 'for the rest of the run HQ doesn\'t start an app it knows won\'t start')
  assert.equal((await hq.api('settings', { key: 'app_look', value: 'off' })).status, 200); assert.equal((await hq.api('settings', { key: 'app_look', value: 'maybe' })).status, 400)
  await work(p, t2, e2, { 'two.txt': '2\n' }); await until(t2, 'merged')
  assert.deepEqual(await lookOf(t2), { ran: 'skipped', why: "opening the app before a merge is turned off in HQ's settings", quiet: true })
  await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`## Worth a look\\n- ${t1.key}, ${t3.key}: app not opened: the app doesn't start on main either[^\\n]+$`)) // said once, for both
})

// HQ's plan check (plancheck.ts): on auto a fresh reader sees a ticket's criteria and its plan before the plan is approved. The reader here is the fake Claude
// Code's `-p` mode (fake-claude.mjs): a `FAKE-CHECK:` line in what it reads is its answer; with none it finds nothing. Each call is logged, so a test can count them.
const readerCalls = (): any[] => { try { return fs.readFileSync(path.join(hq.home, 'fake-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } }
const says = (verdict: string, ...findings: [string, string][]) => `FAKE-CHECK: ${JSON.stringify({ verdict, findings: findings.map(([about, problem]) => ({ about, problem })) })}`
const reviewsOf = async (t: any) => (await hq.state()).reviews.filter((r: any) => r.ticket_id === t.id).sort((a: any, b: any) => b.round - a.round)
const planCheck = async (t: any, round?: number) => { const r = (await reviewsOf(t)).find((x: any) => !round || x.round === round); return r?.plan_check ? JSON.parse(r.plan_check) : null }
const plan = (e: any, text: string) => hq.hook(e.id, exitPlanMode(text))
const verdict = (h: any): string => h.hookSpecificOutput.decision.behavior
const CANT = { criterion: 'A2', cant_test: 'Bold is a matter of looks: this project has no way to render a page.' }

test('on auto a plan is read against the ticket\'s criteria before it is approved: a clean one goes ahead, and the reader saw the criteria and the plan only', async () => {
  const p = await project('plancheck'), t = await withCriteria(p, 'Adding', CRIT, { spec: 'SPEC-TEXT-THE-READER-NEVER-SEES' }); await turnEnds(p)
  const e = await engineer(t), text = '## In plain words\nAdds numbers.\n\n1. add.js\n2. a test'
  assert.equal(verdict(await plan(e, text)), 'allow')
  const calls = readerCalls(); assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, `## Acceptance criteria\n- A1 (behind the screen): Adding 2 and 3 gives 5.\n- A2 (screen): The total is shown in bold.\n\n## The engineer's plan\n${text}\n`)
  assert.equal(calls[0].tools, ''); assert.match(calls[0].system, /^You are a second reader/); assert.doesNotMatch(JSON.stringify(calls[0]), /SPEC-TEXT/)
  const c = await planCheck(t); assert.deepEqual({ ...c, at: 0, ms: 0 }, { state: 'ok', at: 0, ms: 0, tokens: 1802, model: 'opus' })
  assert.equal((await tk(t)).status, 'implementing'); assert.equal((await reviewsOf(t))[0].closed_reason, 'approve')
  assert.deepEqual(sql("SELECT payload FROM events WHERE kind = 'gate.verdict'").map((x) => JSON.parse(x.payload).by), ['plan_check'])
})

test('a plan that misses a criterion goes back once with what the reader found; the next plan is approved as it stands, and the summary says what happened', async () => {
  const p = await project('planback'), t = await withCriteria(p, 'Adding', CRIT); await turnEnds(p)
  const e = await engineer(t)
  const back = await plan(e, `Plan one.\n${says('send_back', ['a2', 'No step shows the total in bold.'], ['style', 'Rename things more nicely, please.'],
    ['extra', 'Step 3 adds a dark mode no criterion asks for.'])}`)
  assert.equal(verdict(back), 'deny'); const msg = back.hookSpecificOutput.decision.message
  assert.match(msg, /^HQ's plan check sent your plan back\. A fresh reader saw only the ticket's acceptance criteria and your plan, and found:\n- A2: No step shows the total in bold\.\n/)
  assert.match(msg, /- extra: Step 3 adds a dark mode no criterion asks for\.\nChange the plan .* This check happens once: your next plan is approved as it stands\.$/)
  assert.doesNotMatch(msg, /Rename/) // a finding has to be about a criterion, or about something extra
  assert.equal((await tk(t)).status, 'planning'); assert.deepEqual((await planCheck(t)).findings.map((f: any) => f.about), ['A2', 'extra'])
  assert.equal(verdict(await plan(e, `Plan two.\n${says('send_back', ['A1', 'A reader would send this one back too.'])}`)), 'allow')
  assert.equal(readerCalls().length, 1, 'one read, one send-back'); assert.equal(await planCheck(t, 2), null)
  await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST }, { plan: false }); assert.equal((await finish(e, [A1, CANT])).isError, false)
  await until(t, 'merged'); await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`## Worth a look\\n- ${t.key}: its plan was sent back once \\(A2: No step shows the total in bold\\. extra: Step 3 adds a dark mode[^\\n]+\\)\\n`))
})

test('a plan check that can\'t run never holds an engineer: asked twice, then the plan is approved unchecked and the summary says so', async () => {
  const p = await project('plandown'), t = await withCriteria(p, 'Adding', CRIT); await turnEnds(p)
  const e = await engineer(t)
  assert.equal(verdict(await plan(e, 'Plan.\nFAKE-CHECK: error')), 'allow') // held through both tries
  assert.equal(readerCalls().length, 2); assert.deepEqual({ ...await planCheck(t), at: 0 }, { state: 'unchecked', at: 0, why: "the check couldn't run (API Error: Overloaded)" })
  await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST }, { plan: false }); assert.equal((await finish(e, [A1, CANT])).isError, false)
  await until(t, 'merged'); await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`- ${t.key}: its plan wasn't checked: the check couldn't run \\(API Error: Overloaded\\)\\n`))
})

test('what the plan check leaves alone: a ticket with no criteria, and every plan once it is turned off in settings', async () => {
  const p = await project('planoff'), t1 = await ticket(p, 'Plain'), t2 = await withCriteria(p, 'Adding', CRIT); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2)
  assert.equal(verdict(await plan(e1, `Plan.\n${says('send_back', ['A1', 'Nothing here to check it against.'])}`)), 'allow')
  assert.equal((await hq.api('settings', { key: 'plan_check', value: 'off' })).status, 200)
  assert.equal(verdict(await plan(e2, `Plan.\n${says('send_back', ['A1', 'It would have gone back with the check on.'])}`)), 'allow')
  assert.deepEqual(readerCalls(), []); assert.equal(await planCheck(t1), null); assert.equal(await planCheck(t2), null)
  assert.deepEqual(sql("SELECT payload FROM events WHERE kind = 'gate.verdict'").map((x) => JSON.parse(x.payload).by), ['auto', 'auto'])
})

test('a plan check ends with what it was for: a restart reads the plan afresh, and auto off hands the plan to the user with no reader left running', async () => {
  const p = await project('planstop'), t = await withCriteria(p, 'Adding', CRIT); await turnEnds(p)
  const e = await engineer(t), text = 'Plan.\nFAKE-CHECK: hang', gone = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }
  plan(e, text).catch(() => {}) // its connection goes with the backend
  await waitFor('the reader to have it', async () => (await planCheck(t))?.state === 'checking'); const first = readerCalls()[0].pid
  await hq.restart(); await waitFor('the first reader to end', () => gone(first), 5000)
  const held = plan(e, text) // Claude Code asks again, and is held for the same review
  await waitFor('a fresh read', async () => readerCalls().length === 2 && (await planCheck(t))?.state === 'checking'); const second = readerCalls()[1].pid
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  await waitFor('the second reader to end', () => gone(second), 5000); await waitFor('the page to say so', async () => (await planCheck(t)) === null)
  const open = (await reviewsOf(t))[0]; assert.equal(open.status, 'open'); await looked(); assert.ok(await pending(held), 'it waits for the user now')
  assert.equal((await hq.api(`reviews/${open.id}/answer`, { verdict: 'approve' })).status, 200); assert.equal(verdict(await held), 'allow')
  assert.equal(readerCalls().length, 2)
  assert.deepEqual(sql("SELECT kind FROM events WHERE kind LIKE 'plan_check.%' ORDER BY id").map((x) => x.kind), ['plan_check.started', 'plan_check.started']) // neither answered or failed
})

// Bug 177: Clear and Remove end a plan check under way, as turning auto off does; nothing it would have said lands on the project, and no new reader starts.
async function readerOnPlan(name: string) {
  const p = await project(name), t = await withCriteria(p, 'Adding', CRIT); await turnEnds(p)
  const e = await engineer(t); plan(e, 'Plan.\nFAKE-CHECK: hang').catch(() => {}) // the engineer is stopped below: its held call ends with it
  await waitFor('the reader to have it', async () => (await planCheck(t))?.state === 'checking')
  return { p, t, e, pid: readerCalls()[0].pid as number }
}
const gone = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }
const planEnds = () => sql("SELECT kind FROM events WHERE kind IN ('plan_check.answered', 'plan_check.failed', 'gate.verdict')")
test('Bug 177: Clear project ends a plan check at once, while the TPM still writes its note, and nothing follows from it', async () => {
  const { p, t, pid } = await readerOnPlan('planclear')
  const t2 = await withCriteria(p, 'Subtracting', CRIT), e2 = await engineer(t2) // still at work when the Clear comes: it is asked for a note, not stopped
  const r = await hq.api(`repos/${p.repo.id}/clear`, {}); assert.equal(r.status, 200); assert.equal(r.json.done, false, 'the clear waits for the TPM\'s note')
  assert.ok(r.json.noting.includes(e2.display_name), `${e2.display_name} writes its note: ${JSON.stringify(r.json)}`)
  await waitFor('the reader to end', () => gone(pid), 5000)
  // A plan that comes late, then the auto loop round again. Bug 323: it came from the engineer the Clear had stopped, whose token was gone, so it
  // never reached HQ. This one comes from the engineer still writing its note: HQ takes it (its review opens) and starts no reader for it.
  const drop = new AbortController(), late = hq.hook(e2.id, exitPlanMode('Plan.\nFAKE-CHECK: hang'), drop.signal)
  await Promise.race([waitFor('HQ to have the late plan', async () => (await reviewsOf(t2))[0]?.status === 'open'),
    late.then((x) => { throw new Error(`the late plan was answered at once: ${JSON.stringify(x)}`) })])
  await looked()
  assert.equal(readerCalls().length, 1, 'no new reader on a project being cleared'); assert.deepEqual(planEnds(), [], 'no answer, no verdict')
  assert.ok((await repoNow(p)).clearing_at, 'the clear is still under way: the check didn\'t wait for it to finish')
  for (const x of [t, t2]) assert.equal((await reviewsOf(x))[0]?.plan_check ?? null, null, 'the page doesn\'t say a reader has it')
  drop.abort(); await late.catch(() => {})
})
test('Bug 177: Remove from HQ ends a plan check at once, and nothing follows from it', async () => {
  const { p, pid } = await readerOnPlan('planremove')
  assert.equal((await hq.api(`repos/${p.repo.id}/remove`, {})).status, 200)
  await waitFor('the reader to end', () => gone(pid), 5000); await looked()
  assert.equal(readerCalls().length, 1); assert.deepEqual(planEnds(), [])
  assert.equal((await hq.state()).repos.some((x: any) => x.id === p.repo.id), false)
})

// HQ's diff check (diffcheck.ts): before a ticket worth a second look merges, a fresh reader sees its criteria, its changes and the test output. The reader is
// the fake Claude Code again: a `FAKE-CHECK:` line in a file the ticket adds is in its diff, and so is the reader's answer.
const diffCheck = async (t: any) => JSON.parse((await tk(t)).diff_check ?? 'null')
const reads = () => readerCalls().filter((c) => /finished software ticket/.test(c.system)) // not the plan checks
const SUB_TEST = "const t=require('node:test'),a=require('node:assert');t.test('subtracts',()=>{a.equal(require('../sub').sub(5,3),2)})\n", SUB = 'exports.sub=(a,b)=>a-b\n'
const S1 = { criterion: 'A1', file: 'test/sub.test.js', name: 'subtracts' }

test('a ticket worth a second look is read before it merges: findings send it back once in the reader\'s words; fixed, it merges without another read', async () => {
  const p = await project('diffcheck'), t = await withCriteria(p, 'Adding', CRIT, { size: 'M' }); await turnEnds(p)
  const e = await engineer(t); assert.equal(verdict(await plan(e, 'PLAN-TEXT-THE-READER-NEVER-SEES')), 'allow')
  const found = says('send_back', ['A1', 'add() subtracts: it should add.'], ['bug', 'add.js: add("2", 3) gives "23", not 5.'], ['style', 'Use a named function, it reads better.'])
  await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST, 'notes.txt': `${found}\n` }, { plan: false }); assert.equal((await finish(e, [A1, CANT])).isError, false)
  await until(t, 'resolving'); assert.equal((await tk(t)).fixing, 'review'); assert.equal(fs.existsSync(path.join(p.dir, 'add.js')), false, 'not merged')
  const [call] = reads(); assert.equal(reads().length, 1)
  assert.match(call.prompt, /^## Acceptance criteria\n- A1 \(behind the screen\): Adding 2 and 3 gives 5\.\n- A2 [^\n]+\n\n## The changes, as a diff against the main branch\n/)
  assert.match(call.prompt, /main branch\nChanged files:\n add\.js/)
  assert.match(call.prompt, /\+exports\.add=\(a,b\)=>a\+b\n/); assert.match(call.prompt, /## What the test run printed \(`npm test`, which passed\)\n[\s\S]*ℹ pass 2/)
  assert.doesNotMatch(call.prompt, /PLAN-TEXT/) // the changes, not the engineer's account of them
  const told = await waitFor('HQ to tell the engineer', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e.id && /a fresh reader/.test(m.body)))
  assert.match(told.body, /passes its tests, but a fresh reader of your changes found problems, so HQ didn't merge it\./)
  assert.match(told.body, /What the reader found:\n- A1: add\(\) subtracts: it should add\.\n- bug: add\.js: add\("2", 3\) gives "23", not 5\.\n\nFix it now/)
  assert.doesNotMatch(told.body, /named function/) // not about a criterion, not a bug: never reaches the engineer
  assert.deepEqual(await cameBack(e.id), [`${t.key} came back: a fresh reader of its changes found something to fix`]) // Bug 206: not "tests fail"
  const d = await diffCheck(t); assert.equal(d.state, 'sent_back'); assert.deepEqual(d.why, ['it is a size M ticket', 'one of its criteria has no test'])
  const w = wt(p, t); fs.writeFileSync(path.join(w, 'add.js'), `${ADD}// fixed\n`); sh(w, 'add', '.'); sh(w, 'commit', '-qm', 'fixed'); assert.equal((await finish(e)).isError, false)
  await until(t, 'merged'); assert.equal(reads().length, 1, 'one read, one send-back'); assert.equal((await tk(t)).auto_tries, 1); assert.equal((await tk(t)).fixing, null)
  await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`- ${t.key}: HQ's read of its changes sent it back once \\(A1: add\\(\\) subtracts: it should add\\. bug: add\\.js: [^\\n]+\\)\\n`))
})

// Bug 185: the reader read a ticket once, so a commit a second open_pr named merged unread
test('Bug 185: a commit named by a second open_pr is read too; the same commit tested again (main moved during its test) is not read again', async () => {
  const p = await project('diffagain'), t = await withCriteria(p, 'Adding', [CRIT[0]], { size: 'M' })
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: `${HELD}; node --test` })).status, 200); await turnEnds(p)
  await onPage(p, 'no ticket:main:running'); await letGo(p); await waitFor('main checked', async () => (await checks())[0])
  const e = await engineer(t); await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST, 'notes.txt': 'FAKE-CHECK: hold read185-go\n' })
  assert.equal((await finish(e, [A1])).isError, false); const first = (await tk(t)).finished_sha
  await onPage(p, `${t.id}:ticket:running`); await letGo(p); await onPage(p, `${t.id}:review:running`); await waitFor('the first read', () => reads().length === 1)
  commit(p, t, 'late.txt'); fs.writeFileSync(path.join(hq.home, 'read185-go'), '') // a commit after its open_pr, while the reader has it (Bug 208: one during the test isn't read)
  await until(t, 'implementing'); assert.doesNotMatch(reads()[0].prompt, /late\.txt/); assert.equal(fs.existsSync(path.join(p.dir, 'add.js')), false, 'not merged')
  const d1 = await diffCheck(t); assert.equal(d1.state, 'ok')
  const back = diffCheckWords(d1, await tk(t))!.text // Bug 207: read, then sent back to building: it didn't merge
  assert.match(back, new RegExp(`read its changes at commit ${first.slice(0, 7)} `)); assert.doesNotMatch(back, /merged/)
  await openPr(e); const second = (await tk(t)).finished_sha; assert.notEqual(second, first)
  await onPage(p, `${t.id}:ticket:running`); onMain(p, { 'other.txt': 'other\n' }) // main moves during this test: the next tick tests the same commit again
  await letGo(p); await waitFor('the second read', () => reads().length === 2); assert.match(reads()[1].prompt, /late\.txt/, 'it read the new commit')
  await onPage(p, `${t.id}:ticket:running`); assert.equal((await tk(t)).status, 'pr_ready', 'tested again, not merged yet')
  await letGo(p); await until(t, 'merged'); assert.equal(reads().length, 2, 'the same commit is not read twice')
  const d = await diffCheck(t); assert.equal(d.state, 'ok'); assert.deepEqual([d1.sha, d.sha], [first, second], 'each read says which commit it read')
  assert.match(diffCheckWords(d, await tk(t))!.text, /^A fresh reader read its changes before it merged /, 'merged with the commit read')
  const lines = ((await hq.api('events?limit=500')).json as any[]).filter((x) => x.kind === 'auto.read').map((x) => JSON.parse(x.payload).again)
  assert.deepEqual(lines.sort(), [false, true])
})
// Bug 208: HQ read a ticket's changes before it looked whether its branch had moved, so a commit during the test cost a read of a commit it won't merge
test('Bug 208: a commit during the test of a ticket worth a read sends it back unread; the commit open_pr names next is read once and merges', async () => {
  const p = await project('readmoved'), t = await withCriteria(p, 'Adding', [CRIT[0]], { size: 'M' })
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: `${HELD}; node --test` })).status, 200); await turnEnds(p)
  await onPage(p, 'no ticket:main:running'); await letGo(p); await waitFor('main checked', async () => (await checks())[0])
  const e = await engineer(t); await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST }); assert.equal((await finish(e, [A1])).isError, false)
  await onPage(p, `${t.id}:ticket:running`); commit(p, t, 'late.txt') // a commit after its open_pr, during its test
  await letGo(p); await until(t, 'implementing')
  assert.equal(reads().length, 0, 'nothing read'); assert.equal(await diffCheck(t), null); assert.equal(fs.existsSync(path.join(p.dir, 'add.js')), false, 'not merged')
  assert.equal(sql("SELECT kind FROM events WHERE kind = 'auto.read'").length, 0)
  await waitFor('its engineer to be told', async () => (await hq.state()).messages.some((m: any) => m.to_id === e.id && /commits from after your open_pr/.test(m.body)))
  await openPr(e); await onPage(p, `${t.id}:ticket:running`); await letGo(p); await until(t, 'merged')
  assert.equal(reads().length, 1, 'the commit it merged is read once'); assert.match(reads()[0].prompt, /late\.txt/)
  const d = await diffCheck(t); assert.equal(d.state, 'ok'); assert.equal(d.sha, (await tk(t)).finished_sha)
})

test('a small ticket with nothing flagged merges unread; one that deletes a test is read, and a reader with nothing to say lets it merge', async () => {
  const p = await project('diffwhen'); onMain(p, { 'test/old.test.js': PASS })
  const t1 = await withCriteria(p, 'Small', [CRIT[0]]), t2 = await withCriteria(p, 'Deletes', [CRIT[0]]); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2)
  assert.equal(verdict(await plan(e1, 'Plan.')), 'allow'); await build(p, t1, e1, { 'add.js': ADD, 'test/add.test.js': ADD_TEST }, { plan: false })
  assert.equal((await finish(e1, [A1])).isError, false); await until(t1, 'merged')
  assert.equal(await diffCheck(t1), null); assert.equal(reads().length, 0) // size S, a test for its criterion, nothing flagged: no tokens spent
  assert.equal(verdict(await plan(e2, 'Plan.')), 'allow'); fs.rmSync(path.join(wt(p, t2), 'test', 'old.test.js'))
  await build(p, t2, e2, { 'sub.js': SUB, 'test/sub.test.js': SUB_TEST }, { plan: false }); assert.equal((await finish(e2, [S1])).isError, false); await until(t2, 'merged')
  const d = await diffCheck(t2); assert.equal(d.state, 'ok'); assert.deepEqual(d.why, ['it deleted tests']); assert.equal(reads().length, 1)
  assert.match(reads()[0].prompt, /deleted file mode[\s\S]*test\/old\.test\.js|test\/old\.test\.js[\s\S]*deleted file mode/)
  await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`- ${t2.key}: deleted tests: test/old\\.test\\.js`)); assert.doesNotMatch(r.summary, /read of its changes|weren't read/)
})

test('a read that can\'t be had never holds a merge, and the summary says nobody read it; turned off in settings, nothing is read', async () => {
  const p = await project('diffdown'), t1 = await withCriteria(p, 'One', [CRIT[0]], { size: 'L' }), t2 = await withCriteria(p, 'Two', [CRIT[0]], { size: 'L' }); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2)
  assert.equal(verdict(await plan(e1, 'Plan.')), 'allow'); await build(p, t1, e1, { 'add.js': ADD, 'test/add.test.js': ADD_TEST, 'notes.txt': 'FAKE-CHECK: error\n' }, { plan: false })
  assert.equal((await finish(e1, [A1])).isError, false); await until(t1, 'merged')
  assert.deepEqual({ ...await diffCheck(t1), at: 0 }, { state: 'unchecked', at: 0, why: ['it is a size L ticket'], error: "the reader couldn't be asked (API Error: Overloaded)",
    sha: (await tk(t1)).finished_sha })
  assert.equal((await hq.api('settings', { key: 'diff_check', value: 'off' })).status, 200)
  assert.equal(verdict(await plan(e2, 'Plan.')), 'allow')
  await build(p, t2, e2, { 'sub.js': SUB, 'test/sub.test.js': SUB_TEST, 'notes2.txt': `${says('send_back', ['bug', 'It would have gone back with the check on.'])}\n` }, { plan: false })
  assert.equal((await finish(e2, [S1])).isError, false); await until(t2, 'merged'); assert.equal(await diffCheck(t2), null); assert.equal(reads().length, 1)
  await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`- ${t1.key}: its changes weren't read before it merged: the reader couldn't be asked \\(API Error: Overloaded\\)`))
})

test('auto off while a reader has a ticket ends the read at once: nothing merges or goes back, and the board said what HQ was doing', async () => {
  const p = await project('diffstop'), t = await withCriteria(p, 'Adding', [CRIT[0]], { size: 'M' }); await turnEnds(p)
  const e = await engineer(t); assert.equal(verdict(await plan(e, 'Plan.')), 'allow')
  await build(p, t, e, { 'add.js': ADD, 'test/add.test.js': ADD_TEST, 'notes.txt': 'FAKE-CHECK: hang\n' }, { plan: false }); assert.equal((await finish(e, [A1])).isError, false)
  await onPage(p, `${t.id}:review:running`); await waitFor('the reader to start', () => reads().length === 1)
  const pid = reads()[0].pid; assert.ok(alive(pid))
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  await waitFor('the reader to end', () => !alive(pid), 5000); await waitFor('the board to say so', async () => (await shown(p)) === '')
  const now = await tk(t); assert.equal(now.status, 'pr_ready'); assert.equal(now.auto_tries, 0); assert.equal(now.diff_check, null); assert.equal(fs.existsSync(path.join(p.dir, 'add.js')), false)
  assert.equal((await hq.api('settings', { key: 'diff_check', value: 'off' })).status, 200); assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  await until(t, 'merged'); assert.equal(reads().length, 1)
})

// The UI tester (uitester.ts): as a run ends, a code-blind tester uses the whole app in a browser. Its host (uitesthost.mjs) is real here: the app runs under
// it in the sandbox and it resets the app before each scenario. The fake Claude Code starts no browser: it plans two scenarios, and for each does what the
// scenario tools and Claude Code's hooks would against the host (fake-claude.mjs). `FAKE-PLAN:` / `FAKE-UITEST:` in a criterion's text say what to answer.
// The browser's own sandbox, with a real browser, is src/uitester.test.ts. On Linux the tester doesn't run yet (its browser's sandbox is macOS's).
const MAC = process.platform === 'darwin'
const UI = (text: string) => ({ kind: 'ui', text })
const NO_TEST = { criterion: 'A1', cant_test: 'It is about what the screen shows, and nothing here can render a page.' }
const uiTestBy = async (p: P) => JSON.parse((await runs(p))[0]?.ui_test ?? 'null')
const planCalls = () => readerCalls().filter((c) => /^You plan how to test/.test(c.system))
const testerCalls = () => readerCalls().filter((c) => /^You are testing a web app/.test(c.system))
const finished = (p: P, n = 1) => waitFor(`run ${n} to finish`, async () => {
  const done = (await runs(p)).filter((x: any) => x.status === 'finished'); return done.length >= n ? done[0] : null }, 30_000)
/** A ticket from plan to merge: its files, and the tests it names. */
async function ship(p: P, t: any, files: Record<string, string>, tests: unknown): Promise<void> {
  const e = await engineer(t); assert.equal(verdict(await plan(e, 'Plan.')), 'allow')
  await build(p, t, e, files, { plan: false }); const r = await finish(e, tests); assert.equal(r.isError, false, r.text); await until(t, 'merged', 30_000)
}

test('as a run ends the UI tester uses the whole app: scenarios from what is new, each reset first, and findings with replayable steps in the summary', async () => {
  const p = await project('uitester'); await startCmd(p, 'npm start') // a start that forks: each reset has to end npm's server too (Bug 170)
  assert.equal((await hq.api('settings', { key: 'app_look', value: 'off' })).status, 200) // the look before each merge has its own switch: off, the tester still runs
  const found = { 's-02': { outcome: 'problem', notes: ['Looked for an error message'], findings: [{ kind: 'no_feedback', at_step: 2, what: 'Pressing Add with no name showed nothing.',
    expected: 'A message saying a name is needed', criterion: 'A1', looked_for: { role: 'alert' } }, { kind: 'odd', at_step: 1, what: 'Not a kind HQ knows of.', expected: '' }] } }
  const t1 = await withCriteria(p, 'Label', [UI(`Books near their due date say "Due soon". FAKE-UITEST: ${JSON.stringify(found)}`)]), t2 = await withCriteria(p, 'Adding', [CRIT[0]])
  await turnEnds(p)
  await ship(p, t1, { 'label.js': '1\n' }, [NO_TEST]); await ship(p, t2, { 'add.js': ADD, 'test/add.test.js': ADD_TEST }, [A1]); await turnEnds(p)
  const r = await finished(p)
  if (!MAC) { assert.match(r.summary, /## Tried in a browser\n- Not tried: the UI tester runs on macOS only for now/); assert.equal(planCalls().length, 0); return }
  assert.match(r.summary, /## Tried in a browser\n- 2 scenarios: 1 fine, 1 finding, 0 unspecified\n/)
  assert.match(r.summary, new RegExp(`\\n- U1 \\(no feedback, s-02 Add nothing, ${t1.key} A1\\): Pressing Add with no name showed nothing\\. Expected: A message saying a name is needed `
    + 'Steps: open / → click button "Add"\\n- s-01 See the list: fine\\n'))
  const tried = /## Tried in a browser\n[\s\S]*?(?=\n## |$)/.exec(r.summary)![0] // the criteria's own text (with the fake's script in it) may be listed elsewhere
  assert.doesNotMatch(tried, /Not a kind HQ knows/) // a finding has to be one of the kinds the tester is given
  const [pc] = planCalls(); assert.equal(planCalls().length, 1); assert.equal(pc.model, 'sonnet'); assert.equal(pc.tools, '')
  assert.match(pc.prompt, new RegExp(`## What's new\\n- \\[${t1.key} A1\\] Books near their due date say "Due soon"\\.`)); assert.doesNotMatch(pc.prompt, /Adding 2 and 3/) // screen criteria only
  const [tc] = testerCalls(); assert.equal(testerCalls().length, 1, 'two scenarios: one session'); assert.equal(tc.model, 'sonnet'); assert.equal(tc.tools, '') // no Bash, Read, Edit, Write
  assert.match(tc.prompt, /### s-01 \(basic\): See the list\n[\s\S]*### s-02 \(weird\): Add nothing\n/)
  const u = await uiTestBy(p); assert.equal(u.state, 'done'); assert.equal(u.sessions, 1); assert.equal(u.tokens, 3500 + 21000); assert.equal(u.cost_usd, 0.06)
  assert.deepEqual(u.scenarios.map((s: any) => [s.id, s.outcome, s.actions]), [['s-01', 'ok', 2], ['s-02', 'problem', 2]])
  assert.deepEqual(u.findings[0].steps.map((x: any) => [x.action, x.url ?? x.name]), [['navigate', '/'], ['click', 'Add']])
  assert.deepEqual(u.findings[0].expect, [{ role: 'alert', visible: false }]) // HQ looked in the page the tester last read: no alert there
  const kept = path.join(hq.hqHome, 'projects', p.repo.id, 'uitest', (await runs(p))[0].id) // HQ's own folder, not the repo
  assert.deepEqual(fs.readdirSync(kept).sort(), ['plan.json', 's-01.json', 's-02.json'])
  const s2 = JSON.parse(fs.readFileSync(path.join(kept, 's-02.json'), 'utf8')); assert.deepEqual(s2.log.map((e: any) => e.tool), ['navigate', 'snapshot', 'click'])
  assert.ok(s2.log.every((e: any, i: number) => !i || e.at >= s2.log[i - 1].at), 'one clock, in order'); assert.deepEqual(s2.notes, ['Looked for an error message'])
  assert.equal(sh(p.dir, 'status', '--porcelain'), ''); assert.equal(sh(p.dir, 'worktree', 'list').split('\n').filter((l) => l.includes('hq-test')).length, 0)
  // The findings loop is connected to the real tester (Bug 171): what it found is a finding the user decides on, and the summary says why the backend
  // checker read nothing (this project has no test setup, so the run wasn't recorded). Bug 223: in words that don't say it has no tests: it has `npm test`
  const why = 'HQ isn\'t set up to record this app yet: Set up testing is under the preview\'s ⚙. This is separate from the project\'s own tests, `npm test`, which still run as usual'
  assert.equal(u.unrecorded, why); assert.equal(s2.recording, null)
  assert.deepEqual((await findingsOf(p)).map((f: any) => [f.fid, f.source, f.by, f.state, f.criterion, f.expect]),
    [['P-1', 'ui', 'tester', 'new', `${t1.key} A1`, [{ role: 'alert', visible: true }]]]) // it was missing: once fixed it shows
  assert.match(r.summary, new RegExp(`## Findings\\n- New P-1 \\(on the screen, ${t1.key} A1\\): Pressing Add with no name showed nothing\\.\\n`
    + `- The backend checker had nothing to read: the tester's run wasn't recorded \\(${why.replace(/[.()]/g, '\\$&')}\\)\\n\\n1 waiting for you`))
  assert.doesNotMatch(r.summary, /no test setup/)
  assert.equal(backendCalls().length, 0)
})

test('Bug 223: what the tester couldn\'t try from a browser is "couldn\'t test" in the summary, never a finding waiting for Fix or Ignore', { skip: !MAC }, async () => {
  const p = await project('uitesterclock'); await startCmd(p); assert.equal((await hq.api('settings', { key: 'app_look', value: 'off' })).status, 200)
  // s-01 as run 2's tester wrote it: a "problem" whose finding is the clock it couldn't change. s-02 as the prompt now asks: its own outcome and words
  const said = { 's-01': { outcome: 'problem', findings: [{ kind: 'missing', at_step: 1, what: 'I couldn\'t change the clock to see the morning greeting.', expected: 'Good morning',
    criterion: 'A1' }] }, 's-02': { outcome: 'couldnt_test', couldnt_test: 'It needs the afternoon, and I can\'t set the computer\'s clock.', findings: [] } }
  const t1 = await withCriteria(p, 'Greeting', [UI(`Says Good morning before noon. FAKE-UITEST: ${JSON.stringify(said)}`)]); await turnEnds(p)
  await ship(p, t1, { 'greet.js': '1\n' }, [NO_TEST]); await turnEnds(p)
  const r = await finished(p), u = await uiTestBy(p)
  assert.deepEqual(u.scenarios.map((s: any) => [s.id, s.outcome, s.why]), [['s-01', 'couldnt_test', 'I couldn\'t change the clock to see the morning greeting.'],
    ['s-02', 'couldnt_test', 'It needs the afternoon, and I can\'t set the computer\'s clock.']]); assert.deepEqual(u.findings, [])
  assert.match(r.summary, /## Tried in a browser\n- 2 scenarios: 0 fine, 0 findings, 0 unspecified, 2 couldn't test\n- s-01 See the list: couldn't test it from a browser, so it has no /)
  assert.deepEqual(await findingsOf(p), []); assert.doesNotMatch(r.summary, /waiting for you|New P-/)
  // The project has `npm test`: the line about the unrecorded run says HQ's recording isn't set up, not that the project has no tests
  assert.match(r.summary, /## Findings\n- The backend checker had nothing to read: the tester's run wasn't recorded \(HQ isn't set up to record this app yet: Set up testing is under /)
  assert.match(r.summary, /This is separate from the project's own tests, `npm test`, which still run as usual\)/); assert.doesNotMatch(r.summary, /no test setup/)
})

test('Bug 260: a "problem" with no finding but what it couldn\'t test said is "couldn\'t test" with its words; an "ok" one says what it couldn\'t check', { skip: !MAC }, async () => {
  const p = await project('uitestercouldnt'); await startCmd(p); assert.equal((await hq.api('settings', { key: 'app_look', value: 'off' })).status, 200)
  const clock = 'I could not change the clock to see the morning greeting.', wait = 'It needs a day to pass for the reminder.'
  const said = { 's-01': { outcome: 'problem', findings: [], couldnt_test: clock }, 's-02': { outcome: 'ok', findings: [], couldnt_test: wait } } // s-01: the real Haiku run
  const t1 = await withCriteria(p, 'Greeting', [UI(`Says Good morning before noon. FAKE-UITEST: ${JSON.stringify(said)}`)]); await turnEnds(p)
  await ship(p, t1, { 'greet.js': '1\n' }, [NO_TEST]); await turnEnds(p)
  const r = await finished(p), u = await uiTestBy(p)
  assert.deepEqual(u.scenarios.map((s: any) => [s.id, s.outcome, s.why]), [['s-01', 'couldnt_test', clock], ['s-02', 'ok', wait]]); assert.deepEqual(u.findings, [])
  assert.match(r.summary, new RegExp(`## Tried in a browser\\n- 2 scenarios: 1 fine, 0 findings, 0 unspecified, 1 couldn't test\\n- s-01 See the list: couldn't test it from a browser, `
    + `so it has no verdict here \\(${clock}\\)\\n- s-02 [^\\n]*: fine, but it couldn't check from a browser: ${wait}\\n`))
  assert.doesNotMatch(r.summary, /saw a problem but reported no finding/); assert.deepEqual(await findingsOf(p), [])
})

test('Bug 170: when HQ can\'t reset the app for the tester, the summary says why once, not "not run" for every scenario', { skip: !MAC }, async () => {
  const p = await project('uitesterreset') // starts once; a reset never puts installed packages back, so every start after the first stops at once
  await startCmd(p, 'if [ -e node_modules/.hq-once ]; then echo only once >&2; exit 3; fi; mkdir -p node_modules && touch node_modules/.hq-once && npm start')
  assert.equal((await hq.api('settings', { key: 'app_look', value: 'off' })).status, 200)
  const t1 = await withCriteria(p, 'Label', [UI('Books near their due date say "Due soon".')]); await turnEnds(p)
  await ship(p, t1, { 'label.js': '1\n' }, [NO_TEST]); await turnEnds(p)
  const r = await finished(p); assert.equal(testerCalls().length, 1)
  assert.match(r.summary, /## Tried in a browser\n- 2 scenarios, none run \(HQ couldn't reset the app: the app didn't start: its app part stopped \(3\) while the app was starting\)\n\n/)
  const u = await uiTestBy(p); assert.deepEqual(u.scenarios.map((x: any) => x.outcome), ['not_run', 'not_run'])
})

// The parts connected (Bugs 171, 172). An app that keeps what it's given in a file; a test setup for it, as the setup helper saves one (testsetupstore.ts).
// The tester's host runs it under HQ's real recorder, and the stand-in tester asks it for the page and POSTs to it, as a browser would.
const STORE = `const http=require('http'),fs=require('fs'),f='data/items.json'
const items=()=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return[]}}
http.createServer((q,s)=>{
 if(q.method==='POST'){fs.mkdirSync('data',{recursive:true});fs.writeFileSync(f,JSON.stringify([...items(),{id:items().length+1,name:'Dune'}]));s.writeHead(201);return s.end('{}')}
 s.end('<!doctype html><h1>Library</h1><p>'+items().length+' books</p>'+(fs.existsSync('notice.txt')?'<div role="alert">Added</div>':'')+'<button>Add</button>')
}).listen(process.env.PORT)\n`
const testSetup = (p: P) => {
  const f = path.join(hq.hqHome, 'projects', p.repo.id, 'test-setup.json'); fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ seen: true, setup: { start: [{ part: 'app', run: 'node server.js' }], snapshot: ['data'], seed: "mkdir -p data && echo '[]' > data/items.json",
    endpoints: [{ method: 'POST', path: '/api/add', kind: 'instant' }], notes: '' } }))
}
const findingsOf = async (p: P) => (await hq.state()).findings.filter((f: any) => f.repo_id === p.repo.id)
const backendCalls = () => readerCalls().filter((c) => /^You check what a web app's backend did/.test(c.system))
const keptFor = async (p: P, n = 0) => path.join(hq.hqHome, 'projects', p.repo.id, 'uitest', (await runs(p))[n].id)

test('with a test setup the tester\'s run is recorded: each scenario\'s API calls and data changes are kept, the backend checker reads them, and what it finds is a finding',
  { skip: !MAC }, async () => {
    const p = await project('recorded'); onMain(p, { 'server.js': STORE }); await startCmd(p); testSetup(p)
    const t1 = await withCriteria(p, 'Adding', [CRIT[0]])
    const said = { scenarios: [{ scenario: 's-02', clean: false, line: 'kept twice', findings: [{ type: 'backend', criterion: `${t1.key} A1`, what: 'The add kept the book under a new id each time.',
      expected: 'One id per book.', why: 'the data row', rows: ['POST /api/add → 201', 'a row nobody recorded'] }] }] }
    const t2 = await withCriteria(p, 'Storing', [{ kind: 'backend', text: `A book is stored once. FAKE-BACKEND: ${JSON.stringify(said)}` }]); await turnEnds(p)
    await ship(p, t1, { 'add.js': ADD, 'test/add.test.js': ADD_TEST }, [A1])
    await ship(p, t2, { 'store.js': '1\n', 'test/store.test.js': "require('node:test').test('stores once',()=>{})\n" }, [{ criterion: 'A1', file: 'test/store.test.js', name: 'stores once' }])
    await turnEnds(p); const r = await finished(p)
    const u = await uiTestBy(p); assert.equal(u.state, 'done'); assert.equal(u.unrecorded, undefined); assert.deepEqual(u.scenarios.map((s: any) => s.outcome), ['ok', 'ok'])
    const kept = await keptFor(p); assert.deepEqual(fs.readdirSync(kept).sort(), ['plan.json', 's-01.json', 's-01.rec', 's-02.json', 's-02.rec']) // HQ's folder, not the repo
    assert.equal(JSON.parse(fs.readFileSync(path.join(kept, 's-02.json'), 'utf8')).recording, `${path.basename(kept)}/s-02`)
    for (const id of ['s-01', 's-02']) { // each from a reset: one book added in each, never two
      assert.match(fs.readFileSync(path.join(kept, `${id}.rec`, 'timeline.md'), 'utf8'), new RegExp('\\| hq \\| reset the app to its seed \\|\\n.*\\| tester \\| open / \\|\\n'
        + '.*\\| tester \\| click button "Add" \\|\\n.*\\| api \\| POST /api/add → 201 \\(\\d+ms\\) \\|\\n.*\\| data \\| items: \\+Dune \\|\\n$'))
    }
    // The checker: one call for both scenarios, read tools only, the recordings' folders in reach, the timelines and the setup's endpoint labels in its prompt
    const [bc] = backendCalls(); assert.equal(backendCalls().length, 1); assert.equal(bc.tools, 'Read,Grep,Glob'); assert.equal(bc.model, 'opus')
    assert.deepEqual(bc.addDirs, [path.join(kept, 's-01.rec'), path.join(kept, 's-02.rec')])
    assert.match(bc.prompt, /## Scenario s-02: Add nothing\n[\s\S]*\| api \| POST \/api\/add → 201 \(\d+ms\) \|\n.*\| data \| items: \+Dune \|/)
    assert.match(bc.prompt, /- POST \/api\/add: instant/)
    const [f] = await findingsOf(p); assert.equal((await findingsOf(p)).length, 1)
    assert.deepEqual([f.fid, f.source, f.by, f.state, f.criterion], ['P-1', 'backend', 'checker', 'new', `${t1.key} A1`])
    assert.deepEqual(f.evidence.rows, ['POST /api/add → 201']); assert.equal(f.evidence.recording, `${path.basename(kept)}/s-02`) // only a row the recording has
    assert.deepEqual(f.steps, [{ action: 'navigate', url: '/' }, { action: 'click', role: 'button', name: 'Add' }])
    assert.match(r.summary, new RegExp(`## Findings\\n- New P-1 \\(behind the screen, ${t1.key} A1\\): The add kept the book under a new id each time\\.\\n`
      + '- The backend checker read what the backend did in 2 scenarios: 1 problem reported\\n\\n1 waiting for you'))
    assert.doesNotMatch(r.summary, /no recording|nothing to read/)
    assert.equal(sh(p.dir, 'status', '--porcelain'), ''); assert.equal(sh(p.dir, 'worktree', 'list').split('\n').filter((l) => l.includes('hq-test')).length, 0)
  })

test('a fixed finding is checked as the next run ends: HQ replays its steps where code can tell, and where a script can\'t, the tester gets it back to try by its goal',
  { skip: !MAC }, async () => {
    const p = await project('recheck'); onMain(p, { 'server.js': STORE }); await startCmd(p); testSetup(p)
    const found = { 's-01': { outcome: 'problem', notes: [], findings: [{ kind: 'confusing', at_step: 1, what: 'No hint where books are added.', expected: 'A hint' }] },
      's-02': { outcome: 'problem', notes: [], findings: [{ kind: 'no_feedback', at_step: 2, what: 'Pressing Add showed nothing.', expected: 'A message', looked_for: { role: 'alert' } }] } }
    const t1 = await withCriteria(p, 'Label', [UI(`Books say "Due soon". FAKE-UITEST: ${JSON.stringify(found)}`)]); await turnEnds(p)
    await ship(p, t1, { 'label.js': '1\n' }, [NO_TEST]); await turnEnds(p); await finished(p)
    assert.deepEqual((await findingsOf(p)).map((f: any) => [f.fid, f.state, f.steps.length, f.expect]), [['P-1', 'new', 1, null], ['P-2', 'new', 2, [{ role: 'alert', visible: true }]]])
    // The user marks both Fix and sends them; the TPM makes a fix ticket for each; both merge in the next run
    for (const id of ['P-1', 'P-2']) assert.equal((await hq.api(`repos/${p.repo.id}/findings/${id}`, { decision: 'fix' })).status, 200)
    assert.equal((await hq.api(`repos/${p.repo.id}/findings-send`, {})).status, 200)
    const fix = async (finding: string, title: string, text: string) => {
      const made = await hq.mcp(p.tpm.id, 'create_fix_ticket', { finding, title, size: 'S', spec: `${title}.`, criteria: [UI(text)] }); assert.equal(made.isError, false, made.text)
      const key = /^Created (\S+) for/.exec(made.text)![1]; return (await hq.state()).tickets.find((t: any) => t.key === key && t.feature_id === p.f.id)
    }
    // (this time the tester, trying P-1 again, will find it still there)
    const still = { 's-01': { outcome: 'problem', notes: [], findings: [{ kind: 'confusing', at_step: 1, what: 'Still no hint where books are added.', expected: 'A hint' }] } }
    const f1 = await fix('P-1', 'Hint', `The start page says how to add a book. FAKE-UITEST: ${JSON.stringify(still)}`)
    const f2 = await fix('P-2', 'Notice', 'Adding a book shows a message.'); await turnEnds(p)
    await ship(p, f1, { 'hint.txt': '1\n' }, [NO_TEST]); await ship(p, f2, { 'notice.txt': '1\n' }, [NO_TEST]); await turnEnds(p) // notice.txt: the page now has its alert
    const r = await finished(p, 2)
    // P-1 has no element a script could look for: it went to the tester, first, as a scenario of its own, with its old steps in words and nothing else
    assert.equal(testerCalls().length, 2); const again = testerCalls()[1].prompt
    assert.match(again, new RegExp('### s-01 \\(retry\\): Again: No hint where books are added\\.\\nP-1: A hint\\nSeen before: No hint where books are added\\.\\n'
      + 'The steps then, which may not fit the app any more \\(find your own way\\): open /\\n\\n### s-02 \\(basic\\): See the list\\n'))
    assert.doesNotMatch(again, /P-2|Pressing Add showed nothing/) // that one HQ replayed itself
    // What the tester found on its retry is P-1, still broken: back with the user after one strike, and never a second finding of its own
    const [p1, p2] = await findingsOf(p); assert.equal((await findingsOf(p)).length, 2)
    assert.deepEqual([p1.state, p1.strikes, p1.checks.at(-1).result, p1.checks.at(-1).how], ['new', 1, 'broken', 'retry'])
    assert.equal(p1.checks.at(-1).why, 'the tester, trying it by its goal: Still no hint where books are added.')
    assert.deepEqual([p2.state, p2.checks.at(-1).result, p2.checks.at(-1).how, p2.checks.at(-1).why], ['fixed', 'fixed', 'replay', 'the replay ended with the page as it should be'])
    assert.match(r.summary, new RegExp(`## Findings\\n- ✓ P-2 fixed: Pressing Add showed nothing\\.\\n- ✗ P-1 still broken after ${f1.key}: No hint where books are added\\. `
      + '\\(the tester, trying it by its goal: Still no hint where books are added\\.\\)\\n')); assert.doesNotMatch(r.summary, /- New /)
    assert.match(r.summary, /\n- The backend checker read what the backend did in 3 scenarios: nothing wrong found\n/)
    // The replay ran the finding's own steps under the recorder, in HQ's folder for the project
    const replays = path.join(hq.hqHome, 'projects', p.repo.id, 'scenarios'), [one] = fs.readdirSync(replays); assert.equal(fs.readdirSync(replays).length, 1)
    assert.match(fs.readFileSync(path.join(replays, one!, 'timeline.md'), 'utf8'), /\| tester \| navigate \/ \|\n.*\| tester \| click Add \|/)
    assert.equal(sh(p.dir, 'status', '--porcelain'), ''); assert.equal(sh(p.dir, 'worktree', 'list').split('\n').filter((l) => l.includes('hq-test')).length, 0)
  })

test('what the UI tester can\'t do never keeps a run from ending: no start steps, turned off in HQ or for the project, a plan that fails', async () => {
  const p = await project('uitesternot')
  const t1 = await withCriteria(p, 'Label', [UI('Books near their due date say "Due soon".')]); await turnEnds(p)
  await ship(p, t1, { 'label.js': '1\n' }, [NO_TEST]); await turnEnds(p)
  const r1 = await finished(p, 1); assert.equal(planCalls().length, 0)
  if (MAC) { assert.doesNotMatch(r1.summary, /Tried in a browser/); const u = await uiTestBy(p); assert.deepEqual([u.state, u.quiet], ['skipped', true]) } // no start steps: quiet
  await startCmd(p); assert.equal((await hq.api('settings', { key: 'tester', value: 'off' })).status, 200)
  const t2 = await withCriteria(p, 'Badge', [UI('The list shows a badge.')]); await turnEnds(p); await ship(p, t2, { 'badge.js': '1\n' }, [NO_TEST]); await turnEnds(p)
  const r2 = await finished(p, 2); assert.doesNotMatch(r2.summary, /Tried in a browser/); assert.equal(r2.ui_test, null)
  assert.equal((await hq.api('settings', { key: 'tester', value: 'on' })).status, 200); assert.equal((await hq.api(`repos/${p.repo.id}/ui-test`, { on: false })).status, 200)
  assert.equal((await repoNow(p)).ui_test, 'off')
  const t3 = await withCriteria(p, 'Dots', [UI('The list shows dots.')]); await turnEnds(p); await ship(p, t3, { 'dots.js': '1\n' }, [NO_TEST]); await turnEnds(p)
  const r3 = await finished(p, 3); assert.equal(r3.ui_test, null, 'off for this project'); assert.equal(planCalls().length, 0)
  assert.equal((await hq.api(`repos/${p.repo.id}/ui-test`, { on: true })).status, 200)
  const t4 = await withCriteria(p, 'Count', [UI('The list shows a count. FAKE-PLAN: error')]); await turnEnds(p); await ship(p, t4, { 'count.js': '1\n' }, [NO_TEST]); await turnEnds(p)
  const r4 = await finished(p, 4)
  if (!MAC) return assert.match(r4.summary, /- Not tried: the UI tester runs on macOS only/)
  assert.match(r4.summary, /## Tried in a browser\n- Not tried: the tester couldn't plan its scenarios \(API Error: Overloaded\)\n/)
  assert.equal(planCalls().length, 1, 'asked once: a run never waits on the tester twice'); assert.equal(testerCalls().length, 0)
})

test('auto off while the UI tester has the app ends it at once: the run closes without it, nothing is left running, and the board said what HQ was doing', { skip: !MAC }, async () => {
  const p = await project('uitesterstop'); await startCmd(p)
  const t = await withCriteria(p, 'Label', [UI('Books near their due date say "Due soon". FAKE-UITEST: hang')]); await turnEnds(p)
  await ship(p, t, { 'label.js': '1\n' }, [NO_TEST]); await turnEnds(p)
  await onPage(p, 'no ticket:tester:running'); await waitFor('the tester to start', () => testerCalls().length === 1); const pid = testerCalls()[0].pid
  assert.equal((await runs(p))[0].status, 'running', 'the run waits for the tester')
  const host = () => { try { return execFileSync('pgrep', ['-f', `uitesthost\\.mjs.*${p.dir}`], { encoding: 'utf8' }).trim().split('\n').length } catch { return 0 } } // this test's own
  assert.ok(host() >= 1, 'the host has the app')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  await waitFor('the tester to end', () => !alive(pid), 5000); await waitFor('the board to say so', async () => (await shown(p)) === '')
  const r = (await runs(p))[0]; assert.equal(r.status, 'off'); assert.equal(r.ui_test, null); assert.doesNotMatch(r.summary, /Tried in a browser/)
  await waitFor('the host and its app to end', () => host() === 0, 5000)
  assert.equal(sh(p.dir, 'worktree', 'list').split('\n').filter((l) => l.includes('hq-test')).length, 0)
})

test('auto off while the UI tester plans its scenarios ends the planning call too, and the board said so meanwhile', { skip: !MAC }, async () => {
  const p = await project('uitesterplan'); await startCmd(p)
  const t = await withCriteria(p, 'Label', [UI('Books near their due date say "Due soon". FAKE-PLAN: hang')]); await turnEnds(p)
  await ship(p, t, { 'label.js': '1\n' }, [NO_TEST]); await turnEnds(p)
  await waitFor('the plan to be asked for', () => planCalls().length === 1); const pid = planCalls()[0].pid
  await onPage(p, 'no ticket:tester:running')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  await waitFor('the planning call to end', () => !alive(pid), 5000); await waitFor('the board to say so', async () => (await shown(p)) === '')
  const r = (await runs(p))[0]; assert.equal(r.status, 'off'); assert.equal(r.ui_test, null); assert.equal(testerCalls().length, 0)
})
