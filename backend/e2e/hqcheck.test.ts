// "Have HQ test this" end to end (hqcheck.ts): with auto mode off the user has HQ test one finished ticket. The tests act as the engineer (fake Claude Code,
// see harness.ts) and press what a user presses. HQ runs auto mode's checks in the real sandbox and only reports: green, red, or amber when it couldn't finish;
// Send to engineer sends what failed; a newer open_pr makes the results out of date; a merge of the tested version records the test. Stop, auto mode coming
// on, a restart, a merge and a Clear each end a check under way and say why, with nothing left behind.
import { test, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'
import { checkButton, checkHeadline, checkOf, checksOf } from '../src/hqcheckrules.ts'

let hq: Hq
// HQ_LOOK_RUNNER: no browser here; HQ's look at the app runs fake-look.mjs in its place. The UI tester's browser is never started (fake-claude.mjs drives its host)
const ENV = { HQ_LOOK_RUNNER: path.join(import.meta.dirname, 'fake-look.mjs'), HQ_UITEST_BROWSER_EXE: '/usr/bin/false' }
beforeEach(async () => { hq = await startHq({ env: ENV }) })
afterEach(async () => { await hq?.stop() })

const PASS = "require('node:test').test('ok',()=>{})\n", FAIL = "require('node:test').test('adds two',()=>{ require('node:assert').equal(1+1,3) })\n"
// HELD waits until the test lets it go, with a file in the run's own checkout (as auto.test.ts): it orders a check's run without timing
const HELD = 'until [ -f go ]; do sleep 0.1; done'
/** A project with `npm test` and one passing test, its TPM running, auto mode off. `files`: its tests instead, wherever they are. */
async function project(name: string, files?: Record<string, string>) {
  const dir = hq.repo(name)
  const all = files ?? { 'package.json': JSON.stringify({ name, private: true, scripts: { start: 'node server.js', test: 'node --test' } }), 'test/ok.test.js': PASS }
  for (const [f, text] of Object.entries(all)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f }
}
type P = Awaited<ReturnType<typeof project>>
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const wt = (p: P, t: any) => path.join(p.dir, '.claude', 'worktrees', t.key)
/** A ticket, its engineer, and `files` committed and handed over with open_pr (after running the tests, as Bug 162 asks with auto off). `proof`: its
 *  criteria, and the test open_pr names for each. */
async function finished(p: P, title: string, files: Record<string, string>, cmd = 'npm test', proof?: { criteria: unknown[]; tests: unknown[] }): Promise<{ t: any; eng: any }> {
  const t = (await hq.api('tickets', { featureId: p.f.id, title, size: 'S', spec: `${title}.`, ...(proof ? { criteria: proof.criteria } : {}) })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  await commitAndOpen(p, t, eng, files, cmd, proof?.tests)
  return { t, eng }
}
async function commitAndOpen(p: P, t: any, eng: any, files: Record<string, string>, cmd = 'npm test', tests?: unknown[]): Promise<void> {
  for (const [f, text] of Object.entries(files)) { // '' removes the file
    const at = path.join(wt(p, t), f); if (text === '') fs.rmSync(at); else { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, text) }
  }
  sh(wt(p, t), 'add', '-A'); sh(wt(p, t), 'commit', '-qm', t.title)
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: `toolu_${eng.id}_${Date.now()}` })
  await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(eng.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true, ...(tests ? { tests } : {}) })
  assert.equal(r.isError, false, r.text)
  await waitFor(`${t.key} finished`, async () => (await tk(t))?.status === 'pr_ready')
}
const check = (t: any) => hq.api(`tickets/${t.id}/check`, {})
/** Bug 403: this PATH with `tool` taken off it. A folder that holds it is replaced by one of links to everything else in it (node and git may share it). */
const linkDirs: string[] = []; after(() => { for (const d of linkDirs) fs.rmSync(d, { recursive: true, force: true }) })
function without(tool: string): string {
  return process.env.PATH!.split(path.delimiter).filter(Boolean).map((d) => {
    if (!fs.existsSync(path.join(d, tool))) return d
    const links = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b403-path-')); linkDirs.push(links)
    for (const f of fs.readdirSync(d)) if (f !== tool) fs.symlinkSync(path.join(d, f), path.join(links, f))
    return links
  }).join(path.delimiter)
}
/** Bug 411: when HQ's command would leave test files out, HQ first asks a helper for the project's test steps (teststeps.ts; its own tests are in
 *  teststeps.test.ts). Here the helper says it can't, so HQ tests with what its rules find. */
async function noSteps(p: P): Promise<void> {
  const id = await waitFor('a test steps helper', async () => (await hq.state()).previews.find((x: any) => x.id === p.repo.id)?.test_steps?.helper_agent_id, 30_000)
  await waitFor('the helper to be running', async () => (await hq.state()).agents.find((a: any) => a.id === id && a.status === 'working'), 30_000)
  assert.equal((await hq.mcp(id, 'report_cant_test_steps', { reason: 'Nothing here can run that folder\'s tests.' })).isError, false)
}
/** HQ's own notice to the project's TPM that matches `re` (Bug 373: what it hears when a ticket goes back, and when it is finished again). */
const toTpm = (p: P, re: RegExp) => waitFor(`HQ to tell the TPM ${re}`, async () =>
  (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === p.f.tpm_agent_id && re.test(m.body)))
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

