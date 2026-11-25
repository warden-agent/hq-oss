// Hook + mod + tmux ingress server (127.0.0.1:PORTS.hooks). Every record is logged to `events`, then applied.
import http from 'node:http'
import { BIND, PORTS, DEFAULTS } from './config.ts'
import { checkContext } from './freshstart.ts'
import { run, now, getSetting, one, q } from './db.ts'
import { emit, patch } from './events.ts'
import { agentByToken, beingStopped, getAgent, liveAgents, update, tmuxToken, revokeToken, type Agent } from './agents.ts'
import { presenceOf } from './presence.ts'
import { paneShowsDialog } from './screen.ts'
import { onExitPlanMode, onPostExitPlanMode, openReviews } from './gate.ts'
import { ackBatchFromPrompt, deliveredByStopHook, recordReply, nextBatchFor, markSubmitted, markReceived, requeue, unreadCount, pendingFor, tellIfHqWasAway, modLook } from './delivery.ts'
import { stepNotes } from './delivery.ts'
import { turnEnded } from './delivery.ts'
import { lateReportFits, submittedWhileAway } from './delivery.ts'
import { listen, wake, type Waiter } from './wake.ts'
import { onPostModelSwitch, onTurnStep } from './modelguard.ts'
import { attention, resolveKind } from './attention.ts'
import { getRepo, getTicket, repoOfAgent } from './records.ts'
import { gateBash, laneMoved } from './heavy.ts'
import { addRun, endRuns, turnHadEnded, waitingText, watchedTask } from './bgruns.ts'
import { isBridgePid } from './terminal.ts'
import * as tmux from './tmux.ts'
import { readJson, asObject, TooLarge } from './util.ts'
import { TOKEN_HEADER } from './roles.ts'
import { sawTestCmd } from './auto.ts'
import { overPause, pauseLevels } from './scheduler.ts'
import { keepBefore, keepState, suiteRan } from './suiteran.ts'
import { gateCmds, stepsOf } from './teststepsstore.ts'
import { dialogMayBeOver } from './dialogclear.ts'

const TAKEOVER_ATTACHED_MS = 365 * 86_400_000 // "until they detach"
/** Bug 99: the longest a waiting `next` goes without looking, for a change that woke nothing (a write that wake.ts doesn't hear of). */
const NEXT_BACKSTOP_MS = Number(process.env.HQ_NEXT_BACKSTOP_MS ?? 5000)
/** Notification types that mean a dialog is open and waiting for a person (checked on 2.1.300). */
const DIALOGS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'worker_permission_prompt'])
/** Bug 188: hooks of the agent's own main loop that say its dialog may be over (its turn went on or ended), so HQ looks at once (dialogclear.ts). Not a
 *  helper's: the main loop's dialog stays open while one works. Not PermissionRequest: that comes before a dialog. Not proof either: a helper's dialog,
 *  or a second one, can still be open, and only the status file and the screen tell. */
const DIALOG_MAY_BE_OVER = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure'])
/** Bugs 352, 359: the mod's turn.complete reasons for a turn that ended on an API error message, which fires StopFailure instead of Stop (2.1.322's query
 *  loop): 'error', and 'refusal' (a reply the API refused with no fallback model to take it; the mod says 'refusal' before 'error'). */
const API_ENDED = new Set(['error', 'refusal'])

const json = (res: http.ServerResponse, code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const deny = (message: string) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } })
const allow = () => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
const trim = (v: unknown, n = 400): string => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > n ? s.slice(0, n) + '…' : s }
/** Bug 83: a Bash command Claude Code let a repair engineer run, kept whole on its event. HQ takes a new test command only when the engineer
 *  ran it this way first (auto.ts ranByEngineer): its own sandbox runs commands that Claude Code refuses in an engineer's session. A refused
 *  command fires PostToolUseFailure with Claude Code's reason; one that ran and failed says "Exit code N" (both seen on 2.1.300). */
const ranBash = (agent: Agent, tool: string, input: Record<string, unknown>, error?: unknown): string | undefined => {
  // a repair's commands (may it propose this test command? Bug 83), and a helper's (Bug 411: which test steps an agent's session can run)
  if (tool !== 'Bash' || (error !== undefined && !/^Exit code \d/.test(String(error))) || !(agent.role === 'launcher' || getTicket(agent.ticket_id ?? '')?.repairs_main)) return undefined
  return String(input.command ?? '').slice(0, 8000)
}

function describeTool(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') return `Running: ${trim(input.command, 80)}`
  if (tool === 'Edit' || tool === 'Write' || tool === 'Read') return `${tool === 'Read' ? 'Reading' : 'Editing'} ${String(input.file_path ?? '').split('/').slice(-2).join('/')}`
  if (tool.startsWith('mcp__hq__')) return `Calling hq.${tool.slice(9)}`
  if (tool === 'ExitPlanMode') return 'Submitting plan'
  if (tool === 'Agent') return `Subagent: ${trim(input.description, 60)}`
  return tool
}

/** When each agent's main loop last started a turn (UserPromptSubmit; `start`: the mod's turn.start) and last ended one (Stop), as steps of one counter, not
 *  clock times: a prompt and its Stop can share a millisecond (Bug 80). In memory, rebuilt from the events log at start-up (rebuildTurns, Bug 281). */
const turns = new Map<string, { prompt: number; stop: number; start?: { id: string; at: number } }>()
let turnSeq = 0
/** Bug 281: after a restart, each live agent's last prompt, Stop and own turn.start since its session last began, from the events log, so a quick Escape
 *  on a turn that started before the restart still ends it (endedWithoutStop). Event ids are a counter too, so they keep the order; the counter goes on
 *  above them. A batch handed over in a Stop hook's answer (Bug 103) counts as a prompt, as it does when it happens (its `batch.acked`). */
export function rebuildTurns(): void {
  turns.clear()
  const last = (agentId: string, since: number, where: string): number =>
    one<{ id: number | null }>(`SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND id > ? AND ${where}`, agentId, since)?.id ?? 0
  for (const a of liveAgents()) {
    const since = last(a.id, 0, "kind = 'hook.SessionStart'")
    const prompt = Math.max(last(a.id, since, "kind = 'hook.UserPromptSubmit'"), last(a.id, since, `kind = 'batch.acked' AND json_extract(payload, '$.id') IN
      (SELECT id FROM batches WHERE method = 'stop_hook')`))
    const stop = last(a.id, since, "kind = 'hook.Stop'")
    const start = one<{ id: number; turn: unknown }>(`SELECT id, json_extract(payload, '$.turnId') AS turn FROM events WHERE agent_id = ? AND id > ?
      AND kind = 'mod.turn.start' AND COALESCE(json_extract(payload, '$.agentId'), '') = '' ORDER BY id DESC LIMIT 1`, a.id, since)
    turns.set(a.id, { prompt, stop, ...(start ? { start: { id: String(start.turn ?? ''), at: start.id } } : {}) })
    turnSeq = Math.max(turnSeq, prompt, stop, start?.id ?? 0)
  }
}
/** Bug 268: a turn that ended while HQ was down (a quick Escape or No on a dialog, or a Stop: only permission requests wait for HQ, hookwait.mjs) sent its
 *  sign to no one, so the box would say "working" until the stuck loop's screen check. Once at start-up, after the helpers and runs are read back: an
 *  agent HQ has working in its own turn whose status file says idle, changed after the last hook HQ had from it, with no menu on screen, has ended that
 *  turn (turnOver: idle unless a helper or a run of its own still goes). Anything unknown leaves it as it is. */
