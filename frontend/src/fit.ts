// Where the board's view goes (Bug 119): on load, when boxes come or go, when the pane changes size, and on ⛶. Where a box's popover goes
// (Bug 120). Pure, so the backend's test runner unit-tests it (src/fit.test.ts).

/** A box on the board, in board coordinates (its position and its style size, which the layout sets exactly). */
export type Box = { id: string; x: number; y: number; w: number; h: number }
/** A ReactFlow viewport: the board point (0, 0) lands at (x, y) in the pane, scaled by `zoom`. */
export type View = { x: number; y: number; zoom: number }
/** Below this zoom a box's 10–12 px text is too small to read, so the view shows less instead of zooming out further. */
export const READABLE = 0.6
/** Room around the boxes, as ReactFlow's fitView `padding`: the boxes get 1/(1+PAD) of the pane each way. */
export const PAD = 0.15
/** A lone box stays its normal size. */
const MAX_ZOOM = 1

/** Where something sits on the board, in board coordinates. */
type Area = { x: number; y: number; w: number; h: number }
const bounds = (bs: Area[]): Area => {
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y))
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y }
}

/** How far, in pane pixels, a box the view is moved to show whole keeps from the board's edge. */
const EDGE = 8
/** Bug 258: a board pane narrower than this (820 px with the panel open, the narrowest of the 1440/1100/820 sweep; less with an app
 *  pane docked right or a smaller window) can't show a two-column feature at READABLE without cutting its far column. There the floor
 *  gives way in step with the pane, so what fits this wide fits in any narrower pane, just smaller (pinch or + zooms in to read). */
export const NARROW = 414
/** The board's own zoom limit (ReactFlow's minZoom): the floor never gives way below it. */
export const LOWEST = 0.25
/** The lowest zoom the view zooms out to in a `w` px wide pane: READABLE, less below NARROW px (Bug 258). */
export const floorAt = (w: number) => w >= NARROW ? READABLE : Math.max(LOWEST, (READABLE * (w - 2 * EDGE)) / (NARROW - 2 * EDGE))

/** A rectangle in pane pixels, edges as left, top, right, bottom. */
export type Rect = { l: number; t: number; r: number; u: number }
/** Bug 306: a set smaller than everything is tried at zooms this far apart, from its own down to the floor (floorAt). */
const ZOOM_STEP = 0.02

/** The view for a `w`×`h` pane. `sets` lists which boxes to show, widest first (everything, then less; buildBoard makes it).
 *  The first set that fits at a readable zoom (floorAt: READABLE, less in a pane under NARROW px) is shown whole and centred (with less
 *  room around it than PAD if that's what keeps it readable, down to EDGE). When none does, the last one is shown at that floor:
 *  centred along a side where it fits, else from its left or top edge (the rest is a pan away), never cut on both sides.
 *  Then (Bug 227) the view is moved, as little as it takes and never so far that the set stops being whole (or its start leaves
 *  the view), so that no box is cut by the board's edge: a box left out sits whole inside or wholly past the edge, a pan away.
 *  Bug 306: up and down, the set and the boxes in view sideways are centred together when they fit (not the set alone, which left a
 *  lone TPM low with the board's top half empty). A set smaller than everything is not shown bigger than it needs: of the zooms from
 *  its own down to the floor (READABLE from NARROW px up), the one that cuts the fewest boxes, then covers the fewest with `avoid`,
 *  then shows the most whole (ties: the biggest) wins, so the rest of the board shows around it as far as it can be read.
 *  Bug 307: `avoid` (the zoom buttons) is kept off the boxes where a move that cuts nothing can do it.
 *  `floor`: the lowest zoom it zooms out to (placeBoard lowers it when the buttons are crowded and CROWDED is 'zoom', Bug 344).
 *  Null while the pane has no size yet or no set names a box on the board. */
