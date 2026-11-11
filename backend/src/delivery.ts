// Messages, batches and the delivery policy. Batches are composed lazily when the mod asks for work.
import fs from 'node:fs'
import path from 'node:path'
import { one, q, run, now, getSetting, tx } from './db.ts'
import { DEFAULTS } from './config.ts'
import { emit, patch } from './events.ts'
import { id } from './util.ts'
import { agentDir, getAgent, liveAgents, type Agent } from './agents.ts'
import { attention, resolveKind } from './attention.ts'
import * as tmux from './tmux.ts'

export type Message = { id: string; repo_id: string | null; feature_id: string | null; channel: string; from_id: string; to_id: string | null; reason: string; in_reply_to: string | null; body: string; created_at: number; batch_id: string | null; delivered_at: number | null; delivery_method: string | null; ack_at: number | null }
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
  const row: Message = { id: id('msg'), repo_id: m.repoId ?? repoFor(m.featureId, m.from, m.to), feature_id: m.featureId ?? null, channel: m.channel, from_id: m.from, to_id: m.to ?? null, reason: m.reason, in_reply_to: m.inReplyTo ?? null, body: m.body, created_at: now(), batch_id: null, delivered_at: null, delivery_method: null, ack_at: null }
  run('INSERT INTO messages(id, repo_id, feature_id, channel, from_id, to_id, reason, in_reply_to, body, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', row.id, row.repo_id, row.feature_id, row.channel, row.from_id, row.to_id, row.reason, row.in_reply_to, row.body, row.created_at)
  patch('message', row.id, row as unknown as Record<string, unknown>)
  emit({ agentId: m.from === 'user' || m.from === 'hq' ? null : m.from, source: 'system', kind: 'message.sent', payload: { id: row.id, to: row.to_id, reason: m.reason, channel: m.channel } })
  // What answers an engineer's question: anything the user sends it (their message box says 'fyi'), or the TPM's reply marked as one.
  const answers = m.from === 'user' || (getAgent(m.from)?.role === 'tpm' && (!!m.inReplyTo || m.reason === 'answer'))
  if (row.to_id && row.to_id !== 'team' && row.to_id !== 'user' && answers) resolveQuestion(row.to_id, row.id, m.inReplyTo ?? null)
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
    created_at: t, batch_id: null, delivered_at: t, delivery_method: 'terminal', ack_at: t }
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
/** Delivery policy for the mod's long-poll: returns a batch or null. */
export function nextBatchFor(agent: Agent): Handed | null {
  const t = now()
  if (agent.takeover_locked_until && agent.takeover_locked_until > t) return null
  if (agent.status === 'paused' || pausedRoles().includes(agent.role)) return null
  const lost = t - getSetting('batch_receive_s', DEFAULTS.batch_receive_s) * 1000 // handed out, but the mod never said it got it
  for (const b of q<Batch>("SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND received_at IS NULL AND handed_at IS NOT NULL AND handed_at < ?", agent.id, lost)) requeue(b.id, 'not_received')
  // Submitted but the prompt never started: Claude Code drops a mod's prompt after an Escape interrupt (2.1.300, 2.1.322). Send it again.
  const unacked = q<Batch>('SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND submitted_at IS NOT NULL AND submitted_at < ?', agent.id, t - NOT_ACKED_MS)
  for (const b of unacked) requeue(b.id, 'not_acked')
  const open = one<Batch>('SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND handed_at IS NOT NULL AND handed_at > ? ORDER BY handed_at DESC', agent.id, t - 180_000)
  if (open) return null // one in flight; wait for the ack (UserPromptSubmit) before handing another
  const launch = one<Batch>("SELECT * FROM batches WHERE agent_id = ? AND method = 'launch' AND handed_at IS NULL AND acked_at IS NULL", agent.id)
  if (launch) { run('UPDATE batches SET handed_at = ? WHERE id = ?', t, launch.id); emit({ agentId: agent.id, source: 'system', kind: 'batch.handed', payload: { id: launch.id, launch: true } }); return { ...launch, handed_at: t, raw: true, asUser: true } }
  // While it writes its handoff note, the request is all it gets; the rest waits for the session that takes over.
  const all = pendingFor(agent), stale = agent.fresh_start_at ? [] : all.filter((m) => m.reason === 'fresh_start') // its fresh start is over
  for (const m of stale) { run("UPDATE messages SET delivered_at = ?, delivery_method = 'dropped' WHERE id = ?", t, m.id); patch('message', m.id, { delivered_at: t, delivery_method: 'dropped' }) }
  const msgs = agent.fresh_start_at ? all.filter((m) => m.reason === 'fresh_start') : all.filter((m) => m.reason !== 'fresh_start'); if (!msgs.length) return null
  const allUser = msgs.every((m) => m.from_id === 'user')
  const text = allUser ? msgs.map((m) => m.body).join('\n\n') : msgs.map((m) => `[${m.reason}] from ${displayName(m.from_id)}${m.from_id === 'user' || m.from_id === 'hq' ? '' : ` (id ${m.from_id})`}${m.in_reply_to ? ' (reply)' : ''} [msg ${m.id}]: ${m.body}`).join('\n\n')
  const b: Batch = { id: id('B'), agent_id: agent.id, text, created_at: t, handed_at: t, submitted_at: null, acked_at: null, method: allUser ? 'mod_user' : 'mod', received_at: null, dropped_at: null }
  tx(() => { run('INSERT INTO batches(id, agent_id, text, created_at, handed_at, method) VALUES (?,?,?,?,?,?)', b.id, b.agent_id, b.text, b.created_at, b.handed_at, b.method); for (const m of msgs) run('UPDATE messages SET batch_id = ?, delivered_at = ?, delivery_method = ? WHERE id = ?', b.id, t, 'mod', m.id) })
  for (const m of msgs) patch('message', m.id, { batch_id: b.id, delivered_at: t, delivery_method: 'mod' })
  emit({ agentId: agent.id, source: 'system', kind: 'batch.handed', payload: { id: b.id, messages: msgs.map((m) => m.id) } })
  return { ...b, raw: allUser, asUser: allUser }
}
/** Urgent delivery: Escape stops the agent's current turn and `m` is typed into its terminal. After an interrupt Claude Code
 *  drops prompts a mod submits until a normal turn has ended (seen on 2.1.300 and 2.1.322), so the mod can't carry it. `m` is marked
 *  delivered before the first await, so the mod's long-poll never hands it out as well. */