export async function lookAtTurnsAtStart(): Promise<void> {
  const ended: string[] = []
  for (const was of liveAgents()) {
    if (was.status !== 'working' || beingStopped(was.id)) continue
    const since = one<{ id: number }>("SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND kind = 'hook.SessionStart'", was.id)?.id ?? 0
    if (turnHadEnded(was, since)) continue // its turn ended and a helper or run keeps it working: nothing was lost
    const p = presenceOf(was.claude_session_id)
    if (!p || p.status !== 'idle' || p.statusUpdatedAt <= (was.last_event_at ?? was.started_at)) continue
    const screen = await tmux.visiblePane(was.tmux_session)
    const a = getAgent(was.id) // after the wait on tmux (Bug 138): a hook since means HQ knows better now
    if (!a || a.status !== 'working' || beingStopped(a.id) || a.last_event_at !== was.last_event_at || paneShowsDialog(screen)) continue
    turnOver(a.id)
    emit({ agentId: a.id, source: 'system', kind: 'agent.turn_ended_away', payload: { status: getAgent(a.id)?.status ?? null } }); ended.push(a.id)
  }
  emit({ agentId: null, source: 'system', kind: 'turn.start_look', payload: { ended } }) // the look is over (tests wait for it)
}
/** Bug 94: the helpers each agent's main loop started in the background itself (the Agent tool), helper id → description. While
 *  one runs the agent is working, even after its turn ended. Claude Code's own helpers never get here (Bug 25). In memory, and in the events log
 *  (Bug 232): a start's `helper` + `helperWhat`, an end's `helper` (SubagentStop) or `helpersDone` (a prompt with their notices). */
const helpers = new Map<string, Map<string, string>>()
const helperActivity = (m: Map<string, string>): string => `Subagent: ${[...m.values()].at(-1)}${m.size > 1 ? ` (+${m.size - 1} more)` : ''}`
/** What the agent still waits on once its turn has ended: a helper (Bug 94) or a run in the background (Bug 95, bgruns.ts). Null: nothing. */
const stillOn = (id: string, m: Map<string, string>): string | null => m.size ? helperActivity(m) : waitingText(id)
/** The stuck loop saw the agent's idle prompt for minutes: nothing HQ thought was running is. */
export function forgetHelpers(agentId: string): void { helpers.delete(agentId) }
/** Bug 232: after a restart, each live agent's helpers from the events log since its session last began. All end with the session, or when the stuck
 *  loop saw the idle prompt (agent.idle_fixed). A start logged before this was kept (no `helperWhat`) is left out: its end wasn't logged either. Like
 *  rebuildRuns (Bug 203), an agent whose turn had ended says again what it waits on; run after it, as a helper comes first in stillOn. */
export function rebuildHelpers(): void {
  helpers.clear()
  for (const a of liveAgents()) {
    const since = one<{ id: number }>("SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND kind = 'hook.SessionStart'", a.id)?.id ?? 0, m = new Map<string, string>()
    for (const e of q<{ kind: string; payload: string }>(`SELECT kind, payload FROM events WHERE agent_id = ? AND id > ? AND kind IN
      ('hook.PostToolUse:Agent', 'hook.SubagentStop', 'hook.UserPromptSubmit', 'hook.SessionEnd', 'agent.idle_fixed') ORDER BY id`, a.id, since)) {
      const p = JSON.parse(e.payload) as { helper?: string; helperWhat?: string; helpersDone?: string[] }
      if (e.kind === 'hook.PostToolUse:Agent') { if (p.helper && typeof p.helperWhat === 'string') m.set(p.helper, p.helperWhat) }
      else if (e.kind === 'hook.SubagentStop') { if (p.helper) m.delete(p.helper) }
      else if (e.kind === 'hook.UserPromptSubmit') { for (const h of p.helpersDone ?? []) m.delete(h) }
      else m.clear()
    }
    if (!m.size) continue
    helpers.set(a.id, m); if (turnHadEnded(a, since)) patch('agent', a.id, { activity: helperActivity(m) })
  }
}
/** Bug 148: the agent's own turn was interrupted (Escape in its terminal), as its mod tells it. No Stop hook comes for such a turn, so this is where it ends:
 *  the agent is idle at once, with no activity line, unless a helper or a run in the background of its own still goes (Bugs 94, 95). It counts as a sign of
 *  life (an engineer's idle time starts here, bgruns.ts idleTooLong). Only a working agent: a plan review or a pause has its own way out, and one on a dialog
 *  gets here once HQ has seen the dialog is gone (Bug 188, onDialogEnd). `why` (Bug 289): the turn ended with no Stop hook and no interrupt (Escape or No
 *  on a dialog), so nothing in the Events tab would say so: it gets a line ('no_stop': at the mod's turn.complete; 'dialog': once its dialog had gone).
 *  True: that line was written. */
function turnOver(agentId: string, afterDialog = false, why?: 'no_stop' | 'dialog'): boolean {
  const a = getAgent(agentId) // read again: turnEnded has just written to it. Bug 188: after a dialog's clear, idle or working by its status file
  if (!a || !(a.status === 'working' || (afterDialog && a.status === 'idle'))) return false
  const turn = turns.get(agentId); if (turn) turn.stop = ++turnSeq // a helper that ends from now on leaves it idle (SubagentStop)
  const on = stillOn(agentId, helpers.get(agentId) ?? new Map())
  update(agentId, { status: on ? 'working' : 'idle', last_event_at: now() }, { activity: on }) // one patch (Bug 98)
  if (why) emit({ agentId, source: 'system', kind: 'agent.turn_over', payload: { why, still: on } })
  return !!why
}
/** Bug 254: the turn the mod says is complete (`turnId`) ended with no Stop hook: it is the last one the mod said started (turn.start), and no prompt and no
 *  Stop came after that start. A turn that ends normally sends its Stop before the mod's turn.complete; the prompt a mod submits once the agent is idle
 *  (a waiting batch) can reach HQ before the turn.complete of the turn before it; and a Stop answered with a block (Bug 103) sends no turn.complete or
 *  turn.start, only the Stop of the turn it goes on with (all seen on 2.1.322). A start before a restart is read back (Bug 281). Nothing known: no. */
