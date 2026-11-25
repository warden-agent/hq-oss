// Bug 387: a ticket's plan rounds in words, for its TPM. With auto mode off the user answers plans on the board and HQ sends the TPM no message about them,
// so before this it couldn't say whether an engineer planned a change ("I haven't seen a plan from the engineer"). list_tickets shows them, and so does
// HQ's notice when a ticket is finished: no message per plan, to keep the TPM's context small.
import { q } from './db.ts'
import { autoOn, type Ticket } from './records.ts'
import { replanDue } from './replan.ts'

type Round = { round: number; verdict: string | null; verdict_by: string | null }
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
/** "R-1 approved by the user; R-2 approved by the user", oldest first, or null when no plan was handed in for the ticket. A new plan owed after a change
 *  to its spec (Bug 371) is said at the end. */
export function planWords(t: Pick<Ticket, 'id' | 'replan_after'>, repoId: string | null | undefined): string | null {
  const all = q<Round>('SELECT round, verdict, verdict_by FROM plan_revisions WHERE ticket_id = ? ORDER BY round, submitted_at', t.id)
  const auto = autoOn(repoId), shown = all.slice(-SHOWN), earlier = all.length - shown.length
  const last = all.at(-1), waiting = !!last && last.verdict === null && last.round > (t.replan_after ?? 0) // the new plan is in: it waits for its answer
  const owed = replanDue(t, repoId) && !waiting ? `a new plan is owed: the spec changed, and R-${t.replan_after} came before its engineer read the change` : null
  const words = [...shown.map((r) => `R-${r.round} ${roundWords(r, auto)}`), ...owed ? [owed] : []]
  if (!words.length) return null
  return `${earlier ? `${earlier} earlier, then ` : ''}${words.join('; ')}`
}
