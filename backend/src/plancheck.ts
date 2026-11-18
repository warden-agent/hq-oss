// The plan check: on auto, HQ used to approve every plan the moment it arrived, and the engineer who wrote it is the only one who had read the ticket. Now a
// fresh reader (checker.ts) sees the ticket's acceptance criteria and the plan, nothing else, and answers one question: does the plan cover every criterion,
// and does it build anything not asked for? Building the wrong thing is the most expensive mistake, and this is where it's cheapest to catch.
// One send-back per ticket, at most three findings, each about a criterion or something extra: no nitpick loops. The plan after a send-back is approved as it
// stands (the diff check reads what was built from it). A ticket with no criteria has nothing to be checked against and is approved as before.
// A check that can't run (the call fails twice, or never answers) never holds an engineer: its plan is approved unchecked, and the run's summary says so.
import { getSetting, now, one, q, run } from './db.ts'
import { DEFAULTS } from './config.ts'
import { emit, patch } from './events.ts'
import { ask } from './checker.ts'
import { findingLines, planCheckLine, planCheckOf, type Finding, type PlanCheck } from './checks.ts'
import { criteriaLines, criteriaOf } from './criteria.ts'
import { answerReview, getReview, getRevision } from './gate.ts'
import { autoOn, getFeature, getTicket } from './records.ts'
import { canLaunch } from './scheduler.ts'

export const PLAN_SYSTEM = `You are a second reader for a software engineer's plan. You see only the ticket's acceptance criteria and the plan: not the code, not the ticket's
other text, not the engineer's reasoning. Answer two questions.

1. Does the plan cover every criterion? A criterion is covered when the plan says how it will be met, plainly enough to build from. A criterion the plan leaves
out, contradicts or has misread is a finding. A step that could say more is not.
2. Does the plan build anything no criterion asks for? Only a feature or behaviour a user of the app would notice counts. Work needed to meet a criterion is
never extra: tests, data and schema changes, wiring, refactoring, error handling for it.

Rules:
- At most three findings, the most serious first.
- Each finding is about one criterion (give its id, like A2) or is "extra" (something built that no criterion asks for).
- Each says in one or two plain sentences what is wrong and what the plan should do instead.
- Nothing about style, naming, or how you would have built it. If you are not sure something is a problem, it is not a finding.
- verdict is "send_back" only with at least one finding. Otherwise "ok", with no findings.`
export const planPrompt = (criteria: string, plan: string): string => `## Acceptance criteria\n${criteria}\n\n## The engineer's plan\n${plan}\n`
/** What the engineer is told when its plan goes back: the findings, what to do, and that this happens once. */
export const sendBackText = (findings: Finding[]): string => 'HQ\'s plan check sent your plan back. A fresh reader saw only the ticket\'s acceptance criteria and your plan, and found:\n'
  + `${findingLines(findings)}\n`
  + 'Change the plan so every criterion is covered and nothing is built that no criterion asks for, rewrite its "## In plain words" section to match, and call '
  + 'ExitPlanMode again. If a finding is wrong, say why in the plan instead of changing it. This check happens once: your next plan is approved as it stands.'

const checking = new Map<string, AbortController>() // review → the reader's call under way
const failed = new Map<string, number>() // review → calls that failed so far: after the second, the plan is approved unchecked
const MAX_TRIES = 2
const repoOf = (ticketId: string): string | null => { const t = getTicket(ticketId); return t ? getFeature(t.feature_id)?.repo_id ?? null : null }
/** Keeps how the check went with the plan, and tells the page. Null: nothing to say about it any more (the user answers this plan now). */
function record(revisionId: string, reviewId: string, c: PlanCheck | null): void {
  const json = c ? JSON.stringify(c) : null
  run('UPDATE plan_revisions SET check_result = ? WHERE id = ?', json, revisionId); patch('review', reviewId, { plan_check: json })
}
/** At startup: a check that was under way when the backend stopped is gone with it. Its plan is checked afresh if auto mode still wants that; until then
 *  nothing says a reader has it. */
export function forgetChecking(): void { run(`UPDATE plan_revisions SET check_result = NULL WHERE check_result LIKE '{"state":"checking"%'`) }
/** Was a plan of this ticket sent back by the check already? Once is all it gets. */
const sentBackBefore = (ticketId: string): boolean => !!one("SELECT 1 AS x FROM plan_revisions WHERE ticket_id = ? AND verdict = 'revise' AND verdict_by = 'plan_check'", ticketId)

/** A plan that waits on a project on auto: check it, then approve it or send it back. Safe to call again and again (the plan gate calls it as the plan
 *  arrives, auto mode's tick calls it for every open review, and after a restart the tick is all there is): one call per review at a time, and a review that
 *  was answered meanwhile is left alone. Nothing here waits: the answer comes when the reader has one. */
