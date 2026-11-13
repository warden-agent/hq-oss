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
import { sendMessage, type Message } from './delivery.ts'
import { wake } from './wake.ts'
import { resolveKind } from './attention.ts'
import { tpmPrompt } from './handover.ts'
import { readNote } from './notes.ts'
import { writeProjectMd } from './projectmd.ts'
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
    const repo = await ensureFresh(repoId)
    const ws = writeProjectMd(repoId), note = readNote(`resume:repo:${repoId}`)
    const prompt = tpmPrompt(repo, { ws, previous: prev?.id ?? null, note, board: board(repoId), messages: prev ? lastTalk(repoId) : [], message: o.message,
      cleared: o.cleared, context: fs.existsSync(path.join(ws, 'CONTEXT.md')), localOnly: localOnly(repo) })
    const a = await launchAgent({ role: 'tpm', repoId, model: modelFor('tpm'), cwd: ws, displayName: `TPM ${repo.name}`, launchPrompt: prompt, extraFlags: ['--add-dir', repo.path] })
    run('UPDATE repos SET tpm_agent_id = ?, tpm_parked_at = NULL WHERE id = ?', a.id, repoId); patch('repo', repoId, { tpm_agent_id: a.id, tpm_parked_at: null })
    if (prev) { handOver(prev.id, a.id); resolveKind('agent_exited', prev.id) }
    emit({ agentId: a.id, source: 'system', kind: 'tpm.started', payload: { repo: repoId, previous: prev?.id ?? null, why: o.why } })
    return a
  } finally { starting.delete(repoId) }
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
  tx(() => {
    run('UPDATE messages SET to_id = ? WHERE to_id = ? AND delivered_at IS NULL', newId, oldId)
    run('UPDATE questions SET to_target = ? WHERE to_target = ? AND answered_at IS NULL', newId, oldId)
    run('UPDATE questions SET from_agent_id = ? WHERE from_agent_id = ? AND answered_at IS NULL', newId, oldId)
    run("UPDATE needs_attention SET agent_id = ? WHERE agent_id = ? AND kind = 'message_for_user' AND resolved_at IS NULL", newId, oldId)
  })
  for (const m of moved) patch('message', m.id, { to_id: newId })
  if (moved.length) wake(newId) // Bug 99: its waiting `next` hands them out
  for (const a of told) patch('attention', a.id, { agent_id: newId })
}
