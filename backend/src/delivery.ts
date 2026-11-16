// Messages, batches and the delivery policy. Batches are composed lazily when the mod asks for work.
import fs from 'node:fs'
import path from 'node:path'
import { one, q, run, now, getSetting, tx } from './db.ts'
import { DEFAULTS } from './config.ts'
import { emit, patch } from './events.ts'
import { id } from './util.ts'
import { agentDir, getAgent, liveAgents, update, type Agent } from './agents.ts'
import { attention, resolveKind } from './attention.ts'
import * as tmux from './tmux.ts'
import { paneLooksIdle, paneShowsDialog } from './screen.ts'
import { wake, wakeAll } from './wake.ts'

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
  if (row.channel === 'team') wakeAll(); else wake(row.to_id) // Bug 99: its waiting `next` hands it out at once
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
/** One line, as HQ types it into a terminal: Enter sends it, so a line break inside can't be relied on to stay one. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()
/** Whether a typed line can go in as it is. In Claude Code's prompt a first character of `!` runs the rest as a shell command, outside the sandbox, and
 *  `/` makes it a slash command (checked on 2.1.322); other signs may get a meaning later. So only a line that starts with a letter or a digit. */
const startsPlain = (line: string): boolean => /^[\p{L}\p{N}]/u.test(line)
/** Delivery policy: returns a batch or null. `by`: who takes it. 'mod' is the mod's long-poll (and the Stop hook's answer when the mod has gone quiet).
 *  'typed' is HQ typing into the agent's terminal (typeNext, Bug 110): the batch's text is then the one line it types. */
