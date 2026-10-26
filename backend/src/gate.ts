// Plan gate: PermissionRequest(ExitPlanMode) is held until a verdict; hash re-attach; pending answers; user override.
import fs from 'node:fs'
import type { ServerResponse } from 'node:http'
import { one, q, run, now, getSetting, tx } from './db.ts'
import { DEFAULTS } from './config.ts'
import { emit, patch } from './events.ts'
import { id, short } from './util.ts'
import { update, type Agent } from './agents.ts'
import { attention, resolveKind } from './attention.ts'
import { setTicket } from './records.ts'

export type PlanRevision = {
  id: string; ticket_id: string; agent_id: string; round: number; plan_text: string; plan_hash: string; plan_file_path: string | null
  submitted_at: number; verdict: string | null; edited_plan_text: string | null; verdict_by: string | null; verdict_at: number | null
  verdict_message: string | null
}
export type ReviewRequest = {
  id: string; ticket_id: string; plan_revision_id: string; round: number; status: string; architect_agent_id: string | null
  packet_path: string | null; opened_at: number; answered_at: number | null; closed_reason: string | null
}
type Held = { res: ServerResponse; timer: NodeJS.Timeout; agentId: string }
const held = new Map<string, Held>() // reviewId -> held hook response

const jsonEnd = (res: ServerResponse, obj: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const allowAnswer = (plan: string, planFilePath: string | null) => ({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow', updatedInput: { plan, planFilePath }, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
  },
})
const denyAnswer = (message: string) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } })
export const pendingMessage = (round: number) => `Review R-${round} still pending — do not change the plan — call ExitPlanMode again.`

export function openReviews(): ReviewRequest[] { return q<ReviewRequest>("SELECT * FROM review_requests WHERE status = 'open' ORDER BY opened_at") }
export function getRevision(revId: string): PlanRevision | undefined { return one<PlanRevision>('SELECT * FROM plan_revisions WHERE id = ?', revId) }
export function getReview(reviewId: string): ReviewRequest | undefined { return one<ReviewRequest>('SELECT * FROM review_requests WHERE id = ?', reviewId) }

