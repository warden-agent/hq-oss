// Who moves a ticket on next (pure, no DB), for every text that says it: the TPM's start-up board (handover.ts), HQ's notices (mergewatch.ts),
// the board's boxes, Your turn and the ⚠ menu (frontend/src/board.ts, needs.ts, alerts.ts, App.tsx). One rule, so a fix for one place covers
// them all (Bugs 193, 209, 246, 292, 311). records.ts re-exports autoGoing and hqMoves.
type ModeRepo = { auto_mode: number | boolean | null; auto_stopped_why?: string | null; clearing_at?: number | null }
type ModeTicket = { auto_parked_why?: string | null }

/** Bugs 193, 209, 246: HQ moves tickets on by itself (starts, tests and merges them): auto mode is on and not stopped. While it is stopped the user does,
 *  with the board's buttons, until Resume, and what HQ tells the TPM and the user says so. */
export const autoGoing = (repo: ModeRepo): boolean => !!repo.auto_mode && !repo.auto_stopped_why
/** HQ moves this ticket on by itself: auto mode is going (autoGoing) and hasn't parked it. Otherwise the user does. */
export const hqMoves = (repo: ModeRepo, t: ModeTicket): boolean => autoGoing(repo) && !t.auto_parked_why
/** Who moves the ticket on next: HQ (hqMoves), the user, or nobody while its project is being cleared (Bug 311: HQ refuses starts and merges until the
 *  board is gone, records.ts notClearing, and auto mode is off for it meanwhile, clear.ts). */
export const nextMover = (repo: ModeRepo, t: ModeTicket): 'hq' | 'user' | 'nobody' => repo.clearing_at ? 'nobody' : hqMoves(repo, t) ? 'hq' : 'user'