const endedWithoutStop = (agentId: string, turnId: unknown): boolean => {
  const s = turns.get(agentId); return !!s?.start && s.start.id === String(turnId ?? '') && s.prompt < s.start.at && s.stop < s.start.at
}
/** Bug 297: the mod's late turn.complete (sent again once HQ was back) of a turn that ended normally, with no Stop hook since it started: the Stop
 *  hook went to an HQ that was down. Not an interrupt, not an API error (a StopFailure, which isn't a Stop), and not a turn that ended at a tool call
 *  (Escape or No on a dialog: no Stop hook comes for it even with HQ up, and its `reason` is 'answer' too; checked on 2.1.322). From the events log, not
 *  `turns`: the start-up look (lookAtTurnsAtStart) may have ended the turn already. A mod from before this change sends no turn.complete late. */
const stopLost = (agentId: string, body: Record<string, unknown>): boolean =>
  body.isAborted !== true && (body.reason ?? 'answer') === 'answer' && body.atTool === false && noEndHeard(agentId, body.turnId)
/** Bugs 297, 367: HQ heard the mod's start of this turn of the agent's own, and no Stop, StopFailure or prompt since. */
const noEndHeard = (agentId: string, turnId: unknown): boolean => {
  const start = one<{ id: number | null }>(`SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND kind = 'mod.turn.start' AND json_extract(payload, '$.turnId') = ?
    AND COALESCE(json_extract(payload, '$.agentId'), '') = ''`, agentId, String(turnId ?? ''))?.id
  return !!start && !one(`SELECT 1 AS x FROM events WHERE agent_id = ? AND id > ? AND kind IN ('hook.Stop', 'hook.StopFailure', 'hook.UserPromptSubmit') LIMIT 1`, agentId, start)
}
/** Bug 367: the mod's late turn.complete of a turn that ended on an API error (API_ENDED), with no Stop or StopFailure since it started: its StopFailure
 *  hook (fire-and-forget, never waits for HQ) went to an HQ that was down. 2.1.322 sends a StopFailure, never a Stop, for every turn whose last reply is an
 *  API error message, a refusal too; a turn that ends on a model error sends neither (Bug 386), but it ended on an error all the same. */
const failureLost = (agentId: string, body: Record<string, unknown>): boolean =>
  body.isAborted !== true && API_ENDED.has(String(body.reason)) && noEndHeard(agentId, body.turnId)
/** Bug 367: what the lost StopFailure hook would have done (handleHook 'StopFailure'): blocked on the API error, no activity line, its ⚠. Logged as a
 *  `hook.StopFailure` marked `away` ("Turn failed while HQ was down"), so a restart and the start-up look read it as they read a real one. The error's own
 *  words went with the hook; the mod only knows the reason. An agent that has ended since keeps its end. */
function failedWhileAway(agent: Agent, reason: string): void {
  const a = getAgent(agent.id); if (!a || a.status === 'exited') return
  const what = reason === 'refusal' ? 'the API refused its reply' : 'an API error'
  update(a.id, { status: 'blocked', blocked_why: 'api_error', last_event_at: now() }, { activity: null }) // one patch (Bug 98)
  emit({ agentId: a.id, source: 'mod', kind: 'hook.StopFailure', payload: { event: 'StopFailure', tool: '', error: what, reason, away: true } })
  attention('api_error', `${a.display_name ?? a.id}: turn ended with an API error while HQ was down${reason === 'refusal' ? ` (${what})` : ''}`,
    { agentId: a.id, ticketId: a.ticket_id })
}
/** Bug 297: what the lost Stop hook would have done (handleHook 'Stop'): the turn is over, the TPM's answer is its reply (the 💬 line and Messages), and
 *  the agent is idle unless a helper or a run of its own still goes. The start-up look (lookAtTurnsAtStart) may have made it idle already. Logged as a
 *  `hook.Stop` marked `away`, so what listens for the end of a turn hears it (a finished engineer's stop, its turn to build, auto mode's look) and a
 *  restart reads it back (rebuildTurns). */
function stoppedWhileAway(agent: Agent, answer: string): void {
  const turn = turns.get(agent.id); if (turn) turn.stop = ++turnSeq
  if (agent.role === 'tpm') recordReply(agent, answer)
  const on = stillOn(agent.id, helpers.get(agent.id) ?? new Map()), a = getAgent(agent.id)
  if (a?.status === 'working') update(agent.id, { status: on ? 'working' : 'idle', last_event_at: now() }, { activity: on, last_message: trim(answer, 2000) })
  else patch('agent', agent.id, { last_message: trim(answer, 2000) })
  emit({ agentId: agent.id, source: 'mod', kind: 'hook.Stop', payload: { event: 'Stop', tool: '', last: trim(answer, 600), away: true } })
}
/** Bug 346: the last event id when the hooks server started listening: what is logged after it, HQ heard since it came back. */
let upFrom = 0
/** Bug 346: the mod's late turn.start (sent again once HQ was back, Bug 297) of a turn that still goes: its UserPromptSubmit hook went to an HQ that was
 *  down, so the box said idle until the turn's Stop. Working now, as that hook would have made it ('Thinking' until its next tool call says more), and
 *  an API error before it is over. Not a turn the mod saw end (`over`: its turn.complete comes next, Bug 297), not when HQ heard a Stop, an API error or
 *  the mod's end of a turn since it came back (this turn's, which started while HQ was down, so the start is old news), not an agent HQ has working
 *  (a hook since), stopping, on a dialog or paused. */
function startedWhileAway(agent: Agent): void {
  const a = getAgent(agent.id)
  if (!a || beingStopped(a.id) || !(a.status === 'idle' || (a.status === 'blocked' && a.blocked_why === 'api_error'))) return
  if (one(`SELECT 1 AS x FROM events WHERE agent_id = ? AND id > ? AND (kind IN ('hook.Stop', 'hook.StopFailure')
    OR (kind = 'mod.turn.complete' AND COALESCE(json_extract(payload, '$.agentId'), '') = '')) LIMIT 1`, a.id, upFrom)) return
  update(a.id, { status: 'working', last_event_at: now() }, { activity: 'Thinking' }) // one patch (Bug 98)
  if (a.status === 'blocked') resolveKind('api_error', a.id)
  emit({ agentId: a.id, source: 'system', kind: 'agent.turn_started_away', payload: { was: a.status } })
}
/** Bug 386: how long HQ waits for a StopFailure once the mod's turn.complete says a turn of the agent's own ended on an error (API_ENDED) with no Stop.
 *  2.1.322 sends StopFailure without waiting for it, so it can reach HQ before or after turn.complete; a turn that ends on a model error (the query loop's
 *  `reason: 'model_error'`: the model policy excludes the model, a usage-credits consent unanswered or declined, model_blocked, its catch-all for a thrown
 *  error) sends none at all, and nothing would say it failed. In memory, and read back at start-up from the events log (waitForFailuresAtStart). */