export function checkPlan(reviewId: string): void {
  if (checking.has(reviewId)) return
  const review = getReview(reviewId); if (!review || review.status !== 'open') return
  const t = getTicket(review.ticket_id), repoId = repoOf(review.ticket_id), rev = getRevision(review.plan_revision_id)
  if (!t || !rev || !autoOn(repoId)) return
  const approve = (by: string) => { failed.delete(reviewId); answerReview(reviewId, 'approve', { by }) }
  const criteria = criteriaOf(t)
  if (!criteria.length) return approve('auto') // HQ's own repair tickets, and tickets from before criteria were a list: nothing to check a plan against
  if (getSetting('plan_check', DEFAULTS.plan_check) === 'off') return approve('auto') // turned off in HQ's settings: as it was before the check existed
  if (sentBackBefore(t.id)) return approve('auto') // its one send-back is spent: this is the plan that came back, approved as it stands
  if (!canLaunch({ ignoreCap: true }).ok) return // at a usage limit nothing new starts, a reader included: auto mode's next look comes back to it
  const c = new AbortController(); checking.set(reviewId, c)
  record(rev.id, reviewId, { state: 'checking', since: now() })
  emit({ agentId: rev.agent_id, source: 'system', kind: 'plan_check.started', payload: { review: reviewId, ticket: t.key, round: review.round } })
  void ask({ system: PLAN_SYSTEM, prompt: planPrompt(criteriaLines(criteria), rev.plan_text), ids: criteria.map((x) => x.id), other: 'extra', signal: c.signal }).then((a) => {
    checking.delete(reviewId)
    // Read again: the call took seconds. The user may have answered it, a newer plan replaced it, the ticket was cancelled, or auto mode went off.
    const cur = getReview(reviewId); if (!cur || cur.status !== 'open') return
    if (a.kind === 'stopped' || !autoOn(repoId)) return record(rev.id, reviewId, null) // auto mode went off: the plan is the user's to answer, and it says so
    if (a.kind === 'error') {
      const n = (failed.get(reviewId) ?? 0) + 1; failed.set(reviewId, n)
      emit({ agentId: rev.agent_id, source: 'system', kind: 'plan_check.failed', payload: { review: reviewId, ticket: t.key, why: a.why, tries: n } })
      if (n < MAX_TRIES) return void bump() // once more, at the next look
      record(rev.id, reviewId, { state: 'unchecked', at: now(), why: `the check couldn't run (${a.why})` }); return approve('auto')
    }
    const base = { at: now(), ms: a.ms, tokens: a.tokens, model: a.model }
    emit({ agentId: rev.agent_id, source: 'system', kind: 'plan_check.answered', payload: { review: reviewId, ticket: t.key, findings: a.findings, ...base } })
    if (!a.findings.length) { record(rev.id, reviewId, { state: 'ok', ...base }); return approve('plan_check') }
    const r = answerReview(reviewId, 'revise', { by: 'plan_check', message: sendBackText(a.findings) })
    if (!r.ok) { record(rev.id, reviewId, { state: 'unchecked', at: now(), why: `it couldn't be sent back (${r.error})` }); return approve('auto') } // at the send-back limit
    failed.delete(reviewId); record(rev.id, reviewId, { state: 'sent_back', ...base, findings: a.findings })
  })
}
let bump: () => void = () => {}
/** What looks at open plans again shortly (auto mode's tick): a failed call is tried once more then. Set at startup, so this module needs nothing of auto.ts. */
export const onRetry = (fn: () => void): void => { bump = fn }
/** Auto mode went off for a project: its plans are the user's to answer again, so the readers at work on them stop. */
export function stopPlanChecks(repoId: string): void {
  for (const [reviewId, c] of checking) { const r = getReview(reviewId); if (r && repoOf(r.ticket_id) === repoId) c.abort() }
}
/** How each ticket's plan check ended, newest plan first, for the run's summary and the diff check: sent back once, or approved unchecked. */
export function planChecks(ticketId: string): PlanCheck[] {
  return q<{ check_result: string | null }>('SELECT check_result FROM plan_revisions WHERE ticket_id = ? AND check_result IS NOT NULL ORDER BY round DESC, submitted_at DESC', ticketId)
    .map((r) => planCheckOf(r.check_result)).filter((c): c is PlanCheck => !!c)
}
/** One line for the summary when a ticket's plan check is worth knowing about (checks.ts planCheckLine). */
export const planLine = (ticketId: string): string | null => planCheckLine(planChecks(ticketId))
