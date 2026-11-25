// Messages, batches and the delivery policy. Batches are composed lazily when the mod asks for work.
import fs from 'node:fs'
import path from 'node:path'
import { one, q, run, now, getSetting, tx } from './db.ts'
import { DEFAULTS } from './config.ts'
import { emit, patch } from './events.ts'
import { id } from './util.ts'
import { agentDir, getAgent, liveAgents, onDialog, update, type Agent } from './agents.ts'
import { attention, resolveKind } from './attention.ts'
import * as tmux from './tmux.ts'
import { ownHalfLine, paneHasDraft, paneLooksIdle, paneShowsDialog, plainScreen } from './screen.ts'
import { wake, wakeAll } from './wake.ts'

export type Message = { id: string; repo_id: string | null; feature_id: string | null; channel: string; from_id: string; to_id: string | null; reason: string; in_reply_to: string | null; body: string; created_at: number; batch_id: string | null; delivered_at: number | null; delivery_method: string | null; ack_at: number | null
  /** Bug 187: why HQ dropped it unread (delivery_method 'dropped'; see dropMessage). */
  dropped_why: string | null }
export type Batch = { id: string; agent_id: string; text: string; created_at: number; handed_at: number | null; submitted_at: number | null; acked_at: number | null; method: string | null; received_at: number | null; dropped_at: number | null }
export type Handed = Batch & { raw: boolean; asUser: boolean }

export function displayName(agentOrId: string): string {
  if (agentOrId === 'user') return 'the user'
  if (agentOrId === 'hq') return 'HQ'
  const a = getAgent(agentOrId); if (!a) return agentOrId
  return a.display_name ?? `${a.role} ${a.id}`
}

/** `from`: an agent id, 'user' (the person running HQ) or 'hq' (HQ's own notices, which are never the user's words or an answer). */
export function sendMessage(m: { repoId?: string | null; featureId?: string | null; channel: 'team' | 'dm'; from: string; to?: string | null; reason: string; body: string; inReplyTo?: string | null; method?: string }): Message {
  const row: Message = { id: id('msg'), repo_id: m.repoId ?? repoFor(m.featureId, m.from, m.to), feature_id: m.featureId ?? null, channel: m.channel, from_id: m.from, to_id: m.to ?? null, reason: m.reason, in_reply_to: m.inReplyTo ?? null, body: m.body, created_at: now(), batch_id: null, delivered_at: null, delivery_method: null, ack_at: null,
    dropped_why: null }
  run('INSERT INTO messages(id, repo_id, feature_id, channel, from_id, to_id, reason, in_reply_to, body, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', row.id, row.repo_id, row.feature_id, row.channel, row.from_id, row.to_id, row.reason, row.in_reply_to, row.body, row.created_at)
  patch('message', row.id, row as unknown as Record<string, unknown>)
  if (row.channel === 'team') wakeAll(); else wake(row.to_id) // Bug 99: its waiting `next` hands it out at once
  emit({ agentId: m.from === 'user' || m.from === 'hq' ? null : m.from, source: 'system', kind: 'message.sent', payload: { id: row.id, to: row.to_id, reason: m.reason, channel: m.channel } })
  // What answers an engineer's question: anything the user sends it (their message box says 'fyi'), or the TPM's reply marked as one.
  const answers = m.from === 'user' || (getAgent(m.from)?.role === 'tpm' && (!!m.inReplyTo || m.reason === 'answer'))
  if (row.to_id && row.to_id !== 'team' && row.to_id !== 'user' && answers) resolveQuestion(row.to_id, row.id, m.inReplyTo ?? null, m.from)
  // The user answered this agent: what it told them and what it's blocked on are dealt with. HQ's notices and the TPM's aren't that.
  if (m.from === 'user' && row.to_id) for (const k of ['message_for_user', 'blocked']) resolveKind(k, row.to_id)
  if (row.to_id === 'user') { run('UPDATE messages SET delivered_at = ?, delivery_method = ? WHERE id = ?', now(), 'ui', row.id); attention('message_for_user', `${displayName(m.from)} (${m.reason}): ${m.body.slice(0, 200)}`, { agentId: m.from }) }
  return row
}

/** The project a message belongs to: its feature's, else the sending or receiving agent's (Bug 52: the TPM has no feature). */
function repoFor(featureId: string | null | undefined, from: string, to: string | null | undefined): string | null {
  if (featureId) { const r = one<{ repo_id: string }>('SELECT repo_id FROM features WHERE id = ?', featureId); if (r) return r.repo_id }
  for (const x of [from, to]) { const a = x ? getAgent(x) : undefined; if (a?.repo_id) return a.repo_id }
  return null
}
/** A TPM's answer at the end of its turn, kept as a message to the user so it shows outside its terminal (the TPM talks to the
 *  user in its terminal; its send_message is for questions). Already delivered: it's on screen. No ⚠ notice: it isn't a request. */
