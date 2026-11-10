// Migration 22 (Bug 70): a run already under way when HQ is updated has no check on record, so it gets one. Nothing else changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-migrate22-'))
const { migrate, run, one } = await import('./db.ts')

test('migration 22 leaves existing runs with no check on record', () => {
  migrate(21); run("INSERT INTO auto_runs(id, repo_id, status, started_at) VALUES ('a', 'r', 'running', 1)"); migrate()
  const r = one<{ status: string; main_checked: string | null }>("SELECT status, main_checked FROM auto_runs WHERE id = 'a'")!
  assert.deepEqual([r.status, r.main_checked], ['running', null])
})