export function onExitPlanMode(agent: Agent, body: Record<string, unknown>, res: ServerResponse): void {
  const input = (body.tool_input ?? {}) as { plan?: string; planFilePath?: string }
  const plan = input.plan ?? ''; const planFilePath = input.planFilePath ?? null; const hash = short(plan)
  const ticketId = agent.ticket_id
  if (!ticketId) { jsonEnd(res, denyAnswer('HQ: no ticket is bound to this session.')); return }
  if (!plan.trim()) { jsonEnd(res, denyAnswer('HQ: the plan is empty (plan file not written). Write the plan, then call ExitPlanMode again.')); return }
  let rev = one<PlanRevision>('SELECT * FROM plan_revisions WHERE ticket_id = ? AND plan_hash = ? ORDER BY submitted_at DESC', ticketId, hash)
  if (rev?.verdict === 'superseded') rev = undefined // the same plan again after a newer one replaced it: a new round
  if (rev?.verdict === 'approve' || rev?.verdict === 'approve_with_edits' || rev?.verdict === 'user_engineer') {
    // Back to an approved plan: a newer round still open is moot, and left open it would read as a terminal-menu approval.
    if (supersedeOpen(ticketId, rev.round, agent.id)) setTicket(ticketId, { status: 'implementing' })
    update(agent.id, { last_gate_allow_at: now() }); emit({ agentId: agent.id, source: 'system', kind: 'gate.allow_stored', payload: { revision: rev.id } })
    jsonEnd(res, allowAnswer(rev.edited_plan_text ?? rev.plan_text, planFilePath)); return
  }
  if (rev?.verdict === 'revise' || rev?.verdict === 'user_architect' || rev?.verdict === 'escalate') {
    jsonEnd(res, denyAnswer(rev.verdict_message ?? 'Plan not approved. Revise and call ExitPlanMode again.')); return
  }
  let review: ReviewRequest | undefined
  if (!rev) {
    const t = one<{ plan_round: number }>('SELECT plan_round FROM tickets WHERE id = ?', ticketId)!
    const round = t.plan_round + 1
    const capped = revisesUsed(ticketId) >= revisionCap()
    const r = tx(() => { // the new round, its review and the ticket's status together, or none of them
      supersedeOpen(ticketId, round, agent.id)
      const nr: PlanRevision = {
        id: id('rev'), ticket_id: ticketId, agent_id: agent.id, round, plan_text: plan, plan_hash: hash, plan_file_path: planFilePath,
        submitted_at: now(), verdict: null, edited_plan_text: null, verdict_by: null, verdict_at: null, verdict_message: null,
      }
      run('INSERT INTO plan_revisions(id, ticket_id, agent_id, round, plan_text, plan_hash, plan_file_path, submitted_at) VALUES (?,?,?,?,?,?,?,?)',
        nr.id, ticketId, agent.id, round, plan, hash, planFilePath, nr.submitted_at)
      const rq: ReviewRequest = {
        id: id('R'), ticket_id: ticketId, plan_revision_id: nr.id, round, status: 'open', architect_agent_id: null, packet_path: null,
        opened_at: now(), answered_at: null, closed_reason: null,
      }
      run('INSERT INTO review_requests(id, ticket_id, plan_revision_id, round, status, opened_at) VALUES (?,?,?,?,?,?)', rq.id, ticketId, nr.id, round, 'open', rq.opened_at)
      setTicket(ticketId, { plan_round: round, status: capped ? 'escalated' : 'plan_review' })
      return { rev: nr, review: rq }
    })
    rev = r.rev; review = r.review
    patch('review', review.id, { ...review, plan_text: plan, revises_used: revisesUsed(ticketId) } as unknown as Record<string, unknown>)
    emit({ agentId: agent.id, source: 'system', kind: 'gate.review_opened', payload: { review: review.id, round, hash, planLen: plan.length, capped } })
    if (capped) {
      const key = one<{ key: string }>('SELECT key FROM tickets WHERE id = ?', ticketId)?.key ?? ticketId
      attention('cap_reached', `${key}: plan sent back ${revisesUsed(ticketId)} times. Approve it or cancel the ticket.`, { agentId: agent.id, ticketId })
    }
  } else {
    review = one<ReviewRequest>("SELECT * FROM review_requests WHERE plan_revision_id = ? AND status = 'open'", rev.id)
    if (!review) { jsonEnd(res, denyAnswer('HQ: this plan has no open review; it was closed. Wait for a message from HQ.')); return }
    emit({ agentId: agent.id, source: 'system', kind: 'gate.reattached', payload: { review: review.id, round: rev.round } })
  }
  const old = held.get(review.id); if (old) { clearTimeout(old.timer); jsonEnd(old.res, denyAnswer(pendingMessage(review.round))) }
  const timeout = getSetting('gate_timeout_s', DEFAULTS.gate_timeout_s), margin = getSetting('gate_answer_margin_s', DEFAULTS.gate_answer_margin_s)
  const timer = setTimeout(() => {
    const h = held.get(review!.id); if (!h) return
    held.delete(review!.id); jsonEnd(h.res, denyAnswer(pendingMessage(review!.round)))
    emit({ agentId: agent.id, source: 'system', kind: 'gate.pending_answered', payload: { review: review!.id } })
  }, Math.max(5, timeout - margin) * 1000)
  held.set(review.id, { res, timer, agentId: agent.id })
  res.on('close', () => { const h = held.get(review!.id); if (h && h.res === res) { clearTimeout(h.timer); held.delete(review!.id) } })
  update(agent.id, { status: 'plan_review' })
}

/** A changed plan replaces the ticket's open review: it closes as superseded (its plan can't be approved any more), and a
 *  hook call still held for it is answered so it doesn't wait for a verdict that won't come. */
function supersedeOpen(ticketId: string, round: number, agentId: string): number {
  const t = now(); const open = q<ReviewRequest>("SELECT * FROM review_requests WHERE ticket_id = ? AND status = 'open'", ticketId)
  for (const old of open) {
    run("UPDATE review_requests SET status = 'abandoned', answered_at = ?, closed_reason = 'superseded' WHERE id = ?", t, old.id)
    run("UPDATE plan_revisions SET verdict = 'superseded', verdict_by = 'hq', verdict_at = ? WHERE id = ? AND verdict IS NULL", t, old.plan_revision_id)
    patch('review', old.id, { status: 'abandoned', closed_reason: 'superseded', answered_at: t })
    const h = held.get(old.id)
    if (h) { held.delete(old.id); clearTimeout(h.timer); jsonEnd(h.res, denyAnswer(`Plan R-${old.round} was replaced by your newer plan (R-${round}); HQ is reviewing that one.`)) }
    emit({ agentId, source: 'system', kind: 'gate.review_superseded', payload: { review: old.id, round: old.round, by: round } })
  }
  return open.length
}

/** Every verdict the gate knows how to act on; anything else would close a review and leave its ticket stuck. */
export const VERDICTS = ['approve', 'approve_with_edits', 'revise', 'escalate', 'user_engineer', 'user_architect'] as const
export type Verdict = (typeof VERDICTS)[number]
export const isVerdict = (v: unknown): v is Verdict => (VERDICTS as readonly unknown[]).includes(v)

