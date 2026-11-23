// "Have HQ test this" end to end (hqcheck.ts): with auto mode off the user has HQ test one finished ticket. The tests act as the engineer (fake Claude Code,
// see harness.ts) and press what a user presses. HQ runs auto mode's checks in the real sandbox and only reports: green, red, or amber when it couldn't finish;
// Send to engineer sends what failed; a newer open_pr makes the results out of date; a merge of the tested version records the test. Stop, auto mode coming
// on, a restart, a merge and a Clear each end a check under way and say why, with nothing left behind.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'
import { checkButton, checkOf } from '../src/hqcheckrules.ts'

let hq: Hq
// HQ_LOOK_RUNNER: no browser here; HQ's look at the app runs fake-look.mjs in its place. The UI tester's browser is never started (fake-claude.mjs drives its host)
const ENV = { HQ_LOOK_RUNNER: path.join(import.meta.dirname, 'fake-look.mjs'), HQ_UITEST_BROWSER_EXE: '/usr/bin/false' }
beforeEach(async () => { hq = await startHq({ env: ENV }) })
afterEach(async () => { await hq?.stop() })

const PASS = "require('node:test').test('ok',()=>{})\n", FAIL = "require('node:test').test('adds two',()=>{ require('node:assert').equal(1+1,3) })\n"
// HELD waits until the test lets it go, with a file in the run's own checkout (as auto.test.ts): it orders a check's run without timing
const HELD = 'until [ -f go ]; do sleep 0.1; done'
/** A project with `npm test` and one passing test, its TPM running, auto mode off. */
async function project(name: string) {
  const dir = hq.repo(name)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { start: 'node server.js', test: 'node --test' } }))
  fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), PASS); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f }
}
type P = Awaited<ReturnType<typeof project>>
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const wt = (p: P, t: any) => path.join(p.dir, '.claude', 'worktrees', t.key)
/** A ticket, its engineer, and `files` committed and handed over with open_pr (after running the tests, as Bug 162 asks with auto off). */
async function finished(p: P, title: string, files: Record<string, string>, cmd = 'npm test'): Promise<{ t: any; eng: any }> {
  const t = (await hq.api('tickets', { featureId: p.f.id, title, size: 'S', spec: `${title}.` })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  await commitAndOpen(p, t, eng, files, cmd)
  return { t, eng }
}
async function commitAndOpen(p: P, t: any, eng: any, files: Record<string, string>, cmd = 'npm test'): Promise<void> {
  for (const [f, text] of Object.entries(files)) { // '' removes the file
    const at = path.join(wt(p, t), f); if (text === '') fs.rmSync(at); else { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, text) }
  }
  sh(wt(p, t), 'add', '-A'); sh(wt(p, t), 'commit', '-qm', t.title)
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: `toolu_${eng.id}_${Date.now()}` })
  await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(eng.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true })
  assert.equal(r.isError, false, r.text)
  await waitFor(`${t.key} finished`, async () => (await tk(t))?.status === 'pr_ready')
}
const check = (t: any) => hq.api(`tickets/${t.id}/check`, {})
/** Waits for the ticket's check to end, and gives it. */
const ended = (t: any, ms = 30_000) => waitFor(`${t.key}'s check to end`, async () => { const c = checkOf((await tk(t)) ?? {}); return c && c.state !== 'running' ? c : null }, ms)
const button = async (t: any) => { const b = checkButton((await tk(t))!, true); return b && [b.label, b.tone] }
const testCheckouts = (p: P) => { const d = path.join(p.dir, '.claude', 'worktrees'); return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.startsWith('hq-test-')) : [] }
/** The page shows HQ's run on the ticket's box (Bug 106), as it does for auto mode's. */
const onBox = (t: any) => waitFor(`HQ's run on ${t.key}'s box`, async () => (await hq.state()).testRuns.find((r: any) => r.ticket_id === t.id && r.state === 'running'), 20_000)

test('a passing check is green with each check said, and merging that very version records it as the merge\'s test', async () => {
  const p = await project('green')
  const t0 = (await hq.api('tickets', { featureId: p.f.id, title: 'Not yet', size: 'S', spec: 'x.' })).json
  assert.match((await check(t0)).json.error, /isn't finished, so there's nothing to test yet/)
  const { t } = await finished(p, 'Add a page', { 'page.txt': 'a page\n', 'test/page.test.js': PASS })
  assert.deepEqual(await button(t), ['Have HQ test this', 'plain'])
  const r = await check(t); assert.equal(r.status, 200, JSON.stringify(r.json))
  const c = await ended(t)
  assert.equal(c.state, 'pass', JSON.stringify(c))
  assert.deepEqual(c.steps.map((s) => [s.kind, s.state]), [['tests', 'pass'], ['criteria', 'skipped'], ['look', 'skipped'], ['read', 'skipped'], ['ui', 'skipped']])
  assert.match(c.steps[0]!.words, /`npm test` passed: 2 passed/); assert.match(c.steps[2]!.words, /no start steps/); assert.match(c.steps[3]!.words, /small ticket/)
  assert.deepEqual(await button(t), ['View results ✓', 'green'])
  assert.deepEqual(testCheckouts(p), []) // its checkout went with it
  assert.equal((await tk(t)).status, 'pr_ready') // HQ only reports: nothing merged
  const m = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json))
  const rec = JSON.parse((await tk(t)).merge_test)
  assert.equal(rec.ran, 'pass'); assert.equal(rec.test, 'npm test'); assert.equal(rec.counts.passed, 2); assert.equal(rec.on, 'main')
})

