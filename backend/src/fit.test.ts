// Where the board's view goes (Bug 119, frontend/src/fit.ts): everything while it's readable, else less, and never cut on both sides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitSets, floorAt, LOWEST, NARROW, placePop, placeView, POP_EDGE, POP_FLOOR, READABLE, type Box } from '../../frontend/src/fit.ts'

/** Which boxes a view shows whole in a w×h pane. */
const whole = (boxes: Box[], v: { x: number; y: number; zoom: number }, w: number, h: number) => boxes.filter((b) =>
  v.x + b.x * v.zoom >= -0.5 && v.y + b.y * v.zoom >= -0.5 && v.x + (b.x + b.w) * v.zoom <= w + 0.5 && v.y + (b.y + b.h) * v.zoom <= h + 0.5).map((b) => b.id)
/** Which boxes a view cuts at an edge of a w×h pane: partly in view, partly past the edge (Bug 227). */
const cut = (boxes: Box[], v: { x: number; y: number; zoom: number }, w: number, h: number) => boxes.filter((b) => {
  const l = v.x + b.x * v.zoom, r = v.x + (b.x + b.w) * v.zoom, t = v.y + b.y * v.zoom, u = v.y + (b.y + b.h) * v.zoom
  return r > 0.5 && l < w - 0.5 && u > 0.5 && t < h - 0.5 && !whole([b], v, w, h).length
}).map((b) => b.id)
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
test('fitSets (Bug 164): a finished feature the user opened is work in view, and the focus unless a feature needs the user', () => {
  const three = [{ ids: ['fa', 'ta'], done: false, needsYou: false, opened: true }, { ids: ['fb', 'tb'], done: false, needsYou: false }, { ids: ['fc'], done: true, needsYou: false }]
  const ids = ['tpm', 'fa', 'ta', 'fb', 'tb', 'fc']
  assert.deepEqual(fitSets(ids, three, true), [ids, ['tpm', 'fa', 'ta', 'fb', 'tb'], ['tpm', 'fa', 'ta'], ['fa', 'ta']]) // it beats Your turn and the newest feature
  three[1]!.needsYou = true
  assert.deepEqual(fitSets(ids, three, false).slice(2), [['tpm', 'fb', 'tb'], ['fb', 'tb']]) // a feature that needs the user beats it
})

