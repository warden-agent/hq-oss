// What auto mode tells the user about a failure: the line that names it, never a stack trace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-auto-unit-'))
const { failedLine } = await import('./auto.ts')

test('failedLine: names what failed in node, pytest and go output, and falls back on the last line', () => {
  assert.equal(failedLine("▶ list\n✖ shows who has the book (1.2ms)\n  AssertionError: 1 == 2\n    at Test.run (node:internal/test_runner/test:1095:25)\nℹ fail 1\n✖ failing tests:\n"),
    '✖ shows who has the book')
  assert.equal(failedLine('tests/test_a.py .F\n=== FAILURES ===\nE   assert 1 == 2\ntests/test_a.py:3: AssertionError\n1 failed in 0.1s'), 'E   assert 1 == 2')
  assert.equal(failedLine('--- FAIL: TestList (0.00s)\nFAIL\nexit status 1'), '--- FAIL: TestList (0.00s)')
  assert.equal(failedLine('something odd'), 'something odd'); assert.equal(failedLine(''), '')
})
