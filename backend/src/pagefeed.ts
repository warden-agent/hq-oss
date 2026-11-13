// Bug 98: what one open tab is told about agents. Every hook an agent sends patches its row, several times a second while it works,
// and each patch the tab gets makes it work out its board again. Most of them change nothing the page shows: the time of the last hook,
// the mod's last poll, a status that was already 'working', the same activity line again. A tab keeps the agent values it was last sent
// (its snapshot, then its patches) and is sent only the ones that differ.
import type { Patch } from './events.ts'

/** Agent columns the page never reads; a hook or a mod poll moves them all the time. HQ itself reads them from the database. */
export const UNSHOWN = new Set(['last_event_at', 'mod_seen_at'])
const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b))

export function pageFeed() {
  const told = new Map<string, Record<string, unknown>>() // agent id → what this tab has
  return {
    /** The tab was sent a whole snapshot: that is what it has now. */
    snapshot(agents: { id: string }[]): void { told.clear(); for (const a of agents) told.set(a.id, { ...a }) },
    /** The patch to send this tab, or null when it would change nothing on it. Only agent rows are thinned out. */
    patch(p: Patch): Patch | null {
      if (p.entity !== 'agent') return p
      if (p.patch === null) { told.delete(p.id); return p }
      const had = told.get(p.id), out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(p.patch)) if (v !== undefined && !UNSHOWN.has(k) && !(had && k in had && same(had[k], v))) out[k] = v
      if (!Object.keys(out).length) return null
      told.set(p.id, { ...had, ...out }); return { ...p, patch: out }
    },
  }
}
