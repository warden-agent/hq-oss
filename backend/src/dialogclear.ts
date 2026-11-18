// When a dialog's notice clears (Bugs 62, 188). Claude Code says nothing when a dialog closes, and a denied or Escaped one fires no hook, so the notice
// clears only on positive evidence (presence.ts dialogGone: its status file says it isn't waiting, it changed after the notice, no menu on screen).
// Two ways to look: the stuck loop's sweep, twice a minute apart, for a dialog that ended with no sign at all; and, once there is a sign the dialog may be over
// (the agent's own turn ended or was interrupted, or its main loop works again), a look at once and every second for a few seconds after (Bug 188).
// A sign sent while HQ was down is lost, so HQ also looks once at start-up at every agent with a dialog notice open (Bug 217).
import { now, q } from './db.ts'
import { emit, patch } from './events.ts'
import { beingStopped, getAgent, liveAgents, update, type Agent } from './agents.ts'
import { resolveAttention, type Attention } from './attention.ts'
import { dialogGone, presenceOf } from './presence.ts'

/** How long after a sign HQ keeps looking (the status file changes within 2 s of the answer, spike S1), and how often. */
const LOOK_MS = Number(process.env.HQ_DIALOG_LOOK_S ?? 10) * 1000
const EVERY_MS = 1000

export const openDialogs = (agentId: string): Attention[] =>
  q<Attention>("SELECT * FROM needs_attention WHERE kind = 'dialog' AND agent_id = ? AND resolved_at IS NULL", agentId)
const running = (agentId: string): Agent | undefined => { const a = getAgent(agentId); return a && a.status !== 'exited' && !beingStopped(agentId) ? a : undefined }

/** The dialog is gone: its notices resolve, and an agent blocked by it goes back to what its status file says (busy: working), unless an API error has it
 *  blocked (Bug 72). `a` is the agent as read after the last look. */
export function clearDialogs(a: Agent, seen: Attention[], by: string): boolean {
  const rows = openDialogs(a.id).filter((r) => seen.some((x) => x.id === r.id)); if (!rows.length) return false // the other way of looking got there first
  for (const r of rows) resolveAttention(r.id)
  const working = presenceOf(a.claude_session_id)?.status === 'busy'
  if (a.status === 'blocked' && a.blocked_why !== 'api_error') { // only over the "blocked" just read
    update(a.id, { status: working ? 'working' : 'idle' }); if (!working) patch('agent', a.id, { activity: null })
  }
  const waitedS = Math.round((now() - Math.min(...rows.map((r) => r.created_at))) / 1000)
  emit({ agentId: a.id, source: 'system', kind: 'agent.dialog_cleared', payload: { by, waitedS, rows: rows.length } }); return true
}

/** The looks under way, by agent: until when, what to do once the dialog has cleared, and whether a hook came in during the current look. Memory only:
 *  after a restart, the look at start-up (lookAtStart) and then the stuck loop's sweep. */
const rounds = new Map<string, { until: number; why: string; then: (() => void)[]; moved: boolean }>()
/** Bug 188: a sign that the agent's dialog may be over. `then` runs once its notices have cleared (not if they stay). */
export function dialogMayBeOver(agentId: string, why: string, then?: () => void): void {
  if (!openDialogs(agentId).length) return
  const r = rounds.get(agentId)
  if (r) { r.until = now() + LOOK_MS; r.moved = true; if (then) r.then.push(then); return }
  rounds.set(agentId, { until: now() + LOOK_MS, why, then: then ? [then] : [], moved: false })
  setImmediate(() => { look(agentId).catch((e) => emit({ agentId, source: 'system', kind: 'dialog.look_error', payload: { error: String(e) } })).finally(() => rounds.delete(agentId)) })
}
async function look(agentId: string): Promise<void> {
  const r = rounds.get(agentId)!
  for (;;) {
    const a = running(agentId), rows = openDialogs(agentId); if (!a || !rows.length) return
    r.moved = false
    const gone = await dialogGone(a, Math.max(...rows.map((x) => x.created_at)))
    // After the wait on tmux, the agent and its notices as they are now (Bug 138). A hook during the look (a new dialog, or the same words again, which adds
    // no notice) means the screen HQ saw may be out of date: that look counts for nothing, and HQ looks again.
    const cur = running(agentId), left = openDialogs(agentId); if (!cur || !left.length) return
    const fresh = !r.moved && cur.last_event_at === a.last_event_at && left.every((x) => rows.some((y) => y.id === x.id))
    if (gone && fresh) { if (clearDialogs(cur, left, r.why)) for (const f of r.then) f(); return }
    if (now() >= r.until) { emit({ agentId, source: 'system', kind: 'dialog.still_open', payload: { why: r.why } }); return } // the sweep goes on looking
    await new Promise((res) => setTimeout(res, fresh ? EVERY_MS : 100))
  }
}
/** Bug 217: what ended a dialog while HQ was down (Escape, a denial, an answer) sent its sign to no one: the mod's turn.complete and the hooks are lost. So
 *  at start-up, once the agents are read back, each one with a dialog notice open gets the same quick look. One still on its dialog keeps its notice. */
export function lookAtStart(): void {
  for (const a of liveAgents()) if (!beingStopped(a.id)) dialogMayBeOver(a.id, 'hq_start')
}
