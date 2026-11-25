// The test steps helper's own rules (teststeps.ts, Bug 411), with no session: what HQ's command leaves out on a commit, HQ's check of saved steps for real
// in the test sandbox, and when a project counts as ready to test. The session itself (start, save, check, finish) is covered end to end (e2e/teststeps.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-teststeps-')))
process.env.HQ_HOME = path.join(tmp, 'hq'); process.env.HQ_ENGINEER_CACHE = path.join(tmp, 'cache')
const { migrate, run } = await import('./db.ts'); migrate()
const { getRepo } = await import('./records.ts')
const { sandboxProblem } = await import('./testrun.ts')
const { checkStepsRun, stepsGap, stepsReady } = await import('./teststeps.ts')
const { readSteps, writeSteps } = await import('./teststepsstore.ts')

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd,
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const T = "const t=require('node:test'),a=require('node:assert');"
/** A project in HQ's records, on a git repo with these files. */
function project(id: string, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-')); sh(dir, 'init', '-q', '-b', 'main')
  for (const [f, text] of Object.entries({ '.gitignore': 'node_modules/\n.claude/\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text)
  }
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base')
  run("INSERT INTO repos(id, name, path, kind, created_at) VALUES (?, ?, ?, 'local', ?)", id, id, dir, Date.now())
  return { dir, repo: () => getRepo(id)!, sha: sh(dir, 'rev-parse', 'HEAD') }
}
const WEB = { 'frontend/package.json': '{"scripts":{"test":"node --test"}}', 'frontend/list.test.js': `${T}t.test('shows the list',()=>a.ok(1))` }
const API = { 'backend/pyproject.toml': '[project]\nname = "api"\n', 'backend/tests/test_app.py': 'def test_answers(): pass\n',
  'backend/print.js': "console.log('tests/test_app.py::test_answers PASSED'); console.log('1 passed in 0.01s')" }
const part = (dir: string, test: string, more: { install?: string } = {}) => ({ dir, test, tests: true, engineers: true, ...more })
const keep = (id: string, parts: ReturnType<typeof part>[], left: { path: string; why: string }[] = []) =>
  writeSteps(id, { ...readSteps(id), steps: { parts, left_out: left, notes: '' } })

test('what HQ would run on a commit and the test files that leaves out: by its rules, by saved steps, and nothing for the user\'s own command', async () => {
  const p = project('split', { ...WEB, ...API, 'mobile/app.test.ts': '' })
  assert.deepEqual(await stepsGap(p.repo(), 'HEAD'), { runs: '(cd "frontend" && npm test)', shaky: [], key: 'backend:python,mobile:js', gaps: [
    { dir: 'backend', kind: 'python', count: 1, example: 'backend/tests/test_app.py' }, { dir: 'mobile', kind: 'js', count: 1, example: 'mobile/app.test.ts' }] })
  keep('split', [part('backend', 'node print.js'), part('frontend', 'npm test')])
  const some = await stepsGap(p.repo(), p.sha)
  assert.equal(some.runs, '(cd "backend" && node print.js) && (cd "frontend" && npm test)'); assert.equal(some.key, 'mobile:js') // the saved steps come before the rules
  keep('split', [part('backend', 'node print.js'), part('frontend', 'npm test')], [{ path: 'mobile', why: 'It needs a phone.' }])
  assert.equal((await stepsGap(p.repo(), p.sha)).key, '') // left out on purpose: no gap
  run("UPDATE repos SET test_cmd = 'make check' WHERE id = 'split'")
  assert.deepEqual(await stepsGap(p.repo(), p.sha), { runs: 'make check', gaps: [], shaky: [], key: '' }) // theirs to say what it runs
  assert.equal((await stepsGap(p.repo(), p.sha, { own: false })).runs, '(cd "backend" && node print.js) && (cd "frontend" && npm test)') // what HQ would run without it
  // a Python project of the rules' with no uv.lock and no requirements.txt naming pytest: their `uv sync` and pytest are a guess
  const py = project('py', { 'pyproject.toml': '[project]\nname = "x"\n', 'tests/test_a.py': '' })
  assert.deepEqual(await stepsGap(py.repo(), 'HEAD'), { runs: 'uv run pytest -q', gaps: [], shaky: ['.'], key: '.:python-setup' })
  assert.equal((await stepsGap(project('uv', { 'pyproject.toml': '', 'uv.lock': '', 'tests/test_a.py': '' }).repo(), 'HEAD')).key, '')
  assert.equal((await stepsGap(project('pip', { 'requirements.txt': 'flask\npytest>=8\n', 'tests/test_a.py': '' }).repo(), 'HEAD')).key, '')
  assert.equal((await stepsGap(project('plain', { 'package.json': '{"scripts":{"test":"node --test"}}', 'test/a.test.js': '' }).repo(), 'HEAD')).key, '') // one project the rules cover
})
const problem = await sandboxProblem(), boxed = { skip: problem ? `no sandbox here: ${problem}` : false }
test('HQ\'s check of test steps, for real: every part passes, each runs a test, and no test file is left out without a reason', boxed, async () => {
  const p = project('check', { ...WEB, ...API }), go = (parts: { dir: string; test: string; install?: string }[], left: { path: string; why: string }[] = []) =>
    checkStepsRun(p.repo(), { parts, left_out: left, notes: '' }, p.sha, new AbortController().signal)
  const ok = await go([{ dir: 'backend', install: 'echo ok > installed.txt', test: 'test -f installed.txt && node print.js' }, { dir: 'frontend', test: 'npm test' }])
  assert.equal(ok.problem, null, ok.problem ?? '')
  assert.equal(ok.words, "`(cd \"backend\" && test -f installed.txt && node print.js)`: 1 passed; HQ can read each test's name\n"
    + "`(cd \"frontend\" && npm test)`: 1 passed; HQ can read each test's name")
  // one part only: the other folder's tests are left out, and HQ says which
  const gap = await go([{ dir: 'frontend', test: 'npm test' }])
  assert.match(gap.problem!, /^every part passed, but these test files are run by no part and aren't in left_out: backend\/ \(1 Python test file\), /)
  assert.match(gap.problem!, /, e\.g\. backend\/tests\/test_app\.py\. Add a part for each, or list it in left_out with the reason$/)
  assert.equal((await go([{ dir: 'frontend', test: 'npm test' }], [{ path: 'backend', why: 'It needs a database server.' }])).problem, null) // left out with a reason
  // a part that fails, with what it printed; and one that passes without running a test
  const bad = await go([{ dir: 'backend', test: 'echo "ModuleNotFoundError: No module named pytest" >&2; exit 1' }, { dir: 'frontend', test: 'npm test' }])
  assert.match(bad.problem!, /^`\(cd "backend" && echo .*\)` failed\. Its output:\n[^]*No module named pytest/)
  const none = await go([{ dir: 'backend', test: 'echo "0 passed in 0.00s"' }, { dir: 'frontend', test: 'npm test' }])
  assert.match(none.problem!, /^`\(cd "backend" && echo "0 passed in 0\.00s"\)` passed but ran no tests/)
  const late = new AbortController(); late.abort()
  assert.deepEqual(await checkStepsRun(p.repo(), { parts: [{ dir: 'frontend', test: 'npm test' }], left_out: [], notes: '' }, p.sha, late.signal),
    { problem: "HQ's check was stopped", words: '', stopped: true })
  assert.deepEqual(fs.existsSync(path.join(p.dir, '.claude', 'worktrees')) ? fs.readdirSync(path.join(p.dir, '.claude', 'worktrees')) : [], []) // no checkout left behind
})
test('ready to test without a helper: the user\'s own command, nothing left out, or a gap a helper has already looked at; a helper at work means wait', async () => {
  const p = project('ready', { ...WEB, ...API })
  run("UPDATE repos SET test_cmd = 'make check' WHERE id = 'ready'"); assert.equal(await stepsReady(p.repo(), p.sha), 'ready'); assert.equal(readSteps('ready').job, null)
  run("UPDATE repos SET test_cmd = NULL WHERE id = 'ready'")
  writeSteps('ready', { ...readSteps('ready'), looked: [{ gap: 'backend:python', at: 1, result: 'cant' }] })
  assert.equal(await stepsReady(p.repo(), p.sha), 'ready'); assert.equal(readSteps('ready').job, null) // looked at, and couldn't: HQ tests with what it has, and says so
  keep('ready', [part('backend', 'node print.js'), part('frontend', 'npm test')]); writeSteps('ready', { ...readSteps('ready'), looked: [] })
  assert.equal(await stepsReady(p.repo(), p.sha), 'ready') // the steps run every test file there is
  writeSteps('ready', { ...readSteps('ready'), job: { agent_id: 'launch-x', worktree: '/nowhere', saves: 0, state: 'working', started_at: 1, sha: p.sha, why: 'again', ticket_id: null, gap: '' } })
  assert.equal(await stepsReady(p.repo(), p.sha), 'working')
  const plain = project('one', { 'package.json': '{"scripts":{"test":"node --test"}}', 'test/a.test.js': '' })
  assert.equal(await stepsReady(plain.repo(), plain.sha), 'ready'); assert.equal(readSteps('one').job, null) // what it must not start: a project the rules cover
})
