// Auto mode end to end: the tests act as the TPM and the engineers (fake Claude Code; see harness.ts) and press nothing a user
// would press. Plans are approved, ready tickets start when the TPM's turn ends, finished tickets are tested on main in the real
// sandbox and merged; failures go back to their engineer, then park; a broken main stops the project; the switch goes off cleanly.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
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
const until = (t: any, status: string, ms = 15_000) => waitFor(`${t.key} to be ${status}`, async () => { const x = await tk(t); return x?.status === status ? x : null }, ms)
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

test('when main itself is broken everything stops, with the reason, until Resume', async () => {
  const p = await project('broken')
  const t1 = await ticket(p, 'One'); await turnEnds(p)
  const e1 = await engineer(t1)
  fs.writeFileSync(path.join(p.dir, 'test', 'main.test.js'), "require('node:test').test('main',()=>{throw new Error('main is broken')})\n"); sh(p.dir, 'add', '.'); sh(p.dir,
    'commit', '-qm', 'break main')
  await work(p, t1, e1, { 'one.txt': '1\n' })
  const why = await waitFor('the stop', async () => (await repoNow(p)).auto_stopped_why)
  assert.match(why, /own tests fail/); assert.equal((await tk(t1)).status, 'pr_ready'); assert.equal((await tk(t1)).auto_tries, 0, 'not the ticket\'s fault')
  const t2 = await ticket(p, 'Two'); await turnEnds(p); await wait(700)
  assert.equal((await tk(t2)).status, 'queued', 'nothing new starts')
  fs.rmSync(path.join(p.dir, 'test', 'main.test.js')); sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'fix main')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-resume`, {})).status, 200)
  await until(t1, 'merged'); await engineer(t2)
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
  const t1 = await ticket(p, 'A'), t2 = await ticket(p, 'B'); await turnEnds(p)
  const e1 = await engineer(t1), e2 = await engineer(t2)
  await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'sleep 2' }) // both finish before either merges
  await work(p, t1, e1, { 'version.txt': 'v1\na\n' }); await work(p, t2, e2, { 'version.txt': 'v1\nb\n' })
  await until(t1, 'merged'); await until(t2, 'resolving')
  try { sh(wt(p, t2), 'merge', '--no-edit', 'main') } catch { /* the conflict */ }
  fs.writeFileSync(path.join(wt(p, t2), 'version.txt'), 'v1\na\nb\n'); sh(wt(p, t2), 'add', '.'); sh(wt(p, t2), 'commit', '--no-edit', '-q'); await openPr(e2)
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
