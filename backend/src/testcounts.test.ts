// Bug 126 (testcounts.ts): the passed and skipped counts a merged ticket shows, read from the summary lines test runners print. The samples are real output, captured
// through runSandboxed (no terminal, CI=1) on 2026-11-16, with the machine's paths cut out. Anything not recognised gives null: the page then shows no counts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { countWords, shownLine, summaryLines, testCounts, took } from './testcounts.ts'

const read = (...chunks: string[]) => { const s = summaryLines(); chunks.forEach(s.take); return testCounts(s.lines()) }
const NODE = `> test\n> node --test\n\n✔ a (0.6ms)\n✔ b (0.04ms)\n﹣ c (0.05ms) # SKIP\n✔ d (0.03ms) # TODO\nℹ tests 4\nℹ suites 0\nℹ pass 2\nℹ fail 0
ℹ cancelled 0\nℹ skipped 1\nℹ todo 1\nℹ duration_ms 73.2755\n`
const SAMPLES: [string, string, { passed: number; failed: number; skipped: number; todo?: number } | null][] = [
  ['node --test', NODE, { passed: 2, failed: 0, skipped: 1, todo: 1 }],
  ['node --test, TAP', 'TAP version 13\nok 1 - a\n1..1\n# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n', { passed: 3, failed: 0, skipped: 0 }],
  ['pytest -q', '..s                                                                      [100%]\n2 passed, 1 skipped in 0.00s\n', { passed: 2, failed: 0, skipped: 1 }],
  ['pytest', 'collected 3 items\n\ntest_a.py ..s                                                            [100%]\n\n'
    + '========================= 2 passed, 1 skipped in 0.00s =========================\n',
    { passed: 2, failed: 0, skipped: 1 }],
  ['pytest with warnings and a clock', '=== 410 passed, 6 skipped, 3 deselected, 2 warnings in 81.20s (0:01:21) ===\n', { passed: 410, failed: 0, skipped: 6 }],
  ['unittest', '..s\n----------------------------------------------------------------------\nRan 3 tests in 0.000s\n\nOK (skipped=1)\n', { passed: 2, failed: 0, skipped: 1 }],
  ['unittest, no skips', 'Ran 12 tests in 0.4s\n\nOK\n', { passed: 12, failed: 0, skipped: 0 }],
  ['cargo, a crate and its doc tests', `running 3 tests\ntest more::ig ... ignored\ntest more::two ... ok\ntest tests::it_works ... ok\n
test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n   Doc-tests rs\n\nrunning 0 tests\n
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n`, { passed: 2, failed: 0, skipped: 1 }],
  ['jest', `PASS ./a.test.js\n  ✓ a\n  ✓ b (1 ms)\n  ○ skipped c\n\nTest Suites: 1 passed, 1 total\nTests:       1 skipped, 2 passed, 3 total\nSnapshots:   0 total\nTime:        0.202 s
Ran all test suites.\n`, { passed: 2, failed: 0, skipped: 1 }],
  ['vitest, in colour', `\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m1 passed\x1b[39m\x1b[22m\x1b[90m (1)\x1b[39m
\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m2 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m1 skipped\x1b[39m\x1b[90m (3)\x1b[39m\n`, { passed: 2, failed: 0, skipped: 1 }],
  ['mocha', '\n  ✔ a\n  ✔ b\n  - c\n\n  2 passing (3ms)\n  1 pending\n', { passed: 2, failed: 0, skipped: 1 }],
  ['go test prints no counts', 'ok  \texample.com/t\t0.114s\n', null],
  ['nothing a runner printed', 'built in 2s\nall good\n', null],
  ['empty', '', null],
]
for (const [name, out, want] of SAMPLES) {
  test(`Bug 126: counts from ${name}`, () => {
    assert.deepEqual(read(out), want)
    assert.deepEqual(read(...out.match(/[\s\S]{1,7}/g) ?? []), want, 'the same, in chunks that split lines')
  })
}
test('Bug 383: a line reads as a terminal shows it: what came after its last carriage return, so a summary drawn over a progress line still counts', () => {
  assert.equal(shownLine('has due_on: \r  ✔ has due_on: 0ms'), '  ✔ has due_on: 0ms') // mocha --reporter list, with no terminal
  assert.equal(shownLine('  4 passing (2ms)\r'), '  4 passing (2ms)'); assert.equal(shownLine('a\rb\rc\r\r'), 'c'); assert.equal(shownLine('plain'), 'plain')
  assert.deepEqual(read(' 3/4 tests\r  4 passing (2ms)\n  1 pending\n'), { passed: 4, failed: 0, skipped: 1 })
  assert.equal(read('  4 passing (2ms)\r  building…\n'), null) // drawn over: a terminal no longer shows it
  for (const [name, out, want] of SAMPLES) assert.deepEqual(read(out.replace(/\n/g, '\r\n')), want, `${name}, with Windows line ends`)
})
test('Bug 126: a chained command adds up every part, including the summaries long gone from the tail', () => {
  assert.deepEqual(read(NODE, 'x'.repeat(20_000) + '\n', NODE), { passed: 4, failed: 0, skipped: 2, todo: 2 })
  assert.deepEqual(read('3 passed in 0.1s\n', NODE), { passed: 5, failed: 0, skipped: 1, todo: 1 }, 'two kinds of runner')
})
test('Bug 126: what counts must NOT catch', () => {
  assert.equal(read('the test printed: 2 passed, 1 skipped\n'), null, 'pytest-like words with no "in Ns"')
  assert.equal(read('Ran 3 tests in 0.1s\n'), null, "unittest's Ran with no OK/FAILED after it")
  assert.equal(read('OK (skipped=1)\n'), null, 'an OK with no Ran before it')
  assert.equal(read('ℹ duration_ms 70\nℹ suites 2\nℹ tests 4\n'), null, "node's lines that aren't pass, fail or skipped")
  assert.equal(read('Tests: 3\n'), null, 'a Tests: line that is no summary')
  assert.equal(read(`  ${'2 passing'.padEnd(250, ' ')}x\n`), null, 'a line over 200 characters')
})
test('Bug 126: a run with more summaries than HQ keeps gets no counts rather than some of them', () => {
  assert.equal(read('3 passed in 0.1s\n'.repeat(401)), null)
  assert.deepEqual(read('3 passed in 0.1s\n'.repeat(400)), { passed: 1200, failed: 0, skipped: 0 })
})
test('Bug 126: counts and times in words', () => {
  assert.equal(countWords({ passed: 412, failed: 0, skipped: 6 }), '412 passed, 6 skipped')
  assert.equal(countWords({ passed: 3, failed: 0, skipped: 0 }), '3 passed', 'no "0 skipped"')
  assert.equal(countWords({ passed: 3, failed: 1, skipped: 0 }), '3 passed, 1 failed')
  assert.equal(countWords({ passed: 2, failed: 0, skipped: 1, todo: 1 }), '2 passed, 1 skipped, 1 todo', 'Bug 384')
  assert.equal(countWords({ passed: 3, failed: 0, skipped: 0, todo: 0 }), '3 passed', 'no "0 todo"')
  assert.deepEqual([0, 400, 8200, 60_000, 125_000].map(took), ['under 1 s', 'under 1 s', '8 s', '1 min', '2 min 5 s'])
})