// Bug 372: the eight tests named for a ticket's criteria ran and passed, and the check said all eight "never ran". The project's tests were in a folder and
// run by vitest, which prints a ✓ line per test file (its path from that folder) and names only its slow tests. Here web/'s test script prints what vitest
// 4.1.11 really printed for these files (src/testdata/bug372, captured through HQ's sandbox), and HQ's own command for the project is (cd "web" && npm test).
// Bug 375: list.test.ts's line there says "1 skipped", so a test named in it (here the skipped one) is one HQ can't see, not "passed".
test('Bug 372: tests in a folder, run by a runner that prints a line per test file: the check is green, and a test HQ can\'t see by name is no failure', async () => {
  const out = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'testdata', 'bug372', 'vitest-4.1.11.txt'), 'utf8')
  const p = await project('shop', { 'web/package.json': JSON.stringify({ name: 'web', private: true, scripts: { test: 'node print.js' } }),
    'web/print.js': `process.stdout.write(${JSON.stringify(out)})\n`, 'web/src/api.test.ts': "test('has due_on', () => {})\n" })
  const criteria = [{ kind: 'backend', text: 'Each book in the list has its due date.' }, { kind: 'backend', text: 'A book due within 3 days is marked due soon.' },
    { kind: 'backend', text: 'The list says how many books it holds.' }]
  const tests = [{ criterion: 'A1', file: 'web/src/api.test.ts', name: 'has due_on' }, { criterion: 'A2', file: 'web/src/list.test.ts', name: 'marks a book due soon' },
    { criterion: 'A3', file: 'web/checks/count.test.ts', name: 'counts the books' }] // a file the run never lists: HQ can't tell, and says so
  const { t } = await finished(p, 'Due dates', { 'web/src/list.test.ts': "test('shows each due date', () => {})\ntest.skip('marks a book due soon', () => {})\n",
    'web/checks/count.test.ts': "test('counts the books', () => {})\n" }, '(cd "web" && npm test)', { criteria, tests })
  const r = await check(t); assert.equal(r.status, 200, JSON.stringify(r.json))
  const c = await ended(t)
  assert.equal(c.state, 'pass', JSON.stringify(c)); assert.deepEqual(await button(t), ['View results ✓', 'green'])
  assert.deepEqual(c.steps.slice(0, 2).map((s) => [s.kind, s.state]), [['tests', 'pass'], ['criteria', 'pass']])
  assert.equal(c.steps[1]!.words, "The tests passed, but HQ couldn't see 2 of the 3 tests named for its criteria by name.") // not "Every test … ran"
  assert.match(c.steps[0]!.words, /^`\(cd "web" && npm test\)` passed/)
  assert.deepEqual(c.steps[1]!.lines, [
    { text: 'A1: web/src/api.test.ts · "has due_on" · passed in HQ\'s test run', tone: 'ok' }, // its file's line has nothing skipped
    { text: 'A2: web/src/list.test.ts · "marks a book due soon" · in a passing run; the test command doesn\'t print every test\'s name, so HQ couldn\'t confirm it',
      tone: 'plain' }, // Bug 375: was "passed in HQ's test run"
    { text: 'A3: web/checks/count.test.ts · "counts the books" · in a passing run; the test command doesn\'t print every test\'s name, so HQ couldn\'t confirm it', tone: 'plain' }])
  assert.deepEqual(JSON.parse((await tk(t)).proof).tests.map((e: any) => e.state), ['passed', 'unconfirmed', 'unconfirmed']) // the Ticket tab reads these
  assert.equal((await tk(t)).status, 'pr_ready'); assert.equal((await hq.state()).agents.filter((a: any) => a.role === 'engineer' && a.status === 'working').length, 1) // nobody new started
})

// Bug 376: two folders with a test file at the same path in each. HQ's command runs web/'s tests only (admin/ has none of its own to run), and vitest started
// in web/ prints `src/api.test.ts`: that line counted for admin/src/api.test.ts too, so a test named there read "passed". Here as in Bug 372's test above.
test('Bug 376: a file line from web/\'s run doesn\'t count for admin/\'s file at the same path; with the user\'s own command HQ can\'t tell, as before', async () => {
  const out = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'testdata', 'bug372', 'vitest-4.1.11.txt'), 'utf8')
  const p = await project('b376x', { 'web/package.json': JSON.stringify({ name: 'web', private: true, scripts: { test: 'node print.js' } }),
    'web/print.js': `process.stdout.write(${JSON.stringify(out)})\n`, 'admin/package.json': JSON.stringify({ name: 'admin', private: true }) })
  const criteria = [{ kind: 'backend', text: 'Each book has its due date.' }, { kind: 'backend', text: 'The admin page lists the users.' }]
  const tests = [{ criterion: 'A1', file: 'web/src/api.test.ts', name: 'has due_on' }, { criterion: 'A2', file: 'admin/src/api.test.ts', name: 'lists the users' }]
  const { t } = await finished(p, 'Due dates', { 'web/src/api.test.ts': "test('has due_on', () => {})\n", 'admin/src/api.test.ts': "test('lists the users', () => {})\n" },
    '(cd "web" && npm test)', { criteria, tests })
  const states = async () => JSON.parse((await tk(t)).proof).tests.map((e: any) => e.state)
  assert.equal((await check(t)).status, 200); await noSteps(p); const c = await ended(t) // admin/'s test file is one the command runs nothing of: a helper is asked first
  // Bug 376: web/'s line no longer made admin/'s test read "passed in HQ's test run". Bug 411: HQ runs the command part by part and knows it runs nothing in
  // admin/, so it says that, where it used to say it couldn't confirm the test: the command is what's missing, and the check is amber, not green
  assert.equal(c.state, 'fail', JSON.stringify(c)); assert.match(c.steps[0]!.words, /^`\(cd "web" && npm test\)` passed/)
  assert.deepEqual(c.steps[1]!.lines![1], { text: 'A2: admin/src/api.test.ts · "lists the users" · HQ\'s test command runs nothing in admin/', tone: 'bad' })
  assert.deepEqual(await states(), ['passed', 'not_run']); assert.equal(checkHeadline(c), "The tests passed, but HQ's test command doesn't run the folder a test named for its criteria is in")
  // the user's own command, which HQ doesn't build: where its runner starts is the user's to know, so the line counts for both files, as before Bug 376
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'cd web && npm test' })).status, 200)
  assert.equal((await check(t)).status, 200)
  const again = await waitFor('the second check to end', async () => { const x = checkOf(await tk(t)); return x && x.id !== c.id && x.state !== 'running' ? x : null })
  assert.equal(again.state, 'pass', JSON.stringify(again)); assert.deepEqual(await states(), ['passed', 'passed'])
})

