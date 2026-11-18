// The rules for acceptance criteria and the tests named for them (criteria.ts): what a TPM may give, what open_pr's map must look like, what git's list of
// changes flags for the user and what it must leave alone, and what each test runner's own output says about a named test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxCriteria, byKind, confirm, covers, criteriaBlock, criteriaMd, criteriaOf, criteriaSummary,
  flagsFor, isTestFile, lookLines, nameWatch, proofProblem, proofWords, readCriteria, tidyProof, unproven, watchFor,
  type Changed, type Criterion, type Proof } from './criteria.ts'

const list = (r: ReturnType<typeof readCriteria>): Criterion[] => { assert.ok('list' in r, 'error' in r ? r.error : ''); return r.list }
const error = (r: ReturnType<typeof readCriteria>): string => { assert.ok('error' in r); return r.error }

test('criteria are numbered A1, A2… in order, or keep the ids the TPM gave to every one', () => {
  assert.deepEqual(list(readCriteria([{ kind: 'ui', text: ' The list shows\n each due date. ' }, { kind: 'Backend', text: 'GET /api/items has due_on.' }])),
    [{ id: 'A1', kind: 'ui', text: 'The list shows each due date.' }, { id: 'A2', kind: 'backend', text: 'GET /api/items has due_on.' }])
  assert.deepEqual(list(readCriteria([{ id: 'a3', kind: 'ui', text: 'The list shows dates.' }, { id: 'A1', kind: 'backend', text: 'GET /api/items answers 200.' }]))
    .map((c) => c.id), ['A3', 'A1'])
  assert.deepEqual(list(readCriteria([])), [])
})
test('criteria HQ can\'t keep are refused, with what to change', () => {
  assert.match(error(readCriteria('The list shows dates')), /must be a list/)
  assert.match(error(readCriteria([{ kind: 'ui', text: '  ' }])), /Criterion 1 has no text/)
  assert.match(error(readCriteria([{ kind: 'frontend', text: 'x' }])), /A1 needs kind "ui" .* or "backend"/)
  assert.match(error(readCriteria([{ id: 'A1', kind: 'ui', text: 'x' }, { kind: 'ui', text: 'y' }])), /every criterion an id .* or none/)
  assert.match(error(readCriteria([{ id: 'A1', kind: 'ui', text: 'x' }, { id: 'a1', kind: 'ui', text: 'y' }])), /Two criteria are called A1/)
  assert.match(error(readCriteria([{ id: 'first', kind: 'ui', text: 'x' }])), /"FIRST" isn't a criterion id/)
  assert.match(error(readCriteria([{ kind: 'ui', text: 'x'.repeat(401) }])), /over 400 characters/)
  assert.match(error(readCriteria(Array.from({ length: 13 }, () => ({ kind: 'ui', text: 'x' })))), /At most 12 criteria/)
})
// Tester & Checker Part 1: the spec calls it `type`; HQ has stored `kind` since PR #130, and takes either
test('a criterion\'s kind may come as `type`, and is kept as `kind`', () => {
  assert.deepEqual(list(readCriteria([{ type: 'UI', text: 'The list shows dates.' }, { type: 'backend', text: 'An empty name gets a 4xx from the API.' }])),
    [{ id: 'A1', kind: 'ui', text: 'The list shows dates.' }, { id: 'A2', kind: 'backend', text: 'An empty name gets a 4xx from the API.' }])
  assert.match(error(readCriteria([{ type: 'server', text: 'The list shows dates.' }])), /A1 needs kind "ui"/)
})
test('a criterion naming a file or function, or too vague to check, is refused with every problem in the list said at once, and none of the list is kept', () => {
  const e = error(readCriteria([{ kind: 'backend', text: 'A line is added to data/books.json' }, { kind: 'ui', text: 'The list shows dates.' },
    { kind: 'ui', text: 'The form is intuitive' }]))
  assert.match(e, /^A1 names a file or path \("data\/books\.json"\)\. .* A3 is too vague to check \("is intuitive"\)\. .* Fix each one and give the whole list again\.$/)
  assert.doesNotMatch(e, /A2/)
  assert.match(error(readCriteria([{ kind: 'backend', text: 'addItem() is called once' }])), /^A1 names code \("addItem\(\)"\)\. [^]*\.$/)
  // shape comes first: a wrong kind is said before the words are looked at
  assert.match(error(readCriteria([{ kind: 'server', text: 'works well' }])), /needs kind/)
  // stored criteria are read as they are, even ones written before the words were checked
  assert.deepEqual(criteriaOf({ criteria: '[{"id":"A1","kind":"backend","text":"add(2, 3) gives 5."}]' }), [{ id: 'A1', kind: 'backend', text: 'add(2, 3) gives 5.' }])
})
const MIX: Criterion[] = [{ id: 'A1', kind: 'backend', text: 'Exactly one new book record.' }, { id: 'A2', kind: 'ui', text: 'The list shows Dune ×2.' },
  { id: 'A3', kind: 'ui', text: 'An empty name shows an error.' }]
test('criteria split by kind, screen first, in the TPM\'s order within each, for features/F-N.md, the ticket box and the run\'s summary', () => {
  assert.deepEqual(byKind(MIX).map((g) => [g.kind, g.list.map((c) => c.id)]), [['ui', ['A2', 'A3']], ['backend', ['A1']]])
  assert.deepEqual(byKind(MIX.slice(0, 1)).map((g) => g.kind), ['backend']); assert.deepEqual(byKind([]), [])
  assert.equal(criteriaMd(MIX), '\n\nAcceptance criteria (ui):\n- A2: The list shows Dune ×2.\n- A3: An empty name shows an error.'
    + '\n\nAcceptance criteria (backend):\n- A1: Exactly one new book record.')
  assert.equal(criteriaMd([]), '')
  assert.equal(boxCriteria(MIX), 'Criteria: 2 on the screen · 1 behind it')
  assert.equal(boxCriteria(MIX.slice(1)), 'Criteria: 2 on the screen'); assert.equal(boxCriteria(MIX.slice(0, 1)), 'Criteria: 1 behind it')
  assert.equal(boxCriteria([]), null) // HQ's own repair tickets have none: no line on their box
  assert.deepEqual(criteriaSummary([{ key: 'T-01', title: 'Adding', criteria: MIX }, { key: 'T-02', title: 'Repair', criteria: [] }]), [
    '**T-01: Adding**\n- On the screen\n  - A2: The list shows Dune ×2.\n  - A3: An empty name shows an error.\n- Behind the screen\n  - A1: Exactly one new book record.'])
  assert.deepEqual(criteriaSummary([{ key: 'T-02', title: 'Repair', criteria: [] }]), [])
})
test('a ticket\'s stored criteria read back; a ticket with none, or with unreadable ones, has none', () => {
  assert.deepEqual(criteriaOf({ criteria: '[{"id":"A1","kind":"ui","text":"x"}]' }), [{ id: 'A1', kind: 'ui', text: 'x' }])
  for (const criteria of [undefined, null, '', '[]', 'not json', '{"id":"A1"}', '[null, 3]']) assert.deepEqual(criteriaOf({ criteria }), [])
  assert.equal(criteriaBlock([]), '') // a ticket with none says nothing about criteria to its engineer
  assert.match(criteriaBlock([{ id: 'A1', kind: 'ui', text: 'The list shows dates.' }]), /## Acceptance criteria\n.*\n- A1 \(screen\): The list shows dates\.\n$/)
})

const C: Criterion[] = [{ id: 'A1', kind: 'ui', text: 'x' }, { id: 'A2', kind: 'backend', text: 'y' }]
const T1 = { criterion: 'A1', file: 'test/list.test.js', name: 'shows each due date' }
test('open_pr\'s map: every criterion needs a test (file and name) or a reason nothing can test it', () => {
  assert.equal(proofProblem(C, [T1, { criterion: 'a2', cant_test: 'Needs a real phone camera, which no test here has.' }]), null)
  assert.equal(proofProblem(C, [T1, { ...T1, name: 'another test' }, { criterion: 'A2', file: 'test/api.test.js', name: 'has due_on' }]), null) // two tests for one
  assert.match(proofProblem(C, [T1])!, /Nothing named for A2\./)
  assert.match(proofProblem(C, [])!, /Nothing named for A1, A2\./)
  assert.match(proofProblem(C, [T1, { criterion: 'A7', file: 'a', name: 'b' }])!, /"A7" isn't one of this ticket's criteria \(A1, A2\)/)
  assert.match(proofProblem(C, [T1, { criterion: 'A2', file: 'test/api.test.js' }])!, /A2: a test needs both file .* and name/)
  assert.match(proofProblem(C, [T1, { criterion: 'A2', cant_test: 'too hard' }])!, /A2: say why it can't be tested/)
  assert.match(proofProblem(C, [T1, { criterion: 'A2', file: 'a', name: 'b', cant_test: 'Needs a real phone camera.' }])!, /a test .* or cant_test, not both/)
  for (const file of ['/etc/passwd', '../other/test.js', 'test/../../x.js']) assert.match(proofProblem(C, [{ ...T1, file }, { criterion: 'A2', file: 'a', name: 'b' }])!, /inside the repo/)
  assert.deepEqual(tidyProof(C, [{ criterion: 'a2', cant_test: ' why not ' }, { criterion: 'A1', file: './test/list.test.js', name: ' shows ' }]),
    [{ criterion: 'A1', file: 'test/list.test.js', name: 'shows' }, { criterion: 'A2', cant_test: 'why not' }])
})

test('what looks like a test: by its folder or its name, and nothing else', () => {
  for (const p of ['test/a.js', 'tests/unit/a.py', 'src/__tests__/a.tsx', 'spec/a_spec.rb', 'e2e/flow.mjs', 'src/a.test.ts', 'src/a.spec.js', 'pkg/a_test.go', 'tests/test_a.py', 'app/test_a.py']) {
    assert.ok(isTestFile(p), p)
  }
  for (const p of ['src/latest.js', 'src/contest/a.js', 'src/testing.ts', 'docs/tests.md', 'src/attest.go', 'protest_a.py']) assert.ok(!isTestFile(p), p)
})
test('expected_files cover a path, a folder, or a pattern', () => {
  assert.ok(covers('src/list.js', 'src/list.js')); assert.ok(covers('./src/', 'src/a/b.js')); assert.ok(covers('src', 'src/a.js'))
  assert.ok(covers('src/*.js', 'src/a.js')); assert.ok(!covers('src/*.js', 'src/a/b.js')); assert.ok(covers('src/**', 'src/a/b.js')); assert.ok(covers('**/*.css', 'web/a/b.css'))
  assert.ok(!covers('src', 'srcs/a.js')); assert.ok(!covers('src/list.js', 'src/list.json')); assert.ok(!covers('', 'a')); assert.ok(!covers('a.b', 'axb'))
})
const ch = (path: string, status: Changed['status'], added = 1, removed = 0): Changed => ({ path, status, added, removed })
test('flags: deleted tests, lines taken out of existing tests, and files outside the plan', () => {
  const changed = [ch('src/list.js', 'M', 9, 2), ch('src/db.js', 'M', 3, 1), ch('test/old.test.js', 'D', 0, 40), ch('test/items.test.js', 'M', 2, 12), ch('test/list.test.js', 'A', 30)]
  assert.deepEqual(flagsFor(changed, ['src/list.js'], ['test/list.test.js']),
    { tests_deleted: ['test/old.test.js'], tests_cut: [{ file: 'test/items.test.js', removed: 12 }], outside: ['src/db.js'] })
})
test('flags leave alone what is normal: tests added to, new tests, lockfiles, and a ticket the TPM gave no file list', () => {
  const none = { tests_deleted: [], tests_cut: [], outside: [] }
  assert.deepEqual(flagsFor([ch('test/items.test.js', 'M', 20, 0), ch('test/new.test.js', 'A', 9)], ['src/'], []), none) // only added to
  assert.deepEqual(flagsFor([ch('package.json', 'M', 1, 1), ch('package-lock.json', 'M', 40, 2), ch('web/package-lock.json', 'M', 4, 2)], ['package.json', 'web/package.json'], []), none)
  assert.deepEqual(flagsFor([ch('package-lock.json', 'M', 40, 2)], ['src/'], []).outside, ['package-lock.json']) // its manifest wasn't planned either
  assert.deepEqual(flagsFor([ch('src/a.js', 'M'), ch('lib/b.js', 'A')], [], []), none) // nothing to compare with
  assert.deepEqual(flagsFor([ch('checks/list.mjs', 'A', 9)], ['src/'], ['checks/list.mjs']), none) // a test by the map's word, whatever it's called
  assert.deepEqual(flagsFor([ch('src/old.js', 'D', 0, 30)], ['src/'], []), none) // a deleted file that isn't a test
})

// What the runners really print, captured through HQ's sandbox on 2026-11-16 (node 25, pytest 9, go 1.25, cargo 1.91), plus jest's and vitest's file lines.
const NODE = `✔ adds an item (0.497083ms)\n﹣ skipped one (0.037291ms) # SKIP\n▶ due dates\n  ✔ shows "Due soon" within 3 days (0.043167ms)\n✔ due dates (0.118542ms)\n`
  + '✔ later (0.031042ms) # TODO\nℹ tests 4\nℹ pass 2\nℹ fail 0\nℹ skipped 1\n'
const PYTEST_Q = '.s.                                                                      [100%]\n2 passed, 1 skipped in 0.00s\n'
const PYTEST_RA = `${PYTEST_Q.split('\n')[0]}\n==== PASSES ====\n=== short test summary info ===\nPASSED test_a.py::test_adds_item\nPASSED test_a.py::TestDue::test_due_soon\n`
  + 'SKIPPED [1] test_a.py:3: x\n2 passed, 1 skipped in 0.00s\n'
const GO = 'ok  \tx\t0.118s\n', GO_V = '=== RUN   TestAddsItem\n--- PASS: TestAddsItem (0.00s)\n=== RUN   TestSkipped\n    a_test.go:4: x\n--- SKIP: TestSkipped (0.00s)\nPASS\nok  \tx\t0.118s\n'
const CARGO = '\nrunning 2 tests\ntest tests::skipped ... ignored\ntest tests::adds_item ... ok\n\ntest result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'
const JEST = 'PASS test/list.test.js\nPASS test/api.test.js\n\nTests:       5 passed, 5 total\n'
const VITEST = ' ✓ test/list.test.js (3 tests | 1 skipped) 5ms\n ✓ test/api.test.js (2 tests) 3ms\n\n Tests  4 passed | 1 skipped (5)\n'
const seen = (out: string, wanted: string[], chunk = 7) => { const w = nameWatch(wanted); for (let i = 0; i < out.length; i += chunk) w.take(out.slice(i, i + chunk)); return w.seen() }
const state = (out: string, name: string, file = 'test/x.test.js') => confirm({ criterion: 'A1', file, name }, seen(out, [name, file]))

test('a named test in what the run printed: passed, skipped, never run, or no names to go by', () => {
  assert.equal(state(NODE, 'adds an item'), 'passed'); assert.equal(state(NODE, 'shows "Due soon" within 3 days'), 'passed') // inside a describe
  assert.equal(state(NODE, 'skipped one'), 'skipped'); assert.equal(state(NODE, 'later'), 'skipped') // a todo proves nothing either
  assert.equal(state(NODE, 'removes an item'), 'not_run') // node lists every test it ran, and not this one
  assert.equal(state(PYTEST_Q, 'test_adds_item', 'test_a.py'), 'unconfirmed'); assert.equal(state(GO, 'TestAddsItem', 'a_test.go'), 'unconfirmed') // no names at all
  assert.equal(state(PYTEST_RA, 'test_adds_item', 'test_a.py'), 'passed'); assert.equal(state(PYTEST_RA, 'test_use_soon', 'test_a.py'), 'passed')
  assert.equal(state(PYTEST_RA, 'test_missing', 'test_b.py'), 'not_run')
  assert.equal(state(GO_V, 'TestAddsItem', 'a_test.go'), 'passed'); assert.equal(state(GO_V, 'TestSkipped', 'a_test.go'), 'skipped'); assert.equal(state(GO_V, 'TestGone', 'a_test.go'), 'not_run')
  assert.equal(state(CARGO, 'adds_item', 'src/lib.rs'), 'passed'); assert.equal(state(CARGO, 'skipped', 'src/lib.rs'), 'skipped')
})
test('a runner that prints files, not names: the file passing is as much as HQ can see, and a file it never ran is still caught', () => {
  assert.equal(state(JEST, 'shows each due date', 'test/list.test.js'), 'passed'); assert.equal(state(VITEST, 'shows each due date', 'test/list.test.js'), 'passed')
  assert.equal(state(JEST, 'in a file jest never ran', 'test/other.test.js'), 'unconfirmed') // jest's PASS lines alone don't show it prints names
  assert.equal(state(VITEST, 'in a file vitest never ran', 'test/other.test.js'), 'not_run')
})
test('the watcher: whole lines only, colours stripped, a test that also passed elsewhere isn\'t skipped, and a criterion with no test has no state', () => {
  assert.deepEqual(seen('\x1b[32m✔ adds an item \x1b[90m(0.4ms)\x1b[39m\x1b[39m\n', ['adds an item'], 3), { prints: true, passed: ['adds an item'], skipped: [] })
  assert.deepEqual(seen('✔ adds an item (1ms)', ['adds an item']).passed, ['adds an item']) // the last line has no newline
  assert.deepEqual(seen('adds an item is being set up\nlog: ✔ nothing here\n', ['adds an item']), { prints: false, passed: [], skipped: [] }) // not a line that says passed
  assert.deepEqual(seen('﹣ twice (1ms) # SKIP\n✔ twice (1ms)\n', ['twice']), { prints: true, passed: ['twice'], skipped: [] })
  assert.equal(confirm({ criterion: 'A2', cant_test: 'Needs a real phone camera.' }, seen(NODE, [])), undefined)
  assert.deepEqual(watchFor([T1, { criterion: 'A2', cant_test: 'no' }]), ['shows each due date', 'test/list.test.js'])
})

const proof = (tests: Proof['tests'], flags: Partial<Proof['flags']> = {}): Proof => ({ at: 1, tests, flags: { tests_deleted: [], tests_cut: [], outside: [], ...flags } })
test('what goes back to the engineer, and what the summary lists as worth a look', () => {
  const p = proof([{ ...T1, state: 'skipped' }, { criterion: 'A2', file: 'test/api.test.js', name: 'has due_on', state: 'not_run' }, { criterion: 'A3', file: 'a', name: 'b', state: 'passed' }])
  const short = unproven(p.tests, 'npm test').map((l) => l.split(' was ')[0]!.split(' never ')[0])
  assert.deepEqual(short, ['A1: "shows each due date" in test/list.test.js', 'A2: "has due_on" in test/api.test.js'])
  assert.match(unproven(p.tests, 'npm test')[1]!, /`npm test` listed other tests and not this one/)
  assert.deepEqual(unproven(proof([{ ...T1, state: 'unconfirmed' }, { criterion: 'A2', cant_test: 'why' }]).tests, 'x'), []) // neither is the engineer's to fix
  assert.deepEqual(lookLines(null), []); assert.deepEqual(lookLines(proof([{ ...T1, state: 'passed' }])), []) // nothing to look at
  assert.deepEqual(lookLines(proof([{ ...T1, state: 'unconfirmed' }, { criterion: 'A2', cant_test: 'Needs a real phone camera.' }],
    { tests_deleted: ['test/old.test.js'], tests_cut: [{ file: 'test/items.test.js', removed: 12 }], outside: ['a', 'b', 'c', 'd', 'e', 'f'] })), [
    'A2 has no test: Needs a real phone camera.', "tests passed, but HQ couldn't see A1's by name: the test command doesn't print test names",
    'deleted tests: test/old.test.js', 'took lines out of existing tests: test/items.test.js (12)', 'changed files outside the ones planned for it: a, b, c, d and 2 more'])
  assert.deepEqual(proofWords(undefined), { text: 'no test named yet', tone: 'none' })
  assert.deepEqual(proofWords({ ...T1, state: 'passed' }), { text: 'test/list.test.js · "shows each due date" · passed in HQ\'s test run', tone: 'ok' })
  assert.equal(proofWords(T1).tone, 'none'); assert.equal(proofWords({ criterion: 'A2', cant_test: 'why' }).tone, 'look'); assert.equal(proofWords({ ...T1, state: 'unconfirmed' }).tone, 'look')
})
