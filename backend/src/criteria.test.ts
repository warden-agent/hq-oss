// The rules for acceptance criteria and the tests named for them (criteria.ts): what a TPM may give, what open_pr's map must look like, what git's list of
// changes flags for the user and what it must leave alone, and what each test runner's own output says about a named test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { boxCriteria, byKind, confirm, covers, criteriaBlock, criteriaMd, criteriaOf, criteriaSummary,
  flagsFor, isTestFile, leftOutOf, lookLines, mergeWatched, namesFile, nameWatch, outsideParts, proofProblem, proofWords, ranWords, readCriteria, tidyProof, unproven, watchFor,
  type Changed, type Criterion, type Proof, type Watch } from './criteria.ts'

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
  assert.deepEqual(flagsFor([ch('package.json', 'M', 1, 1), ch('bun.lock', 'M', 9, 2), ch('web/bun.lockb', 'M')], ['package.json', 'web/'], []), none) // Bug 358
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
const seen = (out: string, names: string[], files: string[] = [], chunk = 7) => {
  const w = nameWatch({ names, files }); for (let i = 0; i < out.length; i += chunk) w.take(out.slice(i, i + chunk)); return w.seen()
}
const state = (out: string, name: string, file = 'test/x.test.js') => confirm({ criterion: 'A1', file, name }, seen(out, [name], [file]))

test('a named test in what the run printed: passed, skipped, never run, or no names to go by', () => {
  assert.equal(state(NODE, 'adds an item'), 'passed'); assert.equal(state(NODE, 'shows "Due soon" within 3 days'), 'passed') // inside a describe
  assert.equal(state(NODE, 'skipped one'), 'skipped'); assert.equal(state(NODE, 'later'), 'skipped') // a todo proves nothing either
  assert.equal(state(NODE, 'removes an item'), 'not_run') // node lists every test it ran, and not this one
  assert.equal(state(PYTEST_Q, 'test_adds_item', 'test_a.py'), 'unconfirmed'); assert.equal(state(GO, 'TestAddsItem', 'a_test.go'), 'unconfirmed') // no names at all
  assert.equal(state(PYTEST_RA, 'test_adds_item', 'test_a.py'), 'passed')
  assert.equal(state(PYTEST_RA, 'test_use_soon', 'test_a.py'), 'unconfirmed') // never printed, and test_a.py had a test skipped: it may be that one (Bug 375)
  assert.equal(state(PYTEST_RA, 'test_missing', 'test_b.py'), 'not_run')
  assert.equal(state(GO_V, 'TestAddsItem', 'a_test.go'), 'passed'); assert.equal(state(GO_V, 'TestSkipped', 'a_test.go'), 'skipped'); assert.equal(state(GO_V, 'TestGone', 'a_test.go'), 'not_run')
  assert.equal(state(CARGO, 'adds_item', 'src/lib.rs'), 'passed'); assert.equal(state(CARGO, 'skipped', 'src/lib.rs'), 'skipped')
})
test('a runner that prints files, not names: the file passing is as much as HQ can see, and a file it never listed is one HQ can\'t tell about', () => {
  assert.equal(state(JEST, 'shows each due date', 'test/list.test.js'), 'passed'); assert.equal(state(VITEST, 'has due_on', 'test/api.test.js'), 'passed')
  assert.equal(state(VITEST, 'shows each due date', 'test/list.test.js'), 'unconfirmed') // its file had a test skipped (Bug 375)
  assert.equal(state(JEST, 'in a file jest never ran', 'test/other.test.js'), 'unconfirmed') // jest's PASS lines alone don't show it prints names
  assert.equal(state(VITEST, 'in a file vitest never ran', 'test/other.test.js'), 'unconfirmed') // nor do vitest's ✓ lines for files (Bug 372)
})
test('the watcher: whole lines only, colours stripped, a test that also passed elsewhere isn\'t skipped, and a criterion with no test has no state', () => {
  assert.deepEqual(seen('\x1b[32m✔ adds an item \x1b[90m(0.4ms)\x1b[39m\x1b[39m\n', ['adds an item'], [], 3), { prints: true, passed: ['adds an item'], skipped: [], unsure: [] })
  assert.deepEqual(seen('✔ adds an item (1ms)', ['adds an item']).passed, ['adds an item']) // the last line has no newline
  assert.deepEqual(seen('adds an item is being set up\nlog: ✔ nothing here\n', ['adds an item']), { prints: false, passed: [], skipped: [], unsure: [] }) // not a line that says passed
  assert.deepEqual(seen('﹣ twice (1ms) # SKIP\n✔ twice (1ms)\n', ['twice']), { prints: true, passed: ['twice'], skipped: [], unsure: [] })
  assert.equal(confirm({ criterion: 'A2', cant_test: 'Needs a real phone camera.' }, seen(NODE, [])), undefined)
  assert.deepEqual(watchFor([T1, { criterion: 'A2', cant_test: 'no' }]), { names: ['shows each due date'], files: ['test/list.test.js'] })
})