const FAILURE_WAIT_MS = Number(process.env.HQ_FAILURE_WAIT_S ?? 10) * 1000
const failureWaits = new Map<string, NodeJS.Timeout>()
/** Bug 386: the turn `turnId` is the agent's latest own turn (the mod's turn.start), and HQ heard no Stop, StopFailure or prompt since it started. */
const failureUnheard = (agentId: string, turnId: string): boolean => {
  const start = one<{ id: number; turn: unknown }>(`SELECT id, json_extract(payload, '$.turnId') AS turn FROM events WHERE agent_id = ? AND kind = 'mod.turn.start'
    AND COALESCE(json_extract(payload, '$.agentId'), '') = '' ORDER BY id DESC LIMIT 1`, agentId)
  return !!start && String(start.turn ?? '') === turnId
    && !one(`SELECT 1 AS x FROM events WHERE agent_id = ? AND id > ? AND kind IN ('hook.Stop', 'hook.StopFailure', 'hook.UserPromptSubmit') LIMIT 1`, agentId, start.id)
}
/** Bug 386: HQ said the agent's current turn failed (failedUnheard, or Bug 367's failedWhileAway after a restart) and no new turn started since: a
 *  StopFailure for it that comes now is old news. */
const failureTold = (agentId: string): boolean => !!one(`SELECT 1 AS x FROM events WHERE agent_id = ? AND kind = 'hook.StopFailure'
  AND (json_extract(payload, '$.unheard') = 1 OR json_extract(payload, '$.away') = 1) AND id > COALESCE((SELECT MAX(id) FROM events WHERE agent_id = ? AND (kind = 'hook.UserPromptSubmit'
  OR (kind = 'mod.turn.start' AND COALESCE(json_extract(payload, '$.agentId'), '') = ''))), 0) LIMIT 1`, agentId, agentId)
/** Bug 386: wait FAILURE_WAIT_MS from `from` (the turn.complete) for the turn's StopFailure; nothing heard by then, HQ says the turn failed. */
function waitForFailure(agentId: string, turnId: string, reason: string, from = now()): void {
  clearTimeout(failureWaits.get(agentId)); failureWaits.delete(agentId)
  if (!failureUnheard(agentId, turnId)) return // its StopFailure came first
  const t = setTimeout(() => { failureWaits.delete(agentId); failedUnheard(agentId, turnId, reason) }, Math.max(0, from + FAILURE_WAIT_MS - now()))
  t.unref(); failureWaits.set(agentId, t)
}
/** Bug 386: what a StopFailure would have done (handleHook 'StopFailure'): blocked on the error, no activity line, its ⚠, and a "Turn failed" line. Logged
 *  as a `hook.StopFailure` marked `unheard`, so a restart reads it as it reads a real one, and a real one that comes after it adds nothing (failureTold).
 *  The error's own words are only on the agent's screen. Read again: a new turn, a Stop hook, the agent's end or Stop pressed in HQ may have come meanwhile. */
function failedUnheard(agentId: string, turnId: string, reason: string): void {
  const a = getAgent(agentId); if (!a || a.status === 'exited' || beingStopped(a.id) || !failureUnheard(a.id, turnId)) return
  const what = reason === 'refusal' ? 'the API refused its reply' : 'its terminal says which'
  update(a.id, { status: 'blocked', blocked_why: 'api_error', last_event_at: now() }, { activity: null }) // one patch (Bug 98)
  emit({ agentId: a.id, source: 'system', kind: 'hook.StopFailure', payload: { event: 'StopFailure', tool: '', error: `an error (${what})`, reason, unheard: true } })
  attention('api_error', `${a.display_name ?? a.id}: turn ended with an error (${what})`, { agentId: a.id, ticketId: a.ticket_id })
}
/** Bug 386: after a restart, an agent whose last own turn ended on an error HQ was still waiting to hear of waits out the rest of its time. */
export function waitForFailuresAtStart(): void {
  for (const a of liveAgents()) {
    const since = one<{ id: number }>("SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND kind = 'hook.SessionStart'", a.id)?.id ?? 0
    const c = one<{ payload: string; at: number }>(`SELECT payload, created_at AS at FROM events WHERE agent_id = ? AND id > ? AND kind = 'mod.turn.complete'
      AND COALESCE(json_extract(payload, '$.agentId'), '') = '' ORDER BY id DESC LIMIT 1`, a.id, since)
    const b = c ? JSON.parse(c.payload) as Record<string, unknown> : null // a late one is Bug 367's (the mod sent it again once HQ was back)
    if (b && b.isAborted !== true && b.late !== true && API_ENDED.has(String(b.reason))) waitForFailure(a.id, String(b.turnId ?? ''), String(b.reason), c!.at)
  }
}
/** Bug 188: Escape or a denial on a dialog ends the turn with no Stop hook, and the mod's `turn.complete` says isAborted false (checked on 2.1.322). Once HQ
 *  has seen the dialog gone, the turn ends as above, unless a new one has started since (a prompt typed or sent meanwhile). `say`: it ended with no Stop and
 *  no line says so yet (Bug 289). */
