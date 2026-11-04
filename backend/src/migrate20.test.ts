// Migration 20 (Bug 53): the ticket counter starts past every key in the project, whatever the key looks like, and never goes down.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-migrate20-'))
const { migrate, run, one } = await import('./db.ts')

test('migration 20 counts past keys with no dash, and only raises the counter', () => {
  migrate(19)
  const t = 1_000
  for (const [id, next] of [['plain', 1], ['mixed', 1], ['ahead', 50], ['low', 2], ['empty', 1]] as const) {
    run('INSERT INTO repos(id, name, path, next_ticket, created_at) VALUES (?,?,?,?,?)', id, id, `/${id}`, next, t)
    run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES (?,?,?,?,'x','planning',?,?)", `f-${id}`, id, id, id, t, t)
  }
  const keys = { plain: ['T1', 'T2', 'T4'], mixed: ['AB-1', 'T-03', 'XY-12x'], ahead: ['T-03'], low: ['T9'] } as const
  for (const [repo, list] of Object.entries(keys)) for (const key of list) {
    run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES (?,?,?,?,?,'queued',?,?)", `${repo}-${key}`, `f-${repo}`, key, key, key, t, t)
  }
  migrate()
  const next = (id: string) => one<{ next_ticket: number }>('SELECT next_ticket FROM repos WHERE id = ?', id)!.next_ticket
  assert.deepEqual(['plain', 'mixed', 'ahead', 'low', 'empty'].map(next), [5, 13, 50, 10, 1])
})