export function recordReply(agent: Agent, text: string): void {
  const body = text.trim(); if (!body) return
  const t = now(), row: Message = { id: id('msg'), repo_id: agent.repo_id, feature_id: agent.feature_id, channel: 'dm', from_id: agent.id, to_id: 'user', reason: 'reply', in_reply_to: null, body: body.slice(0, 8000),
    created_at: t, batch_id: null, delivered_at: t, delivery_method: 'terminal', ack_at: t, dropped_why: null }
  run('INSERT INTO messages(id, repo_id, feature_id, channel, from_id, to_id, reason, body, created_at, delivered_at, delivery_method, ack_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    row.id, row.repo_id, row.feature_id, row.channel, row.from_id, row.to_id, row.reason, row.body, t, t, 'terminal', t)
  patch('message', row.id, row as unknown as Record<string, unknown>)
}
/** Undelivered messages addressed to this agent: DMs to it, and team messages not sent by it. An engineer hears its feature's
 *  team and the TPM's; the project's TPM (Bug 52) hears every team message in its project. */
export function pendingFor(agent: Agent): Message[] {
  return q<Message>(`SELECT * FROM messages WHERE delivered_at IS NULL AND (to_id = ? OR (channel = 'team' AND from_id != ? AND repo_id = ?
    AND (? = 'tpm' OR feature_id IS NULL OR feature_id = ?))) ORDER BY created_at`, agent.id, agent.id, agent.repo_id ?? '', agent.role, agent.feature_id ?? '')
}
export function pausedRoles(): string[] { return getSetting<string[]>('paused_roles', []) }

const NOT_ACKED_MS = Number(process.env.HQ_NOT_ACKED_S ?? 90) * 1000
/** One line, as HQ types it into a terminal: Enter sends it, so a line break inside can't be relied on to stay one. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()
/** Whether a typed line can go in as it is. In Claude Code's prompt a first character of `!` runs the rest as a shell command, outside the sandbox, and
 *  `/` makes it a slash command (checked on 2.1.322); other signs may get a meaning later. So only a line that starts with a letter or a digit. */
const startsPlain = (line: string): boolean => /^[\p{L}\p{N}]/u.test(line)
/** Delivery policy: returns a batch or null. `by`: who takes it. 'mod' is the mod's long-poll (and the Stop hook's answer when the mod has gone quiet).
 *  'typed' is HQ typing into the agent's terminal (typeNext, Bug 110): the batch's text is then the one line it types. */
export function nextBatchFor(agent: Agent, by: 'mod' | 'typed' = 'mod', t = now()): Handed | null {
  if (agent.takeover_locked_until && agent.takeover_locked_until > t) return null
  if (agent.status === 'paused' || pausedRoles().includes(agent.role)) return null
  const lost = t - getSetting('batch_receive_s', DEFAULTS.batch_receive_s) * 1000 // handed out, but the mod never said it got it
  for (const b of q<Batch>("SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND received_at IS NULL AND handed_at IS NOT NULL AND handed_at < ?", agent.id, lost)) requeue(b.id, 'not_received')
  // Bug 110: its turn was interrupted, so what the mod has submitted since without a prompt starting is gone (Claude Code drops it; the prompt's hook reaches
  // HQ before the mod's "submitted" does, so there's nothing left to wait for). Its messages go back now, to be typed, and that isn't a failed try.
  if (agent.interrupted_at) {
    const gone = q<Batch>("SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND submitted_at IS NOT NULL AND method IN ('mod', 'mod_user')", agent.id)
    for (const b of gone) requeue(b.id, 'interrupted')
  }
  // Submitted (or typed) but the prompt never started, and HQ doesn't know why: most likely an interrupt it never heard of. Send it again, typed (see requeue).
  const unacked = q<Batch>('SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND submitted_at IS NOT NULL AND submitted_at < ?', agent.id, t - NOT_ACKED_MS)
  for (const b of unacked) requeue(b.id, 'not_acked')
  const interrupted = !!(unacked.length ? getAgent(agent.id) ?? agent : agent).interrupted_at
  const open = one<Batch>('SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND handed_at IS NOT NULL AND handed_at > ? ORDER BY handed_at DESC', agent.id, t - 180_000)
  if (open) return null // one in flight; wait for the ack (UserPromptSubmit) before handing another
  const launch = one<Batch>("SELECT * FROM batches WHERE agent_id = ? AND method = 'launch' AND handed_at IS NULL AND acked_at IS NULL", agent.id)
  if (launch && by === 'typed') return null // a launch prompt is the mod's to give: it is the session's first, and nothing can have interrupted a turn before it
  if (launch) { run('UPDATE batches SET handed_at = ? WHERE id = ?', t, launch.id); emit({ agentId: agent.id, source: 'system', kind: 'batch.handed', payload: { id: launch.id, launch: true } }); return { ...launch, handed_at: t, raw: true, asUser: true } }
  // While it writes its handoff note, its request is all it gets; the rest waits for the session that takes over. A request HQ replaced with
  // one in other words (freshstart.ts retarget, Bug 338) never comes up, nor does one whose fresh start is over.
  const all = pendingFor(agent), ask = (m: Message): boolean => m.reason === 'fresh_start'
  const current = (m: Message): boolean => !!agent.fresh_start_at && (!agent.fresh_start_msg || m.id === agent.fresh_start_msg)
  for (const m of all.filter((x) => ask(x) && !current(x))) dropMessage(m.id, agent.fresh_start_at ? 'replaced' : 'fresh_start_over', t)
  const held = by === 'mod' ? heldForStep(agent, all, t) : [] // Bug 370: these go in at its next tool step (stepNotes), not after its turn
  const msgs = agent.fresh_start_at ? all.filter(current) : all.filter((m) => !ask(m) && !held.includes(m)); if (!msgs.length) return null
  // Bug 110: after an interrupted turn the mod's prompt would be dropped, so nothing is handed to it. HQ types the messages itself, when the screen allows it.
  if (by === 'mod' && interrupted) { typeNext(agent.id); return null }
  const user = msgs.map((m) => m.body).join('\n\n'), bid = id('B')
  const labelled = labelledText(msgs)
  // What the user wrote goes in as their own words, but only when it can't be taken for a command; otherwise labelled, like everyone else's.
  // Bug 146: the mod's `$.prompt.submit` refuses a text that begins with "/" (2.1.322), so its words had never got through that way either
  const allUser = msgs.every((m) => m.from_id === 'user') && startsPlain(oneLine(user))
  const text = by === 'typed' ? (allUser ? oneLine(user) : `HQ message batch ${bid}: ${oneLine(labelled)}`) : allUser ? user : labelled
  const how = by === 'typed' ? 'tmux' : 'mod'
  const b: Batch = { id: bid, agent_id: agent.id, text, created_at: t, handed_at: t, submitted_at: null, acked_at: null, method: by === 'typed' ? 'typed' : allUser ? 'mod_user' : 'mod',
    received_at: by === 'typed' ? t : null, dropped_at: null }
  tx(() => {
    run('INSERT INTO batches(id, agent_id, text, created_at, handed_at, received_at, method) VALUES (?,?,?,?,?,?,?)', b.id, b.agent_id, b.text, b.created_at, b.handed_at, b.received_at, b.method)
    for (const m of msgs) run('UPDATE messages SET batch_id = ?, delivered_at = ?, delivery_method = ? WHERE id = ?', b.id, t, how, m.id)
  })
  for (const m of msgs) patch('message', m.id, { batch_id: b.id, delivered_at: t, delivery_method: how })
  emit({ agentId: agent.id, source: 'system', kind: 'batch.handed', payload: { id: b.id, messages: msgs.map((m) => m.id), ...(by === 'typed' ? { typed: true } : {}) } })
  return { ...b, raw: allUser, asUser: allUser }
}
/** Each message on its own lines, saying what kind it is and who sent it, as a batch and a tool step's note (stepNotes) give them. */
const labelledText = (msgs: Message[]): string => msgs.map((m) => `[${m.reason}] from ${displayName(m.from_id)}${m.from_id === 'user' || m.from_id === 'hq' ? ''
  : ` (id ${m.from_id})`}${m.in_reply_to ? ' (reply)' : ''} [msg ${m.id}]: ${m.body}`).join('\n\n')
/** Bug 370: messages that can't wait for the agent's turn to end. An engineer builds its ticket in one long turn, so HQ's notice that the ticket's spec
 *  changed (mcp.ts update_ticket_spec) came after the old version was built. While its own turn is at work, these aren't handed to the mod (which
 *  submits a prompt only once the agent is idle): the agent's next tool step carries them in, as the hook's added context (stepNotes, hooks.ts), and
 *  Claude Code puts that in front of the model at once (checked on 2.1.322, after a step that worked and one that failed). Not Escape and typing, as
 *  Urgent does: an Escape kills a build or a test run that is running, and no hook says so (2.1.322). Held MID_TURN_HOLD_MS at most, in case no step
 *  comes (hooks are lossy); after that, or once its turn ends, the mod hands them out as before. */
export const MID_TURN_REASONS: ReadonlySet<string> = new Set(['spec_change'])
const MID_TURN_HOLD_MS = Number(process.env.HQ_MID_TURN_HOLD_S ?? 600) * 1000
/** The messages among `pending` that wait for the agent's next tool step: of a MID_TURN_REASONS kind, held for less than MID_TURN_HOLD_MS, and only while
 *  its own turn is at work (turnAtWork). Empty when none is of that kind, without a look at the events log. */
function heldForStep(agent: Agent, pending: Message[], t: number): Message[] {
  const some = pending.filter((m) => MID_TURN_REASONS.has(m.reason) && m.created_at > t - MID_TURN_HOLD_MS)
  return some.length && turnAtWork(agent) ? some : []
}
/** Its own turn is at work: it is working, on a plan review or on a dialog, and the last of its turn events is a prompt that started a turn, not a
 *  Stop, a failed turn, its mod's end of a turn (an Escape) or a new session. Read from the events log, so it holds across a backend restart. Working
 *  only because a helper or a run in the background still goes, after its turn ended, isn't at work: the mod gives it its messages then. */
export function turnAtWork(a: Agent): boolean {
  if (!(a.status === 'working' || a.status === 'plan_review' || (a.status === 'blocked' && a.blocked_why === 'dialog'))) return false
  const last = one<{ kind: string }>(`SELECT kind FROM events WHERE agent_id = ? AND (kind IN ('hook.UserPromptSubmit', 'hook.Stop', 'hook.StopFailure', 'hook.SessionStart')
    OR (kind = 'mod.turn.complete' AND COALESCE(json_extract(payload, '$.agentId'), '') = '')) ORDER BY id DESC LIMIT 1`, a.id)
  return last?.kind === 'hook.UserPromptSubmit'
}
/** Bug 370: what the agent's own tool step (a main-loop PostToolUse or PostToolUseFailure, hooks.ts) carries in: the MID_TURN_REASONS messages that wait
 *  for it, held or not. The hook's answer is the delivery, so they count as read now (delivery_method 'hook'). Null: none, or it takes no messages now
 *  (stopped, a fresh start's note, someone at its terminal, paused), and they go the usual way. */
export function stepNotes(agentId: string, t = now(), use = ''): string | null { // use: the step's tool_use_id (Bug 371: which model response read them)
  const a = getAgent(agentId); if (!a || a.status === 'exited' || a.fresh_start_at || (a.takeover_locked_until ?? 0) > t) return null
  if (a.status === 'paused' || pausedRoles().includes(a.role)) return null
  const msgs = pendingFor(a).filter((m) => MID_TURN_REASONS.has(m.reason)); if (!msgs.length) return null
  tx(() => { for (const m of msgs) run("UPDATE messages SET delivered_at = ?, delivery_method = 'hook', ack_at = ? WHERE id = ?", t, t, m.id) })
  for (const m of msgs) patch('message', m.id, { delivered_at: t, delivery_method: 'hook', ack_at: t })
  emit({ agentId: a.id, source: 'system', kind: 'message.at_step', payload: { ids: msgs.map((m) => m.id), text: msgs.map((m) => m.body).join(' ').slice(0, 400), ...use ? { use } : {} } })
  return `HQ: ${msgs.length > 1 ? 'these messages' : 'this message'} came in while you work. Read ${msgs.length > 1 ? 'them' : 'it'} now, before your next step:\n\n${labelledText(msgs)}`
}
/** The agent's own turn ended, as its mod tells it (not a helper's turn). Bug 110: an interrupted one (Escape in its terminal; no Stop hook comes) leaves
 *  Claude Code dropping every prompt a mod submits until a turn has ended normally (2.1.300, 2.1.322), so HQ types this agent's messages from here on. */
export function turnEnded(agent: Agent, aborted: boolean): void {
  if (aborted) { update(agent.id, { interrupted_at: now() }); emit({ agentId: agent.id, source: 'system', kind: 'agent.interrupted', payload: { why: 'turn' } }) }
  else if (agent.interrupted_at) update(agent.id, { interrupted_at: null }) // both writes wake its waiting `next` (wake.ts)
}
/** One writer at a time in an agent's terminal. An urgent message, a fresh start's request and a typed batch are each a whole line. */
const typing = new Map<string, Promise<unknown>>()
function inTerminal<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const p = (typing.get(agentId) ?? Promise.resolve()).then(fn, fn), done = (): void => { if (typing.get(agentId) === p) typing.delete(agentId) }
  typing.set(agentId, p); p.then(done, done); return p
}
/** A menu or a dialog on the screen, where Enter would pick an option, or a status that takes no messages. Blocked by an API error isn't one (Bug 72). */
const notTypeable = (a: Agent): boolean => onDialog(a) || a.status === 'plan_review'
/** Why HQ holds back from typing into each agent's terminal right now: 'status' (HQ knows of a dialog or a plan menu), 'dialog' or 'busy' (its screen
 *  shows one, or a turn at work), 'draft' (Bug 149: a line somebody typed sits unsent in its prompt box, and Enter would send the two as one),
 *  'screen' (anything else that isn't the waiting prompt: Claude Code's Rewind menu after Escape twice, say). Logged
 *  once per reason, not at every look, and sent to the page, whose box says why the message waits (`type_waits`, frontend waitingFor). */