export function nextBatchFor(agent: Agent, by: 'mod' | 'typed' = 'mod'): Handed | null {
  const t = now()
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
  // While it writes its handoff note, the request is all it gets; the rest waits for the session that takes over.
  const all = pendingFor(agent), stale = agent.fresh_start_at ? [] : all.filter((m) => m.reason === 'fresh_start') // its fresh start is over
  for (const m of stale) { run("UPDATE messages SET delivered_at = ?, delivery_method = 'dropped' WHERE id = ?", t, m.id); patch('message', m.id, { delivered_at: t, delivery_method: 'dropped' }) }
  const msgs = agent.fresh_start_at ? all.filter((m) => m.reason === 'fresh_start') : all.filter((m) => m.reason !== 'fresh_start'); if (!msgs.length) return null
  // Bug 110: after an interrupted turn the mod's prompt would be dropped, so nothing is handed to it. HQ types the messages itself, when the screen allows it.
  if (by === 'mod' && interrupted) { typeNext(agent.id); return null }
  const user = msgs.map((m) => m.body).join('\n\n'), bid = id('B')
  const labelled = msgs.map((m) => `[${m.reason}] from ${displayName(m.from_id)}${m.from_id === 'user' || m.from_id === 'hq' ? '' : ` (id ${m.from_id})`}${m.in_reply_to ? ' (reply)' : ''} [msg ${m.id}]: ${m.body}`).join('\n\n')
  // What the user wrote goes in as their own words. Typed, only when the line can't be taken for a command; otherwise labelled, like everyone else's
  const allUser = msgs.every((m) => m.from_id === 'user') && (by === 'mod' || startsPlain(oneLine(user)))
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
/** Statuses with a menu or a dialog on the screen, where Enter would pick an option, and one that takes no messages. */
const NOT_TYPEABLE = ['blocked', 'paused', 'plan_review']
/** Why HQ holds back from typing into each agent's terminal right now: 'status' (HQ knows of a dialog or a plan menu), 'dialog' or 'busy' (its screen
 *  shows one, or a turn at work), 'screen' (anything else that isn't the waiting prompt: Claude Code's Rewind menu after Escape twice, say). Logged
 *  once per reason, not at every look, and sent to the page, whose box says why the message waits (`type_waits`, frontend waitingFor). */
const typeWaits = new Map<string, string>()
function typeWaiting(a: Agent, why: string | null): void {
  if ((typeWaits.get(a.id) ?? null) === why) return
  if (why) { typeWaits.set(a.id, why); emit({ agentId: a.id, source: 'system', kind: 'batch.type_waits', payload: { why, status: a.status } }) } else typeWaits.delete(a.id)
  patch('agent', a.id, { type_waits: why })
}
/** Bug 110: types the agent's next batch into its terminal, as a person would, because the mod can't deliver it (see turnEnded). Only into Claude Code's
 *  waiting prompt: never into a menu or a dialog, and not while it works. Otherwise nothing happens now, and the mod's `next` request looks again
 *  when something changes and every few seconds (hooks.ts). The prompt's UserPromptSubmit hook acks the batch like any other; one that never
 *  starts is typed again after NOT_ACKED_MS, three times at most (requeue). */
export function typeNext(agentId: string): void {
  if (typing.has(agentId)) return
  inTerminal(agentId, async () => {
    const was = getAgent(agentId); if (!was) return
    const screen = await tmux.visiblePane(was.tmux_session)
    const a = getAgent(agentId); if (!a || a.status === 'exited' || !a.interrupted_at) return // read again: the look at the screen took a moment
    const why = NOT_TYPEABLE.includes(a.status) ? 'status' : paneLooksIdle(screen) ? null : paneShowsDialog(screen) ? 'dialog' : /esc to interrupt/.test(screen) ? 'busy' : 'screen'
    typeWaiting(a, why); if (why) return
    const b = nextBatchFor(a, 'typed'); if (!b) return
    try { await tmux.typeLine(a.tmux_session, b.text) }
    catch (e) { emit({ agentId: a.id, source: 'system', kind: 'batch.type_failed', payload: { id: b.id, error: String(e) } }); return requeue(b.id, 'type_failed') }
    markSubmitted(b.id); emit({ agentId: a.id, source: 'system', kind: 'batch.typed', payload: { id: b.id } })
  }).catch((e) => emit({ agentId, source: 'system', kind: 'backend.error', payload: { server: 'typing', error: String(e) } }))
}
/** Bug 99: when nextBatchFor could next find something with nothing else changing (no message, no ack, no setting): a hold ends,
 *  a batch handed out or submitted is due to be handed out again, or the one in flight stops holding the rest back. Null: none. */
export function nextDeadline(agent: Agent): number | null {
  const t = now(), receive = getSetting('batch_receive_s', DEFAULTS.batch_receive_s) * 1000, times: number[] = []
  if (agent.takeover_locked_until && agent.takeover_locked_until > t) times.push(agent.takeover_locked_until)
  for (const b of q<Batch>('SELECT * FROM batches WHERE agent_id = ? AND acked_at IS NULL AND dropped_at IS NULL AND handed_at IS NOT NULL', agent.id)) {
    times.push(b.handed_at! + 180_000); if (b.received_at === null) times.push(b.handed_at! + receive); if (b.submitted_at !== null) times.push(b.submitted_at + NOT_ACKED_MS)
  }
  const later = times.filter((x) => x >= t); return later.length ? Math.min(...later) + 1 : null // the checks compare with < and >
}
/** Urgent delivery: Escape stops the agent's current turn and `m` is typed into its terminal. After an interrupt Claude Code
 *  drops prompts a mod submits until a normal turn has ended (seen on 2.1.300 and 2.1.322), so the mod can't carry it. `m` is marked
 *  delivered before the first await, so the mod's long-poll never hands it out as well. */
export async function interruptAndType(agent: Agent, m: Message): Promise<void> {
  const t0 = now(); run("UPDATE messages SET delivered_at = ?, delivery_method = 'tmux' WHERE id = ?", t0, m.id); patch('message', m.id, { delivered_at: t0, delivery_method: 'tmux' })
  await inTerminal(agent.id, async () => { // not in the middle of a batch HQ is typing there (Bug 110)
    await tmux.sendEscape(agent.tmux_session).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500)) // let the interrupted turn wind down
    const text = (m.from_id === 'user' ? m.body : `[${m.reason}] from ${displayName(m.from_id)}: ${m.body}`).replace(/\s*\n\s*/g, ' ')
    await tmux.sendKeys(agent.tmux_session, text)
  })
  const t = now(); run('UPDATE messages SET ack_at = ? WHERE id = ?', t, m.id); patch('message', m.id, { ack_at: t })
  emit({ agentId: agent.id, source: 'system', kind: 'message.typed', payload: { id: m.id, reason: m.reason } })
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
    + 'Check its terminal, then send the message again.', { agentId: b.agent_id })
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
