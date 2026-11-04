// Migration 18 (Bug 52, one TPM per project) on data from before it: agents, messages and asks get their repo, features their
// handles in creation order, ticket counting starts past every key already in the project, and open questions survive the
// rebuilt asks table (an open "Remove it" included).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-migrate18-'))
const { migrate, run, one, q } = await import('./db.ts')

test('migration 18 backfills repos, handles, ticket counters and keeps every ask', () => {
  migrate(17)
  const t = 1_000
  run("INSERT INTO repos(id, name, path, created_at) VALUES ('r1', 'demo', '/p', ?), ('r2', 'empty', '/e', ?)", t, t)
  const f = (id: string, at: number) => run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES (?, 'r1', ?, ?, 'x', 'planning', ?, ?)", id, id, id, at, at)
  f('fb', 20); f('fa', 10)
  for (const [id, fid, key] of [['t1', 'fa', 'AB-1'], ['t2', 'fa', 'T-03'], ['t3', 'fb', 'T-01'], ['t4', 'fb', 'XY-12x']]) {
    run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES (?,?,?,?,?,'queued',?,?)", id, fid, key, key, key, t, t)
  }
  run("INSERT INTO agents(id, role, feature_id, model_alias, token_hash, status, started_at) VALUES ('tpm-a', 'tpm', 'fa', 'opus', 'h', 'exited', ?), ('eng-b', 'engineer', 'fb', 'opus', 'h2', 'idle', ?)", t, t)
  run("INSERT INTO messages(id, feature_id, channel, from_id, to_id, reason, body, created_at) VALUES ('m1', 'fa', 'dm', 'user', 'tpm-a', 'fyi', 'hi', ?), ('m2', NULL, 'dm', 'eng-b', 'user', 'fyi', 'yo', ?)", t, t)
  run(`INSERT INTO asks(id, feature_id, agent_id, question, choices, created_at, answered_at, answer, action) VALUES
    ('a1', 'fa', 'tpm-a', 'Remove T-03?', '["Remove it","Keep it"]', ?, NULL, NULL, '{"kind":"cancel_ticket","ticket":"t2"}'),
    ('a2', 'fb', 'tpm-a', 'Dark?', '[]', ?, 5, 'yes', NULL)`, t, t)
  migrate()
  assert.deepEqual(q<{ id: string; handle: string }>('SELECT id, handle FROM features ORDER BY created_at').map((x) => [x.id, x.handle]), [['fa', 'F-1'], ['fb', 'F-2']])
  assert.deepEqual({ ...one<object>("SELECT next_feature, next_ticket, tpm_agent_id FROM repos WHERE id = 'r1'") }, { next_feature: 3, next_ticket: 13, tpm_agent_id: null }) // past XY-12x
  assert.deepEqual({ ...one<object>("SELECT next_feature, next_ticket FROM repos WHERE id = 'r2'") }, { next_feature: 1, next_ticket: 1 })
  assert.deepEqual(q<{ id: string; repo_id: string }>('SELECT id, repo_id FROM agents ORDER BY id').map((x) => [x.id, x.repo_id]), [['eng-b', 'r1'], ['tpm-a', 'r1']])
  assert.deepEqual(q<{ id: string; repo_id: string }>('SELECT id, repo_id FROM messages ORDER BY id').map((x) => [x.id, x.repo_id]), [['m1', 'r1'], ['m2', 'r1']])
  const asks = q<{ id: string; repo_id: string; feature_id: string; answered_at: number | null; action: string | null }>('SELECT * FROM asks ORDER BY id')
  assert.deepEqual(asks.map((a) => [a.id, a.repo_id, a.feature_id, a.answered_at, a.action]),
    [['a1', 'r1', 'fa', null, '{"kind":"cancel_ticket","ticket":"t2"}'], ['a2', 'r1', 'fb', 5, null]])
  assert.ok(one("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'asks_open'"))
  run("INSERT INTO asks(id, repo_id, agent_id, question, created_at) VALUES ('a3', 'r1', 'tpm-a', 'no feature', ?)", t) // a project TPM's ask has none
})
