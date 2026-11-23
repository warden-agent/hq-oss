// Stuck detection: quiet (no events) + static pane for longer than the threshold; dead pane; missing mod heartbeat.
import { getSetting, now } from './db.ts'
import { DEFAULTS } from './config.ts'
import { beingStopped, getAgent, liveAgents, lost, update, type Agent } from './agents.ts'
import { paneLooksIdle } from './screen.ts'
import * as tmux from './tmux.ts'
import { attention, openAttention, resolveKind, resolveLeftOnEnded, type Attention } from './attention.ts'
import { clearDialogs } from './dialogclear.ts'
import { dialogGone } from './presence.ts'
import { emit, patch } from './events.ts'
import { beat } from './beats.ts'
import { forgetHelpers } from './hooks.ts'
import { hasRuns, idleTooLong, lookAtRuns, stopFrozen } from './bgruns.ts'
import { getRepo, getTicket, repoOfAgent } from './records.ts'
import { getRevision, openReviews } from './gate.ts'
const lastHash = new Map<string, { hash: string; since: number }>()
// Gone on two checks in a row before it counts as lost: being lost revokes the agent's token, so one failed tmux call (which
// hasSession and paneDead read as "gone") must not cut off a session that is still running.
const missed = new Set<string>()
// Bug 25: an agent HQ thinks is working but whose screen has sat at Claude Code's idle prompt, untouched, for IDLE_FIX_MS, on
// two checks in a row: a hook was missed, so HQ sets it idle (which also lets queued messages reach it).
const IDLE_FIX_MS = Number(process.env.HQ_IDLE_FIX_S ?? 180) * 1000
const idleSeen = new Set<string>()
// Bug 62: an agent with an open "waiting on a dialog" alert whose dialog is gone, on two checks in a row (presence.ts dialogGone): the alert clears.
const dialogSeen = new Set<string>()
/** Bug 138: the agent as it is now, or undefined once it has ended or HQ is stopping it. Each look below waits on tmux or `ps`, and HQ can stop the
 *  agent meanwhile (Stop, a merge, a finished ticket's engineer): read it again after every wait, and leave alone one that has gone. */
function live(agentId: string): Agent | undefined {
  const a = getAgent(agentId); if (a && a.status !== 'exited' && !beingStopped(agentId)) return a
  forget(agentId); return undefined
}
/** Bug 180: what this loop keeps on an agent goes when it ends. Every way an agent ends (agents.ts update) takes it off liveAgents(), so each
 *  look drops whatever it kept on one no longer listed, and live() drops it on one that ended during a look. */
function forget(agentId: string): void { lastHash.delete(agentId); missed.delete(agentId); idleSeen.delete(agentId); dialogSeen.delete(agentId) }
/** The agents this loop keeps anything on (for tests). */
export const trackedIds = (): string[] => [...new Set([...lastHash.keys(), ...missed, ...idleSeen, ...dialogSeen])].sort()
/** Bug 114: an engineer whose plan waits for the user's review (the plan is in Your turn) is waiting on the user, not stuck. Its status says so
 *  while the gate holds the plan; once the hold is answered as still waiting, the open review of its own plan does (not another engineer's on
 *  the same ticket: one that took over is working on its own plan). */
const waitsForReview = (a: Agent): boolean => a.status === 'plan_review'
  || openReviews().some((r) => r.ticket_id === a.ticket_id && getRevision(r.plan_revision_id)?.agent_id === a.id)
/** A look every `HQ_STUCK_TICK_S` seconds, one at a time (Bug 328): the next starts that long after the last one ended, never while one is under way.
 *  "On two checks in a row" (missed, idleSeen, dialogSeen) means two looks a period apart; two at once, as a look stuck on tmux overlapped the next,
 *  could meet it moments apart. `look` and `periodMs` are for tests. Returns what ends the loop. */
