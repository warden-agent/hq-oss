// Where the board's view goes (Bug 119): on load, when boxes come or go, when the pane changes size, and on ⛶. Pure, so the
// backend's test runner unit-tests it (src/fit.test.ts).

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

/** The view for a `w`×`h` pane. `sets` lists which boxes to show, widest first (everything, then less; buildBoard makes it).
 *  The first set that fits at a readable zoom is shown whole and centred. When none does, the last one is shown at READABLE:
 *  centred along a side where it fits, else from its left or top edge (the rest is a pan away), never cut on both sides.
 *  Null while the pane has no size yet or no set names a box on the board. */
export function placeView(boxes: Box[], sets: string[][], w: number, h: number): View | null {
  if (!(w > 0 && h > 0)) return null
  const byId = new Map(boxes.map((b) => [b.id, b])), room = { w: w / (1 + PAD), h: h / (1 + PAD) }
  let last: ReturnType<typeof bounds> | null = null
  for (const set of sets) {
    const bs = set.flatMap((id) => byId.get(id) ?? []); if (!bs.length) continue
    last = bounds(bs)
    const zoom = Math.min(MAX_ZOOM, room.w / last.w, room.h / last.h)
    if (zoom >= READABLE) return { x: w / 2 - (last.x + last.w / 2) * zoom, y: h / 2 - (last.y + last.h / 2) * zoom, zoom }
  }
  if (!last) return null
  const z = READABLE, b = last
  const along = (pane: number, space: number, start: number, size: number) => // pane and space in pixels, start and size on the board
    size * z <= space ? pane / 2 - (start + size / 2) * z : (pane - space) / 2 - start * z // fits: centred; else its start edge at the margin
  return { x: along(w, room.w, b.x, b.w), y: along(h, room.h, b.y, b.h), zoom: z }
}

/** One feature's boxes on the board (its own and its tickets'), whether it's finished, and whether one of them waits on the user. */
export type Group = { ids: string[]; done: boolean; needsYou: boolean }
/** Which boxes the view tries to show, widest first (placeView shows the first that is readable):
 *  1. everything: the TPM sits centred over all the branches, so the view keeps it in the middle (Bug 52);
 *  2. the TPM and the work still going on (finished features left out);
 *  3. the TPM and the feature that needs the user; 4. that feature alone. With no feature waiting on the user: the TPM if its
 *     Your turn has something (`tpmTurn`), else the newest unfinished feature. The same set twice is tried once. */
export function fitSets(all: string[], groups: Group[], tpmTurn: boolean): string[][] {
  const going = groups.filter((g) => !g.done), want = going.find((g) => g.needsYou)
  const focus = want ? want.ids : tpmTurn || !going.length ? ['tpm'] : going.at(-1)!.ids
  const sets = [all, ['tpm', ...going.flatMap((g) => g.ids)], [...new Set(['tpm', ...focus])], focus]
  return sets.filter((set, i) => sets.findIndex((o) => o.join(' ') === set.join(' ')) === i)
}