export async function interruptAndType(agent: Agent, m: Message): Promise<void> {
  const t0 = now(); run("UPDATE messages SET delivered_at = ?, delivery_method = 'tmux' WHERE id = ?", t0, m.id); patch('message', m.id, { delivered_at: t0, delivery_method: 'tmux' })
  await tmux.sendEscape(agent.tmux_session).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500)) // let the interrupted turn wind down
  const text = (m.from_id === 'user' ? m.body : `[${m.reason}] from ${displayName(m.from_id)}: ${m.body}`).replace(/\s*\n\s*/g, ' ')
  await tmux.sendKeys(agent.tmux_session, text)
  const t = now(); run('UPDATE messages SET ack_at = ? WHERE id = ?', t, m.id); patch('message', m.id, { ack_at: t })
  emit({ agentId: agent.id, source: 'system', kind: 'message.typed', payload: { id: m.id, reason: m.reason } })
}
export function markSubmitted(batchId: string): void { run('UPDATE batches SET submitted_at = ? WHERE id = ?', now(), batchId) }
export function markReceived(batchId: string): void { run('UPDATE batches SET received_at = ? WHERE id = ? AND received_at IS NULL', now(), batchId) }
/** A batch that didn't get through (the mod couldn't submit it, or never got it): its messages go back in the queue and are
 *  handed out again in a new batch; a launch prompt is handed out again as it is. One that was acked stays delivered. After
 *  three failures in ten minutes HQ stops retrying (a mod that keeps failing would otherwise loop every 1.5 s): the batch's
 *  messages are marked failed and the user is told. */