const onDialogEnd = (agentId: string, say = false): (() => void) => {
  const at = turns.get(agentId)?.prompt ?? 0
  return () => { if ((turns.get(agentId)?.prompt ?? 0) === at) turnOver(agentId, true, say ? 'dialog' : undefined) }
}
function handleHook(agent: Agent, body: Record<string, unknown>, res: http.ServerResponse): void {
  const ev = String(body.hook_event_name ?? ''); const tool = String(body.tool_name ?? ''); const input = (body.tool_input ?? {}) as Record<string, unknown>
  const mode = body.permission_mode as string | undefined; const t = now()
  const fields: Partial<Agent> = { last_event_at: t } // agent columns
  const live: { activity?: string | null; last_message?: string } = {} // not columns: patches (the line is kept for a restart, agents.ts keepLine)
  if (mode) fields.in_plan_mode = mode === 'plan' ? 1 : 0
  const payload: Record<string, unknown> = { event: ev, tool, mode }
  const cleared = ev === 'SessionEnd' && body.reason === 'clear' // /clear: the same session goes on with a fresh context
  // Bug 25: hooks from a helper agent (a subagent, or Claude Code's own background helpers) carry agent_id. They can run after
  // the main turn has ended, so they never make the agent "working"; only the main loop's turns do.
  const sub = typeof body.agent_id === 'string' && body.agent_id !== ''
  if (sub) payload.sub = true
  const turn = turns.get(agent.id) ?? { prompt: 0, stop: 0 }; turns.set(agent.id, turn)
  const bg = helpers.get(agent.id) ?? new Map<string, string>(); helpers.set(agent.id, bg); const helperId = String(body.agent_id ?? '')
  if (ev !== 'SessionEnd') tellIfHqWasAway(agent) // Bug 85: it was told to wait for HQ, and HQ is answering again
  switch (ev) {
    case 'SessionStart': { bg.clear(); endRuns(agent.id, 'all', 'session'); Object.assign(payload, { source: body.source, model: body.model, cwd: body.cwd })
      // Bug 324: both rows take the same values, a missing session id or transcript as null (SQLite refuses undefined, and the whole hook was dropped)
      const sid = String(body.session_id ?? '') || null, transcript = typeof body.transcript_path === 'string' ? body.transcript_path : null
      Object.assign(fields, { claude_session_id: sid, transcript_path: transcript, status: 'working' })
      run('UPDATE sessions SET claude_session_id = ?, transcript_path = ? WHERE agent_id = ? AND ended_at IS NULL', sid, transcript, agent.id); break }
    case 'UserPromptSubmit': { turn.prompt = ++turnSeq; payload.prompt = trim(body.prompt, 200); fields.status = 'working'; live.activity = 'Thinking'
      const done = [...String(body.prompt ?? '').matchAll(/<task-id>([\w-]+)<\/task-id>/g)].map((m) => m[1]!) // a helper's or a background run's "done" notice
      const ended = done.filter((task) => bg.delete(task)); if (ended.length) payload.helpersDone = ended // Bug 232: logged, for rebuildHelpers
      endRuns(agent.id, done, 'done') // Bugs 94, 95
      payload.acked = ackBatchFromPrompt(agent, String(body.prompt ?? '')); break }
    case 'PreToolUse': payload.input = trim(input, 300); if (!sub) fields.status = 'working'
      if (tool === 'Bash') Object.assign(payload, { use: body.tool_use_id, timeout: input.timeout }) // leftovers.ts: which command, and how long it may run
      if (sub && bg.has(helperId)) live.activity = `Subagent: ${bg.get(helperId)} · ${describeTool(tool, input)}`
      else if (!sub || agent.status === 'working') live.activity = describeTool(tool, input); break
    // A helper that finishes after the main turn ended (Stop, and no prompt since) leaves the agent idle, whatever set it working,
    // unless a background helper the agent started is still running (Bug 94)
    case 'SubagentStop': if (bg.delete(helperId)) payload.helper = helperId // Bug 232: logged, for rebuildHelpers
      if (turn.stop > turn.prompt && agent.status === 'working') { const on = stillOn(agent.id, bg); if (on) live.activity = on; else { fields.status = 'idle'; live.activity = null } } break
    case 'PostToolUse': Object.assign(payload, { input: trim(input, 200), use: body.tool_use_id })
      if (tool === 'ExitPlanMode') payload.responsePlanLen = String((body.tool_response as { plan?: string } | undefined)?.plan ?? '').length
      if (tool === 'Agent' && !sub) { const r = (body.tool_response ?? {}) as { isAsync?: boolean; agentId?: unknown; description?: unknown }
        if (r.isAsync && typeof r.agentId === 'string') {
          const what = trim(r.description ?? input.description, 60); bg.set(r.agentId, what); Object.assign(payload, { helper: r.agentId, helperWhat: what }) } }
      if (tool === 'Bash' && !sub) { // Bug 95: still running in the background, and the agent waits on it
        const its = getRepo(repoOfAgent(agent) ?? ''), task = watchedTask(input, body.tool_response, its ? gateCmds(its.test_cmd, stepsOf(its.id)) : null)
        if (task) { addRun(agent.id, { task, use: String(body.tool_use_id ?? ''), command: String(input.command ?? '') }); payload.bg = task } }
      payload.ran = ranBash(agent, tool, input); if (tool === 'Bash') payload.suite = suiteRan(agent, String(input.command ?? '')); break
    case 'PostToolUseFailure': Object.assign(payload, { input: trim(input, 200), use: body.tool_use_id, error: trim(body.error, 300), is_interrupt: body.is_interrupt })
      payload.ran = ranBash(agent, tool, input, body.error ?? ''); if (tool === 'Bash') payload.suite = suiteRan(agent, String(input.command ?? ''), String(body.error ?? '')); break
    case 'Stop': { turn.stop = ++turnSeq; payload.last = trim(body.last_assistant_message, 600); const on = stillOn(agent.id, bg); fields.status = on ? 'working' : 'idle'
      if (agent.interrupted_at) fields.interrupted_at = null // Bug 110: a turn ended normally (an interrupted one sends no Stop), so the mod's prompts get through again
      Object.assign(live, { activity: on, last_message: trim(body.last_assistant_message, 2000) })
      if (agent.role === 'tpm') recordReply(agent, String(body.last_assistant_message ?? '')); break }
    // Bug 72: no dialog, the turn just ended with an error. It waits at its prompt for a message, isn't "waiting on a dialog", and isn't "Thinking"
    case 'StopFailure': payload.error = trim(body.error ?? body, 400); Object.assign(fields, { status: 'blocked', blocked_why: 'api_error' }); live.activity = null
      if (failureTold(agent.id)) payload.told = true; break // Bug 386: HQ already said this turn failed: no second line or ⚠
    case 'Notification': Object.assign(payload, { ntype: body.notification_type, message: trim(body.message, 200) }); break
    case 'PostModelSwitch': case 'PreModelSwitch': Object.assign(payload, { from: body.from_model, to: body.to_model, source: body.source, requested: body.requested_model }); break
    case 'PreCompact': case 'PostCompact': payload.trigger = body.trigger; break
    case 'ConfigChange': Object.assign(payload, { csource: body.source, file: body.file_path }); break
    case 'SessionEnd': payload.reason = body.reason; bg.clear(); if (cleared) break
      endRuns(agent.id, 'all', 'session')
      Object.assign(fields, { status: 'exited', ended_at: t, ended_why: `session:${String(body.reason ?? '')}` }); live.activity = null; run('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE agent_id = ? AND ended_at IS NULL', t, String(body.reason ?? ''), agent.id); break
    case 'TaskCreated': case 'TaskCompleted': payload.task = trim(body.task ?? body, 300); break
  }
  if (fields.status && fields.status !== 'paused' && agent.paused_reason?.startsWith('quota_auto_resume')) { // the usage wait is over: a turn moved on
    fields.paused_reason = null; resolveKind('usage_limit', agent.id)
  }
  // Bug 178: a turn after an API error started (or one ended normally), so that error is over. An ended agent's stays: auto mode acts on it
  if ((ev === 'UserPromptSubmit' || ev === 'Stop') && agent.status !== 'exited') resolveKind('api_error', agent.id)
  // a late hook from a session HQ already counts as gone doesn't bring it back, or say why it went
  if (agent.status === 'exited') { delete fields.status; delete fields.ended_why; delete fields.blocked_why }
  update(agent.id, fields, agent.status !== 'exited' ? live : {}) // one patch (Bug 98)
  const row = emit({ agentId: agent.id, sessionId: String(body.session_id ?? ''), source: 'hook', kind: `hook.${ev}${tool ? ':' + tool : ''}`, payload })
  if (payload.suite && !payload.bg && row.id) keepState(agent, row.id, String(input.command ?? ''), String(body.tool_use_id ?? '')) // Bug 194: what the worktree held when the test command was over
  if (!sub && DIALOG_MAY_BE_OVER.has(ev) && agent.status !== 'exited') dialogMayBeOver(agent.id, `hook:${ev}`) // Bug 188: after the update, which the look reads
  // Bug 107: a Bash command of an engineer's (or of a helper of its: same session, same worktree) is over. Was it the project's test command, refused by Claude Code?
  if (tool === 'Bash' && (ev === 'PostToolUse' || ev === 'PostToolUseFailure')) sawTestCmd(agent, String(input.command ?? ''), ev === 'PostToolUse' ? undefined : String(body.error ?? ''))

  // ---- decisions ----
  if (ev === 'PermissionRequest') {
    if (tool === 'ExitPlanMode') return onExitPlanMode(agent, body, res)
    const inPlan = mode === 'plan'
    if (tool.startsWith('mcp__hq__')) return json(res, 200, allow())
    if (tool === 'Bash' && !inPlan && (agent.role === 'engineer' || agent.role === 'launcher')) return json(res, 200, allow()) // sandboxed either way
    if (tool === 'Bash' && inPlan) return json(res, 200, deny(`HQ: '${trim(input.command, 80)}' is not allowed during planning; run it after plan approval.`))
    attention('unexpected_prompt', `${agent.display_name ?? agent.id}: ${tool} needed approval (${trim(input, 120)}); denied by policy`, { agentId: agent.id, ticketId: agent.ticket_id })
    return json(res, 200, deny(`HQ: '${tool}' would need approval and is not allowed here. Continue without it, or report_blocked if you cannot.`))
  }
  // Bug 76: a build or a full test run waits here for its turn; the answer is what lets the command start. The agent itself and each helper of its run one tool
  // at a time, so the next tool starting (or a helper finishing) means the turn its last command held is free
  const lane = sub ? String(body.agent_id) : 'main'
  if (ev === 'PreToolUse' || ev === 'SubagentStop') laneMoved(agent.id, lane, ev === 'PreToolUse' && tool === 'Bash' ? String(body.tool_use_id ?? '') : '') // Bug 145: asked again
  // Bug 213: a test run with a command after it that may change files starts once HQ has what the worktree holds before it (suiteran.ts)
  const goAhead = (): void => { const p = row.id ? keepBefore(agent, String(input.command ?? ''), row.id, input.run_in_background === true) : null
    if (!p) return json(res, 200, {}); void p.then(() => { if (!res.writableEnded && !res.destroyed) json(res, 200, {}) }) }
  if (ev === 'PreToolUse' && tool === 'Bash' && gateBash(agent, { use: String(body.tool_use_id ?? ''), command: String(input.command ?? ''), timeout: input.timeout,
    background: input.run_in_background === true, lane, plan: mode === 'plan', activity: describeTool(tool, input) }, res, goAhead)) return
  if (ev === 'PreToolUse' && tool === 'Bash') return goAhead()
  if (ev === 'PreModelSwitch') return json(res, 200, { hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'deny', permissionDecisionReason: 'HQ controls models for this agent.' } })
  if (ev === 'PostModelSwitch') { onPostModelSwitch(agent, body); return json(res, 200, {}) }
  if (ev === 'ConfigChange') return json(res, 200, agent.role === 'engineer' || agent.role === 'launcher' ? { decision: 'block', reason: 'HQ: configuration changes are not allowed' } : {})
  if (ev === 'PreCompact' && agent.role === 'tpm' && body.trigger === 'auto') { attention('tpm_rotate', `TPM ${agent.id}: Claude Code wanted to compact its memory; HQ blocked it. Fresh start the TPM`, { agentId: agent.id }); return json(res, 200, { decision: 'block', reason: 'HQ fresh-starts the TPM instead of compacting' }) }
  if (ev === 'PostToolUse' && tool === 'ExitPlanMode') { onPostExitPlanMode(agent, body); return json(res, 200, atStep(agent, ev, sub, body)) } // its plan's OK: it builds next
  if (ev === 'PostToolUse' && (tool === 'TaskCreate' || tool === 'TaskUpdate')) { recordTask(agent, tool, input, body.tool_response as Record<string, unknown> | undefined) }
  if (ev === 'UserPromptSubmit' || ev === 'Stop') {
    if (ev === 'Stop' && !sub) wake(agent.id) // Bug 370: what waited for its next step goes to the mod now, though a helper may keep it 'working'
    const ctx: string[] = []
    // Only as a turn starts (Bug 139): on Stop the note made the agent answer it, again and again, and never go idle for the message to come in
    const unread = ev === 'UserPromptSubmit' ? unreadCount(agent) : 0
    if (unread) ctx.push(`HQ: ${unread} unread message(s) are queued and will arrive as a new turn when you are idle.`)
    if (agent.ticket_id) { const rv = openReviews().find((r) => r.ticket_id === agent.ticket_id); if (rv) ctx.push(`HQ: plan review R-${rv.round} is pending; if your ExitPlanMode call was denied without an HQ message, call ExitPlanMode again without changing the plan.`) }
    if (ev === 'Stop') { const modAlive = agent.mod_seen_at && t - agent.mod_seen_at < 120_000; const pend = pendingFor(agent)
      // The mod has gone quiet: the batch goes in this answer, and the turn goes on with it (Bug 103). So the agent is working again, as
      // after a prompt: a finished engineer isn't stopped while it reads the message, and a helper ending now doesn't make it idle.
      if (!modAlive && pend.length && !(agent.takeover_locked_until && agent.takeover_locked_until > t)) { const b = nextBatchFor({ ...agent, interrupted_at: null }); if (b) {
        deliveredByStopHook(agent, b.id); turn.prompt = ++turnSeq; update(agent.id, { status: 'working' }, { activity: 'Thinking' }) // one patch (Bug 98)
        return json(res, 200, { decision: 'block', reason: `HQ message batch ${b.id}:\n${b.text}` }) } } }
    return json(res, 200, ctx.length ? { hookSpecificOutput: { hookEventName: ev, additionalContext: ctx.join('\n') } } : {})
  }
  if (ev === 'Notification') { // Bug 62: exact names. elicitation_response and _complete mean a dialog ended, and quota_auto_resume_fired that Claude Code carries on
    const nt = String(body.notification_type ?? ''), who = agent.display_name ?? agent.id
    if (nt === 'permission_prompt' && /plan/i.test(String(body.message ?? ''))) { /* gate open; not stuck */ }
    else if (DIALOGS.has(nt)) { update(agent.id, { status: 'blocked', blocked_why: 'dialog' })
      attention('dialog', `${who}: ${trim(body.message, 160)}`, { agentId: agent.id, ticketId: agent.ticket_id }) }
    else if (nt === 'quota_auto_resume_stale' || nt === 'quota_auto_resume_disabled') {
      update(agent.id, { status: 'paused', paused_reason: nt }); attention('usage_limit', `${who}: ${trim(body.message, 160)}`, { agentId: agent.id })
    } else if (nt === 'quota_auto_resume_fired') {
      if (agent.status === 'paused') update(agent.id, { status: 'working' })
      if (agent.paused_reason?.startsWith('quota_auto_resume')) update(agent.id, { paused_reason: null })
      resolveKind('usage_limit', agent.id)
    }
    return json(res, 200, {})
  }
  if (ev === 'StopFailure' && !payload.told) { attention('api_error', `${agent.display_name ?? agent.id}: turn ended with an API error: ${trim(body.error ?? body, 200)}`, { agentId: agent.id, ticketId: agent.ticket_id }) }
  if (ev === 'SessionEnd' && !cleared) { revokeToken(agent.id); resolveKind('dialog', agent.id) } // the session is over: its token is no good to anyone now, and it has no dialog
  if (ev === 'SessionEnd' && !cleared && !agent.fresh_start_at && agent.role === 'engineer' && agent.ticket_id) { const tk = getTicket(agent.ticket_id); if (tk && !['pr_ready', 'pr_open', 'merged', 'cancelled'].includes(tk.status)) attention('engineer_exited', `${agent.display_name ?? agent.id} exited with ticket ${tk.key} in status ${tk.status}`, { agentId: agent.id, ticketId: agent.ticket_id }) }
  if (ev === 'PostToolUse' || (ev === 'PostToolUseFailure' && body.is_interrupt !== true)) return json(res, 200, atStep(agent, ev, sub, body))
  return json(res, 200, {})
}

