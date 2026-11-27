// Worker slots (each running engineer's ports and DB name) and engineers' worktrees once they're gone.
import fs from 'node:fs'
import path from 'node:path'
import { q, run } from './db.ts'
import { portBusy } from './apprun.ts'
import { freeBase, SLOT_SIZE } from './slotports.ts'
import { heldBases, slotBasesNow, takenSlots } from './runports.ts'
import { emit } from './events.ts'
import { j, sleep } from './util.ts'
import { sweepNow } from './leftovers.ts'
import { claudeLockPid, listWorktrees, removeMerged, unlockStale } from './worktrees.ts'
import { agentDir, getAgent, type Agent } from './agents.ts'
import { getFeature, getRepo, getTicket, repos, type Ticket, removing } from './records.ts'

/** A worker slot's env: the engineer owns ports `base` … `base`+9 (PORT is the first) and a database name no other HQ's engineer has. */
export const slotEnv = (idx: number, base: number): Record<string, string> =>
  ({ HQ_WORKER: String(idx), PORT: String(base), HQ_PORT_BASE: String(base), DB_NAME: `hq_w${idx}_${base}` })
export { slotBasesNow }
/** The lowest free slot, with the lowest block of ports no running engineer or test run of this HQ holds (Bug 273) and nothing on the machine listens on. The
 *  ports stay the engineer's for its whole run (they're in its launch script). Throws when every block is in use. */
export async function nextWorkerSlot(agentId: string, busy: (port: number) => Promise<boolean> = portBusy, bases = slotBasesNow()):
  Promise<{ idx: number; env: Record<string, string> }> {
  const got = await freeBase(bases, heldBases, busy, (base) => { // no await from here to the INSERT: another launch can't take the same slot
    const used = new Set(takenSlots().map((r) => r.idx)); let idx = 1; while (used.has(idx)) idx++
    const env = slotEnv(idx, base)
    run('INSERT OR REPLACE INTO worker_slots(idx, agent_id, env) VALUES (?,?,?)', idx, agentId, JSON.stringify(env)); return { idx, env }
  })
  if (!got) {
    throw new Error(`No free ports for another engineer: HQ's engineer ports ${bases[0]}–${bases.at(-1)! + SLOT_SIZE - 1} are all in use `
      + '(by its engineers, its own test runs or other programs).')
  }
  return got
}
export function releaseSlot(agentId: string): void { run('UPDATE worker_slots SET agent_id = NULL WHERE agent_id = ?', agentId) }
/** The first port an agent's launch script gave it (HQ_PORT_BASE), or null. */
function launchBase(agentId: string): string | null {
  try { return /^export HQ_PORT_BASE='(\d+)'$/m.exec(fs.readFileSync(path.join(agentDir(agentId), 'launch.sh'), 'utf8'))?.[1] ?? null } catch { return null }
}
/** Bug 422: on backend start, before anything can start an engineer (no start of this backend is under way, so every `pending-<ticket>` row is the last
 *  backend's). startEngineer holds a block under that name until launchAgent returns; a backend that went down in between left it there, counted as taken
 *  for good. It goes to the engineer that start launched if that one still runs (its launch script has those ports; a take-over finds it there), so it is
 *  freed when that engineer ends, like any engineer's; with no such engineer it is free now. Returns what it did, for the event. */
export function settlePendingSlots(): { idx: number; ticket: string; to: string | null }[] {
  const out: { idx: number; ticket: string; to: string | null }[] = []
  for (const r of q<{ idx: number; agent_id: string; env: string }>("SELECT idx, agent_id, env FROM worker_slots WHERE agent_id LIKE 'pending-%'")) {
    const ticket = r.agent_id.slice('pending-'.length), base = j<Record<string, string>>(r.env, {}).HQ_PORT_BASE
    const a = q<Agent>(`SELECT * FROM agents WHERE role = 'engineer' AND ticket_id = ? AND status != 'exited'
      AND id NOT IN (SELECT agent_id FROM worker_slots WHERE agent_id IS NOT NULL) ORDER BY started_at DESC`, ticket).find((x) => !!base && launchBase(x.id) === base)
    run('UPDATE worker_slots SET agent_id = ? WHERE idx = ?', a?.id ?? null, r.idx); out.push({ idx: r.idx, ticket, to: a?.id ?? null })
  }
  return out
}

/** Once an engineer is gone, its worktree's stale lock is cleared, and a merged ticket's worktree is removed if nothing in it
 *  would be lost (see worktrees.ts). A session HQ just stopped can take a moment to exit, so the lock is checked a few times. */
export async function releaseWorktree(t: Ticket): Promise<void> {
  const f = getFeature(t.feature_id), repo = f && getRepo(f.repo_id); if (!repo || !t.worktree_path || removing.has(repo.id)) return // Remove from HQ leaves the folder, locks and all
  for (let i = 0; i < 10; i++) {
    for (const p of await unlockStale(repo.path)) emit({ agentId: null, source: 'system', kind: 'worktree.unlocked', payload: { path: p } })
    const w = (await listWorktrees(repo.path).catch(() => [])).find((x) => x.path === t.worktree_path)
    if (!w || claudeLockPid(w.locked) === null) break
    await sleep(500)
  }
  const cur = getTicket(t.id); if (cur?.status !== 'merged' || !cur.branch || !fs.existsSync(t.worktree_path)) return
  await sweepNow() // what the engineer left running there goes first (Bug 75)
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
