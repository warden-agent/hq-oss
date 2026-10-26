// Input checks and state upkeep against a real SQLite DB in a temp HQ_HOME: which settings and verdicts the API takes, that a
// failed multi-row change leaves nothing behind, and that old events and usage samples are pruned (pinned events stay).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-hardening-'))
const { migrate, run, one, tx } = await import('./db.ts')
migrate()
const { validSetting, DEFAULTS } = await import('./config.ts')
const { VERDICTS } = await import('./gate.ts')
const { prune } = await import('./retention.ts')

test('settings: known keys with values of the right shape only', () => {
  assert.equal(validSetting('concurrency_cap', 3), null)
  assert.equal(validSetting('dm_per_peer_min', 0), null)
  assert.equal(validSetting('models', { ...DEFAULTS.models, tpm: 'sonnet' }), null)
  assert.equal(validSetting('paused_roles', ['engineer']), null)
  assert.match(validSetting('nope', 1)!, /unknown setting/)
  assert.match(validSetting('concurrency_cap', 0)!, /whole number of at least 1/)
  assert.match(validSetting('concurrency_cap', 2.5)!, /whole number/)
  assert.equal(validSetting('revision_cap', 3), null)
  assert.match(validSetting('revision_cap', 0)!, /whole number of at least 1/)
  assert.match(validSetting('gate_timeout_s', -1)!, /number of at least 0/)
  assert.match(validSetting('gate_timeout_s', '60')!, /number/)
  assert.match(validSetting('models', { tpm: 'opus' })!, /models\.architect/)
  assert.match(validSetting('models', { ...DEFAULTS.models, engineer_s: '' })!, /models\.engineer_s/)
  assert.match(validSetting('paused_roles', ['boss'])!, /paused_roles/)
})

test('verdicts: the six the gate handles', () => {
  assert.deepEqual([...VERDICTS].sort(), ['approve', 'approve_with_edits', 'escalate', 'revise', 'user_architect', 'user_engineer'])
})

test('tx: all of it or none of it', () => {
  run("INSERT INTO settings(key, value) VALUES ('a', '1')")
  assert.throws(() => tx(() => { run("UPDATE settings SET value = '2' WHERE key = 'a'"); throw new Error('half way') }), /half way/)
  assert.equal(one<{ value: string }>("SELECT value FROM settings WHERE key = 'a'")!.value, '1')
  assert.equal(tx(() => { run("UPDATE settings SET value = '3' WHERE key = 'a'"); return 'done' }), 'done')
  assert.equal(one<{ value: string }>("SELECT value FROM settings WHERE key = 'a'")!.value, '3')
  assert.equal(tx(() => tx(() => 'nested')), 'nested') // an inner tx joins the outer one
  assert.throws(() => tx((async () => {}) as unknown as () => void), /synchronous/)
})

test('retention: events past events_retention_days go (pinned ones stay); usage samples past 7 days go', () => {
  const day = 86_400_000, t = Date.now()
  const ev = (age: number, pinned = 0) => run("INSERT INTO events(agent_id, source, kind, payload, created_at, pinned) VALUES (NULL, 'system', 'x', '{}', ?, ?)", t - age, pinned)
  ev(31 * day); ev(31 * day, 1); ev(29 * day)
  const us = (age: number) => run('INSERT INTO usage_samples(agent_id, at) VALUES (?, ?)', 'a', t - age)
  us(8 * day); us(6 * day)
  const r = prune(t)
  assert.deepEqual(r, { events: 1, usage: 1 })
  assert.equal(one<{ c: number }>("SELECT COUNT(*) c FROM events WHERE kind = 'x'")!.c, 2)
  assert.equal(one<{ c: number }>('SELECT COUNT(*) c FROM usage_samples')!.c, 1)
})