export function startStuckLoop(look: () => Promise<void> = tick, periodMs = Number(process.env.HQ_STUCK_TICK_S ?? 60) * 1000): () => void {
  let timer: NodeJS.Timeout | undefined, ended = false
  const once = () => look().catch((e) => emit({ agentId: null, source: 'system', kind: 'stuck.error', payload: { error: String(e) } }))
  const next = () => { if (!ended) timer = setTimeout(() => { void once().finally(() => { beat('stuck'); next() }) }, periodMs) }
  next(); return () => { ended = true; clearTimeout(timer) }
}
export async function tick(): Promise<void> {
  const t = now(), listed = liveAgents()
  // Bugs 114, 153: an agent's alerts end with it (agents.ts update). One still open on an agent that has ended, saved before that, goes here.
  resolveLeftOnEnded()
  for (const id of trackedIds()) if (!listed.some((a) => a.id === id)) forget(id) // it ended since the last look (Bug 180; a miss: Bug 104)
  for (const was of listed) {
    const gone = !(await tmux.hasSession(was.tmux_session)) || (await tmux.paneDead(was.tmux_session))
    // Bug 104: the list was read once, and the look at each terminal takes a moment. An agent HQ stopped meanwhile (Stop, a merge, a
    // finished ticket's engineer), or is stopping right now, has no terminal either: it is neither missing nor lost.
    let a = live(was.id); if (!a) continue
    if (gone) {
      if (!missed.has(a.id)) { missed.add(a.id); emit({ agentId: a.id, source: 'system', kind: 'agent.missing', payload: {} }); continue }
      missed.delete(a.id); lost(a.id); attention('agent_exited', `${a.display_name ?? a.id} process ended`, { agentId: a.id, ticketId: a.ticket_id }); continue
    }
    missed.delete(a.id)
    await dialogSweep(a)
    a = live(a.id); if (!a) continue // Bug 138: after each look (tmux, ps), the agent as it is now
    await runSweep(a)
    a = live(a.id); if (!a) continue
    const h = await tmux.paneHash(a.tmux_session); const prev = lastHash.get(a.id)
    a = live(a.id); if (!a) continue
    // a wait for the plan's review counts as a new screen: no alert during it, and the quiet spell after the answer starts from there (Bug 114)
    if (!prev || prev.hash !== h || waitsForReview(a)) { lastHash.set(a.id, { hash: h, since: t }); resolveKind('stuck', a.id) }
    const quietMs = t - (a.last_event_at ?? a.started_at); const staticMs = t - (lastHash.get(a.id)?.since ?? t)
    // a run in the background sends no hooks: the agent is quiet and its screen still while it waits, and runSweep watches the run instead
    const waits = hasRuns(a.id)
    // Bug 189: with styles, so a turn running under a half-typed draft (no "esc to interrupt" then) doesn't look idle
    const looksIdle = a.status === 'working' && !waits && quietMs > IDLE_FIX_MS && staticMs > IDLE_FIX_MS && paneLooksIdle(await tmux.capturePane(a.tmux_session, 80, true))
    a = live(a.id); if (!a) continue // the last wait: what is read here is what the rest acts on
    if (looksIdle && a.status === 'working') {
      if (idleSeen.has(a.id)) {
        idleSeen.delete(a.id); forgetHelpers(a.id); update(a.id, { status: 'idle' }); patch('agent', a.id, { activity: null }); resolveKind('stuck', a.id)
        emit({ agentId: a.id, source: 'system', kind: 'agent.idle_fixed', payload: { quietMin: Math.round(quietMs / 60_000) } }); continue
      }
      idleSeen.add(a.id)
    } else idleSeen.delete(a.id)
    const thresholdMin = a.status === 'idle' ? getSetting('stuck_idle_min', DEFAULTS.stuck_idle_min) : getSetting('stuck_working_min', DEFAULTS.stuck_working_min)
    // keep: the minutes in the text change every sweep, and one open 'stuck' per agent is enough (it clears when the screen changes)
    // Bug 114: `a` was read again after the looks above: an agent stopped meanwhile has had its alerts cleared, and must not get a new one
    const quiet = quietMs > thresholdMin * 60_000 && staticMs > thresholdMin * 60_000
    if (!waits && quiet && a.status !== 'idle') {
      attention('stuck', `${a.display_name ?? a.id}: no events for ${Math.round(quietMs / 60_000)} min and the screen has not changed (status ${a.status})`,
        { agentId: a.id, ticketId: a.ticket_id, keep: true })
    }
    idleSweep(a)
    if (a.claude_session_id && !a.mod_seen_at && t - a.started_at > 90_000) attention('mod_missing', `${a.display_name ?? a.id}: the hq mod never reported in; message delivery falls back to the Stop hook`, { agentId: a.id })
  }
}
/** Bug 62: Claude Code says nothing when a dialog closes, and a denied or Escaped one fires no hook, so the alert would stay and auto mode would park or stop on it.
 *  With no sign at all that it ended, cleared only on positive evidence twice a minute apart (dialogclear.ts; a sign that it may have ended looks at once, Bug 188). */
