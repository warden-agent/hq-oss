// Bug 126 (testcounts.ts): the passed and skipped counts a merged ticket shows, read from the summary lines test runners print. The samples are real output, captured
// through runSandboxed (no terminal, CI=1) on 2026-11-16, with the machine's paths cut out. Anything not recognised gives null: the page then shows no counts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countWords, summaryLines, testCounts, took } from './testcounts.ts'

const read = (...chunks: string[]) => { const s = summaryLines(); chunks.forEach(s.take); return testCounts(s.lines()) }
const NODE = `> test\n> node --test\n\n✔ a (0.6ms)\n✔ b (0.04ms)\n﹣ c (0.05ms) # SKIP\n✔ d (0.03ms) # TODO\nℹ tests 4\nℹ suites 0\nℹ pass 2\nℹ fail 0
ℹ cancelled 0\nℹ skipped 1\nℹ todo 1\nℹ duration_ms 73.2755\n`
const SAMPLES: [string, string, { passed: number; failed: number; skipped: number } | null][] = [
  ['node --test', NODE, { passed: 2, failed: 0, skipped: 1 }],
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
test('Bug 126: a chained command adds up every part, including the summaries long gone from the tail', () => {
  assert.deepEqual(read(NODE, 'x'.repeat(20_000) + '\n', NODE), { passed: 4, failed: 0, skipped: 2 })
  assert.deepEqual(read('3 passed in 0.1s\n', NODE), { passed: 5, failed: 0, skipped: 1 }, 'two kinds of runner')
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
  assert.deepEqual([0, 400, 8200, 60_000, 125_000].map(took), ['under 1 s', 'under 1 s', '8 s', '1 min', '2 min 5 s'])
})
