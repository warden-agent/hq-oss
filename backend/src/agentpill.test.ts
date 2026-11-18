// Bug 216: the Agents menu showed an engineer held at the plan gate as a raw `plan_review` pill over "Thinking" (its last activity line), while its box said
// "Plan R-1 waiting for you". The pill and the line under it come from the page's helpers (frontend/src/api.ts), checked here over a small state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentPill, liveActivity, menuActivity, planWait, type Agent, type State } from '../../frontend/src/api.ts'

type S = Pick<State, 'repos' | 'features' | 'tickets' | 'reviews'>
const state = (auto: boolean, reviews: any[] = []): S => ({ repos: [{ id: 'r1', auto_mode: auto ? 1 : 0 }], features: [{ id: 'f1', repo_id: 'r1' }],
  tickets: [{ id: 't1', feature_id: 'f1', key: 'T-1' }], reviews })
const eng = (status: string, more: Record<string, unknown> = {}): Agent => ({ id: 'e1', role: 'engineer', ticket_id: 't1', status, activity: 'Thinking', ...more })
const open = (round: number, plan_check: string | null = null) => ({ id: `R${round}`, ticket_id: 't1', round, status: 'open', plan_check })
const view = (a: Agent, s: S) => [agentPill(a, s), menuActivity(a, s), liveActivity(a)]

test('Bug 216: at the plan gate the pill and the line say whom the plan waits on, as its box does, and never "Thinking"', () => {
  assert.deepEqual(view(eng('plan_review'), state(false, [open(2)])), ['plan for you', 'Plan R-2 waiting for you', null])
  // on auto HQ's plan check answers it: waiting for the check, then reading it now
  assert.deepEqual(view(eng('plan_review'), state(true, [open(1)])), ['plan check', "its plan waits for HQ's check", null])
  const checking = planWait(state(true), 't1', open(1, JSON.stringify({ state: 'checking', since: 5 })))
  assert.deepEqual(checking, { text: 'HQ is checking its plan against its criteria', hq: true, since: 5 })
  assert.equal(menuActivity(eng('plan_review'), state(true, [open(1, JSON.stringify({ state: 'checking', since: 5 }))])), checking.text)
  // its review closed while its status hasn't caught up: it waits on nobody (Bug 234; plananswered.test.ts has the rest)
  assert.deepEqual(view(eng('plan_review'), state(false, [{ ...open(1), status: 'abandoned' }])), ['plan answered', 'its plan was answered · it carries on', null])
  // another ticket's open review isn't its plan
  assert.equal(menuActivity(eng('plan_review'), state(false, [{ ...open(3), ticket_id: 't9' }])), 'its plan was answered · it carries on')
})

test('Bug 216: no status pill prints a raw status word; what must not change: working, idle, paused, exited, and the activity line while working', () => {
  const s = state(false)
  const words = Object.fromEntries(['working', 'idle', 'plan_review', 'blocked', 'paused', 'launching', 'exited'].map((st) =>
    [st, agentPill(eng(st, st === 'blocked' ? { blocked_why: 'dialog' } : {}), s)]))
  assert.deepEqual(words, { working: 'working', idle: 'idle', plan_review: 'plan answered', blocked: 'on a dialog', paused: 'paused', launching: 'starting', exited: 'exited' })
  assert.equal(agentPill(eng('blocked', { blocked_why: 'api_error' }), s), 'API error')
  for (const w of Object.values(words)) assert.doesNotMatch(w, /_/)
  assert.deepEqual(view(eng('working'), s), ['working', 'Thinking', 'Thinking'])
  assert.deepEqual(view(eng('idle', { activity: 'Subagent: tests' }), s), ['idle', 'Subagent: tests', 'Subagent: tests'])
  assert.equal(menuActivity(eng('blocked', { blocked_why: 'dialog' }), s), 'waiting on a dialog in its terminal') // Bug 179 as it was
  assert.equal(menuActivity({ id: 't', role: 'tpm', status: 'working', activity: 'Thinking' }, s), 'Thinking') // no ticket: nothing to look up
})
