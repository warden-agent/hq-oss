// When a press on a dialog's dark backdrop closes it (ui.tsx Backdrop, Bug 252). Pure, so the backend's test runner unit-tests it (src/backdrop.test.ts).

/** A double click is two presses about this far apart (Windows' default; macOS's middle setting is close). A dialog opens on the first click, so the second
 *  press lands on its backdrop: one this soon after the dialog opened is that second click, not the user clicking away. */
export const BACKDROP_QUIET_MS = 500
/** Does a press on the backdrop at `now` close a dialog that opened at `openedAt` (both performance.now() ms)? */
export const backdropCloses = (openedAt: number, now: number): boolean => now - openedAt >= BACKDROP_QUIET_MS
