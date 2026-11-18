// Bug 228: after somebody types in an agent's terminal, HQ holds what it sends that agent for a while (takeover_lock_s). Its box and the Agents menu
// (frontend/src/api.ts waitLine, board.ts note) say so while the hold lasts: with nothing waiting yet, beside a notice, and for the TPM's team messages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { nextHoldEnd, waitLine, waitingFor, type Agent, type State } from '../../frontend/src/api.ts'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts (as donefold.test.ts does).
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { buildBoard } = await import(BOARD) as { buildBoard: (s: any, now: number, repo?: any) => any }

const NOW = 1_000_000, HOLD = NOW + 60_000
const tpm = (o: Record<string, unknown> = {}): Agent => ({ id: 'tpm-1', role: 'tpm', status: 'idle', repo_id: 'r1', feature_id: null, ...o })
const eng = (o: Record<string, unknown> = {}): Agent => ({ id: 'eng-1', role: 'engineer', status: 'working', repo_id: 'r1', feature_id: 'f1', ticket_id: 't1', ...o })
const state = (o: Partial<State> = {}): State => ({
  repos: [{ id: 'r1', name: 'notes', default_branch: 'main', tpm_agent_id: 'tpm-1' }],
  features: [{ id: 'f1', repo_id: 'r1', title: 'Notes page', status: 'planning', created_at: 1 }],
  tickets: [{ id: 't1', key: 'T-01', feature_id: 'f1', title: 'A list', size: 'S', status: 'implementing', deps: '[]', assignee_agent_id: 'eng-1' }],
  agents: [tpm(), eng()], messages: [], reviews: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [], ...o,
} as State)
const dm = (to: string) => ({ id: `m-${to}`, channel: 'dm', to_id: to, from_id: 'hq', repo_id: 'r1', feature_id: 'f1', delivered_at: null, created_at: 5 })
const team = (o: Record<string, unknown> = {}) => ({ id: 'm-team', channel: 'team', to_id: null, from_id: 'eng-1', repo_id: 'r1', feature_id: 'f1', delivered_at: null, created_at: 5, ...o })
const lines = (s: State, node: string) => buildBoard(s, NOW, s.repos[0]).nodes.find((n: any) => n.id === node).data.view.lines.map((l: any) => l.text) as string[]

test('typed in its terminal, nothing waiting yet: the box and the menu say what HQ sends it next is held, and until when', () => {
  const s = state({ agents: [tpm({ takeover_locked_until: HOLD }), eng({ takeover_locked_until: HOLD })] })
  for (const a of s.agents) assert.match(waitLine(a, s, NOW)!.text, /^✉ messages held · you typed in its terminal · until \d/)
  assert.equal(waitLine(tpm({ takeover_locked_until: NOW + 365 * 86_400_000 }), s, NOW)!.text, '✉ messages held · open in another terminal')
  assert.ok(lines(s, 'tpm').some((l) => /^✉ messages held · you typed in its terminal/.test(l)), 'the TPM box says it')
  assert.ok(lines(s, 't:t1').some((l) => /^✉ messages held · you typed in its terminal/.test(l)), "the engineer's box says it")
  // what it must not catch: no hold, a hold that has ended, an agent that has ended
  const none = state()
  for (const a of none.agents) assert.equal(waitLine(a, none, NOW), null)
  assert.equal(waitLine(tpm({ takeover_locked_until: NOW - 1 }), none, NOW), null)
  assert.equal(waitLine(tpm({ takeover_locked_until: HOLD, status: 'exited' }), none, NOW), null)
  assert.deepEqual(lines(none, 'tpm'), ['idle'])
})
test('a message held: the count and why, as before', () => {
  const s = state({ agents: [tpm({ takeover_locked_until: HOLD }), eng()], messages: [dm('tpm-1')] })
  assert.match(waitLine(s.agents[0]!, s, NOW)!.text, /^✉ 1 waiting · held · you typed in its terminal · until /)
  assert.equal(waitLine(tpm(), state({ messages: [dm('tpm-1')] }), NOW)!.text, '✉ 1 waiting · delivering…')
})
test("the TPM hears its project's team messages, whatever the feature, and they show as waiting (they read as idle before)", () => {
  const s = state({ agents: [tpm({ takeover_locked_until: HOLD }), eng()], messages: [team()] })
  assert.equal(waitingFor(s.agents[0]!, s, NOW)!.count, 1)
  assert.ok(lines(s, 'tpm').some((l) => /^✉ 1 waiting · held/.test(l)))
  // what it must not catch: its own team message, another project's, an engineer on another feature; an engineer on that feature hears it
  assert.equal(waitingFor(tpm(), state({ messages: [team({ from_id: 'tpm-1' })] }), NOW), null)
  assert.equal(waitingFor(tpm(), state({ messages: [team({ repo_id: 'r2' })] }), NOW), null)
  assert.equal(waitingFor(eng({ id: 'eng-2', feature_id: 'f2' }), state({ messages: [team()] }), NOW), null)
  assert.equal(waitingFor(eng({ id: 'eng-2' }), state({ messages: [team()] }), NOW)!.count, 1)
})
test('a notice on the box keeps the held line under it; one waiting without a hold stays behind the notice, as before', () => {
  const att = [{ id: 'x1', kind: 'message_for_user', agent_id: 'tpm-1', ticket_id: null, detail: 'TPM: a question', created_at: 9 }]
  const held = lines(state({ agents: [tpm({ takeover_locked_until: HOLD }), eng()], messages: [dm('tpm-1')], attention: att }), 'tpm')
  assert.ok(held.some((l) => /^⚠ /.test(l)), 'the notice'); assert.ok(held.some((l) => /^✉ 1 waiting · held/.test(l)), 'and the hold')
  const open = lines(state({ messages: [dm('tpm-1')], attention: att }), 'tpm')
  assert.ok(open.some((l) => /^⚠ /.test(l))); assert.ok(!open.some((l) => /^✉/.test(l)))
})
test('the page looks again when the soonest timed hold ends; a terminal open elsewhere has no end to wait for', () => {
  assert.equal(nextHoldEnd([tpm({ takeover_locked_until: HOLD }), eng({ takeover_locked_until: NOW + 5000 })], NOW), NOW + 5000)
  assert.equal(nextHoldEnd([tpm({ takeover_locked_until: NOW + 365 * 86_400_000 }), eng({ takeover_locked_until: NOW - 1 })], NOW), null)
  assert.equal(nextHoldEnd([tpm({ takeover_locked_until: HOLD, status: 'exited' })], NOW), null)
  assert.equal(nextHoldEnd([], NOW), null)
})