const typeWaits = new Map<string, string>()
function typeWaiting(a: Agent, why: string | null): void {
  if ((typeWaits.get(a.id) ?? null) === why) return
  if (why) { typeWaits.set(a.id, why); emit({ agentId: a.id, source: 'system', kind: 'batch.type_waits', payload: { why, status: a.status } }) } else typeWaits.delete(a.id)
  patch('agent', a.id, { type_waits: why })
}
/** Bug 110: types the agent's next batch into its terminal, as a person would, because the mod can't deliver it (see turnEnded). Only into Claude Code's
 *  empty waiting prompt: never into a menu or a dialog, not while it works, and not after a half-written line in the box (Bug 149). Otherwise nothing
 *  happens now, and the mod's `next` request looks again when something changes and every NEXT_BACKSTOP_MS (5 s, hooks.ts): a draft sent or cleared
 *  changes nothing HQ hears of, so that look is what ends its hold. The prompt's UserPromptSubmit hook acks the batch like any other; one that never
 *  starts is typed again after NOT_ACKED_MS, three times at most (requeue). */
export function typeNext(agentId: string): void {
  if (typing.has(agentId)) return
  inTerminal(agentId, async () => {
    const was = getAgent(agentId); if (!was) return
    const styled = await tmux.visiblePaneStyled(was.tmux_session), screen = plainScreen(styled)
    const a = getAgent(agentId); if (!a || a.status === 'exited' || !a.interrupted_at) return // read again: the look at the screen took a moment
    const why = notTypeable(a) ? 'status' : paneShowsDialog(screen) ? 'dialog' : paneHasDraft(styled) ? 'draft' : paneLooksIdle(screen) ? null
      : /esc to interrupt/.test(screen) ? 'busy' : 'screen'
    typeWaiting(a, why); if (why) return
    const b = nextBatchFor(a, 'typed'); if (!b) return
    try { await tmux.typeLine(a.tmux_session, b.text) }
    catch (e) { emit({ agentId: a.id, source: 'system', kind: 'batch.type_failed', payload: { id: b.id, error: String(e) } }); return requeue(b.id, 'type_failed') }
    markSubmitted(b.id); emit({ agentId: a.id, source: 'system', kind: 'batch.typed', payload: { id: b.id } })
  }).catch((e) => emit({ agentId, source: 'system', kind: 'backend.error', payload: { server: 'typing', error: String(e) } }))
}
/** Bug 149: an urgent message or a fresh start's request found a half-written line in the agent's prompt box after HQ's Escape. It goes back in the
 *  queue and on from there like any other message. If the Escape interrupted a turn (the mod says so within milliseconds, turnEnded), typeNext
 *  types it once the box is empty, and its box says why it waits. If there was no turn to stop, the mod hands it out at once: a prompt the mod
 *  submits goes in on its own and leaves the draft in the box (2.1.322). A fresh start's request that never gets in gets HQ's note (NEVER_MS). */