// Bug 384: todo tests are a count of their own, as the runners print them (vitest `| 1 todo`, jest `1 todo`, node `ℹ todo 1`): a todo makes its file's
// named tests read "couldn't confirm it" (Bug 375), and the tests line read only "2 passed, 1 skipped", with no reason why. Real vitest 4.1.11 and jest 30
// output from a project with a passing test, an it.skip and an it.todo in one file (testdata/bug375, captured for Bug 375).
const cap375 = (name: string): string => readFileSync(new URL(`./testdata/bug375/${name}.txt`, import.meta.url), 'utf8')
for (const name of ['vitest-4.1.11-skip-todo', 'jest-30.1.3-skip-todo']) {
  test(`Bug 384: ${name} counts its todo test`, () => {
    const c = read(cap375(name))
    assert.deepEqual(c, { passed: 2, failed: 0, skipped: 1, todo: 1 })
    assert.equal(countWords(c!), '2 passed, 1 skipped, 1 todo')
  })
}
test('Bug 384: todo alone, and what todo must NOT catch', () => {
  assert.deepEqual(read(' Tests  3 passed | 1 todo (4)\n'), { passed: 3, failed: 0, skipped: 0, todo: 1 }, 'vitest, todo and no skips')
  assert.deepEqual(read('Tests:       1 todo, 3 passed, 4 total\n'), { passed: 3, failed: 0, skipped: 0, todo: 1 }, 'jest')
  assert.deepEqual(read('# tests 2\n# pass 2\n# todo 0\n'), { passed: 2, failed: 0, skipped: 0 }, 'TAP\'s "# todo 0" adds no todo field')
  assert.equal(read('ℹ todo 2\n')?.todo, 2, 'a run of nothing but todo tests still has counts')
  assert.equal(read('TODO: 3 tests\nwe have 1 todo left\n'), null, 'the word in other lines')
  assert.equal(read('  3 passing (2ms)\n  1 todo\n')?.todo, undefined, 'a line that only looks like mocha\'s')
})

