// What a box says about messages that haven't reached its agent yet (frontend/src/api.ts waitingFor), and why they wait.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentWord, pausedBy, pauseStopped, rolePaused, waitingFor, waitLine, type Agent, type State } from '../../frontend/src/api.ts'

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
test('Bug 149: a half-written line in its prompt box holds the message, and the box says where to send or clear it', () => {
  const draft = 'held · a half-written line is in its terminal · send or clear it there'
  assert.deepEqual(waitingFor(agent({ status: 'working', interrupted_at: NOW - 5000, type_waits: 'draft' }), state(), NOW), { count: 1, held: true, why: draft })
  assert.equal(why(agent({ interrupted_at: NOW - 5000, type_waits: 'draft' })), draft)
  // what it must not catch: a reason left over from an interrupt that is over (the mod delivers then), a hold that comes first
  assert.equal(why(agent({ status: 'working', interrupted_at: null, type_waits: 'draft' })), 'waits for its current turn to end')
  assert.match(why(agent({ interrupted_at: NOW - 5000, type_waits: 'draft', takeover_locked_until: NOW + 60_000 }))!, /you typed in its terminal/)
})
test('Bug 370: a change to its spec goes in with the next step of a working agent; what else waits, when its turn ends', () => {
  const spec = { to_id: 'tpm-1', delivered_at: null, channel: 'dm', reason: 'spec_change' }, fyi = { to_id: 'tpm-1', delivered_at: null, channel: 'dm', reason: 'fyi' }
  assert.equal(why(agent({ status: 'working' }), state({ messages: [spec] })), 'goes in with its next step')
  assert.equal(why(agent({ status: 'plan_review' }), state({ messages: [spec, spec] })), 'goes in with its next step') // once its plan is answered
  assert.equal(why(agent({ status: 'working' }), state({ messages: [spec, fyi] })), '1 with its next step, the rest when its turn ends')
  // what it must not catch: an idle agent (the mod gives it at once), an ordinary note, a hold that comes first
  assert.equal(why(agent(), state({ messages: [spec] })), 'delivering…')
  assert.equal(why(agent({ status: 'working' }), state({ messages: [fyi] })), 'waits for its current turn to end')
  assert.equal(why(agent({ status: 'paused' }), state({ messages: [spec] })), 'held · paused')
})

test('Bug 195: a paused role: each of its boxes says who is paused and where Resume is, with messages waiting or not', () => {
  const on = state({ settings: { paused_roles: ['engineer'] } }), eng = (o: Record<string, unknown> = {}) => agent({ id: 'eng-1', role: 'engineer', ...o })
  const mine = { to_id: 'eng-1', delivered_at: null, channel: 'dm' }, line = 'engineers are paused · Resume is in the ⚠ menu'
  assert.deepEqual(waitingFor(eng(), { ...on, messages: [mine, mine] } as State, NOW), { count: 2, held: true, why: `held · ${line}` })
  assert.deepEqual(waitLine(eng(), { ...on, messages: [mine] } as State, NOW), { text: `✉ 1 waiting · held · ${line}`, held: true })
  // nothing waiting: the line is there all the same, working or stopped: it starts nothing until Resume
  for (const status of ['idle', 'working', 'blocked']) assert.deepEqual(waitLine(eng({ status }), { ...on, messages: [] } as State, NOW), { text: `⏸ ${line}`, held: true }, status)
  assert.equal(waitLine(agent({ role: 'tpm' }), state({ settings: { paused_roles: ['tpm'] }, messages: [] }), NOW)!.text, '⏸ TPMs are paused · Resume is in the ⚠ menu')
  // the one HQ stopped says so, not "interrupted" (that is a person's Escape); once resumed it is an interrupted turn like any other
  const stopped = eng({ interrupted_at: NOW - 5000, pause_stopped_at: NOW - 5000 })
  assert.equal(pauseStopped(stopped), true); assert.equal(agentWord(stopped), 'stopped by the pause')
  assert.equal(agentWord(eng({ interrupted_at: NOW - 5000, pause_stopped_at: null })), 'interrupted')
  assert.equal(agentWord(eng({ status: 'working', pause_stopped_at: NOW })), 'working') // refused a step, its turn not over yet
  // what it must not catch: another role, an ended agent, one writing its handoff note, a role that isn't paused, a hold that comes first
  const tpm = agent(), waits = state({ settings: { paused_roles: ['engineer'] } })
  assert.equal(rolePaused(tpm, waits), false); assert.equal(why(tpm, waits), 'delivering…'); assert.equal(waitLine(tpm, { ...waits, messages: [] } as State, NOW), null)
  assert.equal(waitLine(eng({ status: 'exited' }), { ...on, messages: [] } as State, NOW), null)
  assert.equal(waitLine(eng({ fresh_start_at: NOW - 1000 }), { ...on, messages: [] } as State, NOW), null)
  assert.equal(waitLine(eng(), state({ messages: [] }), NOW), null)
  assert.match(why(eng({ takeover_locked_until: NOW + 60_000 }), { ...on, messages: [mine] } as State)!, /you typed in its terminal/)
  assert.equal(why(eng({ status: 'paused' }), { ...on, messages: [mine] } as State), 'held · paused') // a usage pause is its own agent's
})

test('Bug 195: the notice of the switch carries Resume while its role is paused; resumed, or with its agent not on the page, it is a notice like any other', () => {
  const s = { agents: [{ id: 'eng-1', role: 'engineer', status: 'idle' }, { id: 'tpm-1', role: 'tpm', status: 'idle' }], settings: { paused_roles: ['engineer'] } } as never
  assert.equal(pausedBy({ kind: 'model_fallback', agent_id: 'eng-1' }, s), 'engineer')
  assert.equal(pausedBy({ kind: 'model_fallback', agent_id: 'tpm-1' }, s), null) // its role was resumed already, or never paused
  assert.equal(pausedBy({ kind: 'model_fallback', agent_id: 'eng-gone' }, s), null) // the ⚠ menu's own row has the Resume then (App.tsx Bell)
  assert.equal(pausedBy({ kind: 'model_mismatch', agent_id: 'eng-1' }, s), null); assert.equal(pausedBy({ kind: 'stuck', agent_id: 'eng-1' }, s), null)
  assert.equal(pausedBy({ kind: 'model_fallback', agent_id: 'eng-1' }, { agents: [{ id: 'eng-1', role: 'engineer', status: 'idle' }], settings: {} } as never), null)
})