function holdForDraft(agentId: string, m: Message, why = 'draft'): void { // Bug 296: also 'screen' and 'status', after a restart (typeCutShort)
  run('UPDATE messages SET delivered_at = NULL, delivery_method = NULL WHERE id = ? AND ack_at IS NULL', m.id); patch('message', m.id, { delivered_at: null, delivery_method: null })
  emit({ agentId, source: 'system', kind: 'message.held', payload: { id: m.id, why } })
  wake(agentId) // its waiting `next` looks at once
}
/** Bug 99: when nextBatchFor could next find something with nothing else changing (no message, no ack, no setting): a hold ends,
 *  a batch handed out or submitted is due to be handed out again, or the one in flight stops holding the rest back. Null: none. */
export function nextDeadline(agent: Agent, t = now()): number | null {
  const receive = getSetting('batch_receive_s', DEFAULTS.batch_receive_s) * 1000, times: number[] = []
  if (agent.takeover_locked_until && agent.takeover_locked_until > t) times.push(agent.takeover_locked_until)
  for (const b of q<Batch>('SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND handed_at IS NOT NULL', agent.id)) {
    times.push(b.handed_at! + 180_000); if (b.received_at === null) times.push(b.handed_at! + receive); if (b.submitted_at !== null) times.push(b.submitted_at + NOT_ACKED_MS)
  }
  for (const m of heldForStep(agent, pendingFor(agent), t)) times.push(m.created_at + MID_TURN_HOLD_MS) // Bug 370: no step came, so the mod takes it
  const later = times.filter((x) => x >= t); return later.length ? Math.min(...later) + 1 : null // the checks compare with < and >
}
/** One look for the mod's waiting `next` (hooks.ts): the batch to hand out now, or else when to look again. Bug 330: both from ONE reading of the
 *  clock. Read twice, a batch that fell due between the two readings was in neither answer (not yet due for nextBatchFor, already past for
 *  nextDeadline), and the request slept on to its backstop, or to its end. */
export function modLook(agent: Agent, t = now()): { batch: Handed | null; due: number | null } {
  const batch = nextBatchFor(agent, 'mod', t); return { batch, due: batch ? null : nextDeadline(agent, t) }
}
/** The line an urgent message is typed as. The user's goes in as written only when it starts with a letter or a digit: Bug 146, "/cd …" ran as Claude Code's
 *  own command. Otherwise, and for everyone else's, labelled; a label starts with "[", which Claude Code takes as text (2.1.322). */
function urgentLine(m: Pick<Message, 'from_id' | 'reason' | 'body'>): string {
  return m.from_id === 'user' && startsPlain(oneLine(m.body)) ? oneLine(m.body) : oneLine(`[${m.reason}] from ${displayName(m.from_id)}: ${m.body}`)
}
/** Urgent delivery: Escape stops the agent's current turn and `m` is typed into its terminal. After an interrupt Claude Code
 *  drops prompts a mod submits until a normal turn has ended (seen on 2.1.300 and 2.1.322), so the mod can't carry it. `m` is marked
 *  delivered before the first await, so the mod's long-poll never hands it out as well. */
export async function interruptAndType(agent: Agent, m: Message): Promise<void> {
  const t0 = now(); run("UPDATE messages SET delivered_at = ?, delivery_method = 'tmux' WHERE id = ?", t0, m.id); patch('message', m.id, { delivered_at: t0, delivery_method: 'tmux' })
  await typeUrgent(agent, m, false)
}
/** `again` (Bug 296): typed after a restart cut the first try short (typeCutShort). The Escape then goes only to a screen that shows a turn at
 *  work (the first one never got there): an idle prompt gets no second one, which can open Claude Code's Rewind menu. Then HQ types only into
 *  its waiting prompt; anything else on the screen, or a status that takes no messages, sends the message back to the queue, as a draft does.
 *  Bug 331: a box at that prompt that holds the first pieces of this very line, and nothing else, is HQ's own typing from before the restart:
 *  HQ types the rest (ownHalfLine). */