export function placeView(boxes: Box[], sets: string[][], w: number, h: number, avoid: Rect[] = [], floor = floorAt(w)): View | null {
  if (!(w > 0 && h > 0)) return null
  const byId = new Map(boxes.map((b) => [b.id, b])), room = { w: w / (1 + PAD), h: h / (1 + PAD) }
  let last: Area | null = null, view: View | null = null, part = false
  for (const set of sets) {
    const bs = set.flatMap((id) => byId.get(id) ?? []); if (!bs.length) continue
    last = bounds(bs); part = new Set(bs).size < boxes.length
    // The PAD margin, unless that makes it unreadable when a thinner one (EDGE) wouldn't (Bug 227: then the margin gives way, not the set)
    const zPad = Math.min(MAX_ZOOM, room.w / last.w, room.h / last.h), zEdge = Math.min(MAX_ZOOM, (w - 2 * EDGE) / last.w, (h - 2 * EDGE) / last.h)
    const zoom = Math.min(zEdge, Math.max(zPad, READABLE)) // in a narrow pane it can be under READABLE, down to the floor (Bug 258)
    if (zoom >= floor) { view = { x: w / 2 - (last.x + last.w / 2) * zoom, y: h / 2 - (last.y + last.h / 2) * zoom, zoom }; break }
  }
  if (!last) return null
  const b = last, centred = (z: number): View => ({ x: w / 2 - (b.x + b.w / 2) * z, y: h / 2 - (b.y + b.h / 2) * z, zoom: z })
  if (view) {
    if (!part || view.zoom <= floor) return settle(boxes, b, view, w, h, avoid, true)
    let best = settle(boxes, b, view, w, h, avoid, true), score = judge(boxes, best, w, h, avoid)
    for (let z = view.zoom - ZOOM_STEP; z > floor - ZOOM_STEP; z -= ZOOM_STEP) {
      const v = settle(boxes, b, centred(Math.max(z, floor)), w, h, avoid, true), s = judge(boxes, v, w, h, avoid)
      if (better(s, score)) { best = v; score = s }
    }
    return best
  }
  const z = floor
  const along = (pane: number, space: number, start: number, size: number) => // pane and space in pixels, start and size on the board
    size * z <= space ? pane / 2 - (start + size / 2) * z : (pane - space) / 2 - start * z // fits: centred; else its start edge at the margin
  return settle(boxes, b, { x: along(w, room.w, b.x, b.w), y: along(h, room.h, b.y, b.h), zoom: z }, w, h, avoid, false)
}
/** Whether score `s` beats `t`: the first item that differs is smaller. */
const better = (s: number[], t: number[]) => { for (let i = 0; i < s.length; i++) if (s[i] !== t[i]) return s[i]! < t[i]!; return false }
/** How a view does (Bug 306), smaller first: boxes cut at an edge, boxes under `avoid`, and boxes whole (as a negative). */
function judge(boxes: Box[], v: View, w: number, h: number, avoid: Rect[]): number[] {
  let cut = 0, under = 0, whole = 0
  for (const o of boxes) {
    const l = v.x + o.x * v.zoom, t = v.y + o.y * v.zoom, r = l + o.w * v.zoom, u = t + o.h * v.zoom
    if (r <= 0.5 || l >= w - 0.5 || u <= 0.5 || t >= h - 0.5) continue
    if (l < -0.5 || t < -0.5 || r > w + 0.5 || u > h + 0.5) cut++; else whole++
    if (avoid.some((a) => Math.min(r, a.r) - Math.max(l, a.l) > 0.5 && Math.min(u, a.u) - Math.max(t, a.t) > 0.5)) under++
  }
  return [cut, under, -whole]
}
/** Moves view `v` (Bug 227) so no box is cut by the board's edge, the set (bounds `b`) kept whole; `fits`: the set fits at this zoom,
 *  so up and down it is centred together with the boxes in view sideways where they fit (Bug 306). Each sideways place that keeps
 *  the set whole is tried with the best place up and down for it (a box cut sideways goes out of view up or down where it can), and
 *  the one judged best wins (ties: the nearest `v`), so a box cut sideways at one height doesn't hold back a move that shows more. */
