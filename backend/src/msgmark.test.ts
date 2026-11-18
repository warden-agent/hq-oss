// Bug 187 (frontend/src/msgmark.ts): the mark after a message in Messages. A dropped or undelivered one must not look delivered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliveryMark } from '../../frontend/src/msgmark.ts'

const m = (o: Record<string, unknown>) => ({ to_id: 'eng-1', delivered_at: null, delivery_method: null, ack_at: null, dropped_why: null, ...o })

test('Bug 187: a dropped message has its own mark, and its hover says it was dropped and why', () => {
  const late = deliveryMark(m({ delivered_at: 5, delivery_method: 'dropped', dropped_why: 'finished' }))
  assert.equal(late.kind, 'dropped'); assert.notEqual(late.text, '·'); assert.match(late.title, /^Dropped: HQ never gave this to its agent\. Why: .*finished the ticket/)
  assert.match(deliveryMark(m({ delivered_at: 5, delivery_method: 'dropped', dropped_why: 'fresh_start_over' })).title, /fresh start it asked for was already over/)
  assert.equal(deliveryMark(m({ delivered_at: 5, delivery_method: 'dropped' })).title, 'Dropped: HQ never gave this to its agent.', 'no why recorded: none made up')
  const failed = deliveryMark(m({ delivered_at: 5, delivery_method: 'failed' }))
  assert.equal(failed.kind, 'failed'); assert.notEqual(failed.text, '·'); assert.match(failed.title, /stopped trying/)
})
test('Bug 187: what must NOT look dropped: delivered, read, waiting, shown to the user', () => {
  assert.deepEqual(['mod', 'tmux', 'stop_hook', 'typed'].map((how) => deliveryMark(m({ delivered_at: 5, delivery_method: how })).text), ['·', '·', '·', '·'])
  assert.equal(deliveryMark(m({ delivered_at: 5, delivery_method: 'mcp_read', ack_at: 5 })).text, '✓')
  assert.equal(deliveryMark(m({})).text, '⏳')
  assert.equal(deliveryMark(m({ to_id: 'user', delivered_at: 5, delivery_method: 'ui' })).title, 'Shown to you here')
})
