import { one, run, now, q } from './db.ts'
import { emit, patch } from './events.ts'
import { id } from './util.ts'
export type Attention = { id: string; agent_id: string | null; ticket_id: string | null; kind: string; detail: string; created_at: number; resolved_at: number | null }
/** The open notices a new one would stand for: the same kind about the same agent, or, with no agent, about the same ticket (so
 *  two tickets' launch_failed both show; a kind with neither, like repo_sync:<repo>, is one notice). */
const openLike = (kind: string, agentId: string | null, ticketId: string | null): Attention[] => q<Attention>(
  "SELECT * FROM needs_attention WHERE kind = ? AND resolved_at IS NULL AND IFNULL(agent_id, '') = IFNULL(?, '') AND (IFNULL(?, '') != '' OR IFNULL(ticket_id, '') = IFNULL(?, ''))",
  kind, agentId, agentId, ticketId)
/** Bugs 114, 153, 165: notices about what one agent is doing right now. They mean nothing once it has ended (Stop, lost, its session
 *  ending), so they end with it (agents.ts update) and are never raised for an ended agent. Notices about something that happened
 *  (a message for the user, a report of being blocked, an API error, the agent's own exit) stay: they still need the user, or auto
 *  mode acts on them (auto.ts readNotices). */
export const ENDS_WITH_AGENT = ['stuck', 'bg_stalled', 'engineer_idle', 'context_high', 'mod_missing', 'mod_token_missing', 'dialog', 'usage_limit', 'tpm_rotate']
const ended = (agentId: string): boolean => one<{ status: string }>('SELECT status FROM agents WHERE id = ?', agentId)?.status === 'exited'
/** Create a needs-attention item: one open item per situation. A newer one with different words takes the open one's place (the
 *  old one is resolved; the new one has its own id, so it pops up again: Bug 40), and the same words again change nothing. `keep`:
 *  an open item stays as it is however the words changed, for notices re-asserted every sweep with a live number in them (stuck,
 *  context_high, rate_limit). */
export function attention(kind: string, detail: string, opts: { agentId?: string | null; ticketId?: string | null; keep?: boolean } = {}): Attention | null {
  if (opts.agentId && ENDS_WITH_AGENT.includes(kind) && ended(opts.agentId)) return null // Bug 153: raised after a wait, once its agent had gone
  const open = openLike(kind, opts.agentId ?? null, opts.ticketId ?? null)
  if (open.some((r) => r.detail === detail) || (open.length && opts.keep)) return null
  for (const r of open) resolveAttention(r.id)
  const row: Attention = { id: id('att'), agent_id: opts.agentId ?? null, ticket_id: opts.ticketId ?? null, kind, detail, created_at: now(), resolved_at: null }
  run('INSERT INTO needs_attention(id, agent_id, ticket_id, kind, detail, created_at) VALUES (?,?,?,?,?,?)', row.id, row.agent_id, row.ticket_id, kind, detail, row.created_at)
  patch('attention', row.id, row as unknown as Record<string, unknown>)
  emit({ agentId: opts.agentId ?? null, source: 'system', kind: `attention.${kind}`, payload: open.length ? { detail, replaced: open.map((r) => r.id) } : { detail } })
  return row
}
export function resolveAttention(attId: string): void { run('UPDATE needs_attention SET resolved_at = ? WHERE id = ?', now(), attId); patch('attention', attId, { resolved_at: now() }) }
export function resolveKind(kind: string, agentId: string | null): void {
  for (const r of q<Attention>("SELECT * FROM needs_attention WHERE kind = ? AND resolved_at IS NULL AND IFNULL(agent_id, '') = IFNULL(?, '')", kind, agentId)) resolveAttention(r.id)
}
/** Open notices of one kind about one ticket (attention() keys on the agent; a ticket can outlive its engineer). */
export function resolveKindForTicket(kind: string, ticketId: string): void {
  for (const r of q<Attention>('SELECT * FROM needs_attention WHERE kind = ? AND ticket_id = ? AND resolved_at IS NULL', kind, ticketId)) resolveAttention(r.id)
}
/** Bug 153: an agent has ended, so its notices about what it is doing end too. */
export function resolveEndedAgent(agentId: string): void { for (const kind of ENDS_WITH_AGENT) resolveKind(kind, agentId) }
/** Bug 153: one of those notices still open on an agent that has ended (or is gone from the list): raised in a race, or saved before
 *  the fix. The stuck loop's next look closes it. */
export function resolveLeftOnEnded(): void {
  const marks = ENDS_WITH_AGENT.map(() => '?').join(', ')
  for (const r of q<Attention>(`SELECT n.* FROM needs_attention n LEFT JOIN agents a ON a.id = n.agent_id WHERE n.resolved_at IS NULL
    AND n.agent_id IS NOT NULL AND n.kind IN (${marks}) AND IFNULL(a.status, 'exited') = 'exited'`, ...ENDS_WITH_AGENT)) resolveAttention(r.id)
}
/** Every open notice about one ticket: moot once that ticket is merged. */
export function resolveForTicket(ticketId: string): void { for (const r of q<Attention>('SELECT * FROM needs_attention WHERE ticket_id = ? AND resolved_at IS NULL', ticketId)) resolveAttention(r.id) }
/** The notice as it is now, or undefined once it's resolved (or replaced: attention() resolves the old one). */
export const stillOpen = (attId: string): Attention | undefined => one<Attention>('SELECT * FROM needs_attention WHERE id = ? AND resolved_at IS NULL', attId)
export function openAttention(): Attention[] { return q<Attention>('SELECT * FROM needs_attention WHERE resolved_at IS NULL ORDER BY created_at DESC') }
