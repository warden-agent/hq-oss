// The test steps helper end to end (teststeps.ts, Bug 411), with a fake Claude (see harness.ts): the tests act as the helper and as the engineer, and press
// what a user presses. A project with frontend/ (a test script) and backend/ (tests HQ's rules run nothing of): the first time HQ is to test it, a helper
// works out the test steps, HQ checks them in the real sandbox and sends back what fails, and steps that pass are saved and used from then on with no
// helper. A helper that can't, a Stop, a restart in the middle of HQ's check, the user's own command, and a ticket that adds the first tests of a folder.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, type Hq } from './harness.ts'
import { checkHeadline, checkOf } from '../src/hqcheckrules.ts'

let hq: Hq
const ENV = { HQ_LOOK_RUNNER: path.join(import.meta.dirname, 'fake-look.mjs'), HQ_UITEST_BROWSER_EXE: '/usr/bin/false' }
beforeEach(async () => { hq = await startHq({ env: ENV }) })
afterEach(async () => { await hq?.stop() })

const T = "const t=require('node:test'),a=require('node:assert');", PASS = `${T}t.test('opens',()=>a.ok(1))\n`
const WEB = { 'frontend/package.json': JSON.stringify({ name: 'frontend', private: true, scripts: { test: 'node --test' } }), 'frontend/ok.test.js': PASS }
// backend/: Python test files (what HQ's rules run nothing of), and a stand-in for its runner that prints what pytest -v does
const PRINT = "console.log('tests/test_app.py::test_answers PASSED'); console.log('tests/test_downloads.py::test_download_is_listed PASSED'); console.log('2 passed in 0.01s')\n"
const API = { 'backend/pyproject.toml': '[project]\nname = "api"\nversion = "0.1.0"\n', 'backend/tests/test_app.py': 'def test_answers():\n    assert True\n', 'backend/print.js': PRINT }
const BOTH = { parts: [{ dir: 'backend', test: 'node print.js' }, { dir: 'frontend', test: 'npm test' }] }, CHAIN = '(cd "backend" && node print.js) && (cd "frontend" && npm test)'
/** A project with these files, its TPM running, auto mode off. */
async function project(name: string, files: Record<string, string>) {
  const dir = hq.repo(name)
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f, tpm }
}
type P = Awaited<ReturnType<typeof project>>
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const wt = (p: P, t: any) => path.join(p.dir, '.claude', 'worktrees', t.key)
/** A ticket, its engineer, `files` committed and handed over with open_pr; `tests`: the test open_pr names for each criterion. `cmd`: what its engineer ran. */
async function finished(p: P, title: string, files: Record<string, string>, tests: { criterion: string; file: string; name: string }[], cmd = '(cd "frontend" && npm test)') {
  const t = (await hq.api('tickets', { featureId: p.f.id, title, size: 'S', spec: `${title}.`, criteria: tests.map((x) => ({ kind: 'backend', text: `It does what ${x.name} checks.` })) })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  if ((await hq.state()).repos.find((r: any) => r.id === p.repo.id).auto_mode) assert.equal((await hq.hook(eng.id, exitPlanMode(`Plan for ${t.key}`))).hookSpecificOutput.decision.behavior, 'allow')
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(wt(p, t), f)), { recursive: true }); fs.writeFileSync(path.join(wt(p, t), f), text) }
  sh(wt(p, t), 'add', '-A'); sh(wt(p, t), 'commit', '-qm', title)
  await hq.hook(eng.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: `toolu_${eng.id}_${Date.now()}` })
  await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(eng.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone', feature_map_unchanged: true, tests })
  assert.equal(r.isError, false, r.text)
  return { t, eng }
}
const DOWNLOADS = { 'backend/tests/test_downloads.py': 'def test_download_is_listed():\n    assert True\n', 'frontend/list.test.js': `${T}t.test('counts the downloads',()=>a.ok(1))\n` }
const NAMED = [{ criterion: 'A1', file: 'backend/tests/test_downloads.py', name: 'test_download_is_listed' }, { criterion: 'A2', file: 'frontend/list.test.js', name: 'counts the downloads' }]
const check = (t: any) => hq.api(`tickets/${t.id}/check`, {})
const ended = (t: any, not?: string) => waitFor(`${t.key}'s check to end`, async () => { const c = checkOf((await tk(t)) ?? {}); return c && c.id !== not && c.state !== 'running' ? c : null }, 40_000)
const steps = async (p: P) => (await hq.state()).previews.find((x: any) => x.id === p.repo.id)?.test_steps
const helpers = async () => (await hq.state()).agents.filter((a: any) => a.role === 'launcher' && /^test steps /.test(a.display_name ?? ''))
/** The helper HQ started for this project, once it is running. */
const helper = (p: P, not: string[] = [], ms = 30_000) => waitFor('a test steps helper', async () => { const id = (await steps(p))?.helper_agent_id
  return id && !not.includes(id) ? (await hq.state()).agents.find((a: any) => a.id === id && a.status === 'working') : null }, ms)