async function typeUrgent(agent: Agent, m: Message, again: boolean): Promise<void> {
  let held: string | null = null, rest: string | null = null
  await inTerminal(agent.id, async () => { // not in the middle of a batch HQ is typing there (Bug 110)
    const a = again ? getAgent(agent.id) : agent; if (!a || (again && a.status === 'exited')) { held = 'gone'; return } // read again: the restart took a while
    if (again && notTypeable(a)) { held = 'status'; return }
    if (!again || /esc to interrupt/.test(plainScreen(await tmux.visiblePaneStyled(a.tmux_session)))) {
      await tmux.sendEscape(a.tmux_session).catch(() => {})
      await new Promise((r) => setTimeout(r, 1500)) // let the interrupted turn wind down
    }
    const styled = await tmux.visiblePaneStyled(a.tmux_session), screen = plainScreen(styled), line = urgentLine(m)
    rest = again && paneLooksIdle(styled) ? ownHalfLine(styled, line) : null
    held = rest !== null ? null : paneHasDraft(styled) ? 'draft' : again && !paneLooksIdle(screen) ? 'screen' : null // Bug 149: one Escape leaves a half-written line in the box
    if (held) return
    await tmux.typeLine(a.tmux_session, rest ?? line) // in pieces, as typeNext does: sent in one go, Claude Code kept only the end of a long one (Bug 183)
  })
  if (held === 'gone') return // its session ended: the message stays as it is, and a fresh start gets HQ's note (sweepFreshStarts)
  if (held) return holdForDraft(agent.id, m, held)
  const t = now(); run('UPDATE messages SET ack_at = ? WHERE id = ?', t, m.id); patch('message', m.id, { ack_at: t })
  emit({ agentId: agent.id, source: 'system', kind: 'message.typed', payload: { id: m.id, reason: m.reason, ...(again ? { again: true } : {}),
    ...(rest !== null ? { finished: true } : {}) } }) // Bug 331: only the rest was typed, after HQ's own first pieces
}
/** How long after HQ began typing an urgent message or a fresh start's request a restart still types it again: as long as a fresh start
 *  waits for its request to get in (freshstart.ts NEVER_MS) before HQ writes the note itself. */
const CUT_SHORT_MS = Number(process.env.HQ_FRESH_START_NEVER_S ?? 900) * 1000
/** Bug 296: at start-up, each urgent message and fresh start's request the last backend was typing when it went down. interruptAndType marks
 *  it delivered before its Escape and acks it once typed, so a restart in between left it delivered and never typed: the agent sat idle, and a
 *  Clear, a fresh start or a switch of projects waited 15 minutes for HQ's own note. Typed again (typeUrgent) when its agent still runs and,
 *  for a fresh start's request, that fresh start is still open; not when it is older than CUT_SHORT_MS. Bug 331: and each batch typeNext was
 *  typing (finishCutBatch). */
export async function typeCutShort(t = now()): Promise<void> {
  const cut = q<Message>("SELECT * FROM messages WHERE delivery_method = 'tmux' AND batch_id IS NULL AND ack_at IS NULL AND delivered_at > ? ORDER BY delivered_at",
    t - CUT_SHORT_MS)
  // read now, before the waits below: a batch typeNext hands out meanwhile is this backend's own
  const typed = q<Batch>(`SELECT * FROM batches WHERE method = 'typed' AND submitted_at IS NULL AND acked_at IS NULL AND dropped_at IS NULL
    AND handed_at > ? AND handed_at <= ?`, t - CUT_SHORT_MS, t)
  await Promise.all(cut.map(async (m) => {
    const a = m.to_id ? getAgent(m.to_id) : undefined
    if (!a || a.status === 'exited' || (m.reason === 'fresh_start' && a.fresh_start_msg !== m.id)) return
    emit({ agentId: a.id, source: 'system', kind: 'message.cut_short', payload: { id: m.id, reason: m.reason } })
    await typeUrgent(a, m, true).catch((e) => emit({ agentId: a.id, source: 'system', kind: 'backend.error', payload: { server: 'typing', error: String(e) } }))
  }))
  await Promise.all(typed.map(finishCutBatch))
}
/** Bug 331: a batch typeNext was typing when the backend went down. It counted as received when handed out and is marked submitted only once
 *  typed, so no rule of nextBatchFor ever put it back: its messages were never read, and its first pieces sat in the prompt box. HQ types the
 *  rest when the box at the waiting prompt holds only those (ownHalfLine). Either way it counts as submitted from here: the prompt's hook acks
 *  it if it got in (whole before the restart, or now), and if none comes within NOT_ACKED_MS its messages are typed again (requeue). */
async function finishCutBatch(b: Batch): Promise<void> {
  const was = getAgent(b.agent_id); if (!was || was.status === 'exited') return
  let rest: string | null = null
  await inTerminal(b.agent_id, async () => {
    const styled = await tmux.visiblePaneStyled(was.tmux_session), a = getAgent(b.agent_id) // read again: the look took a moment
    if (!a || a.status === 'exited' || notTypeable(a) || !paneLooksIdle(styled)) return
    const r = ownHalfLine(styled, b.text); if (r === null) return
    await tmux.typeLine(a.tmux_session, r); rest = r
  }).catch((e) => emit({ agentId: b.agent_id, source: 'system', kind: 'batch.type_failed', payload: { id: b.id, error: String(e) } }))
  if (one('SELECT 1 AS x FROM batches WHERE id = ? AND acked_at IS NULL AND dropped_at IS NULL', b.id)) markSubmitted(b.id)
  emit({ agentId: b.agent_id, source: 'system', kind: 'batch.cut_short', payload: { id: b.id, finished: rest !== null } })
}
export function markSubmitted(batchId: string): void { run('UPDATE batches SET submitted_at = ? WHERE id = ?', now(), batchId) }
export function markReceived(batchId: string): void { run('UPDATE batches SET received_at = ? WHERE id = ? AND received_at IS NULL', now(), batchId) }
/** A batch that didn't get through (the mod couldn't submit it, or never got it; its prompt never started): its messages go back
 *  in the queue and are handed out again in a new batch; a launch prompt is handed out again as it is. One that was acked stays
 *  delivered. After three failures in ten minutes HQ stops retrying (a mod that keeps failing would otherwise loop every 1.5 s):
 *  the batch's messages are marked failed and the user is told. Bug 110: `interrupted` is no failure (HQ knows the turn was
 *  interrupted and types the messages next), so it never counts. A message batch whose prompt never started for no reason HQ
 *  knows (`not_acked`) is taken for an interrupt it didn't hear of, so the next try is typed. */
