// Bug 164: a feature whose tickets have all merged folds into one small "done" box, out of the way. The user can open it to show its
// tickets again (each one's box opens its Ticket tab, as on any feature) and fold it back. Which ones are open lives in the page only:
// a reload folds them all again.
import { useSyncExternalStore } from 'react'

let open: ReadonlySet<string> = new Set()
const watchers = new Set<() => void>()
const set = (next: ReadonlySet<string>) => { open = next; for (const w of watchers) w() }

/** Opens the done feature `featureId` (its tickets show on the board), or folds it with `on: false`. */
export function openDone(featureId: string, on = true): void {
  if (open.has(featureId) === on) return
  const next = new Set(open); if (on) next.add(featureId); else next.delete(featureId); set(next)
}
/** The done features the user opened (their ids). A new set each time it changes, so it can be a memo's dependency. */
export const useOpenDone = (): ReadonlySet<string> =>
  useSyncExternalStore((w) => { watchers.add(w); return () => { watchers.delete(w) } }, () => open)