export function requeue(batchId: string, why: string): void {
  const b = one<Batch>('SELECT * FROM batches WHERE id = ?', batchId); if (!b || b.acked_at || b.dropped_at) return
  const tries = one<{ c: number }>("SELECT COUNT(*) c FROM events WHERE agent_id = ? AND kind = 'batch.requeued' AND created_at > ?", b.agent_id, now() - 600_000)!.c + 1
  if (tries >= 3) return giveUp(b, why, tries)
  if (b.method === 'launch') run('UPDATE batches SET handed_at = NULL, received_at = NULL, submitted_at = NULL WHERE id = ?', b.id)
  else {
    const ms = q<{ id: string }>('SELECT id FROM messages WHERE batch_id = ?', b.id)
    tx(() => { run('UPDATE batches SET dropped_at = ? WHERE id = ?', now(), b.id); run('UPDATE messages SET batch_id = NULL, delivered_at = NULL, delivery_method = NULL WHERE batch_id = ?', b.id) })
    for (const m of ms) patch('message', m.id, { batch_id: null, delivered_at: null, delivery_method: null })
  }
  emit({ agentId: b.agent_id, source: 'system', kind: 'batch.requeued', payload: { id: b.id, why, launch: b.method === 'launch' } })
}
function giveUp(b: Batch, why: string, tries: number): void {
  const ms = q<{ id: string }>('SELECT id FROM messages WHERE batch_id = ?', b.id)
  tx(() => { run('UPDATE batches SET dropped_at = ? WHERE id = ?', now(), b.id); run("UPDATE messages SET delivery_method = 'failed' WHERE batch_id = ?", b.id) })
  for (const m of ms) patch('message', m.id, { delivery_method: 'failed' })
  emit({ agentId: b.agent_id, source: 'system', kind: 'batch.given_up', payload: { id: b.id, why, tries, launch: b.method === 'launch' } })
  attention('delivery_failed', `${displayName(b.agent_id)}: HQ couldn't deliver ${b.method === 'launch' ? 'its launch prompt' : 'a message batch'} ${tries} times (${why === 'submit_failed' ? 'the mod could not submit it' : 'the mod never got it'}), so it stopped trying. Check its terminal, then send the message again.`, { agentId: b.agent_id })
}
export function ackBatchFromPrompt(agent: Agent, prompt: string): string | null {
  const m = /HQ message batch (B-[0-9a-f]+)/.exec(prompt)
  let batchId = m?.[1] ?? null
  if (!batchId) { // raw batches (launch prompt, user messages): match by prefix
    const open = q<Batch>('SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND handed_at IS NOT NULL ORDER BY handed_at DESC', agent.id)
    const head = prompt.trim().slice(0, 60)
    batchId = open.find((b) => head && b.text.trim().slice(0, 60) === head)?.id ?? null
  }
  if (!batchId) return null
  const t = now(); run('UPDATE batches SET acked_at = ? WHERE id = ? AND agent_id = ?', t, batchId, agent.id)
  run('UPDATE messages SET ack_at = ? WHERE batch_id = ?', t, batchId)
  for (const row of q<Message>('SELECT * FROM messages WHERE batch_id = ?', batchId)) patch('message', row.id, { ack_at: t, delivered_at: row.delivered_at })
  emit({ agentId: agent.id, source: 'system', kind: 'batch.acked', payload: { id: batchId } })
  return batchId
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
export function messagesForFeature(featureId: string | null, limit = 200): Message[] {
  return featureId ? q<Message>('SELECT * FROM messages WHERE feature_id = ? ORDER BY created_at DESC LIMIT ?', featureId, limit) : q<Message>('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?', limit)
}
export function unreadCount(agent: Agent): number { return pendingFor(agent).length }
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

export function resolveQuestion(engineerId: string, answerMessageId: string, inReplyTo: string | null): void {
  const qrow = inReplyTo ? one<{ id: string; ticket_id: string | null }>('SELECT id, ticket_id FROM questions WHERE message_id = ? AND answered_at IS NULL', inReplyTo) : one<{ id: string; ticket_id: string | null }>('SELECT id, ticket_id FROM questions WHERE from_agent_id = ? AND answered_at IS NULL ORDER BY asked_at', engineerId)
  if (!qrow) return
  // tickets.ts hears question.answered and takes the ticket out of awaiting_answer (it owns ticket writes; no import cycle).
  tx(() => { run('UPDATE questions SET answered_at = ?, answer_message_id = ? WHERE id = ?', now(), answerMessageId, qrow.id); emit({ agentId: engineerId, source: 'system', kind: 'question.answered', payload: { question: qrow.id, answer: answerMessageId, ticket: qrow.ticket_id } }) })
}
