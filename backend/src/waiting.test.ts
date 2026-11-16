// What a box says about messages that haven't reached its agent yet (frontend/src/api.ts waitingFor), and why they wait.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitingFor, type Agent, type State } from '../../frontend/src/api.ts'

const NOW = 1_000_000
const agent = (o: Record<string, unknown> = {}): Agent => ({ id: 'tpm-1', role: 'tpm', status: 'idle', feature_id: null, ...o })
const state = (o: Partial<State> = {}): State => ({ messages: [{ to_id: 'tpm-1', delivered_at: null, channel: 'dm' }], settings: {}, ...o } as State)
const why = (a: Agent, s = state()) => waitingFor(a, s, NOW)?.why

test('nothing waiting, or an agent that has ended: no line', () => {
  assert.equal(waitingFor(agent(), state({ messages: [] }), NOW), null)
  assert.equal(waitingFor(agent({ status: 'exited' }), state(), NOW), null)
})
test('a hold says who holds it; otherwise the message is on its way or waits for the turn to end', () => {
  assert.match(why(agent({ takeover_locked_until: NOW + 60_000 }))!, /^held · you typed in its terminal · until /)
  assert.equal(why(agent({ takeover_locked_until: NOW + 365 * 86_400_000 })), 'held · open in another terminal')
  assert.equal(why(agent({ status: 'paused' })), 'held · paused')
  assert.equal(why(agent()), 'delivering…'); assert.equal(why(agent({ status: 'working' })), 'waits for its current turn to end')
})
test('Bug 110: after an interrupted turn HQ types the message, and the box says so when a menu or a question is in the way', () => {
  const menu = 'held · its terminal shows a menu or a question · answer or close it there'
  for (const type_waits of ['dialog', 'screen']) {
    const w = waitingFor(agent({ status: 'working', interrupted_at: NOW - 5000, type_waits }), state(), NOW)
    assert.deepEqual(w, { count: 1, held: true, why: menu })
  }
  // what it must not catch: a turn really at work, a reason left over from an interrupt that is over, a hold that comes first
  assert.equal(why(agent({ status: 'working', interrupted_at: NOW - 5000, type_waits: 'busy' })), 'waits for its current turn to end')
  assert.equal(why(agent({ status: 'working', interrupted_at: null, type_waits: 'screen' })), 'waits for its current turn to end')
  assert.match(why(agent({ interrupted_at: NOW - 5000, type_waits: 'screen', takeover_locked_until: NOW + 60_000 }))!, /you typed in its terminal/)
})
