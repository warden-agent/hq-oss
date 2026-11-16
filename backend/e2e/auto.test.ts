// Auto mode end to end: the tests act as the TPM and the engineers (fake Claude Code; see harness.ts) and press nothing a user
// would press. Plans are approved, ready tickets start when the TPM's turn ends, finished tickets are tested on main in the real
// sandbox and merged; failures go back to their engineer, then park; a broken main gets a repair ticket of HQ's, and stops the project
// only if that can't work; the switch goes off cleanly.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startHq, waitFor, sh, exitPlanMode, pendingAfter, type Hq } from './harness.ts'
import { WebSocket } from 'ws'

let hq: Hq
const prompt = (id: string) => fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'prompt.md'), 'utf8') // what the agent was started with
beforeEach(async () => { hq = await startHq({ env: { HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500' } }) })
afterEach(async () => { await hq?.stop() })

const PASS = "require('node:test').test('ok',()=>{})\n"
/** A project with `npm test` and one passing test, its TPM running and auto mode on. */
async function project(name: string, o: { tests?: boolean; auto?: boolean } = {}) {
  const dir = hq.repo(name)
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
/** Waits for `t` to reach `status`; a time-out says where it was instead (Bug 113: a CI failure that never said which wait it was). */
const until = async (t: any, status: string, ms = 15_000) => { let last = 'not found'
  try { return await waitFor(`${t.key} to be ${status}`, async () => { const x = await tk(t); last = x ? `${x.status}${x.auto_parked_why ? `, parked: ${x.auto_parked_why}` : ''}` : 'gone'
    return x?.status === status ? x : null }, ms) } catch (e) { throw new Error(`${(e as Error).message} (it is ${last})`) } }
async function openPr(e: any): Promise<void> {
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
}
/** What an engineer does: plan (no one approves it but HQ), write `files`, commit, open_pr. */
async function work(p: P, t: any, e: any, files: Record<string, string>): Promise<void> {
  const held = await hq.hook(e.id, exitPlanMode(`Plan for ${t.key}`))
  assert.equal(held.hookSpecificOutput.decision.behavior, 'allow')
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(wt(p, t), f)), { recursive: true }); fs.writeFileSync(path.join(wt(p, t), f), text) }
  sh(wt(p, t), 'add', '.'); sh(wt(p, t), 'commit', '-qm', t.title); await openPr(e)
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  process.kill(Number(pid), 'SIGKILL'); await wait(300)
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
  await waitFor('the run to end', () => !stuckRun(), 5000); await wait(500)
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
test('Bug 115: a project auto mode stops ends its test run at once, frees the turn an engineer waits for, and Resume tests afresh', async () => {
  const p = await project('stoprun'), t = await ticket(p, 'Thing'), t2 = await ticket(p, 'Other')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: `if [ -f thing.js ]; then ${MARK}; fi` })).status, 200); await turnEnds(p)
  const e2 = await engineer(t2); await waitFor('main checked', async () => (await checks())[0]); await work(p, t, await engineer(t), { 'thing.js': '1\n' })
  await waitFor('the ticket\'s test', () => stuckRun(), 15_000); const old = stuckPids()
  const use = { tool_name: 'Bash', tool_use_id: 'toolu_115', tool_input: { command: 'npm test' } }
  const theirs = hq.hook(e2.id, { hook_event_name: 'PreToolUse', ...use }); assert.ok(await pendingAfter(theirs, 1000), 'the engineer waits behind HQ\'s run')
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  assert.match(await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why), /The TPM needs you/)
  await waitFor('the run to end', () => !old.some(alive), 5000); assert.deepEqual(await theirs, {}, 'its turn now')
  await hq.hook(e2.id, { hook_event_name: 'PostToolUse', ...use }); await wait(700)
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
  await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why); await waitFor('the run to end', () => !stuckRun(), 5000); await wait(500)
  assert.deepEqual(await tested(), [], 'no result: not a failure, not a repair'); assert.deepEqual(await repairs(p), []); assert.equal((await runs(p))[0].main_checked, null)
  await hq.api(`agents/${p.tpm.id}/stop`, {}); assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: '' })).status, 200)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-resume`, {})).status, 200)
  const c = await waitFor('a new check', async () => (await checks())[0], 15_000); assert.equal(c.result, 'pass')
})

test('a machine that can\'t sandbox the tests says so before anything starts: no switch, no run, no tokens', async () => {
  await hq.stop(); hq = await startHq({ env: { HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500', HQ_SANDBOX_BIN: 'hq-no-such-sandbox' } })
  const p = await project('nosandbox', { auto: false })
  const check = (await hq.api(`repos/${p.repo.id}/auto-check`, {})).json; assert.match(check.sandbox, /bubblewrap|sandbox/)
  const r = await hq.api(`repos/${p.repo.id}/auto`, { on: true }); assert.equal(r.status, 409); assert.equal(r.json.error, check.sandbox)
  await ticket(p, 'Nothing'); await turnEnds(p); await wait(700)
  assert.equal((await repoNow(p)).auto_mode, 0); assert.equal((await runs(p)).length, 0)
  assert.equal((await hq.state()).agents.filter((a: any) => a.role === 'engineer').length, 0)
})

test('a request runs to the end with nobody pressing anything: starts after the split, plan on record, tested, merged, summed up', async () => {
  const p = await project('all')
  const t1 = await ticket(p, 'Orders'), t2 = await ticket(p, 'Invoices', [t1.key])
  await wait(700); assert.equal((await hq.state()).agents.filter((a: any) => a.role === 'engineer').length, 0, 'nothing starts while the TPM is splitting')
  await turnEnds(p)
  const e1 = await engineer(t1); await work(p, t1, e1, { 'orders.txt': 'r\n' })
  await until(t1, 'merged')
  assert.ok(fs.existsSync(path.join(p.dir, 'orders.txt')), 'the work is on main')
  const review = (await hq.state()).reviews.find((r: any) => r.ticket_id === t1.id); assert.equal(review.closed_reason, 'approve'); assert.match(review.plan_text ?? `Plan for ${t1.key}`, /Plan for/)
  await waitFor('the first engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id)?.status === 'exited')
  await turnEnds(p) // the TPM heard the merge and answered
  const e2 = await engineer(t2); await work(p, t2, e2, { 'invoices.txt': 's\n' })
  await until(t2, 'merged')
  await turnEnds(p)
  const r = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.match(r.summary, new RegExp(`${t1.key}: Orders`)); assert.match(r.summary, new RegExp(`${t2.key}: Invoices`)); assert.ok(r.start_sha && r.end_sha && r.start_sha !== r.end_sha)
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
  await work(p, t2, e2, { 'two.txt': '2\n' }); await wait(1500) // finished during the repair: it waits, and it isn't blamed
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
  const spec = (t: any, a: { spec?: string; title?: string }) => hq.mcp(p.tpm.id, 'update_ticket_spec', { key: t.key, ...a })
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
  const got = (await hq.mcp(er.id, 'get_ticket')).text; assert.match(got, /Reach the internet/); assert.match(got, /Leave the date tests alone\.\n\n## Handoff so far/)
  // Finished and not merged yet (auto is off by then): it goes back to its engineer for the TPM's text, HQ's spec still on top
  assert.equal((await hq.hook(er.id, exitPlanMode('Plan'))).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  fs.writeFileSync(path.join(wt(p, r), 'test', 'main.test.js'), PASS); sh(wt(p, r), 'add', '.'); sh(wt(p, r), 'commit', '-qm', 'fix'); await openPr(er); await until(r, 'pr_ready')
  const late = await spec(r, { spec: 'Keep the slow test too.' }); assert.equal(late.isError, false, late.text)
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
  await engineer(t1); await hq.restart(); await wait(1500)
  assert.equal((await checks()).length, 1); assert.deepEqual(await repairs(p), [])
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
  await wait(1200); assert.equal((await repairs(p)).length, 1)
})

test('Bug 62: a TPM that has gone can\'t stop the project again on Resume with its old dialog alert', async () => {
  const p = await project('gone'); await ticket(p, 'One')
  await hq.hook(p.tpm.id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow this?' })
  await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why)
  await hq.api(`agents/${p.tpm.id}/stop`, {}) // its session is over, and its dialog with it
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-resume`, {})).status, 200); await wait(1500)
  assert.equal((await repoNow(p)).auto_stopped_why, null)
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
  const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite')) // an alert from before the fix: HQ now clears it as the engineer stops
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
  const t3 = await ticket(p, 'Three'); await turnEnds(p); await wait(700); assert.equal((await tk(t3)).status, 'queued', 'nothing new starts')
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
  const r = await repair(p), er = await engineer(r); await hq.restart(); await wait(1200)
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
  const db = new DatabaseSync(path.join(hq.hqHome, 'hq.sqlite')); try { const s = db.prepare(query); return /^select/i.test(query) ? s.all(...args) : (s.run(...args), []) } finally { db.close() }
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
  assert.equal((await propose(er, cmd, 'nothing')).isError, true, 'having run it first makes no difference')
  await work(p, r, er, { 'test/main.test.js': PASS }); await until(r, 'merged'); await until(t1, 'merged'); await turnEnds(p) // what the command runs changed, not the command
  const run = await waitFor('the run to finish', async () => (await runs(p)).find((x: any) => x.status === 'finished'))
  assert.equal(run.test_change, null); assert.doesNotMatch(run.summary, /Test command changed/); assert.deepEqual(changes(), []); assert.equal((await repoNow(p)).test_cmd, cmd)
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
  await work(p, t1, e1, { 'one.txt': '1\n' }); await wait(1200); assert.equal((await tk(t1)).status, 'pr_ready'); assert.equal((await repairs(p)).length, 1, 'one repair')
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
  await bash(e2, HARD, refusal(wt(p, t2))); await wait(1200)
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
  const other = await project('nevers', { auto: false }); breakMain(other); const t = await ticket(other, 'Plain'); await turnEnds(other); await wait(900)
  assert.equal((await repairs(other)).length, 0); assert.equal((await tk(t)).status, 'queued')
})

