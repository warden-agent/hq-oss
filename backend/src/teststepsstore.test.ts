// A project's saved test steps (teststepsstore.ts, Bug 411): what a helper may save, the one command the parts make, which parts apply to a commit, which
// test files the steps still leave out, and what the turn gate and engineers are told.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-steps-')))
process.env.HQ_HOME = path.join(tmp, 'hq')
const { chain, checkSteps, gapKey, gateCmds, hasTests, partCmd, partsHere, readSteps, savedCmd, stepsFile, stepsOf, stepsSkip, stepsView, writeSteps } = await import('./teststepsstore.ts')

const root = path.join(tmp, 'repo'); for (const d of ['backend/tests', 'frontend', 'packages/core', 'my app']) fs.mkdirSync(path.join(root, d), { recursive: true })
const ok = (input: unknown) => { const r = checkSteps(input, root); assert.ok('steps' in r, 'error' in r ? r.error : ''); return r.steps }
const bad = (input: unknown): string => { const r = checkSteps(input, root); assert.ok('error' in r, 'it was taken'); return r.error }
const BOTH = { parts: [{ dir: 'backend', install: 'uv sync', test: 'uv run pytest -v' }, { dir: 'frontend', install: 'npm ci', test: 'npm test' }] }

test('steps a helper may save: one part a folder, tidied, with what is left out and why', () => {
  assert.deepEqual(ok(BOTH), { ...BOTH, left_out: [], notes: '' })
  const s = ok({ parts: [{ dir: './packages/core/', test: ' npm test ' }, { dir: '.', test: 'go test -v ./...', install: ' go mod download ' }, { dir: 'my app', test: 'npm test' }],
    left_out: [{ path: 'backend/tests/', why: ' It needs a database server. ' }], notes: 'x' })
  assert.deepEqual(s.parts, [{ dir: 'packages/core', test: 'npm test' }, { dir: '.', test: 'go test -v ./...', install: 'go mod download' }, { dir: 'my app', test: 'npm test' }])
  assert.deepEqual(s.left_out, [{ path: 'backend/tests', why: 'It needs a database server.' }])
  assert.deepEqual(ok({ parts: [{ dir: '.', test: 'npm test' }, { dir: '.', test: '.venv/bin/python -m pytest -v' }] }).parts.length, 2) // two kinds of tests in one folder
})
test('steps HQ can\'t run are refused, with what to change', () => {
  assert.match(bad({ parts: [] }), /^parts: /); assert.match(bad({}), /^parts: /); assert.match(bad({ parts: [{ dir: 'backend' }] }), /^parts\.0\.test: /)
  assert.match(bad({ parts: [{ dir: 'backend', test: 'x'.repeat(301) }] }), /^parts\.0\.test: /)
  assert.match(bad({ parts: [{ dir: 'mobile', test: 'npm test' }] }), /^parts: there is no folder "mobile" in the project$/)
  for (const dir of ['../other', '/etc', 'backend/../..', 'a"b', 'a$b', 'a`b`']) {
    assert.match(bad({ parts: [{ dir, test: 'npm test' }] }), /^parts: ".*" must be a plain folder inside the project/, dir) // a name the shell would read as more than a name
  }
  assert.match(bad({ parts: [{ dir: 'back\\end', test: 'npm test' }] }), /^parts: there is no folder "back\/end" in the project$/) // a backslash is read as a slash
  assert.match(bad({ parts: [{ dir: 'backend', test: 'npm test' }, { dir: 'backend/', test: 'npm test' }] }), /^parts: "npm test" in "backend" is listed twice$/)
  assert.match(bad({ ...BOTH, left_out: [{ path: '../x', why: 'y' }] }), /^left_out: "\.\.\/x" must be a path inside the project/)
  assert.match(bad({ ...BOTH, left_out: [{ path: 'docs' }] }), /^left_out\.0\.why: /)
})
test('the parts as one command, in the shape HQ\'s rules build: a folder in brackets, the root bare', () => {
  assert.equal(partCmd('backend', 'uv run pytest -v'), '(cd "backend" && uv run pytest -v)'); assert.equal(partCmd('.', 'npm test'), 'npm test')
  assert.equal(partCmd('my app', 'npm test'), '(cd "my app" && npm test)')
  assert.equal(chain([{ dir: '.', test: 'go test -v ./...' }, ...BOTH.parts]), 'go test -v ./... && (cd "backend" && uv run pytest -v) && (cd "frontend" && npm test)')
})
const saved = (parts: { dir: string; test: string; tests?: boolean; engineers?: boolean }[], left: string[] = []) => ({ notes: '', left_out: left.map((p) => ({ path: p, why: 'w' })),
  parts: parts.map((p) => ({ tests: true, engineers: true, ...p })) })