export function requeue(batchId: string, why: string): void {
  const b = one<Batch>('SELECT * FROM batches WHERE id = ?', batchId); if (!b || b.acked_at || b.dropped_at) return
  const tries = one<{ c: number }>(`SELECT COUNT(*) c FROM events WHERE agent_id = ? AND kind = 'batch.requeued' AND created_at > ?
    AND payload NOT LIKE '%"why":"interrupted"%'`, b.agent_id, now() - 600_000)!.c + 1
  if (why !== 'interrupted' && tries >= 3) return giveUp(b, why, tries)
  if (why === 'not_acked' && b.method !== 'launch' && !getAgent(b.agent_id)?.interrupted_at) {
    update(b.agent_id, { interrupted_at: now() }); emit({ agentId: b.agent_id, source: 'system', kind: 'agent.interrupted', payload: { why: 'not_acked', batch: b.id } })
  }
  if (b.method === 'launch') run('UPDATE batches SET handed_at = NULL, received_at = NULL, submitted_at = NULL WHERE id = ?', b.id)
  else {
    const ms = q<{ id: string }>('SELECT id FROM messages WHERE batch_id = ?', b.id)
    tx(() => { run('UPDATE batches SET dropped_at = ? WHERE id = ?', now(), b.id); run('UPDATE messages SET batch_id = NULL, delivered_at = NULL, delivery_method = NULL WHERE batch_id = ?', b.id) })
    for (const m of ms) patch('message', m.id, { batch_id: null, delivered_at: null, delivery_method: null })
  }
  wake(b.agent_id) // back in the queue (and no longer the one in flight)
  emit({ agentId: b.agent_id, source: 'system', kind: 'batch.requeued', payload: { id: b.id, why, launch: b.method === 'launch' } })
}
function giveUp(b: Batch, why: string, tries: number): void {
  const ms = q<{ id: string }>('SELECT id FROM messages WHERE batch_id = ?', b.id)
  tx(() => { run('UPDATE batches SET dropped_at = ? WHERE id = ?', now(), b.id); run("UPDATE messages SET delivery_method = 'failed' WHERE batch_id = ?", b.id) })
  for (const m of ms) patch('message', m.id, { delivery_method: 'failed' })
  wake(b.agent_id) // no longer the one in flight: what came after it can go
  emit({ agentId: b.agent_id, source: 'system', kind: 'batch.given_up', payload: { id: b.id, why, tries, launch: b.method === 'launch' } })
  const how = why === 'submit_failed' ? 'the mod could not submit it' : why === 'not_received' ? 'the mod never got it' : why === 'type_failed' ? "HQ couldn't type it into its terminal"
    : 'it went in but the agent never started on it'
  attention('delivery_failed', `${displayName(b.agent_id)}: HQ couldn't deliver ${b.method === 'launch' ? 'its launch prompt' : 'a message batch'} ${tries} times (${how}), so it stopped trying. `
    + whatNow(b, why), { agentId: b.agent_id })
}
/** Bug 146: what the user can do that will work. Sent again the normal way a message goes through the same mod, so when the mod is what failed, Urgent:
 *  HQ types that one into the terminal itself. */
function whatNow(b: Batch, why: string): string {
  if (b.method === 'launch' || (why !== 'submit_failed' && why !== 'not_received')) return 'Check its terminal, then send the message again.'
  return "Sent again the normal way it may fail the same way: send it with Urgent in the agent's panel instead, and HQ types it into its terminal "
    + '(that stops what the agent is doing).'
}
export function ackBatchFromPrompt(agent: Agent, prompt: string): string | null {
  const m = /HQ message batch (B-[0-9a-f]+)/.exec(prompt)
  let batchId = m?.[1] ?? null
  if (!batchId) { // raw batches (launch prompt, user messages): match by prefix. A typed one (Bug 110) may follow something already in the prompt box
    const open = q<Batch>('SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND handed_at IS NOT NULL ORDER BY handed_at DESC', agent.id)
    const head = prompt.trim().slice(0, 60), start = (b: Batch): string => b.text.trim().slice(0, 60)
    batchId = open.find((b) => head && (start(b) === head || (b.method === 'typed' && prompt.includes(start(b)))))?.id ?? null
  }
  if (!batchId) return null
  ackBatch(agent, batchId); return batchId
}
function ackBatch(agent: Agent, batchId: string): void {
  const t = now(); run('UPDATE batches SET acked_at = ? WHERE id = ? AND agent_id = ?', t, batchId, agent.id)
  run('UPDATE messages SET ack_at = ? WHERE batch_id = ?', t, batchId)
  for (const row of q<Message>('SELECT * FROM messages WHERE batch_id = ?', batchId)) patch('message', row.id, { ack_at: t, delivered_at: row.delivered_at, delivery_method: row.delivery_method })
  emit({ agentId: agent.id, source: 'system', kind: 'batch.acked', payload: { id: batchId } })
  wake(agent.id) // the one in flight arrived: the next can go
}
/** Bug 140: a report on a batch that the mod sends again because HQ was away when it first sent it (`late`). It counts only for the
 *  hand-out it names (`handed`: a launch prompt handed out again keeps its id), and only while that batch is still on its way: a resend
 *  for one that was dropped and handed out again in a new batch never touches the new one. */
export function lateReportFits(agent: Agent, batchId: string, handed: unknown): boolean {
  const b = one<Batch>('SELECT * FROM batches WHERE id = ? AND agent_id = ?', batchId, agent.id)
  return !!b && !b.dropped_at && b.handed_at !== null && b.handed_at === handed
}
/** Bug 140: the mod's "it's in", sent again once HQ is back. The prompt's UserPromptSubmit hook reaches HQ before the mod's report does,
 *  so while HQ was away that hook failed too and nothing else will ack the batch: this does. Unless the turn that ended next was
 *  interrupted (`interrupted`, as the mod saw it) or HQ knows of an interrupt: then the prompt was most likely dropped (Bug 110), and
 *  it only counts as submitted (the "submitted but never started" rule in nextBatchFor sends it again, typed). */