test('a failing check is red; main alone decides whose it is; Send goes to the engineer once; a new open_pr makes it out of date; Test again', async () => {
  const p = await project('red')
  const { t, eng } = await finished(p, 'Add maths', { 'test/maths.test.js': FAIL })
  assert.equal((await check(t)).status, 200)
  const c = await ended(t)
  assert.equal(c.state, 'fail'); assert.equal(c.steps.length, 1)
  assert.match(c.steps[0]!.words, /They failed: .*adds two · main passes them without T-01, so the failure is T-01's/); assert.match(c.steps[0]!.output!, /adds two/)
  assert.deepEqual(await button(t), ['View results ✗', 'red'])
  const s = await hq.api(`tickets/${t.id}/check-send`, {}); assert.equal(s.status, 200, JSON.stringify(s.json))
  assert.equal(s.json.engineer, eng.id) // still running: it gets a message
  const told = await waitFor('the engineer told', async () => (await hq.state()).messages.find((m: any) => m.to_id === eng.id && /so the user sent it back to you/.test(m.body)))
  assert.match(told.body, /adds two/); assert.doesNotMatch(told.body, /HQ didn't merge/)
  const now = await tk(t); assert.equal(now.status, 'resolving'); assert.ok(checkOf(now)!.sent_at)
  assert.equal(await button(t), null, 'its engineer has it: no button until it is finished again')
  assert.match((await hq.api(`tickets/${t.id}/check-send`, {})).json.error, /sent to its engineer already/)
  // the engineer fixes it and finishes again: the old results are about older code
  await commitAndOpen(p, t, eng, { 'test/maths.test.js': PASS })
  assert.deepEqual(await button(t), ['Results out of date', 'grey'])
  assert.equal((await check(t)).status, 200); assert.equal((await ended(t)).state, 'pass')
  assert.deepEqual(await button(t), ['View results ✓', 'green'])
})

test('main\'s own tests failing too: amber, not the ticket\'s fault, and nothing to send', async () => {
  const p = await project('broken')
  const { t } = await finished(p, 'Something', { 'thing.txt': 'x\n' })
  fs.writeFileSync(path.join(p.dir, 'test', 'main.test.js'), FAIL); sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'main breaks') // the user's own commit on main
  assert.equal((await check(t)).status, 200)
  const c = await ended(t)
  assert.equal(c.state, 'error'); assert.match(c.why!, /main's own tests fail, so HQ can't tell whether T-01 is fine/); assert.equal(c.send, undefined)
  assert.match(c.steps[0]!.words, /main fails them too, without T-01/)
  assert.deepEqual(await button(t), ["Couldn't finish", 'amber'])
  assert.match((await hq.api(`tickets/${t.id}/check-send`, {})).json.error, /found nothing to send/)
})

test('a project with start steps: the app is opened and the UI tester tries it; a finding is red, and a tester that can\'t run is amber, never green', async () => {
  const p = await project('app')
  assert.equal((await hq.api(`previews/${p.repo.id}/command`, { command: 'node server.js' })).status, 200)
  const plan = `FAKE-PLAN: ${JSON.stringify({ scenarios: [{ kind: 'basic', title: 'Tick Dune off', goal: 'Tick Dune off.', criteria: ['A1'] }] })}`
  const found = `FAKE-UITEST: ${JSON.stringify({ 's-01': { outcome: 'problem', notes: [], findings: [{ kind: 'no_feedback', what: 'Ticking showed nothing.', expected: 'Crossed out' }] } })}`
  const made = async (title: string, crit: { kind: string; text: string }[]) => {
    const t = (await hq.api('tickets', { featureId: p.f.id, title, size: 'S', spec: `${title}.`, criteria: crit })).json, eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
    await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
    for (const [f, text] of Object.entries({ [`${t.key}.txt`]: 'x\n' })) fs.writeFileSync(path.join(wt(p, t), f), text)
    sh(wt(p, t), 'add', '-A'); sh(wt(p, t), 'commit', '-qm', title)
    await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `toolu_${eng.id}_1` })
    await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
    const cant = 'It is about what the screen shows, and nothing here can render a page.'
    const r = await hq.mcp(eng.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true,
      tests: crit.map((_, i) => ({ criterion: `A${i + 1}`, cant_test: cant })) })
    assert.equal(r.isError, false, r.text); await waitFor(`${t.key} finished`, async () => (await tk(t))?.status === 'pr_ready')
    return t
  }
  const red = await made('Tick things off', [{ kind: 'ui', text: `Ticking crosses it out. ${plan}` }, { kind: 'ui', text: `It stays on the list. ${found}` }])
  assert.equal((await check(red)).status, 200)
  const c = await ended(red)
  if (process.platform !== 'darwin') { // the UI tester runs on macOS only: on Linux it is skipped, as how the machine is, and the rest passes (never amber)
    assert.equal(c.state, 'pass', JSON.stringify(c)); assert.equal(c.steps.at(-1)!.state, 'skipped'); assert.equal(c.steps.at(-1)!.trouble, undefined)
    assert.match(c.steps.at(-1)!.words, /macOS only/); return
  }
  assert.equal(c.state, 'fail'); assert.deepEqual(c.steps.map((s) => [s.kind, s.state]), [['tests', 'pass'], ['criteria', 'skipped'], ['look', 'pass'], ['read', 'pass'], ['ui', 'fail']])
  assert.match(c.steps[1]!.words, /named no test for any of its criteria/) // each criterion says why instead (cant_test)
  assert.match(c.steps[4]!.lines![0]!.text, /Tick Dune off: Ticking showed nothing/); assert.equal(c.send?.kind, 'fix')
  assert.equal(checkOf((await tk(red))!)!.cost_usd! > 0, true)
  const amber = await made('Something', [{ kind: 'ui', text: 'It does something. FAKE-PLAN: error' }])
  assert.equal((await check(amber)).status, 200)
  const a = await ended(amber)
  assert.equal(a.state, 'error', JSON.stringify(a)); assert.equal(a.why, "the UI tester couldn't run; nothing that ran failed")
  assert.match(a.steps.at(-1)!.words, /couldn't plan its scenarios/); assert.equal(a.steps.at(-1)!.trouble, true)
  assert.deepEqual(await button(amber), ["Couldn't finish", 'amber'])
})