test('a part whose folder has no test files on a commit is left out there, unless it had none when HQ checked it', () => {
  const files = ['frontend/src/a.test.ts', 'backend/app/main.py', 'backend/pyproject.toml', 'README.md'], s = saved([{ dir: 'backend', test: 'p' }, { dir: 'frontend', test: 'f' }])
  assert.deepEqual(partsHere(s.parts, files).map((p) => p.dir), ['frontend']) // the backend's tests arrive with another ticket
  assert.deepEqual(partsHere(s.parts, [...files, 'backend/tests/test_app.py']).map((p) => p.dir), ['backend', 'frontend'])
  assert.deepEqual(partsHere(saved([{ dir: 'backend', test: 'p', tests: false }]).parts, files).map((p) => p.dir), ['backend']) // HQ saw no test files there, and it ran: it runs
  assert.deepEqual(partsHere(saved([{ dir: '.', test: 'r' }]).parts, files).map((p) => p.dir), ['.']); assert.deepEqual(partsHere(saved([{ dir: '.', test: 'r' }]).parts, ['README.md']), [])
  assert.equal(hasTests(files, 'frontend'), true); assert.equal(hasTests(files, 'backend'), false); assert.equal(hasTests(['shop/tests.py'], 'shop'), true)
  assert.equal(hasTests(['frontend/node_modules/x/x.test.js', 'frontendish/a.test.ts'], 'frontend'), false)
})
test('what saved steps still leave out: test files under no part and not left out on purpose', () => {
  const files = ['frontend/src/a.test.ts', 'backend/tests/test_app.py', 'backend/tests/integration/test_db.py', 'mobile/app/b.test.ts', 'e2e/login.spec.ts']
  const skip = (parts: string[], left: string[] = []) => stepsSkip(files, saved(parts.map((dir) => ({ dir, test: 't' })), left), (p) => files.includes(p), () => '')
  assert.deepEqual(skip(['backend', 'frontend']).map((g) => `${g.dir}:${g.kind}:${g.count}`), ['e2e:js:1', 'mobile:js:1'])
  assert.deepEqual(skip(['backend', 'frontend'], ['mobile', 'e2e/login.spec.ts']), []); assert.deepEqual(skip(['.']), []) // a part at the root answers for everything
  assert.deepEqual(skip(['frontend'], ['backend/tests/integration']).map((g) => `${g.dir}:${g.kind}:${g.count}`), ['backend:python:1', 'e2e:js:1', 'mobile:js:1'])
  assert.equal(gapKey(skip(['backend', 'frontend'])), 'e2e:js,mobile:js'); assert.equal(gapKey([]), '')
})
test('what the turn gate knows as the project\'s test runs, and the saved command whoever wrote it', () => {
  const s = saved([{ dir: 'backend', test: 'uv run pytest -v' }, { dir: 'frontend', test: 'npm test' }, { dir: 'admin', test: 'npm test' }])
  assert.deepEqual(gateCmds(null, s), ['uv run pytest -v', 'npm test']); assert.deepEqual(gateCmds(' make check ', s), ['make check']); assert.deepEqual(gateCmds(null, null), [])
  assert.equal(savedCmd(null, s), '(cd "backend" && uv run pytest -v) && (cd "frontend" && npm test) && (cd "admin" && npm test)')
  assert.equal(savedCmd('make check', s), 'make check'); assert.equal(savedCmd('  ', null), null)
})
test('the file HQ keeps per project: nothing at first, written whole, and what the page is shown', () => {
  assert.equal(stepsOf('repo-1'), null); assert.deepEqual(readSteps('repo-1').looked, [])
  const s = saved([{ dir: 'backend', test: 'uv run pytest -v', engineers: false }])
  writeSteps('repo-1', { ...readSteps('repo-1'), steps: s, by: 'Claude (test steps)', saved_at: 5, checked: { sha: 'abc', at: 6 },
    job: { agent_id: 'launch-1', worktree: '/w', saves: 2, state: 'checking', started_at: 1, sha: 'abc', why: 'first', ticket_id: null, gap: 'backend:python' } })
  assert.deepEqual(stepsOf('repo-1'), s); assert.ok(fs.existsSync(stepsFile('repo-1'))); assert.equal(fs.readdirSync(path.dirname(stepsFile('repo-1'))).some((f) => f.endsWith('.tmp')), false)
  const v = stepsView('repo-1')
  assert.deepEqual([v.working, v.state, v.saves, v.helper_agent_id, v.by, v.seen], [true, 'checking', 2, 'launch-1', 'Claude (test steps)', false])
  writeSteps('repo-1', { ...readSteps('repo-1'), job: null, ended: { state: 'cant', note: 'It needs Docker.', at: 9 } })
  assert.deepEqual([stepsView('repo-1').working, stepsView('repo-1').state, stepsView('repo-1').note], [false, 'cant', 'It needs Docker.'])
})
