// Migration 38 (Bug 219; 37 is Bug 215): a clear under way keeps, in the DB, whether its TPM was running when it began, so a backend restart
// before the clear is done no longer ends with no TPM. A clear already under way at the migration: its TPM was on if it still runs
// or stopped after the clear began.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-migrate38-'))
const { migrate, run, q } = await import('./db.ts')

test('migration 38 marks a clear under way whose TPM was running when it began, and nothing else', () => {
  migrate(37)
  const repo = (id: string, clearing: number | null, tpm: string | null) =>
    run("INSERT INTO repos(id, name, path, kind, created_at, clearing_at, tpm_agent_id) VALUES (?, ?, ?, 'local', 1, ?, ?)", id, id, `/tmp/${id}`, clearing, tpm)
  const tpm = (id: string, repoId: string, status: string, ended: number | null) =>
    run("INSERT INTO agents(id, role, repo_id, model_alias, token_hash, status, started_at, ended_at) VALUES (?, 'tpm', ?, 'opus', 'x', ?, 1, ?)", id, repoId, status, ended)
  repo('writing', 100, 't1'); tpm('t1', 'writing', 'working', null) // still writing its note
  repo('noted', 100, 't2'); tpm('t2', 'noted', 'exited', 150) // wrote its note and stopped: the clear stopped it
  // what it must not mark: a TPM that had stopped before the clear, a clear with no TPM, a repo not being cleared
  repo('before', 100, 't3'); tpm('t3', 'before', 'exited', 50)
  repo('none', 100, null)
  repo('idle', null, 't4'); tpm('t4', 'idle', 'working', null)
  migrate()
  const rows = Object.fromEntries(q<{ id: string; clear_tpm_was_on: number | null }>('SELECT id, clear_tpm_was_on FROM repos').map((r) => [r.id, r.clear_tpm_was_on]))
  assert.deepEqual(rows, { writing: 1, noted: 1, before: null, none: null, idle: null })
})
