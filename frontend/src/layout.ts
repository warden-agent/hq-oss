// How the window's width is shared between the graph, the app pane docked to its right and the side panel (Bugs 154, 167).
// Pure, so the backend's test runner unit-tests it (src/layout.test.ts). Widths are in px; `win` is window.innerWidth.

export const PANEL_DEFAULT = 520, PANEL_MIN = 360
/** The drag strip between two panes. */
export const SPLIT = 6
/** The graph keeps at least this much beside an app pane docked right; with less room the pane shows below the graph instead. */
export const GRAPH_MIN = 320
/** An app pane docked right is never narrower than this. */
export const RIGHT_MIN = 300

/** The side panel's drawn width: the width the user chose, but on a narrow window it gives way so the graph keeps ~420 px.
 *  Only what's drawn: the choice itself is kept, so the panel grows back when the window does (Bug 154). */
export const panelWidth = (chosen: number, win: number) =>
  Math.round(Math.max(Math.min(PANEL_MIN, win * 0.45), Math.min(chosen, win * 0.8, win - 420)))
/** The width the graph and the app pane share: the window less the side panel (null: closed) and its drag strip. */
export const mainWidth = (win: number, panel: number | null) => panel === null ? win : win - SPLIT - panel
/** Whether an app pane docked right fits beside the graph in `room` (Bug 167: it used to run on under the side panel). */
export const fitsRight = (room: number) => room - SPLIT - RIGHT_MIN >= GRAPH_MIN
/** An app pane docked right: the width it was given, at most 70% of `room` and never so wide that the graph gets under GRAPH_MIN. */
export const rightWidthIn = (w: number, room: number) => Math.round(Math.max(RIGHT_MIN, Math.min(w, room * 0.7, room - SPLIT - GRAPH_MIN)))
