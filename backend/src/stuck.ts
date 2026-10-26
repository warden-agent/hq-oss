// Stuck detection: quiet (no events) + static pane for longer than the threshold; dead pane; missing mod heartbeat.
import { getSetting, now } from './db.ts'
import { DEFAULTS } from './config.ts'
import { liveAgents, lost } from './agents.ts'
import * as tmux from './tmux.ts'
import { attention, resolveKind } from './attention.ts'
import { emit } from './events.ts'
const lastHash = new Map<string, { hash: string; since: number }>()
// Gone on two checks in a row before it counts as lost: being lost revokes the agent's token, so one failed tmux call (which
// hasSession and paneDead read as "gone") must not cut off a session that is still running.
const missed = new Set<string>()
export function startStuckLoop(): NodeJS.Timeout {
  return setInterval(() => { tick().catch((e) => emit({ agentId: null, source: 'system', kind: 'stuck.error', payload: { error: String(e) } })) }, 60_000)
}
export async function tick(): Promise<void> {
  const t = now()
  for (const a of liveAgents()) {
    if (!(await tmux.hasSession(a.tmux_session)) || (await tmux.paneDead(a.tmux_session))) {
      if (!missed.has(a.id)) { missed.add(a.id); emit({ agentId: a.id, source: 'system', kind: 'agent.missing', payload: {} }); continue }
      missed.delete(a.id); lost(a.id); attention('agent_exited', `${a.display_name ?? a.id} process ended`, { agentId: a.id, ticketId: a.ticket_id }); continue
    }
    missed.delete(a.id)
    const h = await tmux.paneHash(a.tmux_session); const prev = lastHash.get(a.id)
    if (!prev || prev.hash !== h) { lastHash.set(a.id, { hash: h, since: t }); resolveKind('stuck', a.id) }
    const quietMs = t - (a.last_event_at ?? a.started_at); const staticMs = t - (lastHash.get(a.id)?.since ?? t)
    const thresholdMin = a.status === 'idle' ? getSetting('stuck_idle_min', DEFAULTS.stuck_idle_min) : getSetting('stuck_working_min', DEFAULTS.stuck_working_min)
    if (a.status !== 'idle' && a.status !== 'exited' && quietMs > thresholdMin * 60_000 && staticMs > thresholdMin * 60_000) attention('stuck', `${a.display_name ?? a.id}: no events for ${Math.round(quietMs / 60_000)} min and the screen has not changed (status ${a.status})`, { agentId: a.id, ticketId: a.ticket_id })
    if (a.claude_session_id && !a.mod_seen_at && t - a.started_at > 90_000) attention('mod_missing', `${a.display_name ?? a.id}: the hq mod never reported in; message delivery falls back to the Stop hook`, { agentId: a.id })
  }
}