function settle(boxes: Box[], b: Area, v: View, w: number, h: number, avoid: Rect[], fits: boolean): View {
  const z = v.zoom, e = EDGE, whole = b.w * z <= w - 2 * e + 0.01
  const ok = (p: number) => p === v.x || (whole ? p + b.x * z >= e - 0.01 && p + (b.x + b.w) * z <= w - e + 0.01
    : p + b.x * z >= e - 0.01 && p + b.x * z <= w / 2)
  const xs = [...new Set([v.x, ...boxes.flatMap((o) => [e - o.x * z, -(o.x + o.w) * z, w - e - (o.x + o.w) * z, w - o.x * z,
    ...avoid.flatMap((a) => [a.r - o.x * z, a.l - (o.x + o.w) * z])])].filter(ok))] // `avoid` has room to spare: boxes may touch it
  let best: View | null = null, score: number[] = []
  for (const x of xs) {
    const level = boxes.filter((o) => crosses(o.x, o.w, x, w, z)), all = bounds([...level, b])
    const y0 = fits && level.length && all.h * z <= h / (1 + PAD) ? h / 2 - (all.y + all.h / 2) * z : v.y
    // Where `avoid` covers each box level with it sideways (Bug 307), in pane pixels up and down
    const under = (o: Box) => avoid.filter((a) => Math.min(x + (o.x + o.w) * z, a.r) - Math.max(x + o.x * z, a.l) > 0.5).map((a) => [a.t, a.u] as const)
    const y = clear(y0, h, z, b.y, b.h, level.map((o) => [o.y, o.y + o.h, x + o.x * z < -0.5 || x + (o.x + o.w) * z > w + 0.5, under(o)] as const))
    const view = { x, y, zoom: z }, s = [...judge(boxes, view, w, h, avoid), Math.abs(x - v.x)]
    if (!best || better(s, score)) { best = view; score = s }
  }
  return best!
}
/** Whether a box from `start`, `size` long on the board, shows at all in a `pane` px long board placed at `at` px, at zoom `z`. */
const crosses = (start: number, size: number, at: number, pane: number, z: number) => at + (start + size) * z > 0.5 && at + start * z < pane - 0.5
/** One side of the view (Bug 227): where along it the board goes, in pane pixels, so that none of the boxes' `spans` (board units)
 *  is cut by either edge (a span marked cut on the other side counts as cut wherever it shows at all). `at` is the place picked
 *  for the set from `start`, `size` long. The set stays whole (if it fits; else its start stays in the first half of the view).
 *  Where every place cuts a box, the fewest cut at the start edge win, then at the far edge; then the place with the fewest boxes
 *  under `avoid` (each span's last item: where along this side it would be covered, Bug 307); then the place showing the most
 *  boxes whole; then the one nearest `at`. */
function clear(at: number, pane: number, z: number, start: number, size: number,
  spans: (readonly [number, number, boolean, (readonly [number, number])[]])[]): number {
  const e = EDGE, fits = size * z <= pane - 2 * e + 0.01 // a set zoomed to fit exactly (Bug 258) fits, float error or not
  const ok = (p: number) => p === at || (fits ? p + start * z >= e - 0.01 && p + (start + size) * z <= pane - e + 0.01
    : p + start * z >= e - 0.01 && p + start * z <= pane / 2)
  const tries = [at, ...spans.flatMap(([a, c,, hide]) => [e - a * z, -c * z, pane - e - c * z, pane - a * z,
    ...hide.flatMap(([lo, hi]) => [hi - a * z, lo - c * z])])].filter(ok)
  const score = (p: number) => {
    let head = 0, tail = 0, under = 0, whole = 0
    for (const [a, c, lost, hide] of spans) {
      const l = p + a * z, r = p + c * z
      const shows = r > 0.5 && l < pane - 0.5
      if (shows && hide.some(([lo, hi]) => Math.min(r, hi) - Math.max(l, lo) > 0.5)) under++
      if (lost) { if (shows) head++ } else if (shows && l < -0.5) head++; else if (shows && r > pane + 0.5) tail++; else if (shows) whole++
    }
    return [head, tail, under, -whole, Math.abs(p - at)]
  }
  let best = at, bestScore = score(at)
  for (const p of tries) { const s = score(p); if (better(s, bestScore)) { best = p; bestScore = s } }
  return best
}

/** Which of `boxes` a `w`×`h` pane shows whole through view `v` (Bug 306: a view that shows none is refitted after a Clear). */
export const wholeIn = (boxes: Box[], v: View, w: number, h: number): string[] => boxes.filter((b) => v.x + b.x * v.zoom >= -0.5
  && v.y + b.y * v.zoom >= -0.5 && v.x + (b.x + b.w) * v.zoom <= w + 0.5 && v.y + (b.y + b.h) * v.zoom <= h + 0.5).map((b) => b.id)

