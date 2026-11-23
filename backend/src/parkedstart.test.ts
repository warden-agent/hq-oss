// Bug 336: auto mode parks a ticket it can't get through and leaves it to the user (mover.ts). The user can start an engineer on it by hand (Launch,
// Resume, Your turn's Start, Fix tests or conflicts, the TPM's assign_ticket). Its box kept "parked: …" as its first line while that engineer worked,
// over what the engineer did. Now a working engineer's line comes first, as on any box, and the park under it; with no engineer at work it is as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts (as heldline.test.ts does).
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { buildBoard } = await import(BOARD) as { buildBoard: (s: any, now: number, repo?: any) => any }

const WHY = 'Its engineer stopped working on it (eng-0).'
const eng = (o: Record<string, unknown> = {}) => ({ id: 'eng-1', role: 'engineer', status: 'working', repo_id: 'r1', feature_id: 'f1', ticket_id: 't1', ...o })
const state = (t: Record<string, unknown>, o: Record<string, unknown> = {}): any => ({
  repos: [{ id: 'r1', name: 'b336', default_branch: 'main', auto_mode: 1, auto_stopped_why: null, clearing_at: null }],
  features: [{ id: 'f1', repo_id: 'r1', title: 'Notes page', status: 'planning', created_at: 1, merge_order: '[]' }],
  tickets: [{ id: 't1', key: 'T-01', feature_id: 'f1', title: 'A list', size: 'S', deps: '[]', go_ahead: 0, branch: 'hq/x/T-01', auto_parked_why: WHY,
    assignee_agent_id: 'eng-1', ...t }],
  agents: [eng()], messages: [], reviews: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [], ...o,
})
const view = (s: any) => buildBoard(s, 10, s.repos[0]).nodes.find((n: any) => n.id === 't:t1').data.view
const lines = (s: any) => view(s).lines.map((l: any) => l.text) as string[]
const parkedNote = { id: 'a1', kind: 'auto_parked', agent_id: null, ticket_id: 't1', detail: `T-01: ${WHY}`, created_at: 5 }

test('started by hand while parked: the engineer\'s line comes first and the park under it, in every way an engineer can be at work on it', () => {
  const cases: { name: string; t: Record<string, unknown>; o?: Record<string, unknown>; first: RegExp }[] = [
    { name: 'Launch / Start / assign_ticket: planning', t: { status: 'planning' }, o: { agents: [eng({ in_plan_mode: 1 })] }, first: /^engineer · planning/ },
    { name: 'Resume: building', t: { status: 'implementing' }, first: /^engineer · working/ },
    { name: 'its plan, which HQ checks', t: { status: 'plan_review' }, o: { agents: [eng({ status: 'plan_review' })],
      reviews: [{ id: 'R1', ticket_id: 't1', status: 'open', round: 1, plan_check: null }] }, first: /HQ's check/ },
    { name: 'Fix tests', t: { status: 'resolving', fixing: 'tests' }, first: /^its tests failed on main · its engineer is fixing them/ },
    { name: 'Fix conflicts', t: { status: 'resolving', fixing: null }, first: /^its engineer is merging main in/ },
  ]
  for (const c of cases) {
    const got = lines(state(c.t, { attention: [parkedNote], ...c.o }))
    assert.match(got[0] ?? '', c.first, `${c.name}: ${JSON.stringify(got)}`)
    assert.equal(got.filter((l) => l.includes(WHY)).length, 1, `${c.name}: the park is said once, not again as the notice: ${JSON.stringify(got)}`)
    assert.ok(got.includes(`parked by auto mode: ${WHY}`), `${c.name}: the park is still on the box: ${JSON.stringify(got)}`)
    const v = view(state(c.t, c.o))
    assert.ok(v.acts.some((a: any) => a.kind === 'auto-retry'), `${c.name}: Try again still hands it back to auto mode`)
  }
})

test('its engineer\'s own notice still shows under the park (it was hidden on a parked ticket)', () => {
  const stuck = { id: 'a2', kind: 'stuck', agent_id: 'eng-1', ticket_id: 't1', detail: 'eng-1 has shown no sign of life for 10 min', created_at: 6 }
  const got = lines(state({ status: 'implementing' }, { attention: [parkedNote, stuck] }))
  assert.ok(got.some((l) => /^⚠ .*no sign of life/.test(l)), JSON.stringify(got))
})

test('what it must not catch: a parked ticket with no engineer at work still leads with why it was parked', () => {
  const cases: { name: string; t: Record<string, unknown>; o?: Record<string, unknown> }[] = [
    { name: 'ready to start, nobody started it', t: { status: 'queued', assignee_agent_id: null, branch: null }, o: { agents: [] } },
    { name: 'its engineer stopped (Resume offered)', t: { status: 'implementing' }, o: { agents: [eng({ status: 'exited' })] } },
    { name: 'finished, its engineer on its way out', t: { status: 'pr_ready', pr_state: 'local' }, o: { agents: [eng({ status: 'idle' })] } },
    { name: 'PR open, its engineer still up', t: { status: 'pr_open', pr_state: 'open', pr_number: 7 }, o: { agents: [eng({ status: 'idle' })] } },
  ]
  for (const c of cases) {
    const got = lines(state(c.t, c.o))
    assert.equal(got[0], `parked: ${WHY}`, `${c.name}: ${JSON.stringify(got)}`)
    assert.ok(!got.some((l) => l.startsWith('parked by auto mode')), `${c.name}: said once`)
  }
  // and a ticket that isn't parked has no park line at all
  assert.ok(!lines(state({ status: 'implementing', auto_parked_why: null })).some((l) => /parked/.test(l)))
})