const at = (w: number, needs = true) => { const v = placeView(board(), fitSets(all(), groups(needs), false), w, 831)!; return { v, whole: whole(board(), v, w, 831) } }
test('the bug with the panel closed (1440 and 1100 px): every box whole at a readable zoom', () => {
  for (const w of [1440, 1100]) { const { v, whole } = at(w); assert.ok(v.zoom >= READABLE, `${w}: zoom ${v.zoom}`); assert.deepEqual(whole, all(), String(w)) }
})
test('the bug at 1440 px with the panel open (board 914 px): the TPM and F-4 whole, readable; no finished feature cut (Bug 227)', () => {
  const { v, whole } = at(914)
  assert.ok(v.zoom >= READABLE, `zoom ${v.zoom}`) // the old fit stopped at 0.7 and cut F-4's second column and the first feature
  for (const id of ['tpm', ...F4]) assert.ok(whole.includes(id), id)
  assert.deepEqual(cut(board(), v, 914, 831), [])
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
test('nothing fits readably: the last set at READABLE, its first column in view, centred up and down where it fits', () => {
  const wide: Box[] = [0, 1, 2, 3].map((i) => ({ id: `c${i}`, x: 1000 + i * 268, y: 500, w: 220, h: 100 }))
  const v = placeView(wide, [wide.map((b) => b.id)], 414, 830)!
  assert.equal(v.zoom, READABLE)
  const room = 414 / 1.15, left = v.x + 1000 * v.zoom
  assert.ok(left >= (414 - room) / 2 - 0.01 && left <= 207, `left edge at ${left}`) // the first column starts in view, in its first half
  assert.ok(Math.abs(v.y + 550 * v.zoom - 415) < 0.01) // centred vertically
  assert.deepEqual(whole(wide, v, 414, 830), ['c0', 'c1'])
  assert.deepEqual(cut(wide, v, 414, 830), []) // Bug 227: the third column sits wholly past the right edge, a pan away, not half in
})
test('what it must not change: a lone box stays its normal size, centred; no pane size or no boxes gives no view', () => {
  const one: Box[] = [{ id: 'tpm', x: 0, y: 0, w: 340, h: 170 }]
  assert.deepEqual(placeView(one, [['tpm']], 900, 800), { x: 280, y: 315, zoom: 1 })
  assert.equal(placeView(one, [['tpm']], 0, 0), null)
  assert.equal(placeView(one, [['gone']], 900, 800), null)
  assert.deepEqual(placeView(one, [['gone', 'tpm']], 900, 800)?.zoom, 1) // a box not on the board yet is skipped
})

// Bug 227: a box the view leaves out sat half past the board's edge (a finished feature at 1100 px with the panel open, the TPM at 820).
/** The bug's board, as the page lays it out (bug227demo, step 3): two finished features, a third whose one ticket is ready to merge. */
const greet = (): Box[] => [{ id: 'tpm', x: 277, y: 0, w: 340, h: 158 }, { id: 'f1', x: 0, y: 214, w: 220, h: 66 },
  { id: 'f2', x: 292, y: 214, w: 220, h: 66 }, { id: 'f3', x: 611, y: 214, w: 256, h: 50 }, { id: 't3', x: 584, y: 336, w: 310, h: 152 }]
/** The shot's board (bug228-hqtesting-1100-board.png, read off it): the TPM box taller, the ticket narrower. */
const shot = (): Box[] => [{ id: 'tpm', x: 251, y: 0, w: 340, h: 172 }, { id: 'f1', x: 0, y: 214, w: 220, h: 66 },
  { id: 'f2', x: 292, y: 214, w: 220, h: 66 }, { id: 'f3', x: 584, y: 214, w: 256, h: 50 }, { id: 't3', x: 600, y: 336, w: 220, h: 124 }]
const greetSets = (bs: Box[]) => fitSets(bs.map((b) => b.id), [{ ids: ['f1'], done: true, needsYou: false },
  { ids: ['f2'], done: true, needsYou: false }, { ids: ['f3', 't3'], done: false, needsYou: true }], false)
test('Bug 227: no box cut at the board\'s edge at 1440/1100/820 px, panel open or closed; readable; the ticket waiting on you whole', () => {
  for (const bs of [greet(), shot()]) for (const [w, h] of [[914, 831], [574, 831], [414, 831], [1440, 831], [1100, 831], [820, 831], [574, 800], [300, 500]]) {
    const v = placeView(bs, greetSets(bs), w!, h!)!, at = `${bs[4]!.w} wide ticket, ${w}x${h}`
    assert.ok(v.zoom >= floorAt(w!), `${at}: zoom ${v.zoom}`) // READABLE from NARROW px up (Bug 258)
    assert.deepEqual(cut(bs, v, w!, h!), [], at)
    for (const id of ['f3', 't3']) assert.ok(whole(bs, v, w!, h!).includes(id), `${at}: ${id}`)
  }
})
test('Bug 227: every board width from 414 px (820 with the panel open) up, at several heights: readable, nothing cut, the work whole', () => {
  for (let w = 414; w <= 1500; w += 7) for (const h of [500, 650, 831, 900]) {
    for (const [bs, sets, keep] of [[board(), fitSets(all(), groups(true), false), F4], [greet(), greetSets(greet()), ['f3', 't3']],
      [shot(), greetSets(shot()), ['f3', 't3']]] as const) {
      const v = placeView(bs, sets, w, h)!, at = `${keep[0]} board, ${w}x${h}`
      assert.ok(v.zoom >= READABLE, `${at}: zoom ${v.zoom}`); assert.deepEqual(cut(bs, v, w, h), [], at)
      for (const id of keep) assert.ok(whole(bs, v, w, h).includes(id), `${at}: ${id}`)
    }
  }
})
test('Bug 227: the shot at 1100 px with the panel open (574 px) shows every box, the TPM centred over them (Bug 52)', () => {
  const bs = shot(), v = placeView(bs, greetSets(bs), 574, 800)!
  assert.deepEqual(whole(bs, v, 574, 800), bs.map((b) => b.id)) // the old fit showed the TPM and F-3 at zoom 0.85, F-1 half off the left
  assert.equal(v.zoom, READABLE) // with less room round it than PAD, so it stays readable
  const all = bs.reduce((m, b) => [Math.min(m[0]!, b.x), Math.max(m[1]!, b.x + b.w)], [Infinity, -Infinity])
  assert.ok(Math.abs(v.x + ((all[0]! + all[1]!) / 2) * v.zoom - 287) < 0.01) // centred
})
test('Bug 227: at 820 px with the panel open (414 px) the TPM is whole with the work, not cut at the left edge', () => {
  const bs = greet(), v = placeView(bs, greetSets(bs), 414, 831)!
  for (const id of ['tpm', 'f3', 't3']) assert.ok(whole(bs, v, 414, 831).includes(id), id)
})
test('Bug 227: a box left out that the view would cut is panned wholly out of view, the set kept whole, the move as small as it takes', () => {
  const bs: Box[] = [{ id: 'a', x: 0, y: 0, w: 360, h: 100 }, { id: 'b', x: 400, y: 0, w: 300, h: 100 }]
  const v = placeView(bs, [['a', 'b'], ['b']], 400, 300)! // a+b would need 0.55: b alone at zoom 1, centred at x 50, cuts a (10 px in view)
  assert.equal(v.zoom, 1); assert.deepEqual(cut(bs, v, 400, 300), []); assert.deepEqual(whole(bs, v, 400, 300), ['b'])
  assert.ok(Math.abs(v.x + 400 - 40) < 0.01, `b at ${v.x + 400}`) // moved left by 10 px, not more
})
test('Bug 227, what it must not change: everything that fits with PAD is centred as before; boxes level with nothing are not counted', () => {
  assert.deepEqual(placeView(greet(), greetSets(greet()), 1440, 831), placeViewOld(greet(), 1440, 831))
  const bs: Box[] = [{ id: 'a', x: 0, y: 0, w: 300, h: 100 }, { id: 'far', x: -150, y: 2000, w: 300, h: 100 }] // far below the view
  assert.deepEqual(placeView(bs, [['a', 'far'], ['a']], 400, 300), { x: 50, y: 100, zoom: 1 }) // centred, though far crosses the left edge's line
})
// Bug 258: under ~400 px (an app pane docked right, a small window) Bug 119's two-column F-4 couldn't fit at READABLE: its far
// column (or the feature box over both) was cut at the right edge.
test('Bug 258: every board width under NARROW, at several heights: nothing cut, the work whole, zoomed out no more than it takes', () => {
  for (let w = 180; w < NARROW; w += 3) for (const h of [500, 650, 831]) {
    for (const [bs, sets, keep] of [[board(), fitSets(all(), groups(true), false), F4], [greet(), greetSets(greet()), ['f3', 't3']],
      [shot(), greetSets(shot()), ['f3', 't3']]] as const) {
      const v = placeView(bs, sets, w, h)!, at = `${keep[0]} board, ${w}x${h}`
      assert.ok(v.zoom >= floorAt(w) && v.zoom >= LOWEST, `${at}: zoom ${v.zoom}`); assert.deepEqual(cut(bs, v, w, h), [], at)
      for (const id of keep) assert.ok(whole(bs, v, w, h).includes(id), `${at}: ${id}`)
      const shown = bs.filter((b) => whole([b], v, w, h).length), gap = Math.min(...shown.map((b) => v.x + b.x * v.zoom),
        ...shown.map((b) => w - v.x - (b.x + b.w) * v.zoom), ...shown.map((b) => v.y + b.y * v.zoom), ...shown.map((b) => h - v.y - (b.y + b.h) * v.zoom))
      assert.ok(v.zoom >= READABLE - 1e-9 || gap <= 8.01, `${at}: zoom ${v.zoom}, ${gap} px spare`) // under READABLE only to fit
    }
  }
})
test('Bug 258: the bug (F-4 in a 360 px pane) shows all of F-4; what fits at NARROW px fits narrower, just smaller', () => {
  const v = placeView(board(), fitSets(all(), groups(true), false), 360, 831)!
  assert.deepEqual(whole(board(), v, 360, 831).filter((id) => F4.includes(id)), F4); assert.deepEqual(cut(board(), v, 360, 831), [])
  assert.ok(v.zoom < READABLE && v.zoom > 0.5, `zoom ${v.zoom}`) // the old view: 0.6, F-4's box cut at 252..480 px
  assert.equal(floorAt(NARROW), READABLE); assert.equal(floorAt(1440), READABLE); assert.equal(floorAt(50), LOWEST)
})
test('Bug 258, what it must not change: from NARROW px up the floor is READABLE; a wide feature still starts at its left edge', () => {
  const wide: Box[] = [0, 1, 2, 3].map((i) => ({ id: `c${i}`, x: 1000 + i * 268, y: 500, w: 220, h: 100 }))
  for (const w of [NARROW, 500, 574]) assert.equal(placeView(wide, [wide.map((b) => b.id)], w, 830)!.zoom, READABLE)
  const v = placeView(wide, [wide.map((b) => b.id)], 300, 830)! // narrower: the floor gives way in step, so still its start edge
  assert.equal(v.zoom, floorAt(300)); assert.deepEqual(cut(wide, v, 300, 830), []); assert.ok(whole(wide, v, 300, 830).includes('c0'))
})
/** Bug 119's centred view of everything with PAD around it, which must not change when everything fits that way. */
function placeViewOld(bs: Box[], w: number, h: number) {
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y))
  const bw = Math.max(...bs.map((b) => b.x + b.w)) - x, bh = Math.max(...bs.map((b) => b.y + b.h)) - y
  const zoom = Math.min(1, w / 1.15 / bw, h / 1.15 / bh)
  return { x: w / 2 - (x + bw / 2) * zoom, y: h / 2 - (y + bh / 2) * zoom, zoom }
}