/** The mod hands the helper its next batch and Claude Code submits it. */
async function nextBatch(agentId: string): Promise<string> {
  const b = await waitFor('a batch for the helper', async () => (await hq.modNext(agentId)).batch, 40_000)
  await hq.modEvent(agentId, { kind: 'batch_received', id: b.id }); await hq.hook(agentId, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  return b.text
}
/** The helper ran this in its own session (it tried a step before saving it). */
const tried = (id: string, command: string) => hq.hook(id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: `toolu_${id}_${Date.now()}` })
const over = (p: P) => waitFor('the helper to be over', async () => { const s = await steps(p); return s && !s.working ? s : null }, 30_000)
const leftovers = (p: P) => { const d = path.join(p.dir, '.claude', 'worktrees'); return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => /^(teststeps-|hq-test-)/.test(x)) : [] }
/** A finished helper's worktree and HQ's test checkouts are gone (HQ removes them as the job ends, just after the page hears it is over). */
const gone = (p: P) => waitFor('the helper\'s worktree and HQ\'s checkouts to go', () => leftovers(p).length === 0)
const notices = async (re: RegExp) => (await hq.state()).attention.filter((a: any) => re.test(a.kind) && !a.resolved_at)

test('Bug 411: "Have HQ test this" on a split project has Claude work out the test steps once; HQ checks each save, keeps what passes, and tests with it from then on', async () => {
  const p = await project('notes', { ...WEB, ...API })
  const box = (await hq.api(`repos/${p.repo.id}/auto-check`, {})).json
  assert.equal(box.found, '(cd "frontend" && npm test)'); assert.deepEqual(box.not_run, ['backend/ (1 Python test file)']); assert.equal(box.asks, true)
  const { t, eng } = await finished(p, 'Downloads', DOWNLOADS, NAMED)
  assert.equal((await check(t)).status, 200)
  const h = await helper(p), first = await nextBatch(h.id)
  assert.match(first, /^Project: notes\. Your job this time is the TEST STEPS \(the "Test steps" section of your instructions\), not the start steps\.\n\nYou are looking at main /)
  assert.match(first, /\nYou are looking at main with ticket T-01 merged in: the ticket adds tests HQ's steps don't run yet\.\nWhat HQ runs now: `\(cd "frontend" && npm test\)`\n/)
  assert.match(first, /\nTest files that leaves out: backend\/ \(2 Python test files\), e\.g\. backend\/tests\/test_app\.py\nTools HQ found installed on this computer: /)
  const c0 = checkOf(await tk(t))!
  assert.equal(c0.state, 'running'); assert.equal(checkHeadline(c0), 'Testing… Claude is working out how to test this project first (once, a few minutes)') // the check waits, and says for what
  assert.equal((await steps(p)).working, true); assert.equal((await steps(p)).state, 'working')
  // steps HQ can't run at all are refused at once, and don't count as a save
  const none = await hq.mcp(h.id, 'save_test_steps', { parts: [{ dir: 'server', test: 'npm test' }] })
  assert.equal(none.isError, true); assert.match(none.text, /^Not saved: parts: there is no folder "server" in the project\. Fix it and call save_test_steps again\.$/)
  // steps that pass but leave the backend out: HQ runs them for real and says which test files nothing runs
  await tried(h.id, 'cd frontend && npm test'); await tried(h.id, 'cd backend && node print.js')
  const half = await hq.mcp(h.id, 'save_test_steps', { parts: [BOTH.parts[1]] })
  assert.equal(half.isError, false, half.text); assert.match(half.text, /^Saved\. HQ now runs the steps for real in its own sandbox/)
  const back = await nextBatch(h.id)
  assert.match(back, /HQ's check of your test steps failed \(save 1 of 4\): every part passed, but these test files are run by no part and aren't in left_out: backend\/ \(2 Python test files\)/)
  assert.equal((await steps(p)).steps, null) // nothing is kept until a save passes
  // both parts: HQ's check passes, the steps are saved, the helper ends and its worktree goes
  assert.equal((await hq.mcp(h.id, 'save_test_steps', BOTH)).isError, false)
  const passed = await nextBatch(h.id)
  assert.match(passed, /HQ's check passed:\n`\(cd "backend" && node print\.js\)`: 2 passed; HQ can read each test's name\n`\(cd "frontend" && npm test\)`: 2 passed; /)
  assert.match(passed, /HQ can read each test's name\nHQ saved your steps and ends your session now; do nothing else\.$/)
  const s = await over(p)
  assert.deepEqual(s.steps.parts, [{ dir: 'backend', test: 'node print.js', tests: true, engineers: true }, { dir: 'frontend', test: 'npm test', tests: true, engineers: true }])
  assert.equal(s.by, 'Claude (test steps)'); assert.equal(s.state, null)
  await waitFor('the helper to exit', async () => (await hq.state()).agents.find((a: any) => a.id === h.id)?.status === 'exited') // HQ stops it as its job ends
  const good = await notices(/^repo_teststeps_ok:/)
  assert.equal(good.length, 1)
  assert.equal(good[0].detail, `notes: Claude worked out how HQ tests it, and HQ checked the steps in its sandbox: \`${CHAIN}\`. See them in the Auto box.`)
  // the check goes on by itself, with the saved steps: both folders run, and the backend's test is proven by name
  const c = await ended(t)
  assert.equal(c.state, 'pass', JSON.stringify(c)); assert.equal(c.steps[0]!.words.startsWith(`\`${CHAIN}\` passed: 4 passed`), true, c.steps[0]!.words)
  assert.deepEqual(JSON.parse((await tk(t)).proof).tests.map((e: any) => e.state), ['passed', 'passed'])
  await waitFor('its worktree and branch to go', () => leftovers(p).length === 0 && sh(p.dir, 'branch', '--list', 'hq-teststeps/*') === '')
  // from then on no helper: the Auto box shows the steps, a second test runs them, and the engineer still at work hears the command
  const after = (await hq.api(`repos/${p.repo.id}/auto-check`, {})).json
  assert.equal(after.found, CHAIN); assert.deepEqual(after.not_run, []); assert.equal(after.asks, false)
  assert.equal((await check(t)).status, 200); assert.equal((await ended(t, c.id)).state, 'pass'); assert.equal((await helpers()).length, 1)
  assert.equal((await hq.state()).messages.some((m: any) => m.to_id === eng.id && m.reason === 'test_cmd'), false) // its ticket is finished: nothing to tell it
})

test('Bug 411: on auto the project waits for the test steps and says so; with them main is tested and the ticket merges', async () => {
  const p = await project('autonotes', { ...WEB, ...API })
  const { t } = await finished(p, 'Downloads', DOWNLOADS, NAMED)
  await waitFor('T-01 finished', async () => (await tk(t))?.status === 'pr_ready')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const h = await helper(p), first = await nextBatch(h.id)
  assert.match(first, /TEST STEPS/); assert.match(first, /Test files that leaves out: backend\//)
  await waitFor('auto to say what it waits for', async () => /^Claude is working out how to test this project \(once, a few minutes\)\. Tickets are still built; nothing is tested or merged/
    .test((await hq.state()).repos.find((r: any) => r.id === p.repo.id).auto_waiting ?? ''))
  assert.equal((await tk(t)).status, 'pr_ready') // nothing is tested or merged meanwhile
  await tried(h.id, 'cd backend && node print.js'); await tried(h.id, '(cd frontend && npm test)')
  assert.equal((await hq.mcp(h.id, 'save_test_steps', BOTH)).isError, false); assert.match(await nextBatch(h.id), /HQ's check passed/)
  await waitFor('T-01 merged', async () => (await tk(t))?.status === 'merged', 60_000)
  assert.deepEqual(JSON.parse((await tk(t)).proof).tests.map((e: any) => e.state), ['passed', 'passed'])
  await waitFor('auto to stop waiting', async () => !(await hq.state()).repos.find((r: any) => r.id === p.repo.id).auto_waiting)
  assert.equal((await helpers()).length, 1); await gone(p)
})

test('Bug 411: a helper that can\'t, one the user stops, and the user\'s own command: HQ tests with what it has, says what that leaves out, and asks nobody twice', async () => {
  const p = await project('cant', { ...WEB, ...API })
  const { t } = await finished(p, 'Downloads', DOWNLOADS, NAMED)
  assert.equal((await check(t)).status, 200)
  const h = await helper(p); await nextBatch(h.id)
  const cant = await hq.mcp(h.id, 'report_cant_test_steps', { reason: 'The backend\'s tests need a database server, and HQ\'s sandbox has none.' })
  assert.equal(cant.isError, false, cant.text)
  const s = await over(p)
  assert.deepEqual([s.state, s.note, s.steps], ['cant', "The backend's tests need a database server, and HQ's sandbox has none.", null])
  const bad = await notices(/^repo_teststeps:/)
  assert.equal(bad.length, 1); assert.match(bad[0].detail, /^cant: Claude couldn't work out test steps HQ can run: The backend's tests need a database server/)
  // the check goes on with what HQ's rules find, and says the command is the gap (nothing goes to the engineer)
  const c = await ended(t)
  assert.equal(c.state, 'fail'); assert.equal(checkHeadline(c), "The tests passed, but HQ's test command doesn't run the folder a test named for its criteria is in")
  // the same gap starts no second helper by itself; the user can ask again, and stop it
  assert.equal((await check(t)).status, 200); await ended(t, c.id); assert.equal((await helpers()).length, 1)
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-check`, {})).json.asks, false)
  assert.equal((await hq.api(`repos/${p.repo.id}/test-steps`, {})).status, 200)
  const h2 = await helper(p, [h.id]); assert.match(await nextBatch(h2.id), /TEST STEPS/)
  assert.equal((await hq.api(`repos/${p.repo.id}/test-steps`, {})).status, 200); assert.equal((await steps(p)).helper_agent_id, h2.id) // a second press finds the first one on it
  assert.equal((await hq.api(`repos/${p.repo.id}/test-steps`, { action: 'dismiss' })).status, 200)
  const stopped = await over(p)
  assert.deepEqual([stopped.state, stopped.note], ['failed', 'You stopped Claude before it finished.']); await gone(p)
  await waitFor('the stopped helper to exit', async () => (await hq.state()).agents.find((a: any) => a.id === h2.id)?.status === 'exited')
  // Bug 417: its Agent tab's Stop ends it the same way (was "Claude stopped before it finished."), and its Events tab says the user stopped it
  assert.equal((await hq.api(`repos/${p.repo.id}/test-steps`, {})).status, 200)
  const h3 = await helper(p, [h.id, h2.id]); await nextBatch(h3.id)
  assert.equal((await hq.api(`agents/${h3.id}/stop`, {})).status, 200)
  const byTab = await over(p); assert.deepEqual([byTab.state, byTab.note], ['failed', 'You stopped Claude before it finished.']); await gone(p)
  const said = async () => ((await hq.api(`agents/${h3.id}/events`)).json.events as any[]).map((e) => e.text) // its end is logged as its worktree goes
  await waitFor('its Events tab to say the user stopped it', async () => { const l = await said()
    return l.includes('You stopped it') && l.includes('Done with the test steps: you stopped Claude before it finished') })
  // a command of the user's own: that is what HQ runs, and no helper is asked
  assert.equal((await hq.api(`repos/${p.repo.id}/test-cmd`, { cmd: 'cd frontend && npm test && cd ../backend && node print.js' })).status, 200)
  const last = checkOf(await tk(t))!.id
  assert.equal((await check(t)).status, 200); assert.equal((await ended(t, last)).state, 'pass'); assert.equal((await helpers()).length, 3)
})

test('Bug 411: a restart while HQ checks a save ends that helper and says so; a ticket that adds the first tests of a folder gets its steps, and they leave other tickets alone', async () => {
  const p = await project('later', { ...WEB, 'backend/print.js': PRINT.replace("console.log('tests/test_app.py::test_answers PASSED'); ", '').replace('2 passed', '1 passed') })
  assert.equal((await hq.api(`repos/${p.repo.id}/auto-check`, {})).json.asks, false) // one folder with tests, which the rules run: nobody to ask
  const { t } = await finished(p, 'Downloads', DOWNLOADS, NAMED) // this ticket adds backend/tests/: on main with it merged in, a folder nothing runs
  assert.equal((await check(t)).status, 200)
  const h = await helper(p); assert.match(await nextBatch(h.id), /with ticket T-01 merged in[^]*Test files that leaves out: backend\/ \(1 Python test file\)/)
  // a save whose check is still running when HQ goes down: the check is lost with the backend, and so is the helper's job
  const HELD = { parts: [{ dir: 'backend', test: 'until [ -f go ]; do sleep 0.1; done; node print.js' }, BOTH.parts[1]] }
  assert.equal((await hq.mcp(h.id, 'save_test_steps', HELD)).isError, false)
  await waitFor('HQ\'s check to be running', async () => (await hq.state()).testRuns.some((r: any) => r.what === 'steps_check' && r.state === 'running'), 30_000)
  await hq.restart()
  const lost = await over(p)
  assert.deepEqual([lost.state, lost.note, lost.steps], ['failed', 'HQ restarted while Claude was working it out.', null]); await gone(p)
  assert.equal(checkOf(await tk(t))!.state, 'stopped') // and the user's check with it, as any check a restart cuts off
  // asked again, the helper saves steps that pass on main with the ticket merged in
  assert.equal((await hq.api(`repos/${p.repo.id}/test-steps`, {})).status, 200)
  const h2 = await helper(p, [h.id]); await nextBatch(h2.id); await tried(h2.id, 'cd backend && node print.js')
  assert.equal((await hq.mcp(h2.id, 'save_test_steps', BOTH)).isError, false)
  // "again" looks at main as it is, where backend/ has no tests yet: HQ's check runs that part all the same, and keeps it as one HQ saw no tests under
  assert.match(await nextBatch(h2.id), /HQ's check passed/)
  const s = await over(p)
  // frontend's `npm test` is a command HQ's rules build themselves: engineers ran it before there were steps, though this helper never tried it
  assert.deepEqual(s.steps.parts.map((x: any) => [x.dir, x.tests, x.engineers]), [['backend', false, true], ['frontend', true, true]])
  const before = checkOf(await tk(t))!.id
  assert.equal((await check(t)).status, 200); const c = await ended(t, before)
  assert.equal(c.state, 'pass', JSON.stringify(c)); assert.deepEqual(JSON.parse((await tk(t)).proof).tests.map((e: any) => e.state), ['passed', 'passed'])
  assert.equal((await helpers()).length, 2)
})

test('Bug 411: an engineer at work hears the project\'s test command when the steps are saved; removing the project while a helper works leaves nothing of it', async () => {
  const p = await project('told', { ...WEB, ...API })
  const made = await hq.api('tickets', { featureId: p.f.id, title: 'Counts', size: 'S', spec: 'Counts.', criteria: [{ kind: 'backend', text: 'The list says how many downloads it holds.' }] })
  assert.equal(made.status, 200, JSON.stringify(made.json)); const t = made.json, eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id && a.status === 'working'))
  assert.equal((await hq.api(`repos/${p.repo.id}/test-steps`, {})).status, 200) // the user asks, with nothing saved yet
  const h = await helper(p); assert.match(await nextBatch(h.id), /What HQ runs now: `\(cd "frontend" && npm test\)`\nTest files that leaves out: backend\/ \(1 Python test file\)/)
  await tried(h.id, 'cd backend && node print.js')
  assert.equal((await hq.mcp(h.id, 'save_test_steps', BOTH)).isError, false); await over(p)
  const note = await waitFor('HQ to tell the engineer', async () => (await hq.state()).messages.find((m: any) => m.to_id === eng.id && m.reason === 'test_cmd'))
  assert.equal(note.body.endsWith(`: ${CHAIN}`), true, note.body); assert.match(note.body, /^HQ: While you work, run only the tests for what you changed\. HQ tests this project with this command/)
  // asked again, and the project removed while that helper works: the helper, its worktree and what HQ kept for the project all go
  assert.equal((await hq.api(`repos/${p.repo.id}/test-steps`, {})).status, 200)
  const h2 = await helper(p, [h.id]); assert.match(await nextBatch(h2.id), /The steps HQ has now \(keep what is still right\):/)
  const kept = path.join(hq.hqHome, 'projects', p.repo.id, 'test-steps.json'); assert.ok(fs.existsSync(kept))
  assert.equal((await hq.api(`repos/${p.repo.id}/remove`, {})).status, 200)
  await waitFor('the helper to be stopped', async () => { const a = (await hq.state()).agents.find((x: any) => x.id === h2.id); return !a || a.status === 'exited' })
  await gone(p); await waitFor('what HQ kept for the project to go, and stay gone', () => !fs.existsSync(path.dirname(kept)))
})

// Bug 416: a project whose install by HQ's own rules fails on main: a uv project whose uv.lock uv can't read, so the rules' `uv sync` fails (as it does where
// uv isn't installed at all). A repair could only change the test command, never that install
const B416 = { 'pyproject.toml': '[project]\nname = "b416"\nversion = "0.1.0"\n', 'uv.lock': '', 'tests/test_app.py': 'def test_answers():\n    assert True\n',
  'print.js': "console.log('tests/test_app.py::test_answers PASSED'); console.log('tests/test_hi.py::test_hi PASSED'); console.log('2 passed in 0.01s')\n" }
const events = async (kind: string) => (await hq.api('events?limit=500')).json.filter((e: any) => e.kind === kind).map((e: any) => ({ ...e, payload: JSON.parse(e.payload) }))
const repoNow = async (p: P) => (await hq.state()).repos.find((r: any) => r.id === p.repo.id)
const repairs = async (p: P) => { const fs0 = (await hq.state()).features.filter((f: any) => f.repo_id === p.repo.id).map((f: any) => f.id)
  return (await hq.state()).tickets.filter((t: any) => t.repairs_main && fs0.includes(t.feature_id)) }

test('Bug 416: on auto, an install of HQ\'s own rules that fails on main starts the test steps helper, not a repair; with its steps main is tested again and passes', async () => {
  const p = await project('b416main', B416)
  assert.equal((await hq.api('tickets', { featureId: p.f.id, title: 'Greeting', size: 'S', spec: 'Greeting.' })).status, 200) // queued: auto opens a run
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const h = await helper(p, [], 90_000), first = await nextBatch(h.id)
  assert.match(first, /\nHQ's own rules install this project's packages with `uv sync`, and that failed on main in HQ's sandbox \(network on\), so HQ can't test the project at all\. /)
  assert.match(first, /What the install printed:\n```\n[^]+\n```\nWhat HQ runs now: `uv run pytest -q`\nTools HQ found installed/)
  const bad = await notices(/^repo_teststeps:/)
  assert.equal(bad.length, 1)
  assert.match(bad[0].detail, /^b416main: HQ couldn't install its packages on main with its own rule \(`uv sync`\), so it can't test anything yet\. A repair ticket can't change/)
  const toTpm = await waitFor('the TPM to hear', async () => (await hq.state()).messages.find((m: any) => m.to_id === p.tpm.id && /HQ's own install step \(`uv sync`\) fails there/.test(m.body)))
  assert.match(toTpm.body, /Claude is working out how this project installs and runs its tests instead[^]*Don't open a ticket for this\.$/)
  await waitFor('auto to say what it waits for', async () => /^Claude is working out how to test this project/.test((await repoNow(p)).auto_waiting ?? ''))
  assert.deepEqual(await repairs(p), []); assert.equal((await repoNow(p)).auto_stopped_why, null)
  assert.match((await events('teststeps.helper_started')).find((e: any) => e.agent_id === h.id).payload.install, /^uv sync$/)
  await tried(h.id, 'node print.js')
  assert.equal((await hq.mcp(h.id, 'save_test_steps', { parts: [{ dir: '.', test: 'node print.js' }] })).isError, false)
  assert.match(await nextBatch(h.id), /HQ's check passed/)
  // main is tested again, now with the steps: it passes, and no repair was opened
  const passed = await waitFor('main tested again', async () => (await events('auto.main_checked')).find((e: any) => e.payload.repo === p.repo.id && e.payload.result === 'pass'), 60_000)
  assert.equal(passed.payload.test, 'node print.js')
  assert.deepEqual(await repairs(p), []); assert.equal((await helpers()).length, 1); await gone(p)
})

test('Bug 416: a ticket whose test fails at that install, as main alone does, gets the helper first; when it can\'t, HQ opens a repair as before and asks nobody twice', async () => {
  const p = await project('b416tk', B416)
  const { t } = await finished(p, 'Greeting', { 'tests/test_hi.py': 'def test_hi():\n    assert True\n' }, [{ criterion: 'A1', file: 'tests/test_hi.py', name: 'test_hi' }],
    'uv run pytest -q')
  await waitFor('T-01 finished', async () => (await tk(t))?.status === 'pr_ready')
  assert.equal((await hq.api(`repos/${p.repo.id}/auto`, { on: true })).status, 200)
  const h = await helper(p, [], 90_000); assert.match(await nextBatch(h.id), /with `uv sync`, and that failed on main/)
  assert.deepEqual(await repairs(p), []); assert.equal((await tk(t)).status, 'pr_ready'); assert.equal((await tk(t)).auto_tries, 0) // not the ticket's fault
  assert.equal((await hq.mcp(h.id, 'report_cant_test_steps', { reason: 'This project installs with Poetry, which isn\'t installed on this computer.' })).isError, false)
  const s = await over(p); assert.equal(s.state, 'cant')
  // the helper has looked at this install: the next failure opens the repair it would have opened before, and no second helper
  const r = await waitFor('the repair', async () => (await repairs(p))[0], 60_000)
  assert.match(r.spec, /HQ runs `uv sync` in its test sandbox/)
  assert.equal((await helpers()).length, 1); assert.equal((await tk(t)).auto_tries, 0); await gone(p)
})
