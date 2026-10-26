// Messages, batches and the delivery policy. Batches are composed lazily when the mod asks for work.
import { one, q, run, now, getSetting, tx } from './db.ts'
import { DEFAULTS } from './config.ts'
import { emit, patch } from './events.ts'
import { id } from './util.ts'
import { getAgent, liveAgents, type Agent } from './agents.ts'
import { attention } from './attention.ts'

export type Message = { id: string; feature_id: string | null; channel: string; from_id: string; to_id: string | null; reason: string; in_reply_to: string | null; body: string; created_at: number; batch_id: string | null; delivered_at: number | null; delivery_method: string | null; ack_at: number | null }
export type Batch = { id: string; agent_id: string; text: string; created_at: number; handed_at: number | null; submitted_at: number | null; acked_at: number | null; method: string | null; received_at: number | null; dropped_at: number | null }
export type Handed = Batch & { raw: boolean; asUser: boolean }

export function displayName(agentOrId: string): string {
  if (agentOrId === 'user') return 'the user'
  if (agentOrId === 'hq') return 'HQ'
  const a = getAgent(agentOrId); if (!a) return agentOrId
  return a.display_name ?? `${a.role} ${a.id}`
}

/** `from`: an agent id, 'user' (the person running HQ) or 'hq' (HQ's own notices, which are never the user's words or an answer). */
export function sendMessage(m: { featureId?: string | null; channel: 'team' | 'dm'; from: string; to?: string | null; reason: string; body: string; inReplyTo?: string | null; method?: string }): Message {
  const row: Message = { id: id('msg'), feature_id: m.featureId ?? null, channel: m.channel, from_id: m.from, to_id: m.to ?? null, reason: m.reason, in_reply_to: m.inReplyTo ?? null, body: m.body, created_at: now(), batch_id: null, delivered_at: null, delivery_method: null, ack_at: null }
  run('INSERT INTO messages(id, feature_id, channel, from_id, to_id, reason, in_reply_to, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)', row.id, row.feature_id, row.channel, row.from_id, row.to_id, row.reason, row.in_reply_to, row.body, row.created_at)
  patch('message', row.id, row as unknown as Record<string, unknown>)
  emit({ agentId: m.from === 'user' || m.from === 'hq' ? null : m.from, source: 'system', kind: 'message.sent', payload: { id: row.id, to: row.to_id, reason: m.reason, channel: m.channel } })
  // What answers an engineer's question: anything the user sends it (their message box says 'fyi'), or the TPM's reply marked as one.
  const answers = m.from === 'user' || (getAgent(m.from)?.role === 'tpm' && (!!m.inReplyTo || m.reason === 'answer'))
  if (row.to_id && row.to_id !== 'team' && row.to_id !== 'user' && answers) resolveQuestion(row.to_id, row.id, m.inReplyTo ?? null)
  if (row.to_id === 'user') { run('UPDATE messages SET delivered_at = ?, delivery_method = ? WHERE id = ?', now(), 'ui', row.id); attention('message_for_user', `${displayName(m.from)} (${m.reason}): ${m.body.slice(0, 200)}`, { agentId: m.from }) }
  return row
}

/** Undelivered messages addressed to this agent (DMs to it, or team messages in its feature not sent by it). */
export function pendingFor(agent: Agent): Message[] {
  return q<Message>(`SELECT * FROM messages WHERE delivered_at IS NULL AND (to_id = ? OR (channel = 'team' AND feature_id = ? AND from_id != ?)) ORDER BY created_at`, agent.id, agent.feature_id ?? '', agent.id)
}
export function pausedRoles(): string[] { return getSetting<string[]>('paused_roles', []) }