// Bug 411: a frontend/ with a test script beside a backend/ of pytest tests. HQ's rules stop at the frontend, so a ticket's tests in backend/ never ran, and the
// ticket went back to its engineer with "put it where that command runs it" (it wrapped pytest in the frontend's runner). The command is what's missing.
test('Bug 411: a named test where HQ\'s test command runs nothing is the command\'s gap: amber, said on the check and in the Auto box, with nothing to send the engineer', async () => {
  const pkg = JSON.stringify({ name: 'frontend', private: true, scripts: { test: 'node --test' } })
  const p = await project('b411', { 'frontend/package.json': pkg, 'frontend/ok.test.js': PASS, 'backend/pyproject.toml': '[project]\nname = "api"\nversion = "0.1.0"\n',
    'backend/tests/test_app.py': 'def test_answers():\n    assert True\n', 'backend/print.js': "console.log('tests/test_downloads.py::test_download_is_listed PASSED')\n" })
  const CMD = '(cd "frontend" && npm test)'
  // the Auto box: the command HQ found, and the tests it runs nothing of
  const box = (await hq.api(`repos/${p.repo.id}/auto-check`, {})).json
  assert.equal(box.found, CMD); assert.deepEqual(box.not_run, ['backend/ (1 Python test file)'])
  const criteria = [{ kind: 'backend', text: 'A downloaded file is in the list of downloads.' }, { kind: 'ui', text: 'The list shows each item.' }]
  const tests = [{ criterion: 'A1', file: 'backend/tests/test_downloads.py', name: 'test_download_is_listed' }, { criterion: 'A2', file: 'frontend/list.test.js', name: 'shows the list' }]
  const { t, eng } = await finished(p, 'Downloads', { 'backend/tests/test_downloads.py': 'def test_download_is_listed():\n    assert True\n',
    'frontend/list.test.js': "require('node:test').test('shows the list',()=>{})\n" }, CMD, { criteria, tests })
  const states = async () => JSON.parse((await tk(t)).proof).tests.map((e: any) => e.state)
  assert.equal((await check(t)).status, 200); await noSteps(p); const c = await ended(t) // the helper HQ asks first can't: the rules' command it is
  assert.equal(c.state, 'fail', JSON.stringify(c)); assert.deepEqual(await states(), ['not_run', 'passed'])
  assert.equal(checkHeadline(c), "The tests passed, but HQ's test command doesn't run the folder a test named for its criteria is in"); assert.deepEqual(await button(t), ['View results ⚠', 'amber'])
  assert.match(c.steps[0]!.words, /^`\(cd "frontend" && npm test\)` passed/)
  assert.equal(c.steps[1]!.words, "1 test named for its criteria wasn't seen running. The tests themselves passed: none failed. HQ's test command (`(cd \"frontend\" && npm test)`) runs nothing "
    + 'in backend/: set one that runs those tests too, in the Auto box, then test again.')
  assert.deepEqual(c.steps[1]!.lines, [{ text: 'A1: backend/tests/test_downloads.py · "test_download_is_listed" · HQ\'s test command runs nothing in backend/', tone: 'bad' },
    { text: 'A2: frontend/list.test.js · "shows the list" · passed in HQ\'s test run', tone: 'ok' }])
  const send = c.send as { outside?: number; output: string }
  assert.equal(send.outside, 1); assert.match(send.output, /never ran: HQ's test command runs nothing in backend\/ \(it runs frontend\/\)\.$/)
  // nothing goes to its engineer: it can't change the command
  const sent = await hq.api(`tickets/${t.id}/check-send`, {})
  assert.equal(sent.status >= 400, true)
  assert.match(sent.json.error, /HQ's test command doesn't run the folder T-01's tests are in.*Set a test command that runs them \(Auto box\), then press Test again\./)
  assert.equal((await tk(t)).status, 'pr_ready'); assert.equal((await hq.state()).messages.some((m: any) => m.to_id === eng.id && /didn't run every test/.test(m.body)), false)
  // the user sets a command that runs the backend's tests too (their own: it runs whole, as before), and the same ticket passes
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'cd frontend && npm test && cd ../backend && node print.js' })).status, 200)
  assert.equal((await check(t)).status, 200)
  const again = await waitFor('the second check to end', async () => { const x = checkOf(await tk(t)); return x && x.id !== c.id && x.state !== 'running' ? x : null })
  assert.equal(again.state, 'pass', JSON.stringify(again)); assert.deepEqual(await states(), ['passed', 'passed'])
})

