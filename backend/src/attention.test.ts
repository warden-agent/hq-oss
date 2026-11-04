// Notices (Bug 40), against a real SQLite DB in a temp HQ_HOME: one open item per situation. A newer one with different words takes
// the old one's place, the same words again change nothing, `keep` leaves an open item alone, and a notice with no agent is one per
// ticket (one per kind with no ticket either).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-att-'))
const { migrate, q } = await import('./db.ts')
migrate()
const { attention, openAttention, resolveKind } = await import('./attention.ts')

const open = (kind: string) => openAttention().filter((a) => a.kind === kind)
const ids = (kind: string) => open(kind).map((a) => a.id).sort()
const events = (kind: string) => q<{ payload: string }>('SELECT payload FROM events WHERE kind = ? ORDER BY id', `attention.${kind}`).map((e) => JSON.parse(e.payload))
const resolvedAt = (id: string) => q<{ resolved_at: number | null }>('SELECT resolved_at FROM needs_attention WHERE id = ?', id)[0]!.resolved_at

test('a newer notice with different words takes the open one\'s place; the same words again change nothing', () => {
  const first = attention('blocked', 'eng: need a hand', { agentId: 'eng-1', ticketId: 't-1' })!
  assert.equal(attention('blocked', 'eng: need a hand', { agentId: 'eng-1', ticketId: 't-1' }), null)
  const second = attention('blocked', 'eng: need a key', { agentId: 'eng-1', ticketId: 't-1' })!
  assert.notEqual(second.id, first.id)
  assert.deepEqual(open('blocked').map((a) => [a.id, a.detail]), [[second.id, 'eng: need a key']])
  assert.ok(resolvedAt(first.id), 'the first notice is resolved')
  assert.deepEqual(events('blocked'), [{ detail: 'eng: need a hand' }, { detail: 'eng: need a key', replaced: [first.id] }])
  const other = attention('blocked', 'eng2: stuck on tests', { agentId: 'eng-2', ticketId: 't-2' })! // another agent: its own item
  assert.deepEqual(ids('blocked'), [other.id, second.id].sort())
})

test('once resolved, the same words are a new notice: it pops up again (Bug 61: a second run, a new message)', () => {
  const first = attention('auto_finished:r', 'demo: auto mode finished.')!
  resolveKind('auto_finished:r', null)
  const again = attention('auto_finished:r', 'demo: auto mode finished.')!
  assert.notEqual(again.id, first.id); assert.deepEqual(ids('auto_finished:r'), [again.id])
})

test('keep: an open notice stays as it is however its words change (stuck, context_high, rate_limit)', () => {
  const first = attention('stuck', 'eng: no events for 10 min', { agentId: 'eng-1', keep: true })!
  assert.equal(attention('stuck', 'eng: no events for 11 min', { agentId: 'eng-1', keep: true }), null)
  assert.deepEqual(open('stuck').map((a) => [a.id, a.detail]), [[first.id, 'eng: no events for 10 min']])
  assert.equal(events('stuck').length, 1)
  resolveKind('stuck', 'eng-1'); assert.deepEqual(open('stuck'), [])
  assert.ok(attention('stuck', 'eng: no events for 12 min', { agentId: 'eng-1', keep: true })) // nothing open: a new one is fine
})

test('with no agent, notices are one per ticket; with no ticket either, one per kind', () => {
  const a = attention('launch_failed', 'T-01 could not start: x', { ticketId: 't-1' })!
  const b = attention('launch_failed', 'T-02 could not start: y', { ticketId: 't-2' })!
  assert.deepEqual(ids('launch_failed'), [a.id, b.id].sort())
  const c = attention('launch_failed', 'T-01 could not start: z', { ticketId: 't-1' })! // takes a's place, leaves b
  assert.deepEqual(ids('launch_failed'), [b.id, c.id].sort()); assert.ok(resolvedAt(a.id))
  const s1 = attention('repo_sync:r1', 'demo: fetch failed')!, s2 = attention('repo_sync:r1', 'demo: no network')!
  assert.notEqual(s1.id, s2.id)
  assert.deepEqual(open('repo_sync:r1').map((x) => [x.id, x.detail]), [[s2.id, 'demo: no network']])
  resolveKind('repo_sync:r1', null); assert.deepEqual(open('repo_sync:r1'), [])
})