/** Plans sent back for this ticket so far. At `revision_cap` the next round escalates and can't be sent back again. */
export const revisesUsed = (ticketId: string): number =>
  one<{ n: number }>("SELECT COUNT(*) AS n FROM plan_revisions WHERE ticket_id = ? AND verdict IN ('revise', 'user_architect')", ticketId)!.n
export const revisionCap = (): number => getSetting('revision_cap', DEFAULTS.revision_cap)
const sendsBack = (v: Verdict) => v === 'revise' || v === 'user_architect'

export function answerReview(reviewId: string, verdict: Verdict, opts: { plan?: string; message?: string; by: string }): { ok: boolean; held: boolean; error?: string } {
  const review = getReview(reviewId); if (!review || review.status !== 'open') return { ok: false, held: false, error: 'review not open' }
  const rev = getRevision(review.plan_revision_id)!; const t = now()
  if (sendsBack(verdict) && revisesUsed(review.ticket_id) >= revisionCap()) {
    return { ok: false, held: held.has(reviewId), error: `revision cap reached (sent back ${revisionCap()} times): approve it or cancel the ticket` }
  }
  const approve = verdict === 'approve' || verdict === 'approve_with_edits' || verdict === 'user_engineer'
  const planText = opts.plan ?? rev.plan_text
  if (approve && opts.plan && rev.plan_file_path) {
    try { fs.writeFileSync(rev.plan_file_path, opts.plan) } catch (e) { emit({ agentId: rev.agent_id, source: 'system', kind: 'gate.plan_file_write_failed', payload: { error: String(e) } }) }
  }
  const ticketStatus = approve ? 'implementing' : verdict === 'escalate' ? 'escalated' : 'planning'
  tx(() => {
    run('UPDATE plan_revisions SET verdict = ?, edited_plan_text = ?, verdict_by = ?, verdict_at = ?, verdict_message = ? WHERE id = ?',
      verdict, opts.plan ?? null, opts.by, t, opts.message ?? null, rev.id)
    run('UPDATE review_requests SET status = ?, answered_at = ?, closed_reason = ? WHERE id = ?', 'answered', t, verdict, reviewId)
    setTicket(review.ticket_id, { status: ticketStatus })
    if (approve) update(rev.agent_id, { last_gate_allow_at: t, in_plan_mode: 0, status: 'working' })
  })
  patch('review', reviewId, { status: 'answered', closed_reason: verdict, answered_at: t })
  if (approve) resolveKind('cap_reached', rev.agent_id) // the escalation it raised is settled
  const h = held.get(reviewId); held.delete(reviewId)
  emit({ agentId: rev.agent_id, source: 'system', kind: 'gate.verdict', payload: { review: reviewId, verdict, by: opts.by, held: !!h } })
  if (h) {
    const no = verdict === 'escalate' ? 'Plan escalated to the user; wait for a message from HQ.' : 'Plan not approved. Revise and call ExitPlanMode again.'
    clearTimeout(h.timer); jsonEnd(h.res, approve ? allowAnswer(planText, rev.plan_file_path) : denyAnswer(opts.message ?? no))
  }
  return { ok: true, held: !!h }
}

/** PostToolUse(ExitPlanMode): detect approvals HQ did not issue (user pressed the menu). Every allow HQ sends closes the
 *  ticket's review first, so a review still open here was approved in the terminal. */
export function onPostExitPlanMode(agent: Agent, body: Record<string, unknown>): void {
  const t = now()
  update(agent.id, { in_plan_mode: 0, status: 'working' })
  if (!agent.ticket_id) return
  const open = one<ReviewRequest>("SELECT * FROM review_requests WHERE ticket_id = ? AND status = 'open'", agent.ticket_id)
  if (!open) return
  const h = held.get(open.id); if (h) { clearTimeout(h.timer); held.delete(open.id) }
  const ticketId = agent.ticket_id
  tx(() => {
    run('UPDATE review_requests SET status = ?, answered_at = ?, closed_reason = ? WHERE id = ?', 'closed', t, 'user_override', open.id)
    run('UPDATE plan_revisions SET verdict = ?, verdict_by = ?, verdict_at = ? WHERE id = ?', 'user_override', 'user', t, open.plan_revision_id)
    setTicket(ticketId, { status: 'implementing' })
  })
  patch('review', open.id, { status: 'closed', closed_reason: 'user_override', answered_at: t })
  const responsePlanLen = String((body.tool_response as { plan?: string } | undefined)?.plan ?? '').length
  emit({ agentId: agent.id, source: 'system', kind: 'gate.user_override', payload: { review: open.id, responsePlanLen } })
  attention('user_override', `Plan for ${agent.display_name ?? agent.id} was approved from the terminal menu (review ${open.id} closed as user_override).`,
    { agentId: agent.id, ticketId: agent.ticket_id })
}
export function heldCount(): number { return held.size }
