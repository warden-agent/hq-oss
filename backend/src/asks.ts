// Questions a TPM puts to the user with ask_user (Bug 43). A question at the end of a long reply was easy to miss, and nothing on
// the board said the TPM was waiting: an open ask shows as "Your turn" on the TPM box, in ⚠ and in the tab title, with a button
// per choice. The answer goes to the project's TPM as the user's message (starting it if it isn't running); anything the user
// tells the TPM answers its open asks too. Asks belong to the project (Bug 52); `feature_id` is set when one is about a ticket.
// Some asks carry an action HQ does itself on the user's choice (Bug 50: cancel_ticket's "Remove it"); only their buttons answer them.
import { one, q, run, now } from './db.ts'
import { emit, patch } from './events.ts'
import { id } from './util.ts'
import type { Agent } from './agents.ts'
import { getTicket, liveTpm } from './records.ts'
import { cancelTicket, fillSlots } from './tickets.ts'
import { sendMessage } from './delivery.ts'
import { messageTpm } from './tpm.ts'

export type Ask = { id: string; repo_id: string; feature_id: string | null; agent_id: string; question: string; choices: string; created_at: number; answered_at: number | null; answer: string | null; action: string | null }
/** What HQ does on the user's choice. cancel_ticket: "Remove it" cancels the ticket, "Keep it" leaves it. */
export type AskAction = { kind: 'cancel_ticket'; ticket: string }
export const REMOVE = 'Remove it', KEEP = 'Keep it'
export const actionOf = (a: Pick<Ask, 'action'>): AskAction | null => { try { return a.action ? JSON.parse(a.action) as AskAction : null } catch { return null } }
export const openAsks = (): Ask[] => q<Ask>('SELECT * FROM asks WHERE answered_at IS NULL ORDER BY created_at')

/** ask_user: saves the question for the user. `choices`: up to 4 short answers the UI shows as buttons (none: free text only). */
export function askUser(agent: Agent, question: string, choices: string[], action: AskAction | null = null): Ask {
  const about = action ? getTicket(action.ticket)?.feature_id ?? null : null
  const row: Ask = { id: id('ask'), repo_id: agent.repo_id ?? '', feature_id: about ?? agent.feature_id, agent_id: agent.id, question, choices: JSON.stringify(choices), created_at: now(),
    answered_at: null, answer: null, action: action ? JSON.stringify(action) : null }
  run('INSERT INTO asks(id, repo_id, feature_id, agent_id, question, choices, created_at, action) VALUES (?,?,?,?,?,?,?,?)',
    row.id, row.repo_id, row.feature_id, row.agent_id, row.question, row.choices, row.created_at, row.action)
  patch('ask', row.id, row as unknown as Record<string, unknown>)
  emit({ agentId: agent.id, source: 'mcp', kind: 'ask.opened', payload: { id: row.id, question, choices } })
  return row
}

function close(a: Ask, answer: string | null): void {
  const t = now(); run('UPDATE asks SET answered_at = ?, answer = ? WHERE id = ?', t, answer, a.id)
  patch('ask', a.id, { answered_at: t, answer })
  emit({ agentId: null, source: 'ui', kind: 'ask.closed', payload: { id: a.id, answer } })
}

/** The user answered from a choice button or the Answer box: closed, and the TPM gets it as the user's message. */
export async function answerAsk(askId: string, answer: string): Promise<Ask> {
  const a = one<Ask>('SELECT * FROM asks WHERE id = ?', askId); if (!a) throw new Error('unknown question')
  if (a.answered_at) throw new Error('That question is already answered.')
  const text = answer.trim(); if (!text) throw new Error('Write an answer first.'); if (text.length > 2000) throw new Error('That answer is too long (2000 characters at most).')
  const act = actionOf(a); if (act) return answerAction(a, act, text)
  const body = `You asked: "${a.question}"\nThe user's answer: ${text}`, tpm = liveTpm(a.repo_id)
  close(a, text)
  if (tpm) sendMessage({ repoId: a.repo_id, channel: 'dm', from: 'user', to: tpm.id, reason: 'answer', body })
  else await messageTpm(a.repo_id, body, { keepAsks: true }) // an ask outlives the TPM that asked it: the answer brings the TPM back
  return { ...a, answered_at: now(), answer: text }
}
/** A choice on an ask with an action: HQ does it (whether or not the TPM runs now; a later TPM sees the result in list_tickets). */
async function answerAction(a: Ask, act: AskAction, choice: string): Promise<Ask> {
  const choices = JSON.parse(a.choices) as string[]
  if (!choices.includes(choice)) throw new Error(`Choose ${choices.map((c) => `"${c}"`).join(' or ')}.`)
  const tpm = liveTpm(a.repo_id), t = getTicket(act.ticket)
  const tell = (body: string) => { if (tpm) sendMessage({ repoId: a.repo_id, channel: 'dm', from: 'user', to: tpm.id, reason: 'answer', body }) }
  if (choice === REMOVE && t && t.status !== 'merged' && t.status !== 'cancelled') {
    await cancelTicket(t.id, { asked: true }) // it tells the TPM; if it can't (an engineer is starting right now), the question stays open
    close(a, choice)
  } else {
    close(a, choice)
    if (choice === REMOVE) tell(`You asked to remove ${t?.key ?? 'a ticket'}; it is ${t?.status ?? 'gone'} already, so nothing changed.`)
    else { tell(`You asked: "${a.question}"\nThe user's answer: ${choice}. Leave ${t?.key ?? 'it'} as it is.`); void fillSlots().catch(() => {}) } // it may start now
  }
  return { ...a, answered_at: now(), answer: choice }
}
/** The user wrote to the TPM directly (Talk to TPM): that's their answer to whatever it asked, so nothing stays "your turn".
 *  Not to an ask with an action: removing a ticket takes a press of "Remove it", never a reply that happens to be sent. */
export function answerOpenAsks(repoId: string, text: string): void {
  for (const a of openAsks().filter((x) => x.repo_id === repoId && !x.action)) close(a, text.slice(0, 2000))
}
/** The feature was cancelled: questions about its tickets (Remove it / Keep it) no longer need the user. */
export function closeAsks(featureId: string): void { for (const a of openAsks().filter((x) => x.feature_id === featureId && x.action)) close(a, null) }
