// The briefing a fresh TPM gets when it takes over a feature, built from HQ's records.
import { unmergedDeps } from './readiness.ts'
import type { Message } from './delivery.ts'
import type { Feature, Repo, Ticket } from './records.ts'

/** Where a ticket stands, in words, for a TPM taking over. */
function standing(t: Ticket, all: Ticket[]): string {
  const waits = unmergedDeps(t, all)
  switch (t.status) {
    case 'queued': return waits.length ? `waits for ${waits.join(', ')} to merge` : 'ready to start (the user starts it with "Start ready")'
    case 'planning': return 'an engineer is writing its plan'
    case 'plan_review': return "its plan waits for the user's review"
    case 'implementing': return 'an engineer is building it'
    case 'awaiting_answer': return 'its engineer waits for an answer'
    case 'escalated': return 'escalated to the user'
    case 'pr_ready': return t.pr_state === 'local' ? 'finished; waits for the user to merge it' : 'finished and pushed; its PR still needs opening'
    case 'pr_open': return `finished; PR #${t.pr_number} waits for the user's merge`
    default: return t.status
  }
}
/** The launch prompt of a TPM taking over a feature: built from HQ's records (the design's rotation rule), never from the old
 *  session. FEATURE.md (rewritten just before) carries the specs and decisions; this carries where things stand. */
export function handoverPrompt(f: Feature, o: { repo: Repo; ws: string; previous: string | null; tickets: Ticket[]; messages: Message[] }): string {
  const talk = o.messages.map((m) => `- ${m.from_id === 'user' ? 'User' : 'TPM'}: ${m.body.length > 400 ? `${m.body.slice(0, 400)}…` : m.body}`).join('\n')
  return `You are taking over as TPM for the feature "${f.title}" in repo "${o.repo.name}" (read-only copy at ${o.repo.path}; your workspace is ${o.ws} with FEATURE.md). The previous TPM session${o.previous ? ` (${o.previous})` : ''} has ended; nothing from it carries over except what is written here and in FEATURE.md, which has every ticket's spec and the decisions so far.

The user's request, verbatim:
"""
${f.request_text}
"""

Tickets now:
${o.tickets.map((t) => `- ${t.key} (${t.size}) ${t.title}: ${standing(t, o.tickets)}${t.branch ? ` · branch ${t.branch}` : ''}`).join('\n') || '- none yet'}
${talk ? `\nLast messages between the user and the TPM, oldest first:\n${talk}\n` : ''}
Do not create or re-split tickets that already exist. First read FEATURE.md and call list_tickets, then tell the user in two or three lines where the feature stands and what happens next. Use assign_ticket only when the user asks you to.`
}