export function submittedWhileAway(agent: Agent, batchId: string, interrupted: boolean): void {
  markSubmitted(batchId)
  const b = one<Batch>('SELECT * FROM batches WHERE id = ?', batchId)
  if (b && !b.acked_at && !interrupted && !agent.interrupted_at) ackBatch(agent, batchId)
}
/** Bug 103: a batch handed over in the Stop hook's answer, when the agent's mod has gone quiet. Claude Code goes on with it as feedback
 *  on the turn that was ending, and no UserPromptSubmit follows (checked on 2.1.322), so nothing would ever ack it, and the "submitted
 *  but the prompt never started" rule in nextBatchFor would hand its messages out again. The hook's answer is the delivery: acked now. */
export function deliveredByStopHook(agent: Agent, batchId: string): void {
  const t = now()
  tx(() => { run("UPDATE batches SET method = 'stop_hook', submitted_at = ?, received_at = ? WHERE id = ?", t, t, batchId); run("UPDATE messages SET delivery_method = 'stop_hook' WHERE batch_id = ?", batchId) })
  ackBatch(agent, batchId)
}
/** Bug 85: hookwait.mjs leaves this in an agent's folder when HQ stayed away so long that it told the agent to stop and wait for a
 *  message. Once HQ hears from the agent again, or starts with the agent still running, that message goes out, once. */
export const HQ_AWAY_MARK = 'hq-unreachable'
export function tellIfHqWasAway(agent: Agent): void {
  const mark = path.join(agentDir(agent.id), HQ_AWAY_MARK)
  if (agent.status === 'exited' || !fs.existsSync(mark)) return
  try { fs.rmSync(mark) } catch { return } // another hook got there first
  const body = 'HQ is back. It was down for a while (most likely a restart), so a step of yours that needed its OK was turned away and you '
    + 'were told to wait. Carry on from where you stopped, and run that step again.'
  sendMessage({ repoId: agent.repo_id, featureId: agent.feature_id, channel: 'dm', from: 'hq', to: agent.id, reason: 'fyi', body })
  emit({ agentId: agent.id, source: 'system', kind: 'agent.hq_back', payload: {} })
}
/** read_inbox fallback: returns and marks delivered. */
export function readInbox(agent: Agent): Message[] {
  const msgs = pendingFor(agent); const t = now()
  for (const m of msgs) { run('UPDATE messages SET delivered_at = ?, delivery_method = ?, ack_at = ? WHERE id = ?', t, 'mcp_read', t, m.id); patch('message', m.id, { delivered_at: t, ack_at: t }) }
  return msgs
}
/** Bug 187: a message HQ won't hand out. Its delivered_at takes it out of the queue; delivery_method and dropped_why say it was never read
 *  and why ('fresh_start_over': a fresh-start request whose fresh start was over; 'replaced': one HQ asked again in other words, Bug 338;
 *  'finished': a test-command note its engineer hadn't read by open_pr, Bug 147), so Messages shows it as dropped, not as delivered. */
function dropMessage(msgId: string, why: 'fresh_start_over' | 'replaced' | 'finished', t: number): void {
  run("UPDATE messages SET delivered_at = ?, delivery_method = 'dropped', dropped_why = ? WHERE id = ?", t, why, msgId)
  patch('message', msgId, { delivered_at: t, delivery_method: 'dropped', dropped_why: why })
}
export function messagesForFeature(featureId: string | null, limit = 200): Message[] {
  return featureId ? q<Message>('SELECT * FROM messages WHERE feature_id = ? ORDER BY created_at DESC LIMIT ?', featureId, limit) : q<Message>('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?', limit)
}
export function unreadCount(agent: Agent): number { return pendingFor(agent).length }
/** Bug 147: HQ's note that the test command changed (auto.ts tellEngineers, reason 'test_cmd') is for an engineer at work. One it hasn't read
 *  when it calls open_pr would come after its last full run and start a turn it can do nothing with, and keep it from being stopped
 *  (tickets.ts stopFinished): it's dropped. HQ tests the ticket with the new command whatever the engineer ran. */
export function dropLateNotes(agentId: string | null): void {
  const late = agentId ? q<{ id: string }>("SELECT id FROM messages WHERE to_id = ? AND from_id = 'hq' AND reason = 'test_cmd' AND delivered_at IS NULL", agentId) : []
  const t = now()
  for (const m of late) dropMessage(m.id, 'finished', t)
  if (late.length) emit({ agentId, source: 'system', kind: 'message.dropped', payload: { ids: late.map((m) => m.id), why: 'finished' } })
}
export function resolveRecipient(agent: Agent, to: string): string | null {
  if (to === 'user' || to === 'team') return to
  const tpmOfRepo = (repoId: string | null) => repoId ? one<{ tpm_agent_id: string | null }>('SELECT tpm_agent_id FROM repos WHERE id = ?', repoId)?.tpm_agent_id ?? null : null
  if (to === 'tpm') return tpmOfRepo(agent.repo_id) // the project's TPM (Bug 52); a message waits for it if it isn't running
  if (liveAgents().find((a) => a.id === to)) return to
  const gone = getAgent(to) // the project's TPM that has since been replaced: its successor
  if (gone?.role === 'tpm' && gone.repo_id && gone.repo_id === agent.repo_id) return tpmOfRepo(gone.repo_id)
  if (gone?.role === 'engineer' && gone.ticket_id && gone.repo_id === agent.repo_id) { // a ticket's engineer that was fresh-started: the one now on the ticket
    const now_ = one<{ assignee_agent_id: string | null }>('SELECT assignee_agent_id FROM tickets WHERE id = ?', gone.ticket_id)?.assignee_agent_id
    if (now_ && now_ !== gone.id && liveAgents().some((a) => a.id === now_)) return now_
  }
  return null
}
/** How long a message of the user's to an agent still counts as what the agent's next message to someone passes on (Bug 86). */
const RELAY_MS = 3_600_000
/** Bug 86: a DM `m` (one row of messages, as alias m) that passes on what the user said: the user wrote to its sender after the
 *  sender's previous DM to the same recipient, and not long before `m`. Each message of the user's frees one DM per recipient.
 *  Ordered by rowid, not created_at: a reply and the message before it can share a millisecond. */
