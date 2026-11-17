// Bug 121: the Events tab's live lines, kept outside React so a new line redraws only the Events list (Bug 98).
export type EventLine = { id: number; at: number; agentId: string | null; text: string }
export const KEEP = 300

/** Live lines per agent, the newest 300 of each. Outside App's state, so a line redraws only the Events list (Bug 98). */
export function eventLog() {
  const by = new Map<string, EventLine[]>(), subs = new Set<() => void>(); let ver = 0
  return {
    add(evs: EventLine[]) {
      for (const e of evs) { if (!e.agentId) continue; const l = by.get(e.agentId) ?? []; l.push(e); if (l.length > KEEP) l.splice(0, l.length - KEEP); by.set(e.agentId, l) }
      ver++; for (const f of subs) f()
    },
    get: () => ver, lines: (agentId: string): EventLine[] => by.get(agentId) ?? [],
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  }
}
export type EventLog = ReturnType<typeof eventLog>
