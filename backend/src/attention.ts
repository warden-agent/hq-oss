import { one, run, now, q } from './db.ts'
import { emit, patch } from './events.ts'
import { id } from './util.ts'
export type Attention = { id: string; agent_id: string | null; ticket_id: string | null; kind: string; detail: string; created_at: number; resolved_at: number | null }
/** Create a needs-attention item unless an open one of the same kind exists for the agent. */
export function attention(kind: string, detail: string, opts: { agentId?: string | null; ticketId?: string | null } = {}): Attention | null {
  const existing = one<Attention>("SELECT * FROM needs_attention WHERE kind = ? AND resolved_at IS NULL AND IFNULL(agent_id, '') = IFNULL(?, '')", kind, opts.agentId ?? null)
  if (existing) return null
  const row: Attention = { id: id('att'), agent_id: opts.agentId ?? null, ticket_id: opts.ticketId ?? null, kind, detail, created_at: now(), resolved_at: null }
  run('INSERT INTO needs_attention(id, agent_id, ticket_id, kind, detail, created_at) VALUES (?,?,?,?,?,?)', row.id, row.agent_id, row.ticket_id, kind, detail, row.created_at)
  patch('attention', row.id, row as unknown as Record<string, unknown>)
  emit({ agentId: opts.agentId ?? null, source: 'system', kind: `attention.${kind}`, payload: { detail } })
  return row
}
export function resolveAttention(attId: string): void { run('UPDATE needs_attention SET resolved_at = ? WHERE id = ?', now(), attId); patch('attention', attId, { resolved_at: now() }) }
export function resolveKind(kind: string, agentId: string | null): void {
  for (const r of q<Attention>("SELECT * FROM needs_attention WHERE kind = ? AND resolved_at IS NULL AND IFNULL(agent_id, '') = IFNULL(?, '')", kind, agentId)) resolveAttention(r.id)
}
/** Every open notice about one ticket: moot once that ticket is merged. */
export function resolveForTicket(ticketId: string): void { for (const r of q<Attention>('SELECT * FROM needs_attention WHERE ticket_id = ? AND resolved_at IS NULL', ticketId)) resolveAttention(r.id) }
export function openAttention(): Attention[] { return q<Attention>('SELECT * FROM needs_attention WHERE resolved_at IS NULL ORDER BY created_at DESC') }
