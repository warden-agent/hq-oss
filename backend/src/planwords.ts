// Bug 387: a ticket's plan rounds in words, for its TPM. With auto mode off the user answers plans on the board and HQ sends the TPM no message about them,
// so before this it couldn't say whether an engineer planned a change ("I haven't seen a plan from the engineer"). list_tickets shows them, and so does
// HQ's notice when a ticket is finished: no message per plan, to keep the TPM's context small.
// Bug 394 follow-up: a finished ticket the TPM changes (changeFinished) is built again with no new plan, so the rounds alone read as if the last approved
// plan covered the work as it is now. The changes made after the last round are said at the end.
import { q } from './db.ts'
import { autoOn, type Ticket } from './records.ts'
import { replanDue } from './replan.ts'

type Round = { round: number; verdict: string | null; verdict_by: string | null; submitted_at: number }
/** The rounds shown: the last few, and how many came before them. */
const SHOWN = 4
const who = (by: string | null): string => by === 'user' ? 'the user' : by === 'plan_check' ? "HQ's plan check" : 'HQ'
function roundWords(r: Round, auto: boolean): string {
  switch (r.verdict) {
    case 'approve': case 'user_engineer': return `approved by ${who(r.verdict_by)}`
    case 'approve_with_edits': return `approved with edits by ${who(r.verdict_by)}`
    case 'user_override': return "approved in its engineer's terminal"
    case 'revise': case 'user_architect': return `sent back by ${who(r.verdict_by)}`
    case 'escalate': return 'escalated to the user'
    case 'superseded': return 'replaced by a newer plan'
    case null: return auto ? "waits for HQ's plan check" : "waits for the user's review"
    default: return r.verdict
  }
}
/** How many times `ticketId` was changed after it was finished (`ticket.change`, from changeFinished) since plan round `last` was handed in: each change was
 *  built with no new plan. A change records the ticket's plan round as it was then; one recorded before that (no `round`) goes by time. "Build the change"
 *  again (`again`) is the same change sent once more, not a new one. The events are pinned, so the event log's clean-up keeps them; each is
 *  its engineer's (looked up by agent: list_tickets asks for every ticket, and the log has no index by kind). */
function changesAfter(ticketId: string, last: Round): number {
  return q<{ round: number | null; at: number }>(`SELECT json_extract(payload, '$.round') AS round, created_at AS at FROM events WHERE kind = 'ticket.change'
    AND agent_id IN (SELECT id FROM agents WHERE ticket_id = ?) AND json_extract(payload, '$.ticket') = ? AND json_extract(payload, '$.again') IS NOT 1`, ticketId, ticketId)
    .filter((c) => c.round != null ? c.round >= last.round : c.at >= last.submitted_at).length
}
/** "R-1 approved by the user; R-2 approved by the user", oldest first, or null when no plan was handed in for the ticket. A new plan owed after a change
 *  to its spec (Bug 371) is said at the end, and so are changes to the finished ticket built with no new plan since its last round. */
export function planWords(t: Pick<Ticket, 'id' | 'replan_after'>, repoId: string | null | undefined): string | null {
  const all = q<Round>('SELECT round, verdict, verdict_by, submitted_at FROM plan_revisions WHERE ticket_id = ? ORDER BY round, submitted_at', t.id)
  const auto = autoOn(repoId), shown = all.slice(-SHOWN), earlier = all.length - shown.length
  const last = all.at(-1), waiting = !!last && last.verdict === null && last.round > (t.replan_after ?? 0) // the new plan is in: it waits for its answer
  const owed = replanDue(t, repoId) && !waiting ? `a new plan is owed: the spec changed, and R-${t.replan_after} came before its engineer read the change` : null
  const n = last ? changesAfter(t.id, last) : 0, many = n > 1
  const changed = last && n ? `then the ticket was changed ${many ? `${n} times ` : ''}after it was finished, with no new plan for the change${many ? 's' : ''}:`
    + ` R-${last.round} doesn't cover ${many ? 'them' : 'it'}` : null
  const words = [...shown.map((r) => `R-${r.round} ${roundWords(r, auto)}`), ...owed ? [owed] : [], ...changed ? [changed] : []]
  if (!words.length) return null
  return `${earlier ? `${earlier} earlier, then ` : ''}${words.join('; ')}`
}
