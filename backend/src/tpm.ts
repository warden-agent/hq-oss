// The project's TPM (Bug 52): one per repo, and its box is always on the board. It starts with the user's first message (that
// message is its launch prompt), stays while the project is open, is parked when the user switches away and comes back from its
// handoff note, gets a fresh session on ⟳ or at the context limit, and after a Clear. Features are the branches it makes.
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.ts'
import { one, q, run, now, tx } from './db.ts'
import { emit, patch } from './events.ts'
import { getAgent, launchAgent, type Agent } from './agents.ts'
import { modelFor } from './roles.ts'
import { features, getRepo, liveTpm, localOnly, notClearing, tickets, type Repo } from './records.ts'
import { ensureFresh } from './repos.ts'
import { patchQuestion, sendMessage, type Message } from './delivery.ts'
import { wake } from './wake.ts'
import { resolveKind } from './attention.ts'
import { tpmPrompt } from './handover.ts'
import { lastNote } from './notes.ts'
import { writeRepoMd } from './projectmd.ts'
import { answerOpenAsks } from './asks.ts'

const starting = new Set<string>() // repos whose TPM is being started right now
/** The project's TPM is starting (Clear project waits for that). */
export const tpmStarting = (repoId: string): boolean => starting.has(repoId)

/** A new project's first request becomes its context doc, so every TPM there gets it as CONTEXT.md. */
export function keepFirstRequest(repo: Repo, request: string): void {
  const file = path.join(PATHS.projects, repo.id, 'CONTEXT.md'); fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `# ${repo.name}\n\nWhat the user asked for when the project started:\n\n${request}\n`)
  run('UPDATE repos SET context_doc_path = ? WHERE id = ?', file, repo.id); patch('repo', repo.id, { context_doc_path: file })
}

/** The last messages between the user and the project's TPM sessions, oldest first. */
const lastTalk = (repoId: string): Message[] => q<Message>(`SELECT m.* FROM messages m WHERE m.repo_id = ? AND m.delivered_at IS NOT NULL AND (
  (m.from_id = 'user' AND m.to_id IN (SELECT id FROM agents WHERE role = 'tpm')) OR (m.to_id = 'user' AND m.from_id IN (SELECT id FROM agents WHERE role = 'tpm')))
  ORDER BY m.created_at DESC LIMIT 10`, repoId).reverse()
/** Open features of the repo with their tickets (not cancelled), oldest first. */
function board(repoId: string) {
  return features().filter((f) => f.repo_id === repoId && f.status !== 'cancelled').reverse()
    .map((f) => ({ f, tickets: tickets(f.id).filter((t) => t.status !== 'cancelled') }))
    .filter((x) => !x.tickets.length || x.tickets.some((t) => t.status !== 'merged'))
}

/** Starts a TPM session for the repo, briefed from HQ's records: a first start, or a take-over from the last session (its note,
 *  the board, the last messages). `message`: the user's words that start it. `cleared`: right after a Clear. */
async function launch(repoId: string, o: { message?: string | null; cleared?: boolean; why: string }): Promise<Agent> {
  if (starting.has(repoId)) throw new Error('The TPM is starting right now; try again in a moment.')
  starting.add(repoId)
  try {
    notClearing(repoId)
    const r0 = getRepo(repoId); if (!r0) throw new Error('unknown repo')
    const prev = r0.tpm_agent_id ? getAgent(r0.tpm_agent_id) : undefined
    if (prev && prev.status !== 'exited') throw new Error(`${r0.name}'s TPM is already running (${prev.id}).`)
    // Bug 389: a TPM session the last backend started from the note but went down before recording here: it takes over, so a resume run again
    // starts no second one. Not for a start that carries the user's words or a Clear's briefing: those are in the new session's prompt only.
    const cut = o.message || o.cleared ? undefined : one<Agent>(`SELECT * FROM agents WHERE role = 'tpm' AND repo_id = ? AND feature_id IS NULL
      AND status != 'exited' AND id IS NOT ? ORDER BY started_at DESC`, repoId, r0.tpm_agent_id)
    if (cut) return took(repoId, cut, prev, { why: o.why, adopted: true })
    const repo = await ensureFresh(repoId)
    const ws = writeRepoMd(repoId), note = lastNote(`resume:repo:${repoId}`, prev) // Bug 442: an older session's is kept (Bug 52), labelled
    const prompt = tpmPrompt(repo, { ws, previous: prev?.id ?? null, note: note?.text ?? null, olderNote: note && !note.own ? note.at : null,
      board: board(repoId), messages: prev ? lastTalk(repoId) : [], message: o.message, cleared: o.cleared,
      context: fs.existsSync(path.join(ws, 'CONTEXT.md')), localOnly: localOnly(repo) })
    const a = await launchAgent({ role: 'tpm', repoId, model: modelFor('tpm'), cwd: ws, displayName: `TPM ${repo.name}`, launchPrompt: prompt, extraFlags: ['--add-dir', repo.path] })
    return took(repoId, a, prev, { why: o.why })
  } finally { starting.delete(repoId) }
}