/** Delivery policy for the mod's long-poll: returns a batch or null. */
export function nextBatchFor(agent: Agent): Handed | null {
  const t = now()
  if (agent.takeover_locked_until && agent.takeover_locked_until > t) return null
  if (agent.status === 'paused' || pausedRoles().includes(agent.role)) return null
  const lost = t - getSetting('batch_receive_s', DEFAULTS.batch_receive_s) * 1000 // handed out, but the mod never said it got it
  for (const b of q<Batch>("SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND received_at IS NULL AND handed_at IS NOT NULL AND handed_at < ?", agent.id, lost)) requeue(b.id, 'not_received')
  const open = one<Batch>('SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND handed_at IS NOT NULL AND handed_at > ? ORDER BY handed_at DESC', agent.id, t - 180_000)
  if (open) return null // one in flight; wait for the ack (UserPromptSubmit) before handing another
  const launch = one<Batch>("SELECT * FROM batches WHERE agent_id = ? AND method = 'launch' AND handed_at IS NULL AND acked_at IS NULL", agent.id)
  if (launch) { run('UPDATE batches SET handed_at = ? WHERE id = ?', t, launch.id); emit({ agentId: agent.id, source: 'system', kind: 'batch.handed', payload: { id: launch.id, launch: true } }); return { ...launch, handed_at: t, raw: true, asUser: true } }
  const msgs = pendingFor(agent); if (!msgs.length) return null
  const allUser = msgs.every((m) => m.from_id === 'user')
  const text = allUser ? msgs.map((m) => m.body).join('\n\n') : msgs.map((m) => `[${m.reason}] from ${displayName(m.from_id)}${m.from_id === 'user' || m.from_id === 'hq' ? '' : ` (id ${m.from_id})`}${m.in_reply_to ? ' (reply)' : ''} [msg ${m.id}]: ${m.body}`).join('\n\n')
  const b: Batch = { id: id('B'), agent_id: agent.id, text, created_at: t, handed_at: t, submitted_at: null, acked_at: null, method: allUser ? 'mod_user' : 'mod', received_at: null, dropped_at: null }
  tx(() => { run('INSERT INTO batches(id, agent_id, text, created_at, handed_at, method) VALUES (?,?,?,?,?,?)', b.id, b.agent_id, b.text, b.created_at, b.handed_at, b.method); for (const m of msgs) run('UPDATE messages SET batch_id = ?, delivered_at = ?, delivery_method = ? WHERE id = ?', b.id, t, 'mod', m.id) })
  for (const m of msgs) patch('message', m.id, { batch_id: b.id, delivered_at: t, delivery_method: 'mod' })
  emit({ agentId: agent.id, source: 'system', kind: 'batch.handed', payload: { id: b.id, messages: msgs.map((m) => m.id) } })
  return { ...b, raw: allUser, asUser: allUser }
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
  if (to === 'tpm') { const f = agent.feature_id ? one<{ tpm_agent_id: string | null }>('SELECT tpm_agent_id FROM features WHERE id = ?', agent.feature_id) : undefined; return f?.tpm_agent_id ?? null }
  if (liveAgents().find((a) => a.id === to)) return to
  const gone = getAgent(to) // a TPM of this feature that has since been replaced: its successor
  if (gone?.role === 'tpm' && gone.feature_id && gone.feature_id === agent.feature_id) return one<{ tpm_agent_id: string | null }>('SELECT tpm_agent_id FROM features WHERE id = ?', gone.feature_id)?.tpm_agent_id ?? null
  return null
}
export function dmAllowed(agent: Agent, to: string): { ok: boolean; why?: string } {
  const perHour = getSetting('dm_per_hour', DEFAULTS.dm_per_hour); const perPeerMin = getSetting('dm_per_peer_min', DEFAULTS.dm_per_peer_min)
  const t = now()
  const hour = one<{ c: number }>("SELECT COUNT(*) c FROM messages WHERE from_id = ? AND channel = 'dm' AND created_at > ?", agent.id, t - 3_600_000)!.c
  if (hour >= perHour) return { ok: false, why: `DM limit: ${perHour} per hour` }
  const peer = one<{ c: number }>("SELECT COUNT(*) c FROM messages WHERE from_id = ? AND to_id = ? AND channel = 'dm' AND created_at > ?", agent.id, to, t - perPeerMin * 60_000)!.c
  if (peer >= 1) return { ok: false, why: `DM limit: one per ${perPeerMin} min to the same recipient` }
  return { ok: true }
}

export function resolveQuestion(engineerId: string, answerMessageId: string, inReplyTo: string | null): void {
  const qrow = inReplyTo ? one<{ id: string; ticket_id: string | null }>('SELECT id, ticket_id FROM questions WHERE message_id = ? AND answered_at IS NULL', inReplyTo) : one<{ id: string; ticket_id: string | null }>('SELECT id, ticket_id FROM questions WHERE from_agent_id = ? AND answered_at IS NULL ORDER BY asked_at', engineerId)
  if (!qrow) return
  // tickets.ts hears question.answered and takes the ticket out of awaiting_answer (it owns ticket writes; no import cycle).
  tx(() => { run('UPDATE questions SET answered_at = ?, answer_message_id = ? WHERE id = ?', now(), answerMessageId, qrow.id); emit({ agentId: engineerId, source: 'system', kind: 'question.answered', payload: { question: qrow.id, answer: answerMessageId, ticket: qrow.ticket_id } }) })
}