// Bug 377: mocha prints a pending test (it.skip, or it() with no body) as `  - name`, and HQ read it as "never ran". What mocha 11.8.0 really printed through
// HQ's own sandbox on 2026-11-24 (spec reporter, the same with --color, and the list reporter), from a project with tests in and out of suites. In testdata/bug377.
const cap377 = (name: string): string => readFileSync(new URL(`./testdata/bug377/${name}.txt`, import.meta.url), 'utf8')
const MAP377 = [
  { criterion: 'A1', file: 'test/list.test.js', name: 'shows each due date' }, { criterion: 'A2', file: 'test/list.test.js', name: 'sorts books by due date' },
  { criterion: 'A3', file: 'test/api.test.js', name: 'a top-level skipped one' }, { criterion: 'A4', file: 'test/api.test.js', name: 'a pending one with no body' },
  { criterion: 'A5', file: 'test/api.test.js', name: 'deep skip' }, { criterion: 'A6', file: 'test/api.test.js', name: 'has due_on' },
  { criterion: 'A7', file: 'checks/other.test.js', name: 'in a file mocha never runs' },
]
test('Bug 377: a mocha test marked pending reads "skipped", in a suite or not, and the engineer is told it was skipped', () => {
  const states = (out: string) => { const w = seen(out, watchFor(MAP377).names, watchFor(MAP377).files, 64); return MAP377.map((e) => confirm(e, w)) }
  for (const c of ['mocha-11.8.0', 'mocha-11.8.0-color']) {
    assert.deepEqual(states(cap377(c)), ['passed', 'skipped', 'skipped', 'skipped', 'skipped', 'passed', 'not_run'], c) // mocha names every test, so A7 never ran
  }
  assert.deepEqual(states(cap377('mocha-11.8.0-list')).slice(1, 5), ['skipped', 'skipped', 'skipped', 'skipped']) // `  - book list sorts books by due date`
  const told = unproven(MAP377.map((e, i) => ({ ...e, state: states(cap377('mocha-11.8.0'))[i] })), 'npm test')
  assert.equal(told[0], 'A2: "sorts books by due date" in test/list.test.js was skipped, so nothing proved A2. Make it run, or name a test that does.')
  assert.equal(told.filter((l) => l.includes('listed other tests')).length, 1) // only A7's, which really isn't in the run
})
// Bug 383: with no terminal, mocha's `list` reporter writes a test's title, then `\r` and its ✔ line over it, all on one line of output (`has due_on: \r  ✔ has
// due_on: 0ms`), so no line began with ✔ and every named test that passed read "couldn't see it by name". HQ reads a line as a terminal shows it now.
test('Bug 383: a named test reads "passed" when the runner draws its ✔ over the title with a carriage return (mocha --reporter list)', () => {
  const states = (out: string, chunk = 64) => { const w = seen(out, watchFor(MAP377).names, watchFor(MAP377).files, chunk); return MAP377.map((e) => confirm(e, w)) }
  const list = cap377('mocha-11.8.0-list'), spec = states(cap377('mocha-11.8.0'))
  assert.ok(list.includes('has due_on: \r  ✔ has due_on: 0ms\n')) // the real capture, as it came through HQ's sandbox
  assert.deepEqual(states(list), ['passed', 'skipped', 'skipped', 'skipped', 'skipped', 'passed', 'not_run']) // as the spec reporter reads
  assert.deepEqual(states(list, 1), states(list), 'the \r and the line split across chunks')
  assert.deepEqual(states(cap377('mocha-11.8.0').replace(/\n/g, '\r\n')), spec, 'Windows line ends redraw nothing')
  assert.equal(seen(list, ['has due_on']).prints, true) // mocha names every test, so a name it never printed never ran
})
test('Bug 383, what a carriage return must not change: only what a terminal shows at the end of the line counts', () => {
  assert.deepEqual(seen('    shows each due date: \r  1) shows each due date\n', ['shows each due date']), { prints: false, passed: [], skipped: [], unsure: [] }) // failed
  assert.deepEqual(seen('  ✔ shows each due date\r  - shows each due date\n', ['shows each due date']).skipped, ['shows each due date']) // drawn over
  assert.deepEqual(seen(' 40% [====    ]\r100% [========]\r\n  ✔ shows each due date\n', ['shows each due date']).passed, ['shows each due date'])
  const names = ['adds_item', 'shows each due date', 'sorts books by due date', 'has due_on'], files = ['test/list.test.js', 'web/src/sort.test.ts']
  for (const [k, c] of Object.entries({ VITEST, JEST, PYTEST_RA, GO_V, CARGO })) assert.deepEqual(seen(c.replace(/\n/g, '\r\n'), names, files), seen(c, names, files), k)
  for (const d of ['bug372', 'bug375', 'bug377', 'bug414', 'bug427']) { // every real test run captured reads the same with Windows line ends
    for (const f of readdirSync(new URL(`./testdata/${d}/`, import.meta.url))) {
      const c = readFileSync(new URL(`./testdata/${d}/${f}`, import.meta.url), 'utf8')
      assert.deepEqual(seen(c.replace(/\n/g, '\r\n'), names, files, 64), seen(c, names, files, 64), `${d}/${f}`)
    }
  }
})
test('Bug 377, what mocha\'s pending line must not catch: a list or a diff line that names a test', () => {
  for (const line of ['- shows each due date', '-shows each due date', '      -shows each due date', '  -   shows each due date: 2', '  -- shows each due date',
    '      + expected - actual shows each due date', '\t- shows each due date']) assert.deepEqual(seen(`${line}\n`, ['shows each due date']).skipped, [], line)
  assert.deepEqual(seen('  - shows each due date\n  ✔ shows each due date\n', ['shows each due date']).passed, ['shows each due date']) // it also passed: passed
})

