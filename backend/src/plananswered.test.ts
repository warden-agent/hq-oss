// Bug 234: an engineer still at the plan gate (its status `plan_review`) whose review has closed, say a plan sent back, until its next step moves its
// status on. Its ticket box read "engineer · waiting for your review", on auto too, where no person reviews plans; the Agents menu said "plan for you"
// (or "plan check"). Now both say what happened to the plan. What must not change: an open review still says whom it waits on, in both modes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { agentPill, menuActivity, planAnswered, shownStatus } from '../../frontend/src/api.ts'

register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { buildBoard } = await import(BOARD) as { buildBoard: (s: any, now: number, repo?: any) => any }

const review = (round: number, status: string, closed_reason: string | null = null) => ({ id: `R${round}`, ticket_id: 'a0', round, status, closed_reason, plan_check: null })
/** The engineer at the gate; its ticket's status as the backend leaves it (a plan sent back: planning). */
const state = (auto: boolean, reviews: any[], ticket = 'planning'): any => ({
  repos: [{ id: 'r1', name: 'garden', default_branch: 'main', auto_mode: auto ? 1 : 0 }],
  features: [{ id: 'f1', repo_id: 'r1', title: 'Water the plants', status: 'planning', created_at: 1 }],
  tickets: [{ id: 'a0', key: 'T-05', feature_id: 'f1', title: 'Reminders', size: 'S', status: ticket, deps: '[]' }],
  agents: [{ id: 'e1', role: 'engineer', display_name: 'eng-1', status: 'plan_review', ticket_id: 'a0', feature_id: 'f1', repo_id: 'r1', activity: 'Thinking' }],
  reviews, messages: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [],
})
const box = (s: any) => buildBoard(s, 10, s.repos[0]).nodes.find((n: any) => n.id === 't:a0').data.view
const seen = (s: any) => ({ box: box(s).lines[0].text, pill: agentPill(s.agents[0], s), menu: menuActivity(s.agents[0], s) })
const colour = (s: any) => [box(s).border, shownStatus(s.agents[0], s)] // the box's border and the pill's colour: amber at the gate means "for you"

test('Bug 234: a plan sent back, its engineer not yet moved on: nobody is asked to review it, on auto or in manual mode', () => {
  const sent = { box: 'engineer · its plan was sent back · it is revising it', pill: 'revising plan', menu: 'its plan was sent back · it is revising it' }
  for (const auto of [true, false]) {
    assert.deepEqual(seen(state(auto, [review(1, 'answered', 'revise')])), sent, `auto ${auto}`)
    assert.deepEqual(seen(state(auto, [review(2, 'answered', 'revise'), review(1, 'answered', 'revise')])), sent) // the newest round counts
    assert.deepEqual(box(state(auto, [review(1, 'answered', 'revise')])).acts.map((a: any) => a.kind), []) // no Read plan or Approve for a closed review
    assert.deepEqual(colour(state(auto, [review(1, 'answered', 'revise')])), ['#10b981', 'working']) // at work on the answer, as a working engineer
  }
  // the older round sent back, the newer closed some other way (ticket cancelled): no "revising"
  const other = seen(state(true, [review(1, 'answered', 'revise'), review(2, 'abandoned', 'cancelled')]))
  assert.deepEqual(other, { box: 'engineer · its plan was answered · it carries on', pill: 'plan answered', menu: 'its plan was answered · it carries on' })
  assert.deepEqual(planAnswered({ reviews: [] }, 'a0'), { text: 'its plan was answered · it carries on', pill: 'plan answered' }) // none on the page
  for (const s of [seen(state(true, [review(1, 'answered', 'revise')])), other]) assert.doesNotMatch(Object.values(s).join(' '), /your review|for you|HQ's check/)
})

test('what it must not catch: an open review says whom it waits on as before, in manual mode and on auto', () => {
  assert.deepEqual(seen(state(false, [review(1, 'open')], 'plan_review')), { box: 'Plan R-1 waiting for you', pill: 'plan for you', menu: 'Plan R-1 waiting for you' })
  assert.deepEqual(seen(state(true, [review(1, 'open')], 'plan_review')), { box: "its plan waits for HQ's check", pill: 'plan check', menu: "its plan waits for HQ's check" })
  assert.deepEqual(colour(state(false, [review(1, 'open')], 'plan_review')), ['#f59e0b', 'plan_review'])
  assert.deepEqual(colour(state(true, [review(1, 'open')], 'plan_review')), ['#f59e0b', 'plan_review'])
  // an open round after an older one sent back: the open one is what counts
  assert.equal(seen(state(false, [review(2, 'open'), review(1, 'answered', 'revise')], 'plan_review')).box, 'Plan R-2 waiting for you')
  const working = state(false, [review(1, 'answered', 'revise')]); working.agents[0].status = 'working' // moved on: its box says what it does
  assert.equal(box(working).lines[0].text, 'engineer · working')
})