/** Bug 370: the answer to the agent's own tool step (not a helper's): what can't wait for its turn to end goes in with it (stepNotes). */
function atStep(agent: Agent, ev: string, sub: boolean, body: Record<string, unknown>): Record<string, unknown> {
  const notes = sub ? null : stepNotes(agent.id, now(), String(body.tool_use_id ?? '')); return notes ? { hookSpecificOutput: { hookEventName: ev, additionalContext: notes } } : {}
}
function recordTask(agent: Agent, tool: string, input: Record<string, unknown>, resp: Record<string, unknown> | undefined): void {
  const taskId = String(input.taskId ?? input.id ?? resp?.id ?? resp?.taskId ?? '')
  const subject = input.subject ?? input.content ?? resp?.subject; const status = input.status ?? (tool === 'TaskCreate' ? 'pending' : undefined)
  if (!taskId && !subject) return
  const key = taskId || `${agent.id}:${String(subject).slice(0, 40)}`
  const existing = one<{ id: string; status: string }>('SELECT id, status FROM task_progress WHERE agent_id = ? AND task_id = ?', agent.id, key)
  if (existing) run('UPDATE task_progress SET subject = COALESCE(?, subject), status = COALESCE(?, status), updated_at = ? WHERE id = ?', subject ? String(subject) : null, status ? String(status) : null, now(), existing.id)
  else run('INSERT INTO task_progress(id, agent_id, task_id, subject, status, position, updated_at) VALUES (?,?,?,?,?,?,?)', `${agent.id}:${key}`, agent.id, key, subject ? String(subject) : null, status ? String(status) : 'pending', one<{ c: number }>('SELECT COUNT(*) c FROM task_progress WHERE agent_id = ?', agent.id)!.c + 1, now())
  const rows = one<{ total: number; done: number }>("SELECT COUNT(*) total, SUM(status = 'completed') done FROM task_progress WHERE agent_id = ?", agent.id)!
  patch('agent', agent.id, { steps_done: rows.done ?? 0, steps_total: rows.total })
}