// Bug 372: a finished ticket's eight tests ran and passed, and HQ said all eight "never ran". The project's test command was `(cd "frontend" && npm test)`
// with vitest 4.1.11, which prints one ✓ line per test file (its path from the folder it runs in) and no test names but the slow ones. What these runners
// really print, each captured through HQ's own sandbox (runSandboxed) on 2026-11-23 from a made-up project whose tests are in web/; only the folder in
// vitest's RUN line is renamed. In testdata/bug372.
const cap372 = (name: string): string => readFileSync(new URL(`./testdata/bug372/${name}.txt`, import.meta.url), 'utf8')
const MAP372 = [
  { criterion: 'A1', file: 'web/src/list.test.ts', name: 'shows each due date' }, { criterion: 'A2', file: 'web/src/list.test.ts', name: 'marks a book due soon' },
  { criterion: 'A3', file: 'web/src/api.test.ts', name: 'has due_on' }, { criterion: 'A4', file: 'web/src/api.test.ts', name: 'a slow one' },
  { criterion: 'A5', file: 'web/checks/other.test.ts', name: 'in a file the command never runs' },
]
const states372 = (out: string, map = MAP372) => { const w = seen(out, watchFor(map).names, watchFor(map).files, 64); return map.map((e) => confirm(e, w)) }

