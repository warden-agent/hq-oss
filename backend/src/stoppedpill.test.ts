// Bug 437: while a ticket's engineer sat at its prompt after its turn was cut short (Escape in its terminal, Bug 148, or HQ's Escape for a pause, Bug 195),
// its box said "engineer · interrupted" but its pill still said "building" in green, its own pill said "idle", and the top bar counted it as busy.
// The words come from the page's helpers (frontend/src/board.ts, api.ts), checked here over a small state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { agentPill, agentWord, busyWords, type Agent } from '../../frontend/src/api.ts'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
// The board measures its text on a canvas; with none it counts 7 px a character, which is enough to lay it out here.
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { buildBoard, ticketLabel, ticketTone } = await import(BOARD) as { buildBoard: (s: any, now: number, repo?: any) => any
  ticketLabel: (t: any, hqPlan?: boolean, clearing?: boolean, back?: boolean, eng?: Agent | null) => string; ticketTone: (t: any, eng?: Agent | null) => string }

const eng = (status: string, more: Record<string, unknown> = {}): Agent => ({ id: 'e1', role: 'engineer', ticket_id: 't1', status, ...more })
const CUT = { interrupted_at: 5 }, PAUSED = { pause_stopped_at: 5 }
const tk = (status: string, more: Record<string, unknown> = {}) => ({ id: 't1', key: 'T-01', status, ...more })

test('Bug 437: the ticket pill says its engineer was interrupted or stopped by the pause, in its box\'s words, and is grey, not "building" green', () => {
  for (const status of ['planning', 'implementing', 'resolving']) {
    assert.equal(ticketLabel(tk(status), false, false, false, eng('idle', CUT)), 'interrupted', status)
    assert.equal(ticketLabel(tk(status), false, false, false, eng('idle', PAUSED)), 'stopped by the pause', status)
    assert.equal(ticketTone(tk(status), eng('idle', CUT)), 'idle', status)
  }
  assert.equal(ticketLabel(tk('resolving', { fixing: 'tests' }), false, false, false, eng('idle', CUT)), 'interrupted') // not "fixing tests"
  // both on record: the pause's words, as its box (agentWord) says
  assert.equal(ticketLabel(tk('implementing'), false, false, false, eng('idle', { ...CUT, ...PAUSED })), 'stopped by the pause')
  assert.equal(agentWord(eng('idle', { ...CUT, ...PAUSED })), 'stopped by the pause')
})

test('what it must not catch: an engineer at work, plainly idle or at a question, or a ticket past building, keeps its pill', () => {
  assert.equal(ticketLabel(tk('implementing'), false, false, false, eng('working')), 'building')
  assert.equal(ticketLabel(tk('implementing'), false, false, false, eng('working', CUT)), 'building') // a new turn started: interrupted_at is cleared at its end
  assert.equal(ticketLabel(tk('implementing'), false, false, false, eng('idle')), 'building')
  assert.equal(ticketLabel(tk('implementing')), 'building') // no engineer passed (older callers)
  assert.equal(ticketTone(tk('implementing'), eng('working')), 'implementing')
  assert.equal(ticketLabel(tk('awaiting_answer'), false, false, false, eng('idle', CUT)), 'has a question')
  assert.equal(ticketLabel(tk('pr_ready'), false, false, false, eng('idle', CUT)), 'ready to merge')
  assert.equal(ticketTone(tk('pr_ready'), eng('idle', CUT)), 'pr_ready')
  assert.equal(ticketLabel(tk('plan_review'), false, false, false, eng('plan_review', PAUSED)), 'plan for you')
})

test('Bug 437: the agent\'s own pill (Agents menu, its tab) says interrupted / stopped by the pause, not "idle"', () => {
  const s = { repos: [], features: [], tickets: [], reviews: [] }
  assert.equal(agentPill(eng('idle', CUT), s), 'interrupted')
  assert.equal(agentPill(eng('idle', PAUSED), s), 'stopped by the pause')
  assert.equal(agentPill(eng('idle'), s), 'idle')
  assert.equal(agentPill(eng('working', CUT), s), 'working')
  assert.equal(agentPill(eng('blocked', { ...CUT, blocked_why: 'api_error' }), s), 'API error')
})

test('Bug 437: the top bar\'s busy figure leaves out engineers interrupted or stopped by the pause and names them; they still hold their slots', () => {
  const tickets = ['t1', 't2', 't3', 't4'].map((id) => ({ id, status: id === 't4' ? 'pr_ready' : 'implementing' }))
  const agents = [eng('working', { id: 'a1', ticket_id: 't1' }), eng('idle', { id: 'a2', ticket_id: 't2', ...CUT }), eng('idle', { id: 'a3', ticket_id: 't3', ...PAUSED }),
    eng('idle', { id: 'a4', ticket_id: 't4', ...CUT }), // finished: no slot, so not named either
    { id: 'p', role: 'tpm', status: 'idle', interrupted_at: 5 }, eng('exited', { id: 'a5', ticket_id: 't1' })]
  const w = busyWords({ agents, tickets }, 3)
  assert.equal(w.text, '1/3 busy · 1 interrupted · 1 stopped by the pause')
  assert.match(w.tip, /^1 of 3 engineers is working\. 1 is interrupted .* 1 is stopped by the pause: Resume in the ⚠ menu .* They keep their places among the 3/)
  assert.deepEqual(busyWords({ agents: agents.slice(0, 2), tickets }, 2), { text: '1/2 busy · 1 interrupted',
    tip: '1 of 2 engineers is working. 1 is interrupted (Escape in its terminal): a message to it sets it going again. It keeps its place among the 2, so no other engineer starts in it.' })
  assert.equal(busyWords({ agents: [agents[1]!, eng('idle', { id: 'a6', ticket_id: 't3', ...CUT })], tickets }, 2).tip, '0 of 2 engineers are working. 2 are interrupted'
    + ' (Escape in their terminals): a message to one sets it going again. They keep their places among the 2, so no other engineer starts in them.')
  // what it must not change: with nobody stopped, the figure and its hover as before
  assert.deepEqual(busyWords({ agents: [agents[0]!], tickets }, 2), { text: '1/2 busy', tip: '1 of 2 engineers is working.' })
  assert.deepEqual(busyWords({ agents: [], tickets }, 2), { text: '0/2 busy', tip: '0 of 2 engineers are working.' })
})

test('Bug 437: the box is measured with the pill it shows (a longer word widens it instead of being cut)', () => {
  const s = (more: Record<string, unknown>): any => ({
    repos: [{ id: 'r1', name: 'garden', default_branch: 'main', auto_mode: 0 }],
    features: [{ id: 'f1', repo_id: 'r1', title: 'Water the plants', status: 'planning', created_at: 1 }],
    tickets: [{ id: 't1', key: 'GARDEN-REMINDERS-01', feature_id: 'f1', title: 'Reminders', size: 'S', status: 'implementing', deps: '[]', assignee_agent_id: 'e1' }],
    agents: [eng('idle', { feature_id: 'f1', repo_id: 'r1', display_name: 'eng-1', ...more })],
    reviews: [], messages: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [],
  })
  const box = (x: any) => buildBoard(x, 10, x.repos[0]).nodes.find((n: any) => n.id === 't:t1')
  const v = box(s(PAUSED)).data.view
  assert.equal(ticketLabel(v.t, v.hqPlan, v.clearing, v.back, v.eng), 'stopped by the pause')
  assert.equal(v.lines[0].text, 'engineer · stopped by the pause') // the box's own line said it already (Bug 195)
  assert.ok(box(s(PAUSED)).style.width > box(s({})).style.width) // a long key: the header sets the width
})