/** A corner of the board the zoom buttons can sit in (ReactFlow's panel positions), the usual one first (Bug 344). */
export type Corner = 'bottom-left' | 'bottom-right' | 'top-right' | 'top-left'
export const CORNERS: readonly Corner[] = ['bottom-left', 'bottom-right', 'top-right', 'top-left']
/** Bug 344 (the owner's call): what happens when every view placeView may pick leaves a box under the zoom buttons (the feature waiting on
 *  you fills a 414×390 px board at the floor: 820 px with the panel and the app pane open). 'move': the buttons go to the first other
 *  corner where the view placed for them covers no box and cuts no more; the text keeps its size. 'zoom': the buttons stay, and the
 *  view zooms out past the floor as far as it takes, at most CROWDED_GIVE. Where the buttons cover no box nothing changes either way. */
export const CROWDED: 'move' | 'zoom' = 'move'
/** How far under the floor 'zoom' may go (0.6 → 0.5: 10 px text drawn 5 px tall). */
export const CROWDED_GIVE = 0.1
/** The view (placeView's) and the corner for the zoom buttons (Bug 344). `buttons` is where they sit in a corner, in pane pixels. */
export function placeBoard(boxes: Box[], sets: string[][], w: number, h: number, buttons: (c: Corner) => Rect,
  crowded = CROWDED): { view: View; corner: Corner } | null {
  const usual = placeView(boxes, sets, w, h, [buttons(CORNERS[0]!)]); if (!usual) return null
  const [cut, under] = judge(boxes, usual, w, h, [buttons(CORNERS[0]!)])
  if (!under) return { view: usual, corner: CORNERS[0]! }
  const free = (v: View | null, c: Corner): v is View => !!v && ((s) => !s[1] && s[0]! <= cut!)(judge(boxes, v, w, h, [buttons(c)]))
  if (crowded === 'move') for (const corner of CORNERS.slice(1)) {
    const view = placeView(boxes, sets, w, h, [buttons(corner)]); if (free(view, corner)) return { view, corner }
  } else for (let f = floorAt(w) - ZOOM_STEP; f > floorAt(w) - CROWDED_GIVE - ZOOM_STEP && f >= LOWEST; f -= ZOOM_STEP) {
    const view = placeView(boxes, sets, w, h, [buttons(CORNERS[0]!)], Math.max(f, floorAt(w) - CROWDED_GIVE))
    if (free(view, CORNERS[0]!)) return { view, corner: CORNERS[0]! }
  }
  return { view: usual, corner: CORNERS[0]! } // nowhere clear: as before
}

/** A side of the board's view. */
export type Side = 'left' | 'right' | 'top' | 'bottom'
/** Bug 284: boxes wholly past one edge of the view (a finished feature the view left out by fitSets' rule, or anything panned away).
 *  `x`, `y`: the hint's top-left corner in the pane; `to`: the view that brings the nearest of them whole into view (at the left
 *  or right, with the boxes past that edge above and below it, as many as fit: Bug 306), moved on so no box is cut at an edge and
 *  zoomed out where that shows more (Bug 345: moveOn). Worked out when first read (a click), not on every pan. */
export type EdgeHint = { side: Side; ids: string[]; x: number; y: number; to: View }
/** The hint's size in pane pixels (a pill "‹ 3 more"), its gap from the board's edge and from boxes. */
export const HINT_W = 72, HINT_H = 22, HINT_GAP = 4
/** How far to move a pane-pixel span `lo`..`hi` so it sits whole inside a `pane` long side, EDGE from its ends (or its start at EDGE). */
const into = (lo: number, hi: number, pane: number) =>
  hi - lo > pane - 2 * EDGE || lo < EDGE ? EDGE - lo : hi > pane - EDGE ? pane - EDGE - hi : 0
/** The edge hints for a `w`×`h` pane showing `boxes` through view `v`: one per side that has boxes wholly past it. Each sits at its
 *  edge, level with the nearest of those boxes as far as it can, moved along the edge to keep clear of the boxes in view, of
 *  `avoid` (the zoom buttons) and of the hints already placed (where nothing is clear, covering the least of them). A box past a
 *  corner counts for the left or right side. */