function handleMod(agent: Agent, action: string, url: URL, body: Record<string, unknown>, res: http.ServerResponse): void {
  const t = now()
  if (action === 'next') {
    const end = t + Math.min(Number(url.searchParams.get('wait') ?? 15000), 25000)
    // Bug 99: it looks once now, then again when something that could give it a batch changes (wake.ts), when a hold ends or a batch
    // falls due (nextDeadline), or every NEXT_BACKSTOP_MS at most. A wake looks on the next turn of the event loop, after the code that
    // woke it has finished: an urgent message is marked delivered right after it is stored, and must not be handed out as well.
    // The agent row is read again every look: a hold or pause set while the mod waits counts at once. Nothing is handed to a
    // connection that's already closed (a batch handed out but never received is handed out again; see nextBatchFor).
    let timer: NodeJS.Timeout | undefined, soon = false, done = false
    const w: Waiter = { status: agent.status, wake: () => { if (done || soon) return; soon = true; setImmediate(look) } }
    const stop = listen(agent.id, w)
    const finish = (code: number, out: object): void => { done = true; clearTimeout(timer); stop(); json(res, code, out) }
    res.on('close', () => { done = true; clearTimeout(timer); stop() })
    const look = (): void => {
      soon = false; clearTimeout(timer)
      if (done || res.destroyed || res.writableEnded) return
      try { // later looks run from a timer, outside the server's own catch
        const a = getAgent(agent.id); if (!a || a.status === 'exited') return finish(200, {})
        w.status = a.status
        const { batch: b, due } = modLook(a); if (b) return finish(200, { batch: { id: b.id, text: b.text, asUser: b.asUser, raw: b.raw, handed: b.handed_at } })
        const left = end - now(); if (left <= 0) return finish(200, {})
        if (!soon) timer = setTimeout(look, Math.max(5, Math.min(left, NEXT_BACKSTOP_MS, due === null ? Infinity : due - now())))
      } catch (e) { emit({ agentId: agent.id, source: 'system', kind: 'backend.error', payload: { server: 'mod', error: String(e) } }); return finish(500, { error: 'HQ error' }) }
    }
    update(agent.id, { mod_seen_at: t }); return look()
  }
  if (action === 'event') {
    const kind = String(body.kind ?? ''); update(agent.id, { mod_seen_at: t })
    emit({ agentId: agent.id, source: 'mod', kind: `mod.${kind}`, payload: typeof body.answer === 'string' ? { ...body, answer: trim(body.answer, 300) } : body })
    if (kind === 'session.start') { resolveKind('mod_missing', agent.id); if (!body.hasToken) attention('mod_token_missing', `${agent.id}: mod could not read its token file`, { agentId: agent.id }) }
    if (kind === 'turn.step') onTurnStep(agent, body)
    if (kind === 'turn.start' && !body.agentId) { // Bug 254: which turn of its own is the latest, and when it started
      const s = turns.get(agent.id) ?? { prompt: 0, stop: 0 }; s.start = { id: String(body.turnId ?? ''), at: ++turnSeq }; turns.set(agent.id, s) }
    const bid = String(body.id ?? ''), late = body.late === true, fits = !late || lateReportFits(agent, bid, body.handed) // Bug 140: a resend counts for its own hand-out only
    if (kind === 'turn.start' && !body.agentId && late && body.over !== true) startedWhileAway(agent)
    if (kind === 'batch_received' && fits) markReceived(bid)
    if (kind === 'batch_submitted' && fits) {
      if (late) submittedWhileAway(agent, bid, body.interrupted === true); else markSubmitted(bid)
      if (agent.interrupted_at) wake(agent.id) // Bug 110: submitted after an interrupt is dropped; look now
    }
    if (kind === 'turn.complete' && !body.agentId) turnEnded(agent, body.isAborted === true) // the agent's own turn, not a helper's
    if (kind === 'turn.complete' && !body.agentId && late && stopLost(agent.id, body)) stoppedWhileAway(agent, String(body.answer ?? ''))
    else if (kind === 'turn.complete' && !body.agentId && late && failureLost(agent.id, body)) failedWhileAway(agent, String(body.reason))
    if (kind === 'batch_submit_failed' && fits) requeue(bid, 'submit_failed')
    if (kind === 'plugin.register' && body.name && body.name !== 'hq') attention('foreign_mod', `${agent.id}: another mod tried to load: ${body.name}`, { agentId: agent.id })
    if (kind === 'session.measure') {
      const u = (body.usage ?? {}) as { context?: { tokens?: number; percent?: number }; rateLimits?: { kind: string; percentUsed: number }[]; cost?: { usd?: number } }
      const fh = u.rateLimits?.find((r) => r.kind === 'five_hour')?.percentUsed ?? null; const sd = u.rateLimits?.find((r) => r.kind === 'seven_day')?.percentUsed ?? null
      run('INSERT INTO usage_samples(agent_id, at, context_tokens, context_pct, five_hour_pct, seven_day_pct, cost_usd) VALUES (?,?,?,?,?,?,?)', agent.id, t, u.context?.tokens ?? null, u.context?.percent ?? null, fh, sd, u.cost?.usd ?? null)
      patch('agent', agent.id, { context_tokens: u.context?.tokens ?? null, five_hour_pct: fh, seven_day_pct: sd })
      checkContext(agent, u.context?.tokens)
      const over = overPause(fh, sd, pauseLevels()); if (over) attention('rate_limit', `${over}: new launches paused`, { keep: true }) // the percentages change every sample
    }
    // Bug 148: after turnEnded, which keeps the interrupt. Bug 254: or the turn ended with no Stop hook since it started: Escape or No on a dialog in its first
    // ~6 s, before Claude Code's permission_prompt notification, so no dialog notice is open for Bug 188's look either (real 2.1.322: isAborted false)
    // Bug 289: an interrupt has its line (agent.interrupted); a turn with no Stop gets one, here or once its dialog has gone
    const noStop = kind === 'turn.complete' && !body.agentId && body.isAborted !== true && endedWithoutStop(agent.id, body.turnId)
    // Bug 352: an API error ends a turn with no Stop too, and on 2.1.322 its StopFailure comes after this: that hook's "Turn failed" line says so, not ours.
    // Bug 359: so does a reply the API refused ('refusal'): on 2.1.322 it is an API error message too (error invalid_request), so a StopFailure, no Stop
    const say = noStop && !API_ENDED.has(String(body.reason))
    const told = kind === 'turn.complete' && !body.agentId && (body.isAborted === true || noStop) && turnOver(agent.id, false, say ? 'no_stop' : undefined)
    // Bug 188: its turn is over, so a dialog may be too (Escape or a denial on it ends the turn)
    if (kind === 'turn.complete' && !body.agentId) dialogMayBeOver(agent.id, body.isAborted === true ? 'interrupted' : 'turn_end', onDialogEnd(agent.id, say && !told))
    // Bug 386: and if no StopFailure says so within FAILURE_WAIT_MS (a model error sends none), HQ does. A late report is Bug 367's: HQ was down for that hook
    if (noStop && !late && API_ENDED.has(String(body.reason))) waitForFailure(agent.id, String(body.turnId ?? ''), String(body.reason))
    return json(res, 200, { ok: true })
  }
  json(res, 404, {})
}

