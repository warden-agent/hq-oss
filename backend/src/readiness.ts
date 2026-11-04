// Which tickets may start (pure, no DB): a ticket starts only when every ticket it depends on is merged into the default branch.
/** Every status a ticket can have. queued → planning → plan_review → implementing (⇄ awaiting_answer; escalated) → pr_ready →
 *  pr_open → merged; pr_ready/pr_open → resolving (its engineer merges main in after a conflict) → pr_ready/pr_open again;
 *  cancelled from any but merged. */
export const TICKET_STATUSES = ['queued', 'planning', 'plan_review', 'implementing', 'awaiting_answer', 'escalated', 'pr_ready', 'pr_open', 'resolving', 'merged', 'cancelled'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]
export type TicketLike = { key: string; status: string; assignee_agent_id: string | null; deps: string }
/** Statuses where the ticket's engineer is finished; those engineers don't use a parallel slot. */
export const FINISHED: string[] = ['pr_ready', 'pr_open', 'merged', 'cancelled'] satisfies TicketStatus[]
const keys = (s: string): string[] => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
/** Dependencies of `t` (keys within its feature) that aren't merged yet. A key with no ticket counts as not merged. */
export function unmergedDeps(t: TicketLike, siblings: TicketLike[]): string[] { return keys(t.deps).filter((k) => siblings.find((s) => s.key === k)?.status !== 'merged') }
/** Why an engineer may not start on `t` now, or null. One engineer per ticket: one starting or running blocks a second;
 *  an exited one doesn't (that's a relaunch). */
export function launchBlocker(t: { key: string; status: string }, o: { starting: boolean; liveEngineer: string | null }): string | null {
  if (t.status === 'cancelled') return `${t.key} is cancelled`
  if (o.starting) return `${t.key} is already starting an engineer`
  if (o.liveEngineer) return `${t.key} already has an engineer (${o.liveEngineer})`
  if (FINISHED.includes(t.status)) return `${t.key} is already finished (${t.status})`
  return null
}
/** Tickets that could start now: queued, no engineer, every dependency merged. In merge order, then by key. */
export function readyTickets<T extends TicketLike>(all: T[], mergeOrder: string[]): T[] {
  const rank = (k: string) => { const i = mergeOrder.indexOf(k); return i < 0 ? Number.MAX_SAFE_INTEGER : i }
  return all.filter((t) => t.status === 'queued' && !t.assignee_agent_id && !unmergedDeps(t, all).length)
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key, undefined, { numeric: true }))
}
/** Tickets that wait on `key` and could start now: the "Ready now" list of a merge notice. Empty once they've all started. */
export function readyDependents<T extends TicketLike>(key: string, all: T[], mergeOrder: string[]): T[] { return readyTickets(all, mergeOrder).filter((t) => keys(t.deps).includes(key)) }
/** Whether any ticket in the feature waits on `key` (cancelled ones don't count). */
export function hasDependents(key: string, all: TicketLike[]): boolean { return all.some((t) => t.status !== 'cancelled' && keys(t.deps).includes(key)) }
/** Why `key` may not wait on `want` (Bug 50: the TPM rewires tickets that waited on a removed one), or null. Every key must be
 *  another ticket of the feature that isn't cancelled (a cancelled one never merges), and the result must have no loop. */
export function depsProblem(key: string, want: string[], all: TicketLike[]): string | null {
  if (want.includes(key)) return `${key} can't wait on itself`
  for (const k of want) {
    const t = all.find((x) => x.key === k)
    if (!t) return `there's no ticket ${k} in this feature`
    if (t.status === 'cancelled') return `${k} was removed (cancelled); it will never be merged`
  }
  const deps = new Map(all.map((t) => [t.key, t.key === key ? want : keys(t.deps)]))
  const path = (from: string, seen: string[]): string[] | null => { // a way from `from` back to `key`
    if (from === key) return [...seen, from]
    if (seen.includes(from)) return null
    for (const d of deps.get(from) ?? []) { const p = path(d, [...seen, from]); if (p) return p }
    return null
  }
  for (const k of want) { const p = path(k, [key]); if (p) return `that makes a loop: ${p.join(' → ')}` }
  return null
}