test('Bug 372: vitest\'s usual output, one line per test file: tests in a file it ran passed (unless it had one skipped, Bug 375), and nothing reads as "never ran"', () => {
  for (const v of ['4.1.11', '3.2.4', '2.1.9', '1.6.1']) {
    const out = cap372(`vitest-${v}`), got = states372(out)
    assert.match(out, / src\/list\.test\.ts\x1b?[^\n]*4 tests/, `vitest ${v} prints the file from the folder it runs in`)
    // list.test.ts's line says "1 skipped", so its two named tests are ones HQ can't see (Bug 375); api.test.ts's has none skipped
    assert.deepEqual(got, ['unconfirmed', 'unconfirmed', 'passed', 'passed', 'unconfirmed'], `vitest ${v}`)
    assert.deepEqual(unproven(MAP372.map((e, i) => ({ ...e, state: got[i] })), 'npm test'), [], `vitest ${v}: nothing goes back to the engineer`)
  }
  // the slow test vitest 2 to 4 name under its file is no sign that every test is named: before the fix that line alone made the rest "never ran"
  assert.match(cap372('vitest-4.1.11'), /✓\x1b\[22m\x1b\[39m a slow one/); assert.equal(seen(cap372('vitest-4.1.11'), ['a slow one']).prints, false)
  assert.equal(seen(cap372('vitest-1.6.1'), ['a slow one']).passed.length, 0) // vitest 1 names none at all
})
test('Bug 372, what must still be caught: a runner that lists every test by name, with or without lines for its files', () => {
  const map = [...MAP372, { criterion: 'A6', file: 'web/src/list.test.ts', name: 'a skipped one' }]
  // vitest's verbose reporter (file > name on every line) and its tree reporter (a line per file, and every test under it)
  assert.deepEqual(states372(cap372('vitest-4.1.11-verbose'), map), ['passed', 'passed', 'passed', 'passed', 'not_run', 'skipped'])
  assert.deepEqual(states372(cap372('vitest-4.1.11-tree'), map), ['passed', 'passed', 'passed', 'passed', 'not_run', 'skipped'])
  // jest 30, started in web/: all its files gives a PASS line each and no names; one file alone gives that file's tests by name
  const jest = [{ criterion: 'A1', file: 'web/test/list.test.js', name: 'shows each due date' }, { criterion: 'A2', file: 'web/test/api.test.js', name: 'has due_on' },
    { criterion: 'A3', file: 'web/checks/other.test.js', name: 'in a file jest never ran' }, { criterion: 'A4', file: 'web/test/list.test.js', name: 'a skipped one' }]
  // the run's summary says "1 skipped" and a PASS line can't show which file it was in, so none of them is seen passing (Bug 375; before: all but A3 passed)
  assert.deepEqual(states372(cap372('jest-30.1.3'), jest), ['unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed'])
  assert.deepEqual(states372(cap372('jest-30.1.3-one-file'), jest), ['passed', 'not_run', 'not_run', 'skipped'])
  // and runners with no file lines at all are read as before
  assert.equal(state(NODE, 'removes an item'), 'not_run'); assert.equal(state(GO_V, 'TestGone', 'a_test.go'), 'not_run'); assert.equal(state(PYTEST_Q, 'test_x', 't.py'), 'unconfirmed')
})
test('Bug 372: a test file named from the repo\'s root matches the path a runner started in a folder prints, and no other file', () => {
  const f = 'web/src/list.test.ts'
  for (const line of [' ✓ web/src/list.test.ts (4 tests) 1ms', ' ✓ src/list.test.ts (4 tests) 1ms', 'PASS src/list.test.ts', 'PASS ./src/list.test.ts (5.1 s)', '✓ list.test.ts (4 tests)',
    'PASS ../web/src/list.test.ts', ' ✓ /tmp/shop/web/src/list.test.ts (4 tests)', ' ✓ src/list.test.ts > book list > shows each due date 1ms', 'src/list.test.ts::test_x PASSED',
    ' ✓ |web| src/list.test.ts (4 tests) 1ms', '  ✓  1 [chromium] › src/list.test.ts:3:1 › shows each due date (1.2s)']) assert.equal(namesFile(line, f), true, line)
  for (const line of [' ✓ src/other/list.test.ts (4 tests) 1ms', 'PASS lib/src/list.test.ts', ' ✓ src/list.test.tsx (4 tests)', 'PASS src/list.test.ts.snap', ' ✓ src/mylist.test.ts (2 tests)',
    'PASS src/list.test.ts-old', ' ✓ /tmp/shop/other/src/list.test.ts (4 tests)', '✓ list (4 tests)', 'PASS src/']) assert.equal(namesFile(line, f), false, line)
  assert.equal(namesFile('PASSED test_a.py::test_adds_item', 'test_a.py'), true); assert.equal(namesFile('PASSED tests/test_a.py::test_x', 'api/tests/test_a.py'), true)
  // only on a line that says "passed": a file a failing or skipped line names proves nothing
  assert.deepEqual(seen(' ❯ src/list.test.ts (4 tests | 1 failed) 5ms\n ↓ src/list.test.ts (4 tests | 4 skipped)\n', [], [f]).passed, [])
})

// Bug 375: a named test that was skipped read "passed in HQ's test run", because the line for its file said the file passed. Real vitest 4.1.11 and jest 30.1.3
// started in web/, captured 2026-11-24 (outside HQ's sandbox, agent variables unset so vitest uses its usual reporter; folder renamed): src/sort.test.ts
// has a passing test, an it.skip and an it.todo; src/api.test.ts one passing test. In testdata/bug375.
const cap375 = (name: string): string => readFileSync(new URL(`./testdata/bug375/${name}.txt`, import.meta.url), 'utf8')
const MAP375 = (dir: string, ext: string) => [
  { criterion: 'A1', file: `web/${dir}/sort.test.${ext}`, name: 'sorts books by due date' }, { criterion: 'A2', file: `web/${dir}/sort.test.${ext}`, name: 'a todo one' },
  { criterion: 'A3', file: `web/${dir}/sort.test.${ext}`, name: 'keeps the list' }, { criterion: 'A4', file: `web/${dir}/api.test.${ext}`, name: 'has due_on' },
]
test('Bug 375: a file passing with tests in it skipped proves nothing about a named test in it, on vitest\'s file line and jest\'s whole run', () => {
  const vitest = cap375('vitest-4.1.11-skip-todo'), jest = cap375('jest-30.1.3-skip-todo')
  assert.match(vitest, /sort\.test\.ts[^\n]*3 tests[^\n]*1 skipped[^\n]*1 todo/); assert.match(jest, /Tests:[^\n]*1 skipped[^\n]*1 todo/)
  // vitest says which file had them: its tests are unconfirmed (the skipped one, the todo one, and a passing one alike), the other file's still pass
  const v = states372(vitest, MAP375('src', 'ts')); assert.deepEqual(v, ['unconfirmed', 'unconfirmed', 'unconfirmed', 'passed'])
  // jest says only that the run had them: every test seen through a PASS line is unconfirmed
  assert.deepEqual(states372(jest, MAP375('test', 'js')), ['unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed'])
  // none of that sends the ticket back, and the check doesn't say every test ran
  assert.deepEqual(unproven(MAP375('src', 'ts').map((e, i) => ({ ...e, state: v[i] })), 'npm test'), [])
  assert.match(ranWords(MAP375('src', 'ts').map((e, i) => ({ ...e, state: v[i] }))), /couldn't see 3 of the 4 tests/)
  // a todo alone counts as well, and a skip line that names a file (pytest -rA's SKIPPED summary) does too
  assert.equal(state(' ✓ src/a.test.ts (2 tests | 1 todo) 1ms\n', 'x', 'web/src/a.test.ts'), 'unconfirmed')
  assert.equal(state('PASS test/a.test.js\nTests:       1 todo, 1 passed, 2 total\n', 'x', 'test/a.test.js'), 'unconfirmed')
  assert.equal(state('PASSED test_a.py::test_x\nSKIPPED [1] test_a.py:9: no db\n', 'test_y', 'test_a.py'), 'unconfirmed')
})
test('Bug 375, what must not change: a file with nothing skipped, a test printed by name, and a skip in another file or another runner\'s summary', () => {
  assert.equal(state(' ✓ src/a.test.ts (2 tests) 1ms\n ✓ src/b.test.ts (3 tests | 1 skipped) 1ms\n', 'x', 'web/src/a.test.ts'), 'passed') // the skip was in b
  assert.equal(state('PASS test/a.test.js\nTests:       2 passed, 2 total\n', 'x', 'test/a.test.js'), 'passed') // jest, nothing skipped
  // vitest's own summary has no colon: it isn't read as jest's, and a vitest file line keeps what it says
  assert.equal(state(' ✓ src/a.test.ts (2 tests) 1ms\n      Tests  2 passed | 1 skipped (3)\n', 'x', 'src/a.test.ts'), 'passed')
  // printed by name, a test is passed or skipped whatever its file's line says (vitest's tree reporter, jest on one file)
  const map = [...MAP372, { criterion: 'A6', file: 'web/src/list.test.ts', name: 'a skipped one' }]
  assert.deepEqual(states372(cap372('vitest-4.1.11-tree'), map), ['passed', 'passed', 'passed', 'passed', 'not_run', 'skipped'])
  assert.equal(state(`${cap372('jest-30.1.3-one-file')}`, 'shows each due date', 'web/test/list.test.js'), 'passed')
  // a runner that lists names and not files reads as before: a skip elsewhere changes nothing
  assert.equal(state(NODE, 'removes an item'), 'not_run'); assert.equal(state(GO_V, 'TestGone', 'a_test.go'), 'not_run')
})
// Bug 376: vitest started in web/ prints `src/api.test.ts`, and that line counted for admin/src/api.test.ts too, though the command never ran admin/'s tests:
// a test named there read "passed". HQ's own command for a repo split into folders says where each runner starts (testrun.ts testFolders).
test('Bug 376: with the folders the command runs its runners in, a file line counts only for a file in one of them', () => {
  // list.test.ts's line says "1 skipped", so A1/A2 are unconfirmed whatever the folders (Bug 375)
  const map = [...MAP372, { criterion: 'A6', file: 'admin/src/api.test.ts', name: 'lists the users' }], out = cap372('vitest-4.1.11')
  const got = (folders: string[] | null) => { const w = nameWatch(watchFor(map), folders); w.take(out); return map.map((e) => confirm(e, w.seen())) }
  assert.deepEqual(got(['web']), ['unconfirmed', 'unconfirmed', 'passed', 'passed', 'unconfirmed', 'unconfirmed']) // admin/'s never ran: HQ can't see it, not "passed"
  assert.deepEqual(got(['admin', 'web']), ['unconfirmed', 'unconfirmed', 'passed', 'passed', 'unconfirmed', 'passed']) // both ran: either folder's line may be it
  assert.deepEqual(got(null), ['unconfirmed', 'unconfirmed', 'passed', 'passed', 'unconfirmed', 'passed']) // the user's own command: HQ can't tell, as before
  const web = 'web/src/api.test.ts', admin = 'admin/src/api.test.ts', root = 'src/api.test.ts'
  for (const line of [' ✓ src/api.test.ts (2 tests) 3ms', 'PASS ./src/api.test.ts', '✓ api.test.ts (2 tests)', 'PASS web/src/api.test.ts', ' ✓ /tmp/shop/web/src/api.test.ts (2 tests)']) {
    assert.equal(namesFile(line, web, ['web']), true, line); assert.equal(namesFile(line, admin, ['web']), false, line); assert.equal(namesFile(line, root, ['web']), false, line)
  }
  assert.equal(namesFile('PASS admin/src/api.test.ts', admin, ['web']), false) // not a folder it runs in: no line counts for it
  assert.equal(namesFile('PASS src/api.test.ts', admin, ['web', 'admin']), true); assert.equal(namesFile('PASS src/api.test.ts', 'webby/src/api.test.ts', ['web']), false)
  assert.equal(namesFile('PASS src/api.test.ts', admin, null), true); assert.equal(namesFile('PASS src/api.test.ts', root, null), true) // as before
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
    'A2 has no test: Needs a real phone camera.', "tests passed, but HQ couldn't see A1's by name: the test command doesn't print every test's name",
    'deleted tests: test/old.test.js', 'took lines out of existing tests: test/items.test.js (12)', 'changed files outside the ones planned for it: a, b, c, d and 2 more'])
  // the check's own line: "every test ran" only when HQ saw every one (Bug 372)
  const A2 = { criterion: 'A2', file: 'test/api.test.js', name: 'has due_on' }, CANT = { criterion: 'A3', cant_test: 'Needs a real phone camera.' }
  assert.equal(ranWords([{ ...T1, state: 'passed' }, { ...A2, state: 'passed' }]), 'Every test named for its criteria ran.')
  assert.equal(ranWords([{ ...T1, state: 'passed' }, CANT]), 'Every test named for its criteria ran (1 of them has no test).')
  assert.equal(ranWords([{ ...T1, state: 'passed' }, { ...A2, state: 'unconfirmed' }]), "The tests passed, but HQ couldn't see 1 of the 2 tests named for its criteria by name.")
  assert.equal(ranWords([{ ...T1, state: 'unconfirmed' }, { ...A2, state: 'unconfirmed' }, CANT]),
    "The tests passed, but HQ couldn't see the tests named for its criteria by name (1 of them has no test).")
  assert.equal(ranWords([{ ...T1, state: 'unconfirmed' }]), "The tests passed, but HQ couldn't see the test named for its criteria by name.")
  assert.deepEqual(proofWords(undefined), { text: 'no test named yet', tone: 'none' })
  assert.deepEqual(proofWords({ ...T1, state: 'passed' }), { text: 'test/list.test.js · "shows each due date" · passed in HQ\'s test run', tone: 'ok' })
  assert.equal(proofWords(T1).tone, 'none'); assert.equal(proofWords({ criterion: 'A2', cant_test: 'why' }).tone, 'look'); assert.equal(proofWords({ ...T1, state: 'unconfirmed' }).tone, 'look')
})

// Bug 411: a repo with frontend/ (npm) and backend/ (pytest) ran the frontend's tests only, and the backend's named tests "never ran". HQ now runs each
// folder's suite as a part of its own and judges each part's output on its own. What the runners print, captured through HQ's sandbox on 2026-11-25:
// pytest 9.2 -v, Python 3.14's unittest -v, Django 5.2's `manage.py test -v 2`.
const cap411 = (name: string): string => readFileSync(new URL(`./testdata/bug411/${name}.txt`, import.meta.url), 'utf8')
const st411 = (out: string, name: string, file: string, folders: string[] | null = null) => { const w = nameWatch({ names: [name], files: [file] }, folders); w.take(out)
  return confirm({ criterion: 'A1', file, name }, w.seen()) }
test('Bug 411: pytest -v, unittest -v and Django\'s own test runner name each test, and HQ reads the names', () => {
  const py = cap411('pytest-9.2.0-v'), ut = cap411('unittest-3.14-v'), dj = cap411('django-5.2-test-v2'), B = 'backend/tests/test_downloads.py'
  assert.equal(st411(py, 'test_download_is_listed', B, ['backend']), 'passed'); assert.equal(st411(py, 'test_lists_are_per_user', B, ['backend']), 'passed') // `test_lists_are_per_user[a]`
  assert.equal(st411(py, 'test_downloads_survive_restart', B, ['backend']), 'skipped')
  assert.equal(st411(py, 'test_never_written', 'backend/tests/test_other.py', ['backend']), 'not_run') // pytest -v lists every test, and not this one
  assert.equal(st411(ut, 'test_total_adds_prices', 'tests/test_cart.py'), 'passed'); assert.equal(st411(ut, 'test_discount_is_applied', 'tests/test_cart.py'), 'skipped')
  assert.equal(st411(ut, 'test_never_written', 'tests/test_cart.py'), 'not_run')
  assert.equal(st411(dj, 'test_price_is_in_whole_units', 'catalog/tests.py'), 'passed') // printed glued to the end of a migration's line
  assert.equal(st411(dj, 'test_products_are_saved', 'catalog/tests.py'), 'passed'); assert.equal(st411(dj, 'test_never_written', 'catalog/tests.py'), 'not_run')
  // what must not be read as a test passing: a migration's own line, an install's
  const w = nameWatch({ names: ['auth', 'packages'], files: [] })
  w.take('  Applying auth.0001_initial... OK\n  Applying auth.0002_alter_permission_name_max_length... OK\nadded 3 packages ... ok\nok\n')
  assert.deepEqual(w.seen(), { prints: false, passed: [], skipped: [], unsure: [] })
})
test('Bug 411: run part by part, each suite is judged by its own output, and a test in no part\'s folder is told apart', () => {
  const part = (dir: string, out: string, w: Watch) => { const x = nameWatch(w, [dir]); x.take(out); return { dir, seen: x.seen() } }
  const A1 = { criterion: 'A1', file: 'backend/tests/test_downloads.py', name: 'test_download_is_listed' }, A2 = { criterion: 'A2', file: 'backend/tests/test_other.py', name: 'test_never_written' }
  const A3 = { criterion: 'A3', file: 'web/src/api.test.ts', name: 'has due_on' }, A4 = { criterion: 'A4', file: 'mobile/app/list.test.ts', name: 'shows the list' }
  const map = [A1, A2, A3, A4], w = watchFor(map), py = cap411('pytest-9.2.0-v'), vi = cap372('vitest-4.1.11')
  // the frontend's vitest counts 6 tests and names one; the backend's pytest names each of its 7
  const both = mergeWatched([part('backend', py, w), part('web', vi, w)])
  assert.deepEqual(both.parts, [{ dir: 'backend', prints: true }, { dir: 'web', prints: false }]); assert.equal(both.prints, false)
  assert.deepEqual(map.map((e) => confirm(e, both)), ['passed', 'not_run', 'passed', 'not_run']) // A2: pytest listed its tests, and not this one. A4: nobody ran mobile/
  // with one flag for the whole run a quiet suite's file lines could push a names-printing suite's missing test to "couldn't see it": 8 named, 506 counted
  const big = `${vi} ✓ src/more.test.ts (500 tests) 9ms\n`, one = nameWatch(w, ['backend', 'web']); one.take(`${py}\n${big}`)
  assert.equal(confirm(A2, one.seen()), 'unconfirmed'); assert.equal(confirm(A2, mergeWatched([part('backend', py, w), part('web', big, w)])), 'not_run')
  // and a suite that prints no names can't have its tests read "never ran" because the suite beside it lists its own
  const quiet = mergeWatched([part('backend', PYTEST_Q, w), part('web', NODE, w)])
  assert.equal(confirm(A2, quiet), 'unconfirmed'); assert.equal(confirm({ ...A3, name: 'removes an item' }, quiet), 'not_run')
  const flat = nameWatch(w, null); flat.take(`${PYTEST_Q}${NODE}`); assert.equal(confirm(A2, flat.seen()), 'not_run') // what one flag said of the quiet suite's test
  // a part at the project's root holds every file; a name with no file goes by every part
  const root = mergeWatched([part('web', NODE, w), { dir: '.', seen: { prints: false, passed: [], skipped: [], unsure: [] } }])
  assert.equal(confirm({ ...A3, name: 'removes an item' }, root), 'unconfirmed'); assert.equal(confirm({ criterion: 'A5', name: 'no file given' }, both), 'unconfirmed')
  assert.equal(outsideParts(A4, both.parts), true); assert.equal(outsideParts(A2, both.parts), false); assert.equal(outsideParts(A4, root.parts), false)
  assert.equal(outsideParts(A4, undefined), false); assert.equal(outsideParts({ criterion: 'A5', name: 'x' }, both.parts), false) // nothing to go by: as before
  // what the engineer is told: the command's gap for the one, today's words for the other
  const lines = unproven(map.map((e) => ({ ...e, state: confirm(e, both) })), '(cd "backend" && uv run pytest -v) && (cd "web" && npm test)', both.parts)
  assert.match(lines[0]!, /^A2: "test_never_written" in backend\/tests\/test_other\.py never ran\. `\(cd "backend" .*listed other tests and not this one: put it where that command runs it\.$/)
  assert.equal(lines[1], 'A4: "shows the list" in mobile/app/list.test.ts never ran: HQ\'s test command runs nothing in mobile/ (it runs backend/, web/).'); assert.equal(lines.length, 2)
  // skipped tests and what passed elsewhere carry over as before
  const skip = mergeWatched([part('backend', py, { names: ['test_downloads_survive_restart'], files: [] }), part('web', NODE, { names: ['test_downloads_survive_restart'], files: [] })])
  assert.deepEqual(skip.skipped, ['test_downloads_survive_restart']); assert.deepEqual(mergeWatched([]), { prints: false, passed: [], skipped: [], unsure: [], parts: [] })
})

test('Bug 411: a named test in something the project\'s test steps leave out says what is left out and why, and isn\'t the command\'s gap', () => {
  const parts = [{ dir: 'backend', prints: true }, { dir: 'web', prints: true }]
  const left = [{ path: 'backend/tests/integration', why: 'It needs a database server.' }, { path: 'mobile', why: 'It needs a phone.' }]
  const A1 = { criterion: 'A1', file: 'backend/tests/integration/test_db.py', name: 'test_saves_to_the_database', state: 'not_run' as const }
  const A2 = { criterion: 'A2', file: 'mobile/app/list.test.ts', name: 'shows the list', state: 'not_run' as const }
  const A3 = { criterion: 'A3', file: 'docs/a.test.ts', name: 'x', state: 'not_run' as const }
  const lines = unproven([A1, A2, A3], 'cmd', parts, left)
  assert.equal(lines[0], 'A1: "test_saves_to_the_database" in backend/tests/integration/test_db.py never ran: HQ\'s test steps leave backend/tests/integration out (It needs a database server.), '
    + "so HQ can't see it run. Name a test for A1 that HQ's test command runs, or give the reason it can't be tested (cant_test).")
  assert.match(lines[1]!, /^A2: "shows the list" in mobile\/app\/list\.test\.ts never ran: HQ's test steps leave mobile out \(It needs a phone\.\)/)
  assert.match(lines[2]!, /never ran: HQ's test command runs nothing in docs\/ \(it runs backend\/, web\/\)\.$/) // left out by nobody: the command's gap, as before
  assert.deepEqual([A1, A2, A3].map((e) => outsideParts(e, parts, left)), [false, false, true]) // what is left out on purpose is the engineer's to answer for, not the command's
  assert.equal(leftOutOf('mobile', left)?.path, 'mobile'); assert.equal(leftOutOf('mobiles/a.test.ts', left), undefined); assert.equal(leftOutOf(undefined, left), undefined)
  assert.equal(leftOutOf('anything/at/all.py', [{ path: '.', why: 'w' }])?.why, 'w'); assert.equal(unproven([A1], 'cmd', parts).length, 1) // no list given: today's words
})

// Bug 414: pytest -v names every test on a line of its own that also names its file (`tests/test_shelf.py::test_x PASSED`). Such a line was read as one for
// its whole file: a file with one test skipped made its other named tests "couldn't see it by name", and a file with none skipped made a named test pytest
// never ran (one it doesn't collect) read "passed". Real pytest 9.2.0 through HQ's sandbox, 2026-11-26: tests/test_due.py has two passing tests,
// tests/test_shelf.py two passing and one skipped. In testdata/bug414.
const cap414 = (name: string): string => readFileSync(new URL(`./testdata/bug414/${name}.txt`, import.meta.url), 'utf8')
const MAP414 = [
  { criterion: 'A1', file: 'tests/test_shelf.py', name: 'test_shelf_lists_books' }, { criterion: 'A2', file: 'tests/test_shelf.py', name: 'test_shelf_shows_covers' },
  { criterion: 'A3', file: 'tests/test_shelf.py', name: 'check_shelf_is_sorted' }, { criterion: 'A4', file: 'tests/test_due.py', name: 'test_due_date_is_shown' },
  { criterion: 'A5', file: 'tests/test_due.py', name: 'check_due_soon_is_marked' },
]
test('Bug 414: a test pytest -v never ran reads "never ran", whether or not its file had a test skipped or passing', () => {
  const v = cap414('pytest-9.2.0-v'); assert.match(v, /test_shelf\.py::test_shelf_shows_covers SKIPPED/)
  // A3 and A5 are written in their files but pytest doesn't collect them (no test_ in front). Before: A3 unconfirmed (the skip), A5 passed (the file's others)
  assert.deepEqual(states372(v, MAP414), ['passed', 'skipped', 'not_run', 'passed', 'not_run'])
  assert.deepEqual(seen(v, [], ['tests/test_shelf.py', 'tests/test_due.py']), { prints: true, passed: [], skipped: [], unsure: [] }) // one test's line is no file's
  const told = unproven(MAP414.map((e, i) => ({ ...e, state: states372(v, MAP414)[i] })), 'pytest -v')
  assert.equal(told.length, 3); assert.match(told[1]!, /^A3: "check_shelf_is_sorted" in tests\/test_shelf\.py never ran\. `pytest -v` listed other tests and not this one/)
  // also in a folder, run part by part (Bug 411), and with the folder it runs in
  assert.equal(st411(v, 'check_shelf_is_sorted', 'api/tests/test_shelf.py', ['api']), 'not_run')
  // vitest's verbose reporter is shaped the same (file > name on every line): its files' unprinted tests never ran either. Before: unconfirmed, and passed
  const map = [{ criterion: 'A1', file: 'web/src/list.test.ts', name: 'not in the list' }, { criterion: 'A2', file: 'web/src/api.test.ts', name: 'not in the api' }]
  assert.deepEqual(states372(cap372('vitest-4.1.11-verbose'), map), ['not_run', 'not_run'])
})
test('Bug 414, what must not change: a skip line that names no test, and lines for a whole file (Bug 375)', () => {
  // pytest -rA's skip summary names the file and a line, not the test: an unprinted test of that file may be the skipped one. A5 never ran
  // (before: passed, through its file's other PASSED lines: the one thing here that changes)
  const rA = cap414('pytest-9.2.0-rA'); assert.match(rA, /^SKIPPED \[1\] tests\/test_shelf\.py:8: /m)
  assert.deepEqual(states372(rA, MAP414), ['passed', 'unconfirmed', 'unconfirmed', 'passed', 'not_run'])
  assert.equal(state('PASSED test_a.py::test_x\nSKIPPED [1] test_a.py:9: needs std::vector > 2\n', 'test_y', 'test_a.py'), 'unconfirmed') // `::` in the reason
  // vitest's line for a file it skipped whole, and its usual and tree reporters' file lines with a count, and jest's PASS lines in a run with skips: as before
  assert.equal(state(' ✓ src/b.test.ts (1 test) 1ms\n ↓ src/a.test.ts (4 tests | 4 skipped)\n', 'x', 'web/src/a.test.ts'), 'unconfirmed')
  assert.deepEqual(states372(cap372('vitest-4.1.11'), MAP372), ['unconfirmed', 'unconfirmed', 'passed', 'passed', 'unconfirmed'])
  assert.deepEqual(states372(cap372('vitest-4.1.11-tree'), MAP372), ['passed', 'passed', 'passed', 'passed', 'not_run'])
  assert.deepEqual(states372(cap375('vitest-4.1.11-skip-todo'), MAP375('src', 'ts')), ['unconfirmed', 'unconfirmed', 'unconfirmed', 'passed'])
  assert.deepEqual(states372(cap375('jest-30.1.3-skip-todo'), MAP375('test', 'js')), ['unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed'])
  assert.equal(state(JEST, 'shows each due date', 'test/list.test.js'), 'passed') // a PASS line passes its file when nothing was skipped
})

// Bug 427: pytest's XFAIL / XPASS lines were neither a pass nor a skip, so a named test marked xfail read "never ran" with pytest -v or -rA. Real pytest
// 9.2.0 and Python 3.14's unittest, 2026-11-26: tests/test_shelf.py has two passing tests, one xfail that fails (XFAIL), one that passes (XPASS), one strict
// one that passes (FAILED, `[XPASS(strict)]`); tests/test_notrun.py one `run=False` xfail and one `pytest.xfail()`. In testdata/bug427.
const cap427 = (name: string): string => readFileSync(new URL(`./testdata/bug427/${name}.txt`, import.meta.url), 'utf8')
const MAP427 = [
  { criterion: 'A1', file: 'tests/test_shelf.py', name: 'test_shelf_lists_books' }, { criterion: 'A2', file: 'tests/test_shelf.py', name: 'test_shelf_shows_covers' },
  { criterion: 'A3', file: 'tests/test_shelf.py', name: 'test_shelf_sorts_books' }, { criterion: 'A4', file: 'tests/test_notrun.py', name: 'test_shelf_never_run' },
  { criterion: 'A5', file: 'tests/test_notrun.py', name: 'test_shelf_imperative_xfail' }, { criterion: 'A6', file: 'tests/test_shelf.py', name: 'check_shelf_is_sorted' },
]
test('Bug 427: a named test pytest marks xfail reads "skipped" (it proves nothing), one that passed although marked (XPASS) "passed"', () => {
  const v = cap427('pytest-9.2.0-v'), rA = cap427('pytest-9.2.0-rA')
  assert.match(v, /::test_shelf_shows_covers XFAIL \(/); assert.match(v, /::test_shelf_sorts_books XPASS \(/); assert.match(rA, /^XFAIL at setup of tests\/test_notrun\.py::/m)
  // before: ['passed', 'not_run', 'not_run', 'not_run', 'not_run', 'not_run'] from both
  for (const out of [v, rA]) assert.deepEqual(states372(out, MAP427), ['passed', 'skipped', 'passed', 'skipped', 'skipped', 'not_run'])
  const told = unproven(MAP427.map((e, i) => ({ ...e, state: states372(v, MAP427)[i] })), 'pytest -v')
  assert.equal(told.length, 4); assert.match(told[0]!, /^A2: "test_shelf_shows_covers" in tests\/test_shelf\.py was skipped, so nothing proved A2\./)
  // a strict xpass fails the run, and its FAILED line (`[XPASS(strict)]` in the reason) is no pass; nor is unittest's unexpected success, which fails its run
  for (const out of [v, rA]) assert.equal(state(out, 'test_shelf_strict_xpass', 'tests/test_shelf.py'), 'not_run')
  const ut = cap427('unittest-3.14-v'); assert.match(ut, /\.\.\. expected failure$/m)
  assert.deepEqual(['test_lists_books', 'test_shows_covers', 'test_sorts_books'].map((n) => state(ut, n, 'test_ut.py')), ['passed', 'skipped', 'not_run'])
})
test('Bug 427, what the xfail words must not catch: in a test\'s name or in a reason, and a file\'s other tests', () => {
  assert.equal(state('tests/a.py::test_XFAIL_badge PASSED [ 50%]\n', 'test_XFAIL_badge', 'tests/a.py'), 'passed')
  const ok = 'tests/a.py::test_ok PASSED [ 50%]\n' // the run lists its tests by name
  assert.equal(state(`${ok}tests/a.py::test_badge_XPASS_x FAILED [ 50%]\n`, 'test_badge_XPASS_x', 'tests/a.py'), 'not_run')
  assert.equal(state(`${ok}FAILED tests/a.py::test_badge - [XPASS(strict)] why\n`, 'test_badge', 'tests/a.py'), 'not_run')
  assert.equal(state('test_x (a.T.test_x) ... ok\nprinted: an expected failure\n', 'test_x', 'a.py'), 'passed')
  // an xfail line names its test, so (as Bug 414's skip lines) it says nothing of the file's other tests: never ran, not "couldn't see it"
  assert.equal(state(cap427('pytest-9.2.0-rA'), 'check_shelf_is_sorted', 'tests/test_shelf.py'), 'not_run')
  assert.equal(state('tests/a.py::test_x XFAIL (why)\ntests/a.py::test_y PASSED\n', 'test_x', 'tests/a.py'), 'skipped')
})