export function startHooksServer(): http.Server {
  const srv = http.createServer(async (req, res) => {
    try { await route(req, res) } catch (e) {
      emit({ agentId: null, source: 'system', kind: 'backend.error', payload: { server: 'hooks', url: req.url?.replace(/\/(hooks|mod)\/[^/]+/, '/$1/…'), error: String(e) } })
      if (!res.headersSent) json(res, e instanceof TooLarge ? 413 : 500, { error: e instanceof TooLarge ? e.message : 'HQ error' }); else res.end()
    }
  })
  upFrom = one<{ id: number | null }>('SELECT MAX(id) AS id FROM events')?.id ?? 0 // Bug 346
  srv.listen(PORTS.hooks, BIND); return srv
}
async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x'); const parts = url.pathname.split('/').filter(Boolean)
  const body = req.method === 'POST' ? asObject(await readJson(req, 8 * 1024 * 1024)) : {} // hooks carry whole tool outputs
  // Bug 87: the token comes in a header. `/hooks/<token>` is still taken from agents started before that change, until they restart.
  const hookToken = parts[0] === 'hooks' ? (parts.length === 1 ? req.headers[TOKEN_HEADER.toLowerCase()] : parts.length === 2 ? parts[1] : undefined) : undefined
  if (typeof hookToken === 'string' && hookToken) {
    const a = agentByToken(hookToken); if (!a) return json(res, 403, { error: 'bad token' })
    if (!body.hook_event_name) return json(res, 200, {})
    try { return handleHook(a, body, res) } catch (e) { emit({ agentId: a.id, source: 'system', kind: 'hook.error', payload: { error: String(e) } }); return json(res, 200, {}) }
  }
  if (parts[0] === 'mod' && parts[1] && parts[2]) { const a = agentByToken(parts[1]); if (!a) return json(res, 403, { error: 'bad token' }); return handleMod(a, parts[2], url, body, res) }
  if (parts[0] === 'tmux' && parts[1] && parts[2] && parts[3]) {
    const a = getAgent(parts[1]); if (!a || tmuxToken(parts[1]) !== parts[2]) return json(res, 403, {})
    // Someone attached from a real terminal holds delivery until they detach (+ the usual grace). HQ's own terminal view doesn't.
    const lock = getSetting('takeover_lock_s', DEFAULTS.takeover_lock_s) * 1000
    const external = (await tmux.clientPids(a.tmux_session)).filter((pid) => !isBridgePid(pid)).length
    const longHold = (a.takeover_locked_until ?? 0) > now() + 86_400_000
    if (parts[3] === 'attached' && external) update(a.id, { takeover_locked_until: now() + TAKEOVER_ATTACHED_MS })
    else if (parts[3] === 'detached' && !external && longHold) update(a.id, { takeover_locked_until: now() + lock })
    emit({ agentId: a.id, source: 'system', kind: `tmux.${parts[3]}`, payload: { external } }); return json(res, 200, {})
  }
  json(res, 404, {})
}
