// Bug 282: the cancel-feature dialog said "1 engineer stop". Its words and the remove-ticket dialog's (frontend/src/board.ts featureCancelText,
// removeText) are checked here with 0, 1 and 2 of each count, so a count and its noun and verb agree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// The frontend imports its own files without an extension (Vite finds them): the same here, for board.ts.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const BOARD: string = '../../frontend/src/board.ts' // a plain string: the backend's typecheck stays out of the frontend's files
const { featureCancelText, removeText } = await import(BOARD) as { featureCancelText: (v: any, s: any) => string
  removeText: (t: any, eng: any, waiting: string[]) => string }

const TAIL = "Merged work stays, and the project's TPM keeps going."
/** A feature with `open` unmerged tickets, the first `engs` of them with a live engineer, plus a merged ticket, a cancelled one and an exited engineer's. */
const words = (open: number, engs: number): string => {
  const tickets = [...Array.from({ length: open }, (_, i) => ({ id: `t${i}`, feature_id: 'f1', status: 'implementing', assignee_agent_id: i < engs ? `e${i}` : null })),
    { id: 'm', feature_id: 'f1', status: 'merged', assignee_agent_id: 'em' }, { id: 'c', feature_id: 'f1', status: 'cancelled', assignee_agent_id: 'ec' },
    { id: 'o', feature_id: 'f2', status: 'implementing', assignee_agent_id: 'eo' }]
  const agents = [...Array.from({ length: engs }, (_, i) => ({ id: `e${i}`, status: 'working' })), { id: 'em', status: 'working' }, { id: 'ec', status: 'working' },
    { id: 'eo', status: 'working' }]
  return featureCancelText({ f: { id: 'f1' } }, { tickets, agents })
}

test('Bug 282: cancelling a feature says "1 engineer stops" and "2 engineers stop"', () => {
  assert.equal(words(1, 1), `Its 1 unmerged ticket is cancelled and 1 engineer stops. ${TAIL}`)
  assert.equal(words(2, 1), `Its 2 unmerged tickets are cancelled and 1 engineer stops. ${TAIL}`)
  assert.equal(words(2, 2), `Its 2 unmerged tickets are cancelled and 2 engineers stop. ${TAIL}`)
})

test('Bug 282: no engineer running, or nothing left to cancel, names no count at all', () => {
  assert.equal(words(1, 0), `Its 1 unmerged ticket is cancelled. ${TAIL}`)
  assert.equal(words(2, 0), `Its 2 unmerged tickets are cancelled. ${TAIL}`)
  assert.equal(words(0, 0), TAIL)
})

test('Bug 282: an engineer that has exited is not counted as one that stops', () => {
  const s = { tickets: [{ id: 't0', feature_id: 'f1', status: 'implementing', assignee_agent_id: 'e0' }], agents: [{ id: 'e0', status: 'exited' }] }
  assert.equal(featureCancelText({ f: { id: 'f1' } }, s), `Its 1 unmerged ticket is cancelled. ${TAIL}`)
})

test("Bug 282, its neighbour: removing a ticket says who waits on it with 0, 1 and 2, and names its engineer only when there's one", () => {
  const t = { key: 'T-03', title: 'Reminders' }, eng = { id: 'e1', display_name: 'eng-1' }
  assert.equal(removeText(t, null, []), 'T-03 · Reminders. It leaves the board for good; its branch is kept.')
  assert.equal(removeText(t, eng, ['T-04']), 'T-03 · Reminders. Its engineer (eng-1) stops. It leaves the board for good; its branch is kept.'
    + ' T-04 waits on it: ask the TPM to rewire it.')
  assert.equal(removeText(t, eng, ['T-04', 'T-05']), 'T-03 · Reminders. Its engineer (eng-1) stops. It leaves the board for good; its branch is kept.'
    + ' T-04, T-05 wait on it: ask the TPM to rewire them.')
})