export function edgeHints(boxes: Box[], v: View, w: number, h: number, avoid: Rect[] = []): EdgeHint[] {
  if (!(w > 0 && h > 0)) return []
  const z = v.zoom, on = boxes.map((b) => ({ id: b.id, l: v.x + b.x * z, t: v.y + b.y * z, r: v.x + (b.x + b.w) * z, u: v.y + (b.y + b.h) * z }))
  const sideOf = (s: Rect): Side | null => s.r <= 0.5 ? 'left' : s.l >= w - 0.5 ? 'right' : s.u <= 0.5 ? 'top' : s.t >= h - 0.5 ? 'bottom' : null
  const block: Rect[] = [...on.filter((s) => !sideOf(s)), ...avoid], hints: EdgeHint[] = []
  const g = HINT_GAP, across = (s: Side) => s === 'left' || s === 'right'
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const off = on.filter((s) => sideOf(s) === side); if (!off.length) continue
    const gap = (s: Rect) => side === 'left' ? -s.r : side === 'right' ? s.l - w : side === 'top' ? -s.u : s.t - h
    const near = off.reduce((a, b) => gap(b) < gap(a) ? b : a)
    const to = { x: v.x + into(near.l, near.r, w), y: v.y + into(near.t, near.u, h), zoom: z }
    if (across(side)) { // Bug 306: a feature brought in from the side comes with the boxes under it (its tickets) where that shows more
      const col = off.filter((s) => Math.min(s.r, near.r) - Math.max(s.l, near.l) > 0.5)
      const l = Math.min(...col.map((s) => s.l)), r = Math.max(...col.map((s) => s.r)), t = Math.min(...col.map((s) => s.t))
      const top = near.u - t <= h - 2 * EDGE ? t : near.t, bottom = Math.min(Math.max(...col.map((s) => s.u)), top + h - 2 * EDGE)
      const dx = r - l <= w - 2 * EDGE ? into(l, r, w) : into(near.l, near.r, w), dy = into(top, bottom, h)
      const shows = (x: number, y: number) => col.filter((s) => s.l + x >= -0.5 && s.r + x <= w + 0.5 && s.t + y >= -0.5 && s.u + y <= h + 0.5).length
      if (shows(dx, dy) > shows(to.x - v.x, to.y - v.y)) { to.x = v.x + dx; to.y = v.y + dy }
    }
    // Bug 345: then on until no box is cut at an edge, the boxes it brings in kept whole (worked out when a click reads it)
    const brings = off.filter((s) => s.l + to.x - v.x >= -0.5 && s.r + to.x - v.x <= w + 0.5 && s.t + to.y - v.y >= -0.5
      && s.u + to.y - v.y <= h + 0.5).map((s) => s.id), set = bounds(boxes.filter((b) => (brings.length ? brings : [near.id]).includes(b.id)))
    // Along the edge: the hint's start (top for left/right, left for top/bottom), its length, and the room it has
    const len = across(side) ? HINT_H : HINT_W, pane = across(side) ? h : w
    const fix = side === 'left' ? g : side === 'right' ? w - g - HINT_W : side === 'top' ? g : h - g - HINT_H
    const rect = (p: number): Rect => across(side) ? { l: fix, t: p, r: fix + HINT_W, u: p + len } : { l: p, t: fix, r: p + len, u: fix + HINT_H }
    const lo = g, hi = pane - g - len, clamp = (p: number) => Math.max(lo, Math.min(hi, p))
    const want = clamp((across(side) ? (near.t + near.u) / 2 : (near.l + near.r) / 2) - len / 2)
    const tries = [want, lo, hi, ...block.flatMap((b) => across(side) ? [b.t - g - len, b.u + g] : [b.l - g - len, b.r + g])]
      .filter((p) => p >= lo - 0.01 && p <= hi + 0.01)
    // No room clear of everything (a narrow pane, boxes cut along that edge): the place that covers the least of them
    const covered = (p: number) => block.reduce((s, b) => { const a = rect(p)
      return s + Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.u, b.u) - Math.max(a.t, b.t)) }, 0)
    const at = tries.map((p) => [covered(p), Math.abs(p - want), p] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0]?.[2] ?? want
    const r = rect(at)
    let done: View | null = null
    hints.push({ side, ids: off.map((s) => s.id), x: r.l, y: r.t, get to() { return done ??= moveOn(boxes, set, to, w, h, avoid) } }); block.push(r)
  }
  return hints
}

/** Bug 345: an edge hint's view `to` (it brings in the boxes within `b` whole) moved on so that no box is cut at the board's edge,
 *  by Bug 227's rule as on a load (settle), zoomed out where that shows more: of the zooms from `to`'s own down to the floor
 *  (floorAt; never in), the one that cuts the fewest boxes, then covers the fewest with `avoid`, then shows the most whole (ties:
 *  the biggest) wins, as for a set smaller than everything in placeView (Bug 306). At the same zoom, one feature brought in at
 *  820 px with the panel open often stood alone with half the board empty, its neighbour pushed past the edge so as not to be cut. */