// Bug 426: HQ goes by these counts when a test command exits 0 though a test failed (`mocha || true`: testrun.ts failedAnyway), so a failed count must be a
// real failure and nothing else. Real output (testdata/bug426, captured 2026-11-26 with CI=1, paths cut out) from one file of a passing test, a failing one
// (fixed in the -pass captures), a skipped one, and where the runner has them a todo and a test expected to fail: vitest's `1 expected fail`, jest's
// test.failing, pytest's xfail and xpass, unittest's expectedFailure, mocha's pending.
const cap426 = (name: string): string => readFileSync(new URL(`./testdata/bug426/${name}.txt`, import.meta.url), 'utf8')
const COUNTS_426: [string, { passed: number; failed: number; skipped: number; todo?: number }][] = [
  ['mocha-11.8.0-fail', { passed: 1, failed: 1, skipped: 1 }], ['mocha-11.8.0-pass', { passed: 2, failed: 0, skipped: 1 }],
  ['jest-30.1.2-fail', { passed: 2, failed: 1, skipped: 1, todo: 1 }], ['jest-30.1.2-pass', { passed: 3, failed: 0, skipped: 1, todo: 1 }],
  ['vitest-4.1.11-fail', { passed: 1, failed: 1, skipped: 1, todo: 1 }], ['vitest-4.1.11-pass', { passed: 2, failed: 0, skipped: 1, todo: 1 }],
  ['pytest-9.2.0-fail', { passed: 1, failed: 1, skipped: 1 }], ['pytest-9.2.0-pass', { passed: 2, failed: 0, skipped: 1 }],
  ['node-25.4.0-fail', { passed: 1, failed: 1, skipped: 1, todo: 1 }], ['node-25.4.0-pass', { passed: 2, failed: 0, skipped: 1, todo: 1 }],
  ['unittest-3.14-fail', { passed: 1, failed: 1, skipped: 1 }], ['unittest-3.14-pass', { passed: 2, failed: 0, skipped: 1 }],
]
for (const [name, want] of COUNTS_426) test(`Bug 426: ${name} has ${want.failed ? 'its failed test' : 'no failed test'} in its counts`, () => assert.deepEqual(read(cap426(name)), want))
test('Bug 426: vitest\'s two-word count (`1 expected fail`) no longer loses the whole line, and is neither a pass nor a failure', () => {
  assert.deepEqual(read(' Tests  2 passed | 1 expected fail | 1 skipped (4)\n'), { passed: 2, failed: 0, skipped: 1 })
  assert.deepEqual(read(' Tests  1 failed | 1 expected fail (2)\n'), { passed: 0, failed: 1, skipped: 0 })
  assert.equal(read(' Test Files  1 failed (1)\n'), null, 'the files line is not the tests line')
})
