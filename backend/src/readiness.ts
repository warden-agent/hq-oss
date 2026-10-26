// Which tickets may start (pure, no DB): a ticket starts only when every ticket it depends on is merged into the default branch.
/** Every status a ticket can have. queued → planning → plan_review → implementing (⇄ awaiting_answer; escalated) → pr_ready →
 *  pr_open → merged; cancelled from any but merged. */
export const TICKET_STATUSES = ['queued', 'planning', 'plan_review', 'implementing', 'awaiting_answer', 'escalated', 'pr_ready', 'pr_open', 'merged', 'cancelled'] as const
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