/** `a` is the repo's TPM now: recorded, with what was left for the session before it. */
function took(repoId: string, a: Agent, prev: Agent | undefined, o: { why: string; adopted?: boolean }): Agent {
  run('UPDATE repos SET tpm_agent_id = ?, tpm_parked_at = NULL WHERE id = ?', a.id, repoId); patch('repo', repoId, { tpm_agent_id: a.id, tpm_parked_at: null })
  if (prev) { handOver(prev.id, a.id); resolveKind('agent_exited', prev.id) }
  resolveKind(`repo_clear_tpm:${repoId}`, null) // Bug 285: "its TPM didn't start again" alerts, so it goes once one has started
  emit({ agentId: a.id, source: 'system', kind: 'tpm.started', payload: { repo: repoId, previous: prev?.id ?? null, why: o.why, ...(o.adopted ? { adopted: true } : {}) } })
  return a
}

/** The user wrote in the TPM box. A running TPM gets it as a message; otherwise it starts (or comes back from its note) with the
 *  message as its launch prompt, so it acts on it at once. A new project's first message is kept as its context doc. Anything
 *  the user tells the TPM answers its open questions (Bug 43). */
export async function messageTpm(repoId: string, text: string, o: { keepAsks?: boolean } = {}): Promise<{ agent: Agent; message: Message }> {
  const body = text.trim(); if (!body) throw new Error('Write a message first.'); if (body.length > 20_000) throw new Error('That message is too long (20,000 characters at most).')
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  notClearing(repoId)
  const live = liveTpm(repoId)
  if (live) {
    const message = sendMessage({ repoId, channel: 'dm', from: 'user', to: live.id, reason: 'fyi', body })
    if (!o.keepAsks) answerOpenAsks(repoId, body)
    return { agent: live, message }
  }
  if (repo.empty && !repo.context_doc_path && !one('SELECT 1 AS x FROM features WHERE repo_id = ?', repoId)) keepFirstRequest(repo, body)
  const agent = await launch(repoId, { message: body, why: 'message' })
  if (!o.keepAsks) answerOpenAsks(repoId, body)
  return { agent, message: recordUserMessage(repoId, agent.id, body) }
}
/** A new TPM session for the repo with no message of the user's: a fresh start, coming back to the project, "Start TPM again",
 *  or after a Clear. */
export const restartTpm = (repoId: string, o: { cleared?: boolean; why?: string } = {}): Promise<Agent> =>
  launch(repoId, { cleared: o.cleared, why: o.why ?? (o.cleared ? 'cleared' : 'restart') })

/** The user's message that started a TPM: it is in the launch prompt, so it's kept as delivered (it shows in the chat). */
function recordUserMessage(repoId: string, to: string, body: string): Message {
  const t = now(), m = sendMessage({ repoId, channel: 'dm', from: 'user', to, reason: 'fyi', body })
  run("UPDATE messages SET delivered_at = ?, delivery_method = 'launch', ack_at = ? WHERE id = ?", t, t, m.id)
  patch('message', m.id, { delivered_at: t, delivery_method: 'launch', ack_at: t })
  return { ...m, delivered_at: t, delivery_method: 'launch', ack_at: t }
}
/** A new session took over from `oldId`: messages still waiting for the old one, questions it asked or was asked that aren't
 *  answered, and what it told the user that's still open (a reply goes to the new session) move to the new one. */
export function handOver(oldId: string, newId: string): void {
  const moved = q<{ id: string }>('SELECT id FROM messages WHERE to_id = ? AND delivered_at IS NULL', oldId)
  const told = q<{ id: string }>("SELECT id FROM needs_attention WHERE agent_id = ? AND kind = 'message_for_user' AND resolved_at IS NULL", oldId)
  const asked = q<{ id: string }>('SELECT id FROM questions WHERE (to_target = ? OR from_agent_id = ?) AND answered_at IS NULL', oldId, oldId)
  tx(() => {
    run('UPDATE messages SET to_id = ? WHERE to_id = ? AND delivered_at IS NULL', newId, oldId)
    run('UPDATE questions SET to_target = ? WHERE to_target = ? AND answered_at IS NULL', newId, oldId)
    run('UPDATE questions SET from_agent_id = ? WHERE from_agent_id = ? AND answered_at IS NULL', newId, oldId)
    run("UPDATE needs_attention SET agent_id = ? WHERE agent_id = ? AND kind = 'message_for_user' AND resolved_at IS NULL", newId, oldId)
  })
  for (const m of moved) patch('message', m.id, { to_id: newId })
  if (moved.length) wake(newId) // Bug 99: its waiting `next` hands them out
  for (const a of told) patch('attention', a.id, { agent_id: newId })
  for (const x of asked) patchQuestion(x.id) // Bug 129: the page says who it waits on, and the answer goes to the new session
}