async function dialogSweep(a: Agent): Promise<void> {
  const dialogs = (): Attention[] => openAttention().filter((r) => r.kind === 'dialog' && r.agent_id === a.id)
  const rows = dialogs()
  if (!rows.length || !(await dialogGone(a, Math.max(...rows.map((r) => r.created_at))))) { dialogSeen.delete(a.id); return }
  // Bugs 138, 151: the look at the screen waits on tmux. Read the agent and its dialogs again: one HQ stopped meanwhile is left alone, and a hook
  // that came in (a new dialog, or the same words again, which adds no notice) means the screen HQ saw may be out of date, so this look counts for nothing
  const cur = live(a.id); if (!cur) return
  if (cur.last_event_at !== a.last_event_at || dialogs().some((r) => !rows.some((x) => x.id === r.id))) { dialogSeen.delete(a.id); return }
  if (!dialogSeen.has(a.id)) { dialogSeen.add(a.id); return }
  dialogSeen.delete(a.id); clearDialogs(cur, rows, 'session_file')
}
/** Bug 96: the runs the agent waits on in the background, each minute. One that has done nothing for `bg_stall_min` is frozen: a notice with Stop it and tell
 *  the engineer, or on auto HQ stops it at once. It clears when the run moves again or ends. */
async function runSweep(a: Agent): Promise<void> {
  if (!hasRuns(a.id)) { resolveKind('bg_stalled', a.id); return }
  const frozen = await lookAtRuns(a); if (!live(a.id)) return // Bug 138: stopped while `ps` ran: its notices went with it, and none comes back
  if (!frozen.length) { resolveKind('bg_stalled', a.id); return }
  const who = a.ticket_id ? `${getTicket(a.ticket_id)?.key ?? 'Its ticket'}'s ${a.role === 'engineer' ? 'engineer' : a.role}` : a.display_name ?? a.id
  const f = frozen[0]!, what = `${who} is waiting on \`${f.run.command.slice(0, 100)}\`, which has done nothing (no CPU, no output) for ${f.quietMin} min`
  const repo = getRepo(repoOfAgent(a) ?? '')
  if (repo?.auto_mode && !repo.auto_stopped_why) {
    try { await stopFrozen(a.id, 'auto'); return } catch (e) { if (!live(a.id)) return; emit({ agentId: a.id, source: 'system', kind: 'bg.stop_failed', payload: { error: String(e) } }) }
  }
  attention('bg_stalled', `${what}${frozen.length > 1 ? ` (and ${frozen.length - 1} more)` : ''}.`, { agentId: a.id, ticketId: a.ticket_id, keep: true })
}
/** Bug 96 gap 4: an engineer idle with its ticket unfinished and nothing on its way. Auto mode replaces it (auto.ts); with auto off, a notice. */
function idleSweep(a: Agent): void {
  const t = a.role === 'engineer' && a.ticket_id ? getTicket(a.ticket_id) : undefined, repo = getRepo(repoOfAgent(a) ?? '')
  if (!t || repo?.auto_mode || !idleTooLong(t, a) || openReviews().some((r) => r.ticket_id === t.id)) { resolveKind('engineer_idle', a.id); return }
  const min = Math.round((now() - (a.last_event_at ?? a.started_at)) / 60_000)
  attention('engineer_idle', `${t.key}'s engineer has been idle for ${min} min while the ticket is still ${t.status}, with no message or run on its way. `
    + 'Look at its terminal, or send it a message.', { agentId: a.id, ticketId: t.id, keep: true })
}
