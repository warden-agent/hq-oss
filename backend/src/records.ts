// HQ's records of repos, features and tickets: reads, and ticket updates. A leaf: it imports none of the modules that act on
// them (repos, slots, mergewatch, tickets), so they can all import it.
import { openAttention, resolveAttention } from './attention.ts'
import { type TicketStatus, hasDependents, readyDependents } from './readiness.ts'
import { one, q, run, now } from './db.ts'
import { patch } from './events.ts'
import { j } from './util.ts'
import { parseGithubRemote } from './reposync.ts'
import type { Agent } from './agents.ts'

export type Repo = {
  id: string; name: string; path: string; remote: string | null; default_branch: string; context_doc_path: string | null
  network_allowlist: string; ignore_patterns: string; kind: 'local' | 'github' | null; sync_ok: number | null; sync_status: string | null
  sync_detail: string | null; synced_at: number | null; head: string | null; can_push: number | null; clearing_at: number | null
  empty: number | null
  /** The project's TPM (Bug 52): its latest session, and when it was parked (switched away from). */
  tpm_agent_id: string | null; tpm_parked_at: number | null; next_ticket: number; next_feature: number
  /** Auto mode: on or off, why it stopped, why it's waiting, and the user's own test command. */
  auto_mode: number; auto_stopped_why: string | null; auto_waiting: string | null; test_cmd: string | null
}
/** One request the project's TPM is working on: a branch of the board. `handle` (F-1…) is how the TPM names it. `tpm_agent_id`
 *  and `tpm_parked_at` are from when every feature had its own TPM (before Bug 52); nothing reads them any more. */
export type Feature = {
  id: string; repo_id: string; slug: string; title: string; request_text: string; status: string; tpm_agent_id: string | null
  merge_order: string; stacked_branches: number; created_at: number; updated_at: number; tpm_parked_at: number | null; handle: string | null
}
export type Ticket = {
  id: string; feature_id: string; key: string; slug: string; title: string; size: string; status: TicketStatus; prior_status: TicketStatus | null
  assignee_agent_id: string | null; expected_files: string; deps: string; edit_overrides: string; branch: string | null; worktree_path: string | null
  pr_number: number | null; pr_url: string | null; pr_state: string | null; plan_round: number; handoff_updated_at: number | null
  last_handoff_hash: string | null; spec: string | null; go_ahead: number; conflict_files: string | null; conflict_with: string | null; auto_tries: number; auto_parked_why: string | null
  parked_at: number | null; created_at: number; updated_at: number
}

/** Whether finished work goes to GitHub (push + PR) or stays local (Merge into main): a GitHub repo HQ can't push to (an
 *  open-source repo, say) is worked on locally. can_push null (GitHub couldn't be asked) keeps the GitHub way. */
export const usesGithub = (repo: Repo): boolean => repo.kind === 'github' && !!parseGithubRemote(repo.remote ?? '') && repo.can_push !== 0
/** A GitHub repo HQ can't push to, worked on locally. */
export const localOnly = (repo: Repo): boolean => repo.kind === 'github' && repo.can_push === 0
/** A GitHub repo that couldn't be brought up to date blocks launches, unless it's local-only (nothing goes there). A repo whose
 *  first sync failed has no remote or can_push yet, so it blocks too. */
export const syncBlocks = (repo: Repo): boolean => repo.kind === 'github' && !localOnly(repo) && !repo.sync_ok
/** Whether the project runs on auto mode. */
export const autoOn = (repoId: string | null | undefined): boolean => !!repoId && !!one<{ x: number }>('SELECT 1 AS x FROM repos WHERE id = ? AND auto_mode = 1', repoId)
export const repos = (): Repo[] => q<Repo>('SELECT * FROM repos ORDER BY created_at')
export const getRepo = (repoId: string): Repo | undefined => one<Repo>('SELECT * FROM repos WHERE id = ?', repoId)
/** Refuses new work in a repo whose board is being cleared (clear.ts): no launches, tickets, merges or previews until it's done. */
export function notClearing(repoId: string): void {
  const r = getRepo(repoId); if (r?.clearing_at) throw new Error(`${r.name} is being cleared; wait until it's done.`)
}
export const features = (): Feature[] => q<Feature>('SELECT * FROM features ORDER BY created_at DESC')
export const getFeature = (fid: string): Feature | undefined => one<Feature>('SELECT * FROM features WHERE id = ?', fid)
export const tickets = (featureId?: string): Ticket[] =>
  featureId ? q<Ticket>('SELECT * FROM tickets WHERE feature_id = ? ORDER BY key', featureId) : q<Ticket>('SELECT * FROM tickets ORDER BY created_at DESC')
export const getTicket = (tid: string): Ticket | undefined => one<Ticket>('SELECT * FROM tickets WHERE id = ?', tid)
export const ticketByKey = (featureId: string, key: string): Ticket | undefined => one<Ticket>('SELECT * FROM tickets WHERE feature_id = ? AND key = ?', featureId, key)
/** A ticket by its key anywhere in the project: keys are unique per repo (Bug 52). */
export const ticketInRepo = (repoId: string, key: string): Ticket | undefined =>
  one<Ticket>('SELECT t.* FROM tickets t JOIN features f ON f.id = t.feature_id WHERE f.repo_id = ? AND t.key = ?', repoId, key.trim())
/** A feature by its handle (F-3) in the project. */
export const featureByHandle = (repoId: string, handle: string): Feature | undefined =>
  one<Feature>('SELECT * FROM features WHERE repo_id = ? AND handle = ? COLLATE NOCASE', repoId, handle.trim())
/** The project's TPM session if it's running (Bug 52: one per repo). */
export function liveTpm(repoId: string): Agent | undefined {
  const r = getRepo(repoId); if (!r?.tpm_agent_id) return undefined
  const a = one<Agent>('SELECT * FROM agents WHERE id = ?', r.tpm_agent_id); return a && a.status !== 'exited' ? a : undefined
}
/** The repo an agent works in: its own, else its feature's (rows from before Bug 52). */
export const repoOfAgent = (a: Pick<Agent, 'repo_id' | 'feature_id'>): string | null => a.repo_id ?? (a.feature_id ? getFeature(a.feature_id)?.repo_id ?? null : null)
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