// Bug 403: with pnpm missing from HQ's PATH, HQ's command was `npm test`: the Auto box offered it, and auto then stopped at once with "Install pnpm, then test
// again" beside a Resume button. The command names the project's tool whatever PATH holds, the box says up front that it's missing, and the words name the button
test('Bug 403: a pnpm project with no pnpm on HQ\'s PATH: the Auto box names `pnpm test` and says pnpm is missing; a check and auto stop with their own button\'s words', async () => {
  await hq.stop(); hq = await startHq({ env: { ...ENV, PATH: without('pnpm') } })
  const p = await project('b403pn', { 'package.json': JSON.stringify({ name: 'b403pn', private: true, scripts: { test: 'node --test' } }), 'pnpm-lock.yaml': '', 'test/ok.test.js': PASS })
  const box = (await hq.api(`repos/${p.repo.id}/auto-check`, {})).json
  assert.equal(box.found, 'pnpm test'); assert.equal(box.stop, null)
  assert.match(box.no_tool, /^it uses pnpm \(it has a pnpm-lock\.yaml\), and pnpm isn't installed on this computer \(HQ looked in its PATH\), /)
  assert.match(box.no_tool, /, so HQ can't run its tests \(pnpm test\)\. Install pnpm, then HQ can test it\.$/)
  const { t } = await finished(p, 'Hello', { 'test/hello.test.js': PASS }, 'pnpm test')
  assert.equal((await check(t)).status, 200); const c = await ended(t)
  assert.equal(c.state, 'error', JSON.stringify(c)); assert.match(c.why!, /^HQ couldn't test it: it uses pnpm .*Install pnpm, then press Test again\.$/)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const why = await waitFor('auto to stop', async () => (await hq.state()).repos.find((r: any) => r.id === p.repo.id)?.auto_stopped_why, 60_000)
  assert.match(why, /^HQ couldn't test (T-01|main): it uses pnpm .*Install pnpm, then press Resume\.$/)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
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
  // Bug 405: the same as the results say: main passed without it, so no "another ticket may have merged first"
  assert.match(told.body, /main passes them without your ticket, so the failure is your ticket's/); assert.doesNotMatch(told.body, /may have merged first/)
  // Bug 373: the TPM hears what came back and why, in HQ's words: here a test did fail, and it is named
  assert.match((await toTpm(p, /went back/)).body, new RegExp(`^HQ: T-01 went back to its engineer \\(${eng.id}, still running\\) because its tests failed with it merged into main: `
    + '.*adds two.*\\. The user had HQ test it and sent it back\\.$'))
  const now = await tk(t); assert.equal(now.status, 'resolving'); assert.equal(now.fixing, 'tests'); assert.ok(checkOf(now)!.sent_at)
  assert.equal(await button(t), null, 'its engineer has it: no button until it is finished again')
  assert.match((await hq.api(`tickets/${t.id}/check-send`, {})).json.error, /sent to its engineer already/)
  // the engineer fixes it and finishes again: the old results are about older code
  await commitAndOpen(p, t, eng, { 'test/maths.test.js': PASS })
  assert.deepEqual(await button(t), ['Fix is back · test again', 'sky']) // Bug 401: not a grey "out of date": the fix of what the user sent is back
  // Bug 373: and the TPM hears what its engineer did, not "fixed its tests"; the check that was sent keeps it on the ticket
  const done = (await toTpm(p, /finished it again/)).body
  assert.match(done, /^HQ: T-01's engineer finished it again \(hq\/red\/T-01-add-maths\)\. It had gone back because its tests failed with it merged into main: .*adds two/)
  assert.match(done, /\. Since then its engineer changed 1 file: test\/maths\.test\.js\. Its engineer's own notes on it: "done" The user merges it from HQ; you'll be told when it merges\.$/)
  const back = checkOf((await tk(t))!)!.back!; assert.deepEqual([back.files, back.note], [['test/maths.test.js'], 'done'])
  assert.equal((await check(t)).status, 200); assert.equal((await ended(t)).state, 'pass')
  assert.deepEqual(await button(t), ['View results ✓', 'green'])
  // Test again didn't wipe the first results: they are still on the ticket, with what was sent and what came of it
  assert.deepEqual(checksOf((await tk(t))!).map((x) => [x.id, x.state, !!x.sent_at, !!x.back]), [[checkOf((await tk(t))!)!.id, 'pass', false, false], [c.id, 'fail', true, true]])
  assert.deepEqual(checksOf((await tk(t))!).map((x) => x.round), [2, 1], 'Bug 401: round 2 is the test of the fix that came back from round 1')
})

// Bug 426: a project whose `npm test` exits 0 though a test failed (`node --test || true`): the check said "`npm test` passed: 1 passed, 1 failed", then
// "The tests themselves passed: none failed" and that the test named for its criterion didn't run. HQ goes by the counts: red, and it says the command exited 0
test('Bug 426: a test command that exits 0 though a test failed is a failure, said as one, with main alone still passing', async () => {
  const p = await project('b426x', { 'package.json': JSON.stringify({ name: 'b426x', private: true, scripts: { test: 'node --test || true' } }), 'test/ok.test.js': PASS })
  const proof = { criteria: [{ kind: 'backend', text: 'Two and two make four.' }], tests: [{ criterion: 'A1', file: 'test/maths.test.js', name: 'adds two' }] }
  const { t, eng } = await finished(p, 'Add maths', { 'test/maths.test.js': FAIL }, 'npm test', proof)
  assert.equal((await check(t)).status, 200)
  const c = await ended(t)
  assert.equal(c.state, 'fail', JSON.stringify(c)); assert.equal(c.steps.length, 1); assert.deepEqual(await button(t), ['View results ✗', 'red'])
  assert.match(c.steps[0]!.words, /^They failed: .*adds two \(`npm test` exited 0 all the same, but its output says 1 passed, 1 failed\) · main passes them without T-01, so the /)
  assert.doesNotMatch(c.steps[0]!.words, /`npm test` passed/)
  assert.equal((await hq.api(`tickets/${t.id}/check-send`, {})).status, 200)
  const told = await waitFor('the engineer told', async () => (await hq.state()).messages.find((m: any) => m.to_id === eng.id && /so the user sent it back to you/.test(m.body)))
  assert.match(told.body, /`npm test` exits 0 even when a test fails, so don't go by its exit code: read what it prints\. HQ went by its counts, 1 passed, 1 failed\./)
  assert.match((await toTpm(p, /went back/)).body, /because its tests failed with it merged into main: .*adds two \(`npm test` exited 0 all the same, but its output says 1 passed, 1 failed\)/)
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

// Bug 428: HQ's run of main alone can't be done (its checkout fails, as a full disk would). A `git` in front of the real one on HQ's PATH fails only that one
test('Bug 428: when HQ can\'t test main alone, the results don\'t say the failure is the ticket\'s, as its engineer hears', async () => {
  await hq.stop()
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-git-'))), real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\ncase " $* " in *" worktree add "*"/b428/"*"hq-test-T-01-check-main "*) '
    + `echo "fatal: could not create work tree dir: No space left on device" >&2; exit 128;; esac\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 })
  try {
    hq = await startHq({ env: { ...ENV, PATH: `${bin}:${process.env.PATH}` } })
    const p = await project('b428'), { t, eng } = await finished(p, 'Add maths', { 'test/maths.test.js': FAIL })
    assert.equal((await check(t)).status, 200); const c = await ended(t)
    assert.equal(c.state, 'fail', JSON.stringify(c)); assert.deepEqual(await button(t), ['View results ✗', 'red'])
    assert.match(c.steps[0]!.words, new RegExp(/^They failed: .*adds two · HQ couldn't test main without T-01 \(fatal: could not create work tree dir: No space left /.source
      + /on device\), so it can't tell whether the failure is T-01's\.$/.source)); assert.doesNotMatch(c.steps[0]!.words, /main passes them/)
    // its engineer hears the same: maybe another ticket's (Bug 405's hedge)
    assert.equal((await hq.api(`tickets/${t.id}/check-send`, {})).status, 200)
    const told = await waitFor('the engineer told', async () => (await hq.state()).messages.find((m: any) => m.to_id === eng.id && /so the user sent it back to you/.test(m.body)))
    assert.match(told.body, /Another ticket may have merged first/); assert.doesNotMatch(told.body, /main passes them without your ticket/)
  } finally { await hq.stop(); fs.rmSync(bin, { recursive: true, force: true }) }
})

/** The UI tester's planning calls so far (fake-claude.mjs logs each call to its home). */
const planCalls = (): any[] => { try { return fs.readFileSync(path.join(hq.home, 'fake-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((c) => /^You plan how to test/.test(c.system)) } catch { return [] } }
/** A finished ticket with screen criteria (`crit`), each with no test of its own, so the UI tester has something to try. `files`: what it commits, by its key. */
async function screenTicket(p: P, title: string, crit: { kind: string; text: string }[], files = (key: string): Record<string, string> => ({ [`${key}.txt`]: 'x\n' })): Promise<any> {
  const t = (await hq.api('tickets', { featureId: p.f.id, title, size: 'S', spec: `${title}.`, criteria: crit })).json, eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  for (const [f, text] of Object.entries(files(t.key))) fs.writeFileSync(path.join(wt(p, t), f), text)
  sh(wt(p, t), 'add', '-A'); sh(wt(p, t), 'commit', '-qm', title)
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `toolu_${eng.id}_1` })
  await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const cant = 'It is about what the screen shows, and nothing here can render a page.'
  const r = await hq.mcp(eng.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true,
    tests: crit.map((_, i) => ({ criterion: `A${i + 1}`, cant_test: cant })) })
  assert.equal(r.isError, false, r.text); await waitFor(`${t.key} finished`, async () => (await tk(t))?.status === 'pr_ready')
  return t
}

test('a project with start steps: the app is opened and the UI tester tries it; a finding is red, and a tester that can\'t run is amber, never green', async () => {
  const p = await project('app')
  assert.equal((await hq.api(`previews/${p.repo.id}/command`, { command: 'node server.js' })).status, 200)
  const plan = `FAKE-PLAN: ${JSON.stringify({ scenarios: [{ kind: 'basic', title: 'Tick Dune off', goal: 'Tick Dune off.', criteria: ['A1'] }] })}`
  const found = `FAKE-UITEST: ${JSON.stringify({ 's-01': { outcome: 'problem', notes: [],
    findings: [{ kind: 'no_feedback', what: 'Ticking showed nothing.', expected: 'Crossed out', criterion: 'A1' }] } })}`
  const made = (title: string, crit: { kind: string; text: string }[]) => screenTicket(p, title, crit)
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
  // Bug 453: it is about one of the ticket's own screen criteria, which is why it counts; and the tester was asked for this ticket's criteria only, a few each
  assert.equal(c.steps[4]!.words, `A problem with ${red.key}'s screen criteria, in 1 scenario.`)
  assert.match(c.send?.kind === 'fix' ? c.send.output : '', new RegExp(`\\n- ${red.key} A1: Ticking showed nothing\\. \\(expected: Crossed out\\)`))
  assert.match(planCalls().at(-1).prompt, /\n\nWrite about 8 scenarios, every one about an item in what's new: [^\n]* Nothing about the rest of the app\. Fewer is fine: [^\n]*\n$/)
  assert.equal(checkOf((await tk(red))!)!.cost_usd! > 0, true)
  const amber = await made('Something', [{ kind: 'ui', text: 'It does something. FAKE-PLAN: error' }])
  assert.equal((await check(amber)).status, 200)
  const a = await ended(amber)
  assert.equal(a.state, 'error', JSON.stringify(a)); assert.equal(a.why, "the UI tester couldn't run; nothing that ran failed")
  assert.match(a.steps.at(-1)!.words, /couldn't plan its scenarios/); assert.equal(a.steps.at(-1)!.trouble, true)
  assert.deepEqual(await button(amber), ["Couldn't finish", 'amber'])
})

// Bug 453: on a live run, a ticket that changed no screen was failed by the UI tester for an old quirk of another screen, and another for an error from an
// outside service HQ's sandbox can't reach: any finding anywhere was the ticket's, and Send to engineer offered its engineer what it couldn't fix.
test('Bug 453: what the tester finds that isn\'t about the ticket\'s screen criteria is said in its results and not held against it: green, and nothing to send',
  { skip: process.platform !== 'darwin' && 'the UI tester runs on macOS only' }, async () => {
    const p = await project('aside')
    assert.equal((await hq.api(`previews/${p.repo.id}/command`, { command: 'node server.js' })).status, 200)
    const plan = `FAKE-PLAN: ${JSON.stringify({ scenarios: [{ kind: 'basic', title: 'Star a chat', goal: 'Star a chat and see it starred.', about: ['A1'] },
      { kind: 'complex', title: 'Star, then search', goal: 'Star a chat, then find it by searching.', about: ['A1'] }] })}`
    // the tester names no criterion for it: it is about the search, which this ticket didn't touch
    const quirk = `FAKE-UITEST: ${JSON.stringify({ 's-02': { outcome: 'problem', notes: [], findings: [{ kind: 'no_feedback', what: 'Opening a search match did not scroll to it.',
      expected: 'The match in view' }] } })}`
    const t = await screenTicket(p, 'Star chats', [{ kind: 'ui', text: `A starred chat shows a star. ${plan}` }, { kind: 'ui', text: `The star stays after a reload. ${quirk}` }])
    assert.equal((await check(t)).status, 200)
    const c = await ended(t), ui = c.steps.at(-1)!
    assert.equal(c.state, 'pass', JSON.stringify(c)); assert.deepEqual([ui.kind, ui.state, ui.trouble], ['ui', 'pass', undefined]); assert.equal(c.send, undefined)
    assert.equal(ui.words, `1 of 2 scenarios fine, nothing wrong with ${t.key}'s screen criteria. 1 more thing seen on the way (listed below) is not about them.`)
    assert.deepEqual(ui.lines, [{ tone: 'ok', text: 'Star a chat: fine' },
      { tone: 'plain', text: `Star, then search: seen on the way, not about ${t.key}'s screen criteria: Opening a search match did not scroll to it.` }])
    assert.deepEqual(await button(t), ['View results ✓', 'green'])
    assert.match((await hq.api(`tickets/${t.id}/check-send`, {})).json.error, /found nothing to send to its engineer/) // nothing of the ticket's to send
    assert.match(planCalls().at(-1).prompt, /\n\nWrite about 8 scenarios, every one about an item in what's new: /) // two screen criteria: eight, not the whole app's thirty
    // the tester is told what a finding with no [id] is taken for
    const sessions = fs.readFileSync(path.join(hq.home, 'fake-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => /^You are testing a web app/.test(x.system))
    assert.match(sessions.at(-1).prompt, /\nOnly what's new is under test\. A finding names an item's \[id\] only when what that item's line says doesn't hold; anything else you notice, /)
  })

test('Bug 453: a ticket with no screen criteria is not tried by the UI tester: nothing is planned or paid for, and the check is not amber for it', async () => {
  const p = await project('behind')
  assert.equal((await hq.api(`previews/${p.repo.id}/command`, { command: 'node server.js' })).status, 200)
  const t = await screenTicket(p, 'Keep a count', [{ kind: 'backend', text: 'One record is kept per item.' }])
  assert.equal((await check(t)).status, 200)
  const c = await ended(t), ui = c.steps.at(-1)!
  assert.equal(c.state, 'pass', JSON.stringify(c)); assert.deepEqual(c.steps.map((s) => [s.kind, s.state]).slice(0, 3), [['tests', 'pass'], ['criteria', 'skipped'], ['look', 'pass']])
  assert.deepEqual([ui.kind, ui.state, ui.trouble], ['ui', 'skipped', undefined])
  assert.equal(ui.words, `Not tried: ${t.key} has no screen criteria, so there is nothing new on screen to try.`)
  assert.equal(planCalls().length, 0); assert.equal(c.cost_usd, undefined)
  assert.deepEqual(await button(t), ['View results ✓', 'green'])
})

// Bug 460: two checks pressed a moment apart in one project shared the UI tester's one checkout. The second to start replaced the first's code with its own
// (and stopped its app), and the first to end removed the folder under the other: one ticket's tester tried another ticket's app, the other found no app.
test('Bug 460: two checks at once each have the UI tester try their own ticket\'s app, in a checkout of its own, and leave none behind',
  { skip: process.platform !== 'darwin' && 'the UI tester runs on macOS only' }, async () => {
    const p = await project('b460two')
    assert.equal((await hq.api('settings', { key: 'heavy_at_once', value: 2 })).status, 200) // room for both testers at once
    assert.equal((await hq.api(`previews/${p.repo.id}/command`, { command: 'node server.js' })).status, 200)
    const plan = `FAKE-PLAN: ${JSON.stringify({ scenarios: [{ kind: 'basic', title: 'Open the app', goal: 'Open the app.', criteria: ['A1'] }] })}`
    // the app answers with version.txt, which each ticket sets to its own key; each tester waits for b460-go before it opens the page
    const made = (title: string) => screenTicket(p, title, [{ kind: 'ui', text: `It shows its version. ${plan}` }, { kind: 'ui', text: 'Still. FAKE-UITEST: page b460-go' }],
      (key) => ({ 'version.txt': `${key}\n` }))
    const a = await made('Version A'), b = await made('Version B')
    assert.equal((await check(a)).status, 200); assert.equal((await check(b)).status, 200)
    // both testers have made their app ready and planned: the first holds its checkout while the second has made its own
    await waitFor('both testers to plan', () => planCalls().length >= 2, 60_000)
    assert.equal(testCheckouts(p).filter((x) => x.startsWith('hq-test-ui-')).length, 2, testCheckouts(p).join(' '))
    fs.writeFileSync(path.join(hq.home, 'b460-go'), '')
    for (const t of [a, b]) {
      const c = await ended(t, 60_000), ui = c.steps.find((s) => s.kind === 'ui')!
      assert.equal(ui.state, 'fail', JSON.stringify(c)); assert.match(ui.lines![0]!.text, new RegExp(`^Open the app: The page said ${t.key}\\.`)) // its own ticket's app
    }
    await waitFor('no checkout left', () => testCheckouts(p).length === 0); assert.equal(sh(p.dir, 'status', '--porcelain'), '')
  })

// Bug 374: the project's start steps give a part a fixed port (one the project hard-wires), and HQ's own preview of the app is running on it, as it
// normally is. HQ's test used to skip the app ("port … is taken") and end amber. Now its copy runs on another port, in its own checkout: the look and the
// UI tester both run, the results say so, and the preview is never stopped. Linux: a run has a network of its own, so the port was always free there.
test('Bug 374: with HQ\'s preview on the app\'s fixed port, the check still opens the app and tries it, on another port, and the preview stays up', async () => {
  const p = await project('fixed'), free = net.createServer(); await new Promise<void>((r) => free.listen(0, '127.0.0.1', r))
  const port = (free.address() as net.AddressInfo).port; await new Promise((r) => free.close(r))
  const recipe = { parts: [{ name: 'app', dir: '.', run: 'node server.js', port }], show: 'app', worktree_files: [], notes: `Port ${port} is hard-wired.` }
  const db = hq.db() // the start steps as the Launch helper saves them once the user has OK'd them
  try { db.prepare("INSERT OR REPLACE INTO previews(id, recipe, status, updated_at) VALUES (?, ?, 'stopped', 1)").run(p.repo.id, JSON.stringify(recipe)) } finally { db.close() }
  assert.equal((await hq.api(`previews/${p.repo.id}/start`, {})).status, 200)
  const pv = async () => (await hq.state()).previews.find((x: any) => x.id === p.repo.id)
  const up = await waitFor('the preview on its fixed port', async () => { const v = await pv(); return v?.status === 'running' && v.port === port ? v : null }, 20_000)
  const plan = `FAKE-PLAN: ${JSON.stringify({ scenarios: [{ kind: 'basic', title: 'Open the list', goal: 'Open the list.', criteria: ['A1'] }] })}`
  const t = await screenTicket(p, 'Show the list', [{ kind: 'ui', text: `The list shows. ${plan}` }])
  assert.equal((await check(t)).status, 200)
  const c = await ended(t, 60_000), look = c.steps.find((s) => s.kind === 'look')!, ui = c.steps.find((s) => s.kind === 'ui')!
  const mac = process.platform === 'darwin', moved = new RegExp(`HQ ran its own copy of the app on port (\\d+) instead of ${port} \\(in use by HQ's preview of fixed\\)\\.$`)
  assert.equal(c.state, 'pass', JSON.stringify(c)); assert.equal(look.state, 'pass', JSON.stringify(look))
  if (mac) {
    assert.match(look.words, moved); assert.notEqual(Number(moved.exec(look.words)![1]), port)
    assert.equal(ui.state, 'pass', JSON.stringify(ui)); assert.match(ui.lines![0]!.text, moved) // the tester's own app, started for real in HQ's sandbox
    const kept = c.tested?.look; assert.ok(kept?.ran === 'pass' && kept.moved?.[0]?.from === port, JSON.stringify(kept)) // kept with the result, for a merge's record
  } else assert.doesNotMatch(look.words, /instead of/)
  // the preview was never touched: the same run, still answering on the project's own port
  const still = await pv(); assert.deepEqual([still.status, still.port, still.started_at], ['running', port, up.started_at])
  assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), 'v1\n')
  assert.equal(sh(p.dir, 'status', '--porcelain'), ''); await waitFor('no checkout left', () => testCheckouts(p).length === 0) // and nothing in the user's folder
  // A port HQ can't be sure it has found every mention of is left where it is: amber, with who has it and what to press
  if (!mac) return
  fs.writeFileSync(path.join(p.dir, 'ports.js'), `exports.API_PORT = ${port}\n`); sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'a port in the code') // the user's own commit on main
  const asked = planCalls().length; assert.equal(asked, 1, 'the first check above planned once')
  assert.equal((await check(t)).status, 200)
  const a = await ended(t, 60_000), cant = a.steps.find((s) => s.kind === 'look')!
  assert.equal(a.state, 'error', JSON.stringify(a)); assert.equal(a.why, "HQ couldn't open the app; nothing that ran failed")
  assert.equal(cant.words, `Couldn't open it: port ${port}, which its app part always uses, is in use by HQ's preview of fixed. HQ couldn't run its own copy on another port: `
    + `ports.js line 1 names ${port} in a way HQ can't safely change. Stop the app in the preview, then test again.`)
  assert.equal((await pv()).status, 'running')
  // Bug 380: the UI tester found that out before asking for its plan, a paid call: none was made, and its step says why, with nothing paid
  const noPlan = a.steps.find((s) => s.kind === 'ui')!; assert.equal(planCalls().length, asked, 'no plan for an app that can\'t be started here')
  assert.equal(noPlan.words, `Not tried: port ${port}, which its app part always uses, is in use by HQ's preview of fixed. HQ couldn't run its own copy on another `
    + `port: ports.js line 1 names ${port} in a way HQ can't safely change. Stop the app in the preview, then test again.`); assert.equal(a.cost_usd, undefined)
  // A copy HQ moved that doesn't start there (its server takes the port from somewhere HQ can't see, and is refused the old one): amber too, about the port
  // and what to press, never about the code. The look's stand-in says what a real start says; the UI tester's own app is started for real.
  const noStart = 'its app part stopped (1) while the app was starting'
  fs.writeFileSync(path.join(p.dir, 'server.js'), `require('http').createServer((q, s) => s.end('v2')).listen(${port - 1} + 1)\n`)
  fs.writeFileSync(path.join(p.dir, 'look.json'), JSON.stringify({ kind: 'no_start', why: noStart, output: 'listen EPERM' }))
  sh(p.dir, 'rm', '-q', 'ports.js'); sh(p.dir, 'add', '.'); sh(p.dir, 'commit', '-qm', 'the port from somewhere HQ can\'t see')
  assert.equal((await check(t)).status, 200)
  const b = await ended(t, 90_000), words = new RegExp(`port ${port}, which its app part always uses, is in use by HQ's preview of fixed\\. HQ ran its own copy on port (\\d+) instead, `
    + `and the app didn't start there \\(${noStart.replace(/[()]/g, '\\$&')}\\)\\. Stop the app in the preview, then test again`)
  assert.equal(b.state, 'error', JSON.stringify(b)); assert.equal(b.why, "HQ couldn't open the app; nothing that ran failed")
  assert.match(b.steps.find((s) => s.kind === 'look')!.words, new RegExp(`^Couldn't open it: ${words.source}\\.$`))
  const tried = b.steps.find((s) => s.kind === 'ui')!; assert.match(JSON.stringify(tried), words, JSON.stringify(tried)); assert.notEqual(tried.state, 'fail')
  // only a start shows this, so the plan came first here: paid for, and its cost is shown (Bug 380)
  assert.equal(planCalls().length, asked + 1); assert.match(tried.words, /\. Its plan of scenarios had cost \$0\.01\.$/); assert.equal(b.cost_usd, 0.01)
  const after = await pv(); assert.deepEqual([after.status, after.port, after.started_at], ['running', port, up.started_at]) // the preview: still the same run
  assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), 'v1\n')
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
  // Bug 364: with auto mode off (turned off after it parked this) nothing would take it: HQ refuses another go, and the park keeps its reason
  const off = await hq.api(`tickets/${t.id}/auto-retry`, {}); assert.equal(off.status, 409); assert.match(off.json.error, /Auto mode is off/)
  assert.equal((await tk(t)).auto_parked_why, 'Its tests still fail after 2 fixes.')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  assert.equal((await check(t)).status, 200, 'parked: the user moves it on, so HQ tests it on request'); await onBox(t)
  assert.equal((await hq.api(`tickets/${t.id}/auto-retry`, {})).status, 200)
  const c = await ended(t); assert.equal(c.state, 'stopped'); assert.match(c.why!, /auto mode took over/)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: false })).status, 200)
})

// Bug 373: on the live run all eight tests named for a ticket's criteria "never ran" (they had run and passed: Bug 372). The box showed a failed test's red ✗,
// the TPM heard only "to fix its tests" and told the user the tests hadn't passed, what the engineer found stayed in its terminal, and Test again wiped the
// first results. Here a named test really isn't run by `npm test` (it sits in a folder `node --test` never looks in): nothing fails, and HQ says so.
const ADD = 'exports.add=(a,b)=>a+b\n'
const ADD_TEST = "const t=require('node:test'),a=require('node:assert');t.test('adds two numbers',()=>{a.equal(require('../add').add(2,3),5)})\n"
test('Bug 373: tests that pass with a named one unseen are amber, not a failed test; the TPM hears why the ticket went back and what its engineer did; the results stay', async () => {
  const p = await project('unseen'), events = async (id: string): Promise<string[]> => ((await hq.api(`agents/${id}/events`)).json.events as any[]).map((x) => x.text)
  const t = (await hq.api('tickets', { featureId: p.f.id, title: 'Adding', size: 'S', spec: 'Adding.', criteria: [{ kind: 'backend', text: 'Adding 2 and 3 gives 5.' }] })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json, w = wt(p, t)
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  const put = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }); fs.writeFileSync(path.join(w, f), text) }
  const handOver = async (e: string, notes: string[], tests: unknown[]) => {
    sh(w, 'add', '-A'); sh(w, 'commit', '-qm', 'work')
    await hq.hook(e, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `toolu_${e}_${notes.length}` })
    for (const text of notes) await hq.mcp(e, 'update_handoff', { kind: 'before_pr', text })
    const r = await hq.mcp(e, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true, tests })
    assert.equal(r.isError, false, r.text); await waitFor(`${t.key} finished`, async () => (await tk(t))?.status === 'pr_ready')
  }
  put('add.js', ADD); put('checks/add.js', ADD_TEST)
  await handOver(eng.id, ['Built add. npm test: 1 passed.'], [{ criterion: 'A1', file: 'checks/add.js', name: 'adds two numbers' }])
  const branch = (await tk(t)).branch

  // amber, in its own words: the tests passed and none failed
  assert.equal((await check(t)).status, 200)
  const c = await ended(t)
  assert.equal(c.state, 'fail'); assert.deepEqual(c.steps.map((s) => [s.kind, s.state]), [['tests', 'pass'], ['criteria', 'fail']])
  assert.equal(c.steps[1]!.words, "1 test named for its criteria wasn't seen running. The tests themselves passed: none failed.")
  assert.equal(checkHeadline(c), "The tests passed, but 1 test named for its criteria wasn't seen running")
  assert.deepEqual(await button(t), ['View results ⚠', 'amber'])
  assert.equal(c.send?.kind === 'fix' && c.send.missing, 1)

  // its engineer has stopped, as a finished one does: Send starts a fresh one, and the TPM hears what came back and why
  await hq.api(`agents/${eng.id}/stop`, {})
  const s = await hq.api(`tickets/${t.id}/check-send`, {}); assert.equal(s.status, 200, JSON.stringify(s.json))
  const e2: string = s.json.engineer; assert.notEqual(e2, eng.id)
  assert.equal((await toTpm(p, /went back/)).body, "HQ: T-01 went back to an engineer because its tests passed with it merged into main and none failed, but 1 test named for its "
    + `criteria wasn't seen running. The user had HQ test it and sent it back. Engineer ${e2} started on it (branch ${branch}). Address messages for this ticket to id ${e2}.`)
  const tpmHeard = async () => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === p.f.tpm_agent_id).map((m: any) => m.body).join('\n')
  assert.doesNotMatch(await tpmHeard(), /fix its tests|tests failed|tests fail/) // the words it guessed "its tests didn't pass" from
  let now = await tk(t); assert.deepEqual([now.status, now.fixing], ['resolving', 'tests_unseen'])
  assert.deepEqual((await events(e2)).filter((x) => /came back/.test(x)), ["T-01 came back: its tests passed, but 1 test named for its criteria wasn't seen running"])

  // the fresh engineer puts the test where the command runs it, says so in its handoff log, and finishes again
  await waitFor('the fresh engineer', async () => (await hq.state()).agents.find((a: any) => a.id === e2 && a.status === 'working'))
  fs.rmSync(path.join(w, 'checks'), { recursive: true }); put('test/add.test.js', ADD_TEST)
  const notes = ['The test sat in checks/, which npm test never runs: moved it to test/.', 'Ran npm test after the move: 2 passed.']
  await handOver(e2, notes, [{ criterion: 'A1', file: 'test/add.test.js', name: 'adds two numbers' }])
  assert.equal((await toTpm(p, /finished it again/)).body, `HQ: T-01's engineer finished it again (${branch}). It had gone back because its tests passed with it merged into main `
    + "and none failed, but 1 test named for its criteria wasn't seen running. Since then its engineer changed 2 files: checks/add.js, test/add.test.js. Its engineer's own "
    + `notes on it: "${notes.join(' / ')}" The user merges it from HQ; you'll be told when it merges.`)
  assert.doesNotMatch(await tpmHeard(), /fixed its tests/)
  assert.ok((await events(e2)).includes('T-01 is finished again: its engineer changed 2 files: checks/add.js, test/add.test.js'))
  // on the ticket: the check that was sent says what its engineer did with it (it used to stay in the engineer's terminal)
  now = await tk(t); const sent = checkOf(now)!
  assert.equal(sent.id, c.id); assert.ok(sent.sent_at); assert.deepEqual(sent.back!.files, ['checks/add.js', 'test/add.test.js']); assert.equal(sent.back!.note, notes.join('\n'))
  assert.equal(sent.back!.sha, now.finished_sha); assert.deepEqual(await button(t), ['Fix is back · test again', 'sky'])

  // Test again: it passes now, and the first results are still on the ticket, after a restart too
  assert.equal((await check(t)).status, 200); const c2 = await ended(t); assert.equal(c2.state, 'pass', JSON.stringify(c2))
  assert.match(c2.steps[1]!.words, /Every test named for its criteria ran/); assert.deepEqual(await button(t), ['View results ✓', 'green'])
  const kept = () => tk(t).then((x) => checksOf(x).map((k) => [k.id, k.state, !!k.sent_at, k.back?.files.length ?? 0]))
  assert.deepEqual(await kept(), [[c2.id, 'pass', false, 0], [c.id, 'fail', true, 2]])
  await hq.restart(); assert.deepEqual(await kept(), [[c2.id, 'pass', false, 0], [c.id, 'fail', true, 2]])
  // a third test keeps both of the others, and a merge keeps them all on the merged ticket
  assert.equal((await check(t)).status, 200); const c3 = await ended(t)
  assert.deepEqual((await kept()).map((k) => k[0]), [c3.id, c2.id, c.id])
  const m = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json))
  assert.deepEqual((await kept()).map((k) => k[0]), [c3.id, c2.id, c.id])
})
