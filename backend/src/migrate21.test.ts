// Migration 21 (auto mode repairs a broken main): the new columns arrive empty on rows already there, so nothing old looks like a repair.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-migrate21-'))
const { migrate, run, one } = await import('./db.ts')

test('migration 21 leaves existing tickets, runs and repos with nothing to repair and nothing waiting', () => {
  migrate(20)
  run("INSERT INTO repos(id, name, path, test_cmd, created_at) VALUES ('r', 'r', '/r', 'npm test', 1)")
  run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f', 'r', 's', 't', 'x', 'planning', 1, 1)")
  run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES ('t', 'f', 'T-01', 's', 't', 'queued', 1, 1)")
  run("INSERT INTO auto_runs(id, repo_id, started_at) VALUES ('a', 'r', 1)")
  migrate()
  assert.equal(one<{ repairs_main: string | null }>("SELECT repairs_main FROM tickets WHERE id = 't'")!.repairs_main, null)
  assert.equal(one<{ test_change: string | null }>("SELECT test_change FROM auto_runs WHERE id = 'a'")!.test_change, null)
  const r = one<{ test_cmd: string; test_cmd_proposed: string | null }>("SELECT test_cmd, test_cmd_proposed FROM repos WHERE id = 'r'")!
  assert.deepEqual([r.test_cmd, r.test_cmd_proposed], ['npm test', null])
})
