// Migration 23 (Bug 84): what a ticket sent back to its engineer is fixing. One already resolving when HQ is updated was sent back
// for its conflicts (auto mode's tests went the same way, but HQ can't tell which now), so it reads as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-migrate23-'))
const { migrate, run, one } = await import('./db.ts')

test('migration 23 leaves a ticket already resolving with nothing recorded: conflicts, as before', () => {
  migrate(22)
  run("INSERT INTO repos(id, name, path, kind, default_branch, created_at) VALUES ('r', 'demo', '/tmp/x', 'local', 'main', 1)")
  run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f', 'r', 'f', 'F', 'x', 'planning', 1, 1)")
  run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES ('t', 'f', 'T-01', 't', 'T', 'resolving', 1, 1)"); migrate()
  assert.deepEqual({ ...one<{ status: string; fixing: string | null }>("SELECT status, fixing FROM tickets WHERE id = 't'") }, { status: 'resolving', fixing: null })
})
