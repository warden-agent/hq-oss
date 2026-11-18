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

const bounds = (bs: Box[]) => {
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

/** The view for a `w`×`h` pane. `sets` lists which boxes to show, widest first (everything, then less; buildBoard makes it).
 *  The first set that fits at a readable zoom (floorAt: READABLE, less in a pane under NARROW px) is shown whole and centred (with less
 *  room around it than PAD if that's what keeps it readable, down to EDGE). When none does, the last one is shown at that floor:
 *  centred along a side where it fits, else from its left or top edge (the rest is a pan away), never cut on both sides.
 *  Then (Bug 227) the view is moved, as little as it takes and never so far that the set stops being whole (or its start leaves
 *  the view), so that no box is cut by the board's edge: a box left out sits whole inside or wholly past the edge, a pan away.
 *  Null while the pane has no size yet or no set names a box on the board. */
export function placeView(boxes: Box[], sets: string[][], w: number, h: number): View | null {
  if (!(w > 0 && h > 0)) return null
  const byId = new Map(boxes.map((b) => [b.id, b])), room = { w: w / (1 + PAD), h: h / (1 + PAD) }, floor = floorAt(w)
  let last: ReturnType<typeof bounds> | null = null, view: View | null = null
  for (const set of sets) {
    const bs = set.flatMap((id) => byId.get(id) ?? []); if (!bs.length) continue
    last = bounds(bs)
    // The PAD margin, unless that makes it unreadable when a thinner one (EDGE) wouldn't (Bug 227: then the margin gives way, not the set)
    const zPad = Math.min(MAX_ZOOM, room.w / last.w, room.h / last.h), zEdge = Math.min(MAX_ZOOM, (w - 2 * EDGE) / last.w, (h - 2 * EDGE) / last.h)
    const zoom = Math.min(zEdge, Math.max(zPad, READABLE)) // in a narrow pane it can be under READABLE, down to the floor (Bug 258)
    if (zoom >= floor) { view = { x: w / 2 - (last.x + last.w / 2) * zoom, y: h / 2 - (last.y + last.h / 2) * zoom, zoom }; break }
  }
  if (!last) return null
  const z = view?.zoom ?? floor, b = last
  const along = (pane: number, space: number, start: number, size: number) => // pane and space in pixels, start and size on the board
    size * z <= space ? pane / 2 - (start + size / 2) * z : (pane - space) / 2 - start * z // fits: centred; else its start edge at the margin
  view ??= { x: along(w, room.w, b.x, b.w), y: along(h, room.h, b.y, b.h), zoom: z }
  // Left and right first, among the boxes level with the view; then up and down, among the boxes now in view sideways (one still cut
  // at the left or right edge is shown whole no matter how it sits up and down, so there it should go wholly out of view).
  const x = clear(view.x, w, z, b.x, b.w, boxes.filter((o) => crosses(o.y, o.h, view.y, h, z)).map((o) => [o.x, o.x + o.w, false] as const))
  const y = clear(view.y, h, z, b.y, b.h, boxes.filter((o) => crosses(o.x, o.w, x, w, z))
    .map((o) => [o.y, o.y + o.h, x + o.x * z < -0.5 || x + (o.x + o.w) * z > w + 0.5] as const))
  return { x, y, zoom: z }
}
/** Whether a box from `start`, `size` long on the board, shows at all in a `pane` px long board placed at `at` px, at zoom `z`. */
const crosses = (start: number, size: number, at: number, pane: number, z: number) => at + (start + size) * z > 0.5 && at + start * z < pane - 0.5
/** One side of the view (Bug 227): where along it the board goes, in pane pixels, so that none of the boxes' `spans` (board units)
 *  is cut by either edge (a span marked cut on the other side counts as cut wherever it shows at all). `at` is the place picked
 *  for the set from `start`, `size` long. The set stays whole (if it fits; else its start stays in the first half of the view).
 *  Where every place cuts a box, the fewest cut at the start edge win, then at the far edge; then the place showing the most
 *  boxes whole; then the one nearest `at`. */
function clear(at: number, pane: number, z: number, start: number, size: number, spans: (readonly [number, number, boolean])[]): number {
  const e = EDGE, fits = size * z <= pane - 2 * e + 0.01 // a set zoomed to fit exactly (Bug 258) fits, float error or not
  const ok = (p: number) => p === at || (fits ? p + start * z >= e - 0.01 && p + (start + size) * z <= pane - e + 0.01
    : p + start * z >= e - 0.01 && p + start * z <= pane / 2)
  const tries = [at, ...spans.flatMap(([a, c]) => [e - a * z, -c * z, pane - e - c * z, pane - a * z])].filter(ok)
  const score = (p: number) => {
    let head = 0, tail = 0, whole = 0
    for (const [a, c, lost] of spans) {
      const l = p + a * z, r = p + c * z
      const shows = r > 0.5 && l < pane - 0.5
      if (lost) { if (shows) head++ } else if (shows && l < -0.5) head++; else if (shows && r > pane + 0.5) tail++; else if (shows) whole++
    }
    return [head, tail, -whole, Math.abs(p - at)]
  }
  const better = (s: number[], t: number[]) => { for (let i = 0; i < s.length; i++) if (s[i] !== t[i]) return s[i]! < t[i]!; return false }
  let best = at, bestScore = score(at)
  for (const p of tries) { const s = score(p); if (better(s, bestScore)) { best = p; bestScore = s } }
  return best
}

/** One feature's boxes on the board (its own and its tickets'), whether it's finished, and whether one of them waits on the user.
 *  `opened`: a finished feature the user opened to see its tickets (Bug 164); `done` is false for it, so it stays in the work in view. */
export type Group = { ids: string[]; done: boolean; needsYou: boolean; opened?: boolean }
/** Which boxes the view tries to show, widest first (placeView shows the first that is readable):
 *  1. everything: the TPM sits centred over all the branches, so the view keeps it in the middle (Bug 52);
 *  2. the TPM and the work still going on (finished features left out);
 *  3. the TPM and the feature that needs the user; 4. that feature alone. With no feature waiting on the user: the newest finished
 *     feature the user opened, else the TPM if its Your turn has something (`tpmTurn`), else the newest unfinished feature.
 *     The same set twice is tried once. */
export function fitSets(all: string[], groups: Group[], tpmTurn: boolean): string[][] {
  const going = groups.filter((g) => !g.done), want = going.find((g) => g.needsYou) ?? going.filter((g) => g.opened).at(-1)
  const focus = want ? want.ids : tpmTurn || !going.length ? ['tpm'] : going.at(-1)!.ids
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
