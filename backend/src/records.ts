// HQ's records of repos, features and tickets: reads, and ticket updates. A leaf: it imports none of the modules that act on
// them (repos, slots, mergewatch, tickets), so they can all import it.
import { openAttention, resolveAttention } from './attention.ts'
import { type TicketStatus, hasDependents, readyDependents } from './readiness.ts'
import { one, q, run, now } from './db.ts'
import { patch } from './events.ts'
import { j } from './util.ts'
import type { Agent } from './agents.ts'

export type Repo = {
  id: string; name: string; path: string; remote: string | null; default_branch: string; context_doc_path: string | null
  network_allowlist: string; ignore_patterns: string; kind: 'local' | 'github' | null; sync_ok: number | null; sync_status: string | null
  sync_detail: string | null; synced_at: number | null; head: string | null; can_push: number | null
}
export type Feature = {
  id: string; repo_id: string; slug: string; title: string; request_text: string; status: string; tpm_agent_id: string | null
  merge_order: string; stacked_branches: number; created_at: number; updated_at: number
}
export type Ticket = {
  id: string; feature_id: string; key: string; slug: string; title: string; size: string; status: TicketStatus; prior_status: TicketStatus | null
  assignee_agent_id: string | null; expected_files: string; deps: string; edit_overrides: string; branch: string | null; worktree_path: string | null
  pr_number: number | null; pr_url: string | null; pr_state: string | null; plan_round: number; handoff_updated_at: number | null
  last_handoff_hash: string | null; spec: string | null; go_ahead: number; created_at: number; updated_at: number
}

export const repos = (): Repo[] => q<Repo>('SELECT * FROM repos ORDER BY created_at')
export const getRepo = (repoId: string): Repo | undefined => one<Repo>('SELECT * FROM repos WHERE id = ?', repoId)
export const features = (): Feature[] => q<Feature>('SELECT * FROM features ORDER BY created_at DESC')
export const getFeature = (fid: string): Feature | undefined => one<Feature>('SELECT * FROM features WHERE id = ?', fid)
export const tickets = (featureId?: string): Ticket[] =>
  featureId ? q<Ticket>('SELECT * FROM tickets WHERE feature_id = ? ORDER BY key', featureId) : q<Ticket>('SELECT * FROM tickets ORDER BY created_at DESC')
export const getTicket = (tid: string): Ticket | undefined => one<Ticket>('SELECT * FROM tickets WHERE id = ?', tid)
export const ticketByKey = (featureId: string, key: string): Ticket | undefined => one<Ticket>('SELECT * FROM tickets WHERE feature_id = ? AND key = ?', featureId, key)
export function ticketForAgent(agent: Agent): Ticket | undefined { return agent.ticket_id ? getTicket(agent.ticket_id) : undefined }

export function setTicket(ticketId: string, fields: Partial<Omit<Ticket, 'id' | 'updated_at'>>): void {
  const keys = Object.keys(fields)
  run(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k as keyof typeof fields] as never), now(), ticketId)
  patch('ticket', ticketId, fields)
  if ('status' in fields || 'assignee_agent_id' in fields) sweepNotices() // a started ticket can make a "Ready now" notice moot
}
/** Takes down "X merged. Ready now: …" notices once nothing they listed is left to start (all started or cancelled), and
 *  any notice about a ticket or feature that's gone or cancelled. A plain "X merged" with nothing waiting on X stays. */
export function sweepNotices(): void {
  for (const a of openAttention()) {
    if (a.kind !== 'merged' || !a.ticket_id) continue
    const t = getTicket(a.ticket_id), f = t && getFeature(t.feature_id)
    if (!t || !f || f.status === 'cancelled' || t.status === 'cancelled') { resolveAttention(a.id); continue }
    const all = tickets(f.id)
    if (hasDependents(t.key, all) && !readyDependents(t.key, all, j<string[]>(f.merge_order, [])).length) resolveAttention(a.id)
  }
}
