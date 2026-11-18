// Bugs 197 and 220: on auto, a ticket's open plan is HQ's plan check's to answer, not the user's. The ticket box during a Clear (frontend/src/board.ts
// buildBoard) must not say the plan waits for HQ's check (the clear stopped it), and Clear's dialog and Fresh start (freshBlocker) must not say the plan
// waits for the user's review. In manual mode both keep their words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { planWaitsWhy } from './checks.ts'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
// The board measures its text on a canvas; with none it counts 7 px a character, which is enough to lay it out here.
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { buildBoard, freshBlocker } = await import(BOARD) as { buildBoard: (s: any, now: number, repo?: any) => any; freshBlocker: (a: any, s: any, clear?: boolean) => string | null }

const state = (o: { auto: boolean; clearing?: boolean; check?: object | null }): any => ({
  repos: [{ id: 'r1', name: 'garden', default_branch: 'main', auto_mode: o.auto ? 1 : 0, clearing_at: o.clearing ? 5 : null }],
  features: [{ id: 'f1', repo_id: 'r1', title: 'Water the plants', status: 'planning', created_at: 1 }],
  tickets: [{ id: 'a0', key: 'T-05', feature_id: 'f1', title: 'Reminders', size: 'S', status: 'plan_review', deps: '[]' }],
  agents: [{ id: 'e1', role: 'engineer', display_name: 'eng-1', status: 'plan_review', ticket_id: 'a0', feature_id: 'f1', repo_id: 'r1' }],
  reviews: [{ id: 'R1', ticket_id: 'a0', status: 'open', round: 1, plan_check: o.check === undefined ? null : o.check && JSON.stringify(o.check) }],
  messages: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [],
})
const box = (s: any) => buildBoard(s, 10, s.repos[0]).nodes.find((n: any) => n.id === 't:a0').data.view
const first = (s: any): string => box(s).lines[0].text

test('Bug 197: during a Clear on auto the ticket box says HQ won\'t check the plan, whether the check was stopped or not yet aborted', () => {
  assert.equal(first(state({ auto: true, clearing: true })), "HQ won't check its plan: the project is being cleared")
  assert.equal(first(state({ auto: true, clearing: true, check: { state: 'checking', since: 1 } })), "HQ won't check its plan: the project is being cleared")
  assert.deepEqual(box(state({ auto: true, clearing: true })).acts.map((a: any) => a.kind), ['read-plan']) // still opens the plan; no Approve HQ would race
})

test('what it must not catch: outside a Clear the box says what it said before', () => {
  assert.equal(first(state({ auto: true })), "its plan waits for HQ's check")
  assert.equal(first(state({ auto: true, check: { state: 'checking', since: 1 } })), 'HQ is checking its plan against its criteria')
  assert.equal(first(state({ auto: false })), 'Plan R-1 waiting for you')
})

test('Bug 231: during a Clear in manual mode the box says its plan stays unanswered and offers no Approve or auto mode (HQ refuses both); outside it, both are back', async () => {
  assert.equal(first(state({ auto: false, clearing: true })), 'its plan stays unanswered: the project is being cleared')
  const { ticketLabel } = await import(BOARD) as { ticketLabel: (t: any, hqPlan?: boolean, clearing?: boolean) => string }
  for (const auto of [false, true]) assert.equal(ticketLabel(state({ auto }).tickets[0], auto, true), 'plan unanswered') // not "plan for you" / "plan check"
  assert.equal(ticketLabel(state({ auto: false }).tickets[0]), 'plan for you'); assert.equal(box(state({ auto: false, clearing: true })).clearing, true)
  assert.deepEqual(box(state({ auto: false, clearing: true })).acts.map((a: any) => a.kind), ['read-plan'])
  assert.deepEqual(box(state({ auto: false })).acts.map((a: any) => a.kind), ['read-plan', 'approve', 'do-rest'])
})

test('Bug 220: on auto, Clear\'s dialog and Fresh start say the plan waits for HQ\'s plan check, not for the user', () => {
  const s = state({ auto: true }), e = s.agents[0]
  assert.equal(freshBlocker(e, s, true), "T-05's plan waits for HQ's plan check, which the clear stops.")
  assert.equal(freshBlocker(e, s), "T-05's plan waits for HQ's plan check.")
  const m = state({ auto: false }) // manual: the user answers it, as before
  assert.equal(freshBlocker(m.agents[0], m, true), "T-05's plan is waiting for your review. Answer it first.")
  assert.equal(freshBlocker(m.agents[0], m), "T-05's plan is waiting for your review. Answer it first.")
})

test('the backend gives the same words (freshstart.ts freshStartBlocker uses planWaitsWhy)', () => {
  assert.equal(planWaitsWhy('T-05', true), "T-05's plan waits for HQ's plan check.")
  assert.equal(planWaitsWhy('T-05', false), "T-05's plan is waiting for your review. Answer it first.")
})
