// Bug 99: the mod's waiting `next` requests. Whatever could give an agent a message batch wakes its waiting request, which then
// looks at once, instead of every waiting request looking every 500 ms. Import-free, so agents.ts and delivery.ts can both call it.

/** One waiting `next` request. `status`: the agent's status when it last looked; `wake` asks it to look again soon. */
export type Waiter = { status: string | null; wake: () => void }
const waiting = new Map<string, Set<Waiter>>()

/** Registers a waiting request for `agentId`; returns what removes it. */
export function listen(agentId: string, w: Waiter): () => void {
  const s = waiting.get(agentId) ?? new Set<Waiter>(); s.add(w); waiting.set(agentId, s)
  return () => { s.delete(w); if (!s.size && waiting.get(agentId) === s) waiting.delete(agentId) }
}
/** Something that could give `agentId` a batch changed (a message for it, a batch of its acked or put back). */
export function wake(agentId: string | null | undefined): void { if (agentId) for (const w of [...(waiting.get(agentId) ?? [])]) w.wake() }
/** Something that could give any agent a batch changed (a team message, a role resumed, a delivery setting). */
export function wakeAll(): void { for (const s of [...waiting.values()]) for (const w of [...s]) w.wake() }

/** Agent columns that delivery reads (besides status): a hold, a fresh start, which project and feature its messages come from. */
const READS = ['takeover_locked_until', 'fresh_start_at', 'repo_id', 'feature_id', 'role']
/** An agent row changed. Hooks write the row several times a second while it works (`status: 'working'` again and again), so
 *  this wakes only for what delivery reads: a status other than the one its waiting request last saw, or a column in READS. */
export function agentChanged(agentId: string, fields: Record<string, unknown>): void {
  const s = waiting.get(agentId); if (!s) return
  const reads = READS.some((k) => k in fields)
  for (const w of [...s]) if (reads || ('status' in fields && fields.status !== w.status)) w.wake()
}
/** How many requests are waiting (tests). */
export function waitingCount(): number { let n = 0; for (const s of waiting.values()) n += s.size; return n }
