// Migration 36 (Bug 187; 35 is Bug 186): why HQ dropped a message unread, for rows dropped before HQ kept it, and the feature of HQ's notes to engineers
// (they went out with none, so Messages hid them with the engineer's box picked).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-migrate36-'))
const { migrate, run, q } = await import('./db.ts')

test('migration 36 says why old rows were dropped and gives HQ\'s notes to engineers their feature', () => {
  migrate(35)
  run("INSERT INTO agents(id, role, feature_id, model_alias, token_hash, started_at) VALUES ('e', 'engineer', 'f', 'opus', 'x', 1)")
  run("INSERT INTO agents(id, role, feature_id, model_alias, token_hash, started_at) VALUES ('tpm', 'tpm', NULL, 'opus', 'x', 1)")
  const msg = (id: string, from: string, to: string, reason: string, how: string | null, feature: string | null = null) =>
    run('INSERT INTO messages(id, feature_id, channel, from_id, to_id, reason, body, created_at, delivered_at, delivery_method) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, feature, 'dm', from, to, reason, 'b', 1, how ? 1 : null, how)
  msg('late', 'hq', 'e', 'test_cmd', 'dropped'); msg('stale', 'hq', 'e', 'fresh_start', 'dropped', 'f')
  msg('sent', 'hq', 'e', 'test_cmd', 'mod'); msg('fyi', 'hq', 'e', 'fyi', null)
  // what it must not touch: HQ's notes to a TPM (a project's, no feature), an agent's own message, a note that already has a feature
  msg('totpm', 'hq', 'tpm', 'fyi', null); msg('own', 'e', 'tpm', 'fyi', 'mod'); msg('other', 'hq', 'e', 'fyi', null, 'g')
  migrate()
  const rows = Object.fromEntries(q<{ id: string; feature_id: string | null; dropped_why: string | null }>('SELECT id, feature_id, dropped_why FROM messages')
    .map((r) => [r.id, `${r.feature_id}/${r.dropped_why}`]))
  assert.deepEqual(rows, { late: 'f/finished', stale: 'f/fresh_start_over', sent: 'f/null', fyi: 'f/null', totpm: 'null/null', own: 'null/null', other: 'g/null' })
})
