// Worker slots (each running engineer's ports and DB name) and engineers' worktrees once they're gone.
import fs from 'node:fs'
import { q, run } from './db.ts'
import { emit } from './events.ts'
import { sleep } from './util.ts'
import { claudeLockPid, listWorktrees, removeMerged, unlockStale } from './worktrees.ts'
import { getAgent } from './agents.ts'
import { getFeature, getRepo, getTicket, repos, type Ticket } from './records.ts'

/** A worker slot's env: slot n owns ports 3100+10n … 3100+10n+9, and PORT is the first of them. */
export const slotEnv = (idx: number): Record<string, string> => ({ HQ_WORKER: String(idx), PORT: String(3100 + idx * 10), HQ_PORT_BASE: String(3100 + idx * 10), DB_NAME: `hq_w${idx}` })
/** The lowest free slot. A slot is taken by a launch under way (`pending-…`) or an agent that hasn't exited; one still naming
 *  an exited or unknown agent is free (its release was missed). */
export function nextWorkerSlot(agentId: string): { idx: number; env: Record<string, string> } {
  const taken = q<{ idx: number }>(`SELECT s.idx FROM worker_slots s LEFT JOIN agents a ON a.id = s.agent_id
    WHERE s.agent_id LIKE 'pending-%' OR (a.id IS NOT NULL AND a.status != 'exited')`)
  const used = new Set(taken.map((r) => r.idx))
  let idx = 1; while (used.has(idx)) idx++
  const env = slotEnv(idx)
  run('INSERT OR REPLACE INTO worker_slots(idx, agent_id, env) VALUES (?,?,?)', idx, agentId, JSON.stringify(env)); return { idx, env }
}
export function releaseSlot(agentId: string): void { run('UPDATE worker_slots SET agent_id = NULL WHERE agent_id = ?', agentId) }

/** Once an engineer is gone, its worktree's stale lock is cleared, and a merged ticket's worktree is removed if nothing in it
 *  would be lost (see worktrees.ts). A session HQ just stopped can take a moment to exit, so the lock is checked a few times. */
export async function releaseWorktree(t: Ticket): Promise<void> {
  const f = getFeature(t.feature_id), repo = f && getRepo(f.repo_id); if (!repo || !t.worktree_path) return
  for (let i = 0; i < 10; i++) {
    for (const p of await unlockStale(repo.path)) emit({ agentId: null, source: 'system', kind: 'worktree.unlocked', payload: { path: p } })
    const w = (await listWorktrees(repo.path).catch(() => [])).find((x) => x.path === t.worktree_path)
    if (!w || claudeLockPid(w.locked) === null) break
    await sleep(500)
  }
  const cur = getTicket(t.id); if (cur?.status !== 'merged' || !cur.branch || !fs.existsSync(t.worktree_path)) return
  const r = await removeMerged(repo.path, t.worktree_path, cur.branch, repo.default_branch).catch((e) => ({ removed: false, why: (e as Error).message }))
  emit({ agentId: null, source: 'system', kind: r.removed ? 'worktree.removed' : 'worktree.kept', payload: { ticket: t.key, path: t.worktree_path, why: r.why ?? null } })
}
export const releaseFor = (agentId: string | null): void => {
  const a = agentId ? getAgent(agentId) : undefined; const t = a?.role === 'engineer' && a.ticket_id ? getTicket(a.ticket_id) : undefined
  if (t) void releaseWorktree(t).catch(() => {})
}
/** On backend start: locks left by sessions that died while HQ was down, and merged tickets' worktrees. */
export async function sweepWorktrees(): Promise<void> {
  for (const repo of repos()) for (const p of await unlockStale(repo.path)) emit({ agentId: null, source: 'system', kind: 'worktree.unlocked', payload: { path: p } })
  for (const t of q<Ticket>("SELECT * FROM tickets WHERE status = 'merged' AND worktree_path IS NOT NULL")) if (fs.existsSync(t.worktree_path!)) await releaseWorktree(t).catch(() => {})
}