test('a check under way ends, and says why, on Stop, auto mode coming on, a restart, a merge and a Clear; a second click is refused; nothing is left', async () => {
  const p = await project('ends')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: HELD })).status, 200)
  const { t } = await finished(p, 'One', { 'one.txt': '1\n' }, HELD), { t: t2 } = await finished(p, 'Two', { 'two.txt': '2\n' }, HELD)
  const stoppedBy = async (x: any, why: RegExp) => { const c = await ended(x); assert.equal(c.state, 'stopped', JSON.stringify(c)); assert.match(c.why!, why) }
  const gone = () => waitFor('no checkout left', () => testCheckouts(p).length === 0)

  // Stop: the button reads Testing… meanwhile and the box shows HQ's run
  assert.equal((await check(t)).status, 200); await onBox(t)
  assert.deepEqual(await button(t), ['Testing…', 'plain'])
  assert.match((await check(t)).json.error, /already testing T-01/)
  assert.equal((await hq.api(`tickets/${t.id}/check-stop`, {})).json.stopped, true)
  await stoppedBy(t, /you stopped it/); await gone()
  assert.deepEqual(await button(t), ["Couldn't finish", 'amber'])

  // auto mode coming on takes the ticket over; on, the button is gone and a check is refused
  assert.equal((await check(t)).status, 200); await onBox(t)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  await stoppedBy(t, /auto mode took over/)
  assert.equal(checkButton((await tk(t))!, false), null) // the board asks with the user not in charge (board.ts nextMover): no button
  assert.match((await check(t)).json.error, /Auto mode tests and merges T-01 itself/)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
  await waitFor('auto mode\'s own runs to end', async () => (await hq.state()).testRuns.length === 0); await gone()

  // a restart: the check went with the backend, and says so
  assert.equal((await check(t)).status, 200); await onBox(t)
  await hq.restart()
  await stoppedBy(t, /HQ restarted while it was testing/); await gone()

  // a merge (the user's Merge into main): merged as it is, the check ends, and the merge records no test
  assert.equal((await check(t)).status, 200); await onBox(t)
  const m = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json))
  await stoppedBy(t, /it was merged/); assert.equal(JSON.parse((await tk(t)).merge_test).ran, 'none'); await gone()

  // a Clear
  assert.equal((await check(t2)).status, 200); await onBox(t2)
  assert.equal((await hq.api(`repos/${p.repo.id}/clear`, {})).status, 200)
  await stoppedBy(t2, /the project is being cleared/)
  await gone()
})

test('a ticket auto mode parked is the user\'s to test; handed back to auto mode (Try again), the check under way ends', async () => {
  const p = await project('parked')
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: HELD })).status, 200)
  const { t } = await finished(p, 'One', { 'one.txt': '1\n' }, HELD)
  // auto mode on, and this ticket parked by it, as two failed fixes leave it (written as auto.ts park does, without its run)
  const db = hq.db(); try { db.prepare('UPDATE tickets SET auto_parked_why = ? WHERE id = ?').run('Its tests still fail after 2 fixes.', t.id) } finally { db.close() }
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  assert.equal((await check(t)).status, 200, 'parked: the user moves it on, so HQ tests it on request'); await onBox(t)
  assert.equal((await hq.api(`tickets/${t.id}/auto-retry`, {})).status, 200)
  const c = await ended(t); assert.equal(c.state, 'stopped'); assert.match(c.why!, /auto mode took over/)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
})