const RELAYED = `EXISTS (SELECT 1 FROM messages u WHERE u.from_id = 'user' AND u.to_id = m.from_id AND u.rowid < m.rowid AND u.created_at > m.created_at - ${RELAY_MS}
  AND u.rowid > COALESCE((SELECT MAX(p.rowid) FROM messages p WHERE p.from_id = m.from_id AND p.to_id = m.to_id AND p.channel = 'dm' AND p.rowid < m.rowid), 0))`
/** The DMs from one agent to other agents since `since` that the limits count (Bug 86): not its replies and messages to the user,
 *  not what it passed on from the user. */
function countedDms(from: string, since: number, to?: string): number {
  return one<{ c: number }>(`SELECT COUNT(*) c FROM messages m WHERE m.from_id = ? AND m.channel = 'dm' AND m.to_id NOT IN ('user', 'hq')
    AND (? IS NULL OR m.to_id = ?) AND m.created_at > ? AND NOT ${RELAYED}`, from, to ?? null, to ?? null, since)!.c
}
/** The user wrote to `from` since its last DM to `to`: what it sends `to` now passes that on (Bug 86). */
function passesOnUser(from: string, to: string): boolean {
  const last = one<{ r: number | null }>("SELECT MAX(rowid) r FROM messages WHERE from_id = ? AND to_id = ? AND channel = 'dm'", from, to)!.r ?? 0
  return !!one("SELECT 1 AS x FROM messages WHERE from_id = 'user' AND to_id = ? AND rowid > ? AND created_at > ?", from, last, now() - RELAY_MS)
}
/** The limits throttle chatter between agents. They count only agent-to-agent DMs: a TPM's replies to the user and messages to
 *  the user are another kind of thing (Bug 86). A message that passes on what the user just told the agent is never held back.
 *  The per-recipient window lets a blocker or question through, because refusing one leaves the sender waiting on a message
 *  nobody got (seen 2026-10-29); the per-hour cap applies to every reason. */
export function dmAllowed(agent: Agent, to: string, reason: string): { ok: boolean; why?: string } {
  if (passesOnUser(agent.id, to)) return { ok: true }
  const perHour = getSetting('dm_per_hour', DEFAULTS.dm_per_hour); const perPeerMin = getSetting('dm_per_peer_min', DEFAULTS.dm_per_peer_min)
  const t = now()
  if (countedDms(agent.id, t - 3_600_000) >= perHour) return { ok: false, why: `DM limit: ${perHour} per hour` }
  if (reason === 'blocker' || reason === 'question') return { ok: true }
  if (countedDms(agent.id, t - perPeerMin * 60_000, to) >= 1) return { ok: false, why: `DM limit: one per ${perPeerMin} min to the same recipient` }
  return { ok: true }
}

/** An engineer's open question as the page shows it (Bug 129): who it asked (`to_target`: an agent id, 'user' or 'team') and what, with
 *  the message's text, which may be older than the page's last 300 messages. Only for tickets still waiting on the answer. */
export type QuestionView = { id: string; ticket_id: string | null; from_agent_id: string; to_target: string; message_id: string; asked_at: number; answered_at: number | null; body: string }
const QUESTION_SQL = `SELECT q.id, q.ticket_id, q.from_agent_id, q.to_target, q.message_id, q.asked_at, q.answered_at, substr(m.body, 1, 4000) AS body
  FROM questions q JOIN messages m ON m.id = q.message_id`
export const openQuestions = (): QuestionView[] => q<QuestionView>(`${QUESTION_SQL} JOIN tickets t ON t.id = q.ticket_id
  WHERE q.answered_at IS NULL AND t.status = 'awaiting_answer' ORDER BY q.asked_at DESC`)
/** Sends the page a question as it is now: asked, or moved to a new session (tpm.ts handOver). */
export function patchQuestion(questionId: string): void {
  const row = one<QuestionView>(`${QUESTION_SQL} WHERE q.id = ?`, questionId); if (row) patch('question', row.id, row as unknown as Record<string, unknown>)
}
type QRow = { id: string; ticket_id: string | null }
/** An answer from `from` (the user, or the TPM) to `engineerId`. One that says which question it answers (`inReplyTo`) answers that one.
 *  One that doesn't answers every open question the engineer asked `from` (the user: those to the user; the TPM: to it or the team),
 *  or, when it asked `from` nothing, its oldest open question (Bug 157: one answer used to leave the newer of two questions open). */
export function resolveQuestion(engineerId: string, answerMessageId: string, inReplyTo: string | null, from: string): void {
  const open = 'SELECT id, ticket_id FROM questions WHERE from_agent_id = ? AND answered_at IS NULL'
  const asked = () => q<QRow>(`${open} AND to_target IN (?, ?) ORDER BY asked_at`, engineerId, from, from === 'user' ? 'user' : 'team')
  const rows = inReplyTo ? q<QRow>('SELECT id, ticket_id FROM questions WHERE message_id = ? AND answered_at IS NULL', inReplyTo)
    : ((r) => r.length ? r : q<QRow>(`${open} ORDER BY asked_at LIMIT 1`, engineerId))(asked())
  // listeners.ts hears question.answered and takes the ticket out of awaiting_answer once none is left open (it owns ticket writes; no import cycle).
  tx(() => { const at = now(); for (const qrow of rows) { run('UPDATE questions SET answered_at = ?, answer_message_id = ? WHERE id = ?', at, answerMessageId, qrow.id)
    patch('question', qrow.id, { answered_at: at })
    emit({ agentId: engineerId, source: 'system', kind: 'question.answered', payload: { question: qrow.id, answer: answerMessageId, ticket: qrow.ticket_id } }) } })
}
/** Bug 157: whether `ticketId` still waits on an answer to one of its engineer's questions. */
export const waitsOnQuestion = (ticketId: string): boolean => !!one('SELECT 1 AS x FROM questions WHERE ticket_id = ? AND answered_at IS NULL', ticketId)
/** Bug 157: a new question starts a new wait. Questions on `ticketId` still open from an earlier wait that ended without their answer
 *  (the engineer opened its PR anyway, a new engineer took over) aren't waited on any more: they close, with no answer, and leave the page. */
export function dropOldQuestions(ticketId: string): void {
  const old = q<{ id: string }>('SELECT id FROM questions WHERE ticket_id = ? AND answered_at IS NULL', ticketId); if (!old.length) return
  const at = now(); run('UPDATE questions SET answered_at = ? WHERE ticket_id = ? AND answered_at IS NULL', at, ticketId)
  for (const x of old) patch('question', x.id, { answered_at: at })
}
