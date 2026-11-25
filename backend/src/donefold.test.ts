// Bug 164: a feature whose tickets have all merged folds into one "done" box (frontend/src/board.ts buildBoard); the user can open it
// to show its tickets again, each with a box that opens its Ticket tab, and fold it back (frontend/src/donefold.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
// The board measures its text on a canvas; with none it counts 7 px a character, which is enough to lay it out here.
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { buildBoard } = await import(BOARD) as { buildBoard: (s: any, now: number, repo?: any, opened?: ReadonlySet<string>) => any }

const state = (statuses: string[]): any => ({
  repos: [{ id: 'r1', name: 'garden', default_branch: 'main' }],
  features: [{ id: 'f1', repo_id: 'r1', title: 'Water the plants', status: 'planning', created_at: 1 },
    { id: 'f2', repo_id: 'r1', title: 'A chart of the week', status: 'planning', created_at: 2 }],
  tickets: [...statuses.map((status, i) => ({ id: `a${i}`, key: `T-0${i + 1}`, feature_id: 'f1', title: `Ticket ${i + 1}`, size: 'S', status, deps: '[]' })),
    { id: 'b0', key: 'T-09', feature_id: 'f2', title: 'Chart', size: 'S', status: 'implementing', deps: '[]' },
    { id: 'gone', key: 'T-08', feature_id: 'f1', title: 'Removed', size: 'S', status: 'cancelled', deps: '[]' }],
  agents: [], messages: [], reviews: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [],
})
const ids = (b: { nodes: { id: string }[] }) => b.nodes.map((n) => n.id).sort()
const feature = (b: any) => b.nodes.find((n: any) => n.id === 'f:f1').data.view

test('a done feature folds its tickets away: one box, no ticket boxes, left out of the view while other work goes', () => {
  const b = buildBoard(state(['merged', 'merged']), 0)
  assert.deepEqual(ids(b), ['f:f1', 'f:f2', 't:b0', 'tpm'])
  assert.equal(feature(b).done, true); assert.equal(feature(b).collapsed, true)
  assert.equal(feature(b).lines[0].text, '✓ done · all 2 merged')
  assert.deepEqual(b.fits, [['tpm', 'f:f1', 'f:f2', 't:b0'], ['tpm', 'f:f2', 't:b0'], ['f:f2', 't:b0']]) // the view's second try, the work going, leaves it out
  assert.equal(b.attNode({ ticket_id: 'a0' }), 'f:f1') // what's about a folded ticket lands on the done box
})

test('opened, it shows its merged tickets as one-row boxes, stays the done box, and stays in view', () => {
  const b = buildBoard(state(['merged', 'merged']), 0, undefined, new Set(['f1']))
  assert.deepEqual(ids(b), ['f:f1', 'f:f2', 't:a0', 't:a1', 't:b0', 'tpm']) // the removed ticket stays gone
  assert.equal(feature(b).done, true); assert.equal(feature(b).collapsed, false)
  assert.equal(feature(b).lines[0].text, '✓ done · all 2 merged')
  for (const id of ['t:a0', 't:a1']) assert.equal(b.nodes.find((n: any) => n.id === id)!.data.view.compact, true)
  // the view's tries (fit.ts): everything, which is now also "the TPM and the work going", then the opened feature with the TPM, then alone
  assert.deepEqual(b.fits, [['tpm', 'f:f1', 't:a0', 't:a1', 'f:f2', 't:b0'], ['tpm', 'f:f1', 't:a0', 't:a1'], ['f:f1', 't:a0', 't:a1']])
  assert.equal(b.attNode({ ticket_id: 'a0' }), 't:a0')
})

test('opening a feature that is not done changes nothing: its tickets show either way, and it is no done box', () => {
  const s = state(['merged', 'implementing'])
  const shut = buildBoard(s, 0), open = buildBoard(s, 0, undefined, new Set(['f1']))
  assert.deepEqual(ids(open), ids(shut)); assert.deepEqual(ids(open), ['f:f1', 'f:f2', 't:a0', 't:a1', 't:b0', 'tpm'])
  assert.equal(feature(open).done, false); assert.equal(feature(open).lines[0].text, '1/2 merged')
})

test('Bug 365: the view\'s last tries are the boxes waiting on the user in the feature that needs them, then the first of them', () => {
  const s = state(['implementing', 'plan_review', 'plan_review']); s.reviews = [{ id: 'R1', ticket_id: 'a1', status: 'open' }]
  const b = buildBoard(s, 0)
  assert.deepEqual(b.fits.slice(-2), [['f:f1', 't:a0', 't:a1', 't:a2'], ['t:a1']]) // T-03's status alone isn't a plan for you
  s.reviews.push({ id: 'R2', ticket_id: 'a2', status: 'open' })
  assert.deepEqual(buildBoard(s, 0).fits.slice(-3), [['f:f1', 't:a0', 't:a1', 't:a2'], ['t:a1', 't:a2'], ['t:a1']])
  assert.deepEqual(buildBoard(state(['implementing']), 0).fits.at(-1), ['f:f2', 't:b0']) // nothing waits: the newest feature, as before
})

test('Bug 365 follow-up: a plan waiting on the user comes before finished work to merge, whatever the board order', () => {
  const s = state(['pr_ready', 'pr_ready', 'pr_ready', 'plan_review']); s.reviews = [{ id: 'R1', ticket_id: 'a3', status: 'open' }]
  for (const t of s.tickets) if (t.status === 'pr_ready') t.pr_state = 'local'
  const b = buildBoard(s, 0)
  // everything, the feature, its four waiting boxes (the plan first), the plan alone: not T-01, the first to merge
  assert.deepEqual(b.fits.slice(-2), [['t:a3', 't:a0', 't:a1', 't:a2'], ['t:a3']])
  assert.deepEqual(b.holds, ['t:a3']) // the edge pills mark the plan, not the work to merge
  for (const t of s.tickets) if (t.status === 'plan_review') t.status = 'implementing'; s.reviews = []
  assert.deepEqual(buildBoard(s, 0).fits.slice(-2), [['t:a0', 't:a1', 't:a2'], ['t:a0']]) // only work to merge: board order, as before
  assert.deepEqual(buildBoard(s, 0).holds, [])
})