function moveOn(boxes: Box[], b: Area, to: View, w: number, h: number, avoid: Rect[]): View {
  const z = to.zoom, floor = Math.min(z, floorAt(w)), cx = to.x + (b.x + b.w / 2) * z, cy = to.y + (b.y + b.h / 2) * z
  let best = settle(boxes, b, to, w, h, avoid, false), score = judge(boxes, best, w, h, avoid)
  for (let y = z - ZOOM_STEP; y > floor - ZOOM_STEP; y -= ZOOM_STEP) { // each zoom keeps the set's middle where `to` put it
    const q = Math.max(y, floor), v = settle(boxes, b, { x: cx - (b.x + b.w / 2) * q, y: cy - (b.y + b.h / 2) * q, zoom: q }, w, h, avoid, false)
    const s = judge(boxes, v, w, h, avoid); if (better(s, score)) { best = v; score = s }
  }
  return best
}

/** One feature's boxes on the board (its own and its tickets'), whether it's finished, and whether one of them waits on the user.
 *  `opened`: a finished feature the user opened to see its tickets (Bug 164); `done` is false for it, so it stays in the work in view.
 *  `working`: an engineer is on one of its tickets (Bug 306). */
export type Group = { ids: string[]; done: boolean; needsYou: boolean; opened?: boolean; working?: boolean }
/** Which boxes the view tries to show, widest first (placeView shows the first that is readable):
 *  1. everything: the TPM sits centred over all the branches, so the view keeps it in the middle (Bug 52);
 *  2. the TPM and the work still going on (finished features left out);
 *  3. the TPM and the feature that needs the user; 4. that feature alone. With no feature waiting on the user: the newest finished
 *     feature the user opened, else the TPM if its Your turn has something (`tpmTurn`), else the newest unfinished feature an
 *     engineer is on (Bug 306: not a newer one nothing happens on yet), else the newest unfinished feature.
 *     The same set twice is tried once. */
export function fitSets(all: string[], groups: Group[], tpmTurn: boolean): string[][] {
  const going = groups.filter((g) => !g.done), want = going.find((g) => g.needsYou) ?? going.filter((g) => g.opened).at(-1)
  const focus = want ? want.ids : tpmTurn || !going.length ? ['tpm'] : (going.filter((g) => g.working).at(-1) ?? going.at(-1)!).ids
  const sets = [all, ['tpm', ...going.flatMap((g) => g.ids)], [...new Set(['tpm', ...focus])], focus]
  return sets.filter((set, i) => sets.findIndex((o) => o.join(' ') === set.join(' ')) === i)
}

/** A popover keeps this much room from the board's edges, sits this far from its box, and opens above the box when there's less than
 *  POP_ROOM below it (and more above). It never gets shorter than POP_FLOOR: only a box panned off the board leaves less room. */
export const POP_EDGE = 8, POP_GAP = 10, POP_ROOM = 240, POP_FLOOR = 150
/** A popover's place in the pane: its left edge and either its top (below the box) or its bottom (`above`), its width and its
 *  height limit (the panel inside scrolls its body past that). */
export type PopPlace = { left: number; y: number; above: boolean; width: number; maxHeight: number }
/** Where a box's popover goes in a `w`×`h` pane (Bug 120: the visible board, which ends at the side panel). `box` is where the box is
 *  on screen, in pane pixels. The popover is as wide as it `want`s up to the pane less an edge each side, centred under the box and
 *  moved sideways to stay inside the pane. It opens below the box with the rest of the pane's height to grow in, or above when the
 *  room below is short and there's more above. */
export function placePop(box: { x: number; y: number; w: number; h: number }, want: number, w: number, h: number): PopPlace {
  const width = Math.max(0, Math.min(want, w - 2 * POP_EDGE))
  const left = Math.max(POP_EDGE, Math.min(box.x + box.w / 2 - width / 2, w - POP_EDGE - width))
  const below = h - (box.y + box.h + POP_GAP) - POP_EDGE, over = box.y - POP_GAP - POP_EDGE
  const above = below < POP_ROOM && over > below
  return { left, width, above, y: above ? box.y - POP_GAP : box.y + box.h + POP_GAP, maxHeight: Math.max(POP_FLOOR, above ? over : below) }
}