test('engineers get the project\'s test command: in their launch prompt, and as a message if it changes while they work', async () => {
  const p = await project('told')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'node --test test/ok.test.js' })).status, 200)
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1); assert.match(prompt(e1.id), /use it for your full test run instead of the project's usual one: node --test test\/ok\.test\.js/)
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'node --test test/' })).status, 200)
  await waitFor('the engineer to hear', async () => (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e1.id && /node --test test\/$/.test(m.body)))
  await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'node --test test/' }); await wait(300)
  assert.equal((await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === e1.id && /full test run/.test(m.body)).length, 1, 'no change, no message')
  breakMain(p); await work(p, t1, e1, { 'one.txt': '1\n' })
  const er = await engineer(await repair(p)); assert.doesNotMatch(prompt(er.id), /use it for your full test run/, 'a repair isn\'t told to use the command that failed')
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
  await wait(700); assert.equal(await has('auto_stopped'), false, 'gone, and no sweep brings it back'); assert.ok(await has('auto_finished'), 'the run built something')
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
  await wait(1200); assert.equal((await tk(t1)).status, 'pr_ready', 'off: finished tickets wait for the user')
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
  await wait(1500); assert.equal((await tk(t1)).status, 'pr_ready')
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
test("Bug 106: a run in line behind another project's says it is waiting its turn, and running once its turn comes", async () => {
  const a = await project('ahead'); await ticket(a, 'One')
  assert.equal((await hq.api(`repos/${a.repo.id}/test-cmd`, { cmd: HELD })).status, 200); await turnEnds(a); await onPage(a, 'no ticket:main:running')
  const b = await project('behind'); await ticket(b, 'Two')
  assert.equal((await hq.api(`repos/${b.repo.id}/test-cmd`, { cmd: HELD })).status, 200); await turnEnds(b); await onPage(b, 'no ticket:main:waiting')
  const waitedFrom = (await hq.state()).testRuns.find((r: any) => r.repo_id === b.repo.id).since
  assert.equal(await shown(a), 'no ticket:main:running'); await letGo(a)
  await onPage(b, 'no ticket:main:running'); await onPage(a, '') // the first leaves the page once its checkout has gone, a moment after it gave its turn back
  assert.ok((await hq.state()).testRuns.find((r: any) => r.repo_id === b.repo.id).since >= waitedFrom, 'its clock starts again when its turn comes')
  await letGo(b); await onPage(b, '')
})
