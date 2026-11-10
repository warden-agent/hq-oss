// What auto mode tells the user about a failure: the line that names it, never a stack trace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-auto-unit-'))
const { autoRuns, failedLine } = await import('./auto.ts')
const { migrate, run } = await import('./db.ts'); migrate()

test('failedLine: names what failed in node, pytest and go output, and falls back on the last line', () => {
  assert.equal(failedLine("▶ list\n✖ shows who has the book (1.2ms)\n  AssertionError: 1 == 2\n    at Test.run (node:internal/test_runner/test:1095:25)\nℹ fail 1\n✖ failing tests:\n"),
    '✖ shows who has the book')
  assert.equal(failedLine('tests/test_a.py .F\n=== FAILURES ===\nE   assert 1 == 2\ntests/test_a.py:3: AssertionError\n1 failed in 0.1s'), 'E   assert 1 == 2')
  assert.equal(failedLine('--- FAIL: TestList (0.00s)\nFAIL\nexit status 1'), '--- FAIL: TestList (0.00s)')
  assert.equal(failedLine('something odd'), 'something odd'); assert.equal(failedLine(''), '')
})

test('Bug 63: every project keeps its newest runs, so a busy one can\'t push out a quiet one\'s last run', () => {
  run("INSERT INTO auto_runs(id, repo_id, status, started_at) VALUES ('quiet', 'r-quiet', 'finished', 1)")
  for (let i = 0; i < 30; i++) run("INSERT INTO auto_runs(id, repo_id, status, started_at) VALUES (?, 'r-busy', 'finished', ?)", `busy-${i}`, 100 + i)
  const runs = autoRuns(), busy = runs.filter((r) => r.repo_id === 'r-busy')
  assert.ok(runs.some((r) => r.id === 'quiet'))
  assert.equal(busy.length, 20); assert.equal(busy[0]!.id, 'busy-29') // the newest of them
  assert.deepEqual(runs.map((r) => r.started_at), runs.map((r) => r.started_at).sort((a, b) => b - a)) // newest first, as the UI and tests read it
})
