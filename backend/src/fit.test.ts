// Where the board's view goes (Bug 119, frontend/src/fit.ts): everything while it's readable, else less, and never cut on both sides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitSets, placeView, READABLE, type Box } from '../../frontend/src/fit.ts'

/** Which boxes a view shows whole in a w×h pane. */
const whole = (boxes: Box[], v: { x: number; y: number; zoom: number }, w: number, h: number) => boxes.filter((b) =>
  v.x + b.x * v.zoom >= -0.5 && v.y + b.y * v.zoom >= -0.5 && v.x + (b.x + b.w) * v.zoom <= w + 0.5 && v.y + (b.y + b.h) * v.zoom <= h + 0.5).map((b) => b.id)
/** Bug 119's board, as the page lays it out (bug119demo): the TPM on top, three finished features, then F-4 with four tickets in one column
 *  (one with a plan waiting) and two that wait on them in the next. */
const board = (): Box[] => [
  { id: 'tpm', x: 587, y: 0, w: 340, h: 158 },
  { id: 'f1', x: 0, y: 214, w: 220, h: 50 }, { id: 'f2', x: 292, y: 214, w: 220, h: 50 }, { id: 'f3', x: 584, y: 214, w: 220, h: 50 },
  { id: 'f4', x: 1005, y: 214, w: 380, h: 50 },
  ...[0, 1, 2].map((i) => ({ id: `t${i}`, x: 876, y: 320 + i * 130, w: 295, h: 114 })), { id: 't3', x: 876, y: 710, w: 295, h: 142 },
  { id: 't4', x: 1219, y: 320, w: 295, h: 82 }, { id: 't5', x: 1219, y: 418, w: 295, h: 82 },
]
const F4 = ['f4', 't0', 't1', 't2', 't3', 't4', 't5']
const groups = (needs = false) => [{ ids: ['f1'], done: true, needsYou: false }, { ids: ['f2'], done: true, needsYou: false },
  { ids: ['f3'], done: true, needsYou: false }, { ids: F4, done: false, needsYou: needs }]
const all = () => board().map((b) => b.id)

test('fitSets: everything, then the TPM and the work going on, then the TPM and the feature that needs you, then that feature', () => {
  assert.deepEqual(fitSets(all(), groups(true), false), [all(), ['tpm', ...F4], F4])
  const two = [{ ids: ['fa', 'ta'], done: false, needsYou: false }, { ids: ['fb', 'tb'], done: false, needsYou: true }, { ids: ['fc'], done: false, needsYou: false }]
  assert.deepEqual(fitSets(['tpm', 'fa', 'ta', 'fb', 'tb', 'fc'], two, true), [['tpm', 'fa', 'ta', 'fb', 'tb', 'fc'], ['tpm', 'fb', 'tb'], ['fb', 'tb']]) // the feature beats Your turn
})
test('fitSets: with nothing on a feature waiting for you, the TPM if Your turn has something, else the newest unfinished feature', () => {
  const two = [{ ids: ['fa', 'ta'], done: false, needsYou: false }, { ids: ['fb', 'tb'], done: false, needsYou: false }]
  assert.deepEqual(fitSets(['tpm', 'fa', 'ta', 'fb', 'tb'], two, true).at(-1), ['tpm'])
  assert.deepEqual(fitSets(['tpm', 'fa', 'ta', 'fb', 'tb'], two, false).slice(1), [['tpm', 'fb', 'tb'], ['fb', 'tb']])
  assert.deepEqual(fitSets(['tpm'], [], false), [['tpm']]) // an empty board: just the TPM, once
  assert.deepEqual(fitSets(['tpm', 'f1'], [{ ids: ['f1'], done: true, needsYou: false }], false), [['tpm', 'f1'], ['tpm']]) // all done
})

const at = (w: number, needs = true) => { const v = placeView(board(), fitSets(all(), groups(needs), false), w, 831)!; return { v, whole: whole(board(), v, w, 831) } }
test('the bug with the panel closed (1440 and 1100 px): every box whole at a readable zoom', () => {
  for (const w of [1440, 1100]) { const { v, whole } = at(w); assert.ok(v.zoom >= READABLE, `${w}: zoom ${v.zoom}`); assert.deepEqual(whole, all(), String(w)) }
})
test('the bug at 1440 px with the panel open (board 914 px): the TPM and F-4 whole, readable; the finished features may be cut', () => {
  const { v, whole } = at(914)
  assert.ok(v.zoom >= READABLE, `zoom ${v.zoom}`) // the old fit stopped at 0.7 and cut F-4's second column and the first feature
  for (const id of ['tpm', ...F4]) assert.ok(whole.includes(id), id)
})
test('the bug at 1100 and 820 px with the panel open (board 574 and 414 px): F-4 whole, the TPM left out', () => {
  for (const w of [574, 414]) {
    const { v, whole } = at(w)
    assert.ok(v.zoom >= READABLE, `${w}: zoom ${v.zoom}`)
    assert.deepEqual(whole.filter((id) => F4.includes(id)), F4, String(w))
  }
})
test('with nothing waiting on the user the newest unfinished feature is the one shown', () => {
  const { whole } = at(414, false)
  assert.deepEqual(whole.filter((id) => F4.includes(id)), F4)
})
test('nothing fits readably: the last set at READABLE from its left edge, centred up and down where it fits', () => {
  const wide: Box[] = [0, 1, 2, 3].map((i) => ({ id: `c${i}`, x: 1000 + i * 268, y: 500, w: 220, h: 100 }))
  const v = placeView(wide, [wide.map((b) => b.id)], 414, 830)!
  assert.equal(v.zoom, READABLE)
  const room = 414 / 1.15, left = v.x + 1000 * v.zoom
  assert.ok(Math.abs(left - (414 - room) / 2) < 0.01, `left edge at ${left}`) // the first column in view at the margin
  assert.ok(Math.abs(v.y + 550 * v.zoom - 415) < 0.01) // centred vertically
  assert.deepEqual(whole(wide, v, 414, 830), ['c0', 'c1'])
})
test('what it must not change: a lone box stays its normal size, centred; no pane size or no boxes gives no view', () => {
  const one: Box[] = [{ id: 'tpm', x: 0, y: 0, w: 340, h: 170 }]
  assert.deepEqual(placeView(one, [['tpm']], 900, 800), { x: 280, y: 315, zoom: 1 })
  assert.equal(placeView(one, [['tpm']], 0, 0), null)
  assert.equal(placeView(one, [['gone']], 900, 800), null)
  assert.deepEqual(placeView(one, [['gone', 'tpm']], 900, 800)?.zoom, 1) // a box not on the board yet is skipped
})