// A box's popover (Bug 120, placePop): inside the visible board, whatever the board's width and wherever the box is.
/** Whether a popover placed in a w×h pane, `height` tall at most, lies inside it. */
const inside = (p: ReturnType<typeof placePop>, w: number, h: number) => {
  const top = p.above ? p.y - p.maxHeight : p.y, bottom = p.above ? p.y : p.y + p.maxHeight
  return p.left >= POP_EDGE - 0.01 && p.left + p.width <= w - POP_EDGE + 0.01 && top >= POP_EDGE - 0.01 && bottom <= h - POP_EDGE + 0.01
}
test('the bug at 820 px with the panel open (board 414 px): the plan popover is narrowed to the board, not 520 px from -53 to 467', () => {
  const box = { x: 207 - 111, y: 129, w: 222, h: 107 } // Read plan centres the box and puts its top at 15% of an 860 px pane, zoom 0.75
  const p = placePop(box, 520, 414, 860)
  assert.deepEqual({ left: p.left, width: p.width, above: p.above }, { left: POP_EDGE, width: 414 - 2 * POP_EDGE, above: false })
  assert.equal(p.y, 129 + 107 + 10)
  assert.ok(inside(p, 414, 860)); assert.equal(p.y + p.maxHeight, 860 - POP_EDGE) // a taller body scrolls inside it: Approve stays on screen
})
test('at 1440 with Technical details open the height limit keeps Approve in the window', () => {
  const p = placePop({ x: 400, y: 129, w: 295, h: 142 }, 520, 914, 860)
  assert.equal(p.width, 520); assert.ok(inside(p, 914, 860))
  assert.ok(Math.abs(p.left + p.width / 2 - (400 + 147.5)) < 0.01) // centred under the box when it fits
})
test('a box near a side of the board: the popover moves sideways to stay inside, never past either edge', () => {
  for (const x of [-200, -40, 0, 30, 500, 800, 1000]) {
    const p = placePop({ x, y: 100, w: 295, h: 120 }, 520, 914, 860)
    assert.ok(inside(p, 914, 860), `box at ${x}: ${JSON.stringify(p)}`)
  }
})
test('a box low in the board: the popover opens above it, its bottom just over the box', () => {
  const p = placePop({ x: 300, y: 650, w: 295, h: 120 }, 520, 914, 860)
  assert.equal(p.above, true); assert.equal(p.y, 640); assert.ok(inside(p, 914, 860))
})
test('what it must not change: a narrow popover in a wide board keeps its width; room below keeps it below, even with more above', () => {
  const p = placePop({ x: 300, y: 300, w: 295, h: 120 }, 380, 1400, 860) // 422 px below, 282 above
  assert.deepEqual({ width: p.width, above: p.above }, { width: 380, above: false })
  const q = placePop({ x: 300, y: 450, w: 295, h: 120 }, 380, 1400, 860) // 272 px below, 432 above: still enough below
  assert.equal(q.above, false)
})
test('a box panned off the board still gets a popover tall enough to use, and a pane too narrow for any gives width 0', () => {
  assert.equal(placePop({ x: 100, y: 900, w: 200, h: 100 }, 520, 900, 860).maxHeight >= POP_FLOOR, true)
  assert.equal(placePop({ x: 0, y: 0, w: 10, h: 10 }, 520, 10, 860).width, 0)
})
