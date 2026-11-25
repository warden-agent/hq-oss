// When a press on a dialog's dark backdrop closes it (ui.tsx Backdrop, Bug 252), and when a click on a confirm's own button counts (StopDialog, Bug 390).
// Pure, so the backend's test runner unit-tests it (src/backdrop.test.ts).

/** A double click is two presses about this far apart (Windows' default; macOS's middle setting is close). A dialog opens on the first click, so the second
 *  press lands on its backdrop: one this soon after the dialog opened is that second click, not the user clicking away. */
export const BACKDROP_QUIET_MS = 500
/** Does a press on the backdrop at `now` close a dialog that opened at `openedAt` (both performance.now() ms)? */
export const backdropCloses = (openedAt: number, now: number): boolean => now - openedAt >= BACKDROP_QUIET_MS

/** Bug 390: does a click on one of a confirm's own buttons (ui.tsx StopDialog) count? A confirm opens on the first click of a double click, and its button
 *  can sit where the button that opened it was ("Undo this run"), so the second click pressed it and the confirm asked nothing. `detail` is the click's
 *  count: 2 or more is a later click of a double (or triple) click begun before the confirm was there, however slow the user's double-click setting,
 *  and never counts. 0 (Enter or Space on the focused button) and 1 (a click of its own) count at once, so the keyboard and scripted clicks work as
 *  before. No time rule as for the backdrop: it would drop a script's (or a quick user's) click in the confirm's first half second. */
export const confirmPressCounts = (detail: number): boolean => detail < 2
