// Bug 371: with auto mode off, the user approves how a ticket is built. When its spec or criteria change after a plan was handed in, its engineer shows
// a new plan for the ticket as it is now before it builds on, and the user approves that one like the first. HQ owes a plan of a round after the one
// the ticket had at the change (tickets.replan_after): the gate won't take the old plan back for it, and open_pr is refused until one is approved.
import fs from 'node:fs'
import { getSetting, one } from './db.ts'
import { DEFAULTS } from './config.ts'
import { autoOn, type Ticket } from './records.ts'

/** The owner's call (Bug 371). 'on': a new plan as above. 'off': the engineer builds the change on the plan approved before, as HQ did until then (the change was
 *  the user's own request: with auto off the TPM changes a started ticket only when the user asked, Bug 125). The settings API flips it. */
export const replanOn = (): boolean => getSetting('replan_on_change', DEFAULTS.replan_on_change) === 'on'
/** Statuses of a started ticket whose engineer plans or builds on a plan (not one that is finished, or being fixed after it was). */
const UNDER_WAY = ['planning', 'plan_review', 'implementing', 'awaiting_answer', 'escalated']
/** A change to `t`'s spec or criteria now asks for a new plan: the switch is on, auto mode is off (the user answers plans), and a plan was handed in for it. */
export function changeAsksReplan(t: Ticket, repoId: string | null | undefined): boolean {
  if (!replanOn() || autoOn(repoId) || t.plan_round < 1 || !UNDER_WAY.includes(t.status)) return false
  return !(t.status === 'awaiting_answer' && t.prior_status === 'resolving') // a question while fixing a finished ticket: that path has no plan
}
/** A new plan is owed for `t` and HQ holds to it now (auto mode is still off and the switch still on). With auto mode on, HQ's plan check answers plans and
 *  nothing is held, as before. */
export const replanDue = (t: Pick<Ticket, 'replan_after'>, repoId: string | null | undefined): boolean =>
  t.replan_after != null && replanOn() && !autoOn(repoId)
/** A plan of `round` was written before the change, so it can't settle the plan owed for it. */
export const beforeChange = (t: Pick<Ticket, 'replan_after'>, round: number): boolean => t.replan_after != null && round <= t.replan_after

/** Bug 371 follow-up: whether the engineer had read the newest change of its ticket before the model response that handed in this plan. A plan written
 *  before that can't be the new plan owed, even when it reaches HQ after the read: HQ's notice comes in with a tool step (Bug 370, delivery.ts stepNotes),
 *  and Claude Code still runs the rest of the response it was in, so a Write of the plan and its ExitPlanMode decided together hand in the old plan just
 *  after the notice landed (seen live: R-3 of T-02, 2026-11-24). So: no change notice to it still unread, and the one it read last came in a model
 *  response before this plan's, as its transcript shows (each tool call is a line with the id of the response it came in, 2.1.322). A notice that came as
 *  a prompt (the mod, typed) starts a response of its own, so anything after it is later. When the transcript can't tell, the plan counts, as before. */
export function changeReadBefore(agentId: string, transcript: string | null): { read: boolean; why: string } {
  const unread = one<{ id: string }>(`SELECT id FROM messages WHERE to_id = ? AND from_id = 'hq' AND reason = 'spec_change' AND ack_at IS NULL
    AND dropped_why IS NULL ORDER BY created_at LIMIT 1`, agentId)
  if (unread) return { read: false, why: 'unread' }
  const last = one<{ id: string; delivery_method: string | null }>(`SELECT id, delivery_method FROM messages WHERE to_id = ? AND from_id = 'hq'
    AND reason = 'spec_change' AND dropped_why IS NULL ORDER BY ack_at DESC, created_at DESC LIMIT 1`, agentId)
  if (last?.delivery_method !== 'hook') return { read: true, why: last ? 'prompt' : 'none' }
  const step = one<{ use: string | null }>(`SELECT json_extract(payload, '$.use') AS use FROM events WHERE agent_id = ? AND kind = 'message.at_step'
    AND EXISTS (SELECT 1 FROM json_each(json_extract(payload, '$.ids')) WHERE value = ?) ORDER BY id DESC LIMIT 1`, agentId, last.id)
  if (!step?.use || !transcript) return { read: true, why: 'unknown' }
  const at = responseOf(transcript, step.use)
  if (!at.step || !at.plan) return { read: true, why: 'unknown' }
  return at.step === at.plan ? { read: false, why: 'same_response' } : { read: true, why: 'later_response' }
}
/** From a Claude Code transcript (JSONL): the id of the model response the tool call `use` came in, and of the one with its last ExitPlanMode call. */
export function responseOf(file: string, use: string): { step: string | null; plan: string | null } {
  let text = ''; try { text = fs.readFileSync(file, 'utf8') } catch { return { step: null, plan: null } }
  let step: string | null = null, plan: string | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue
    let o: { type?: string; message?: { id?: string; content?: unknown } }; try { o = JSON.parse(line) } catch { continue }
    if (o.type !== 'assistant' || !o.message?.id || !Array.isArray(o.message.content)) continue
    for (const b of o.message.content as { type?: string; id?: string; name?: string }[]) {
      if (b.type !== 'tool_use') continue
      if (b.id === use) step = o.message.id
      if (b.name === 'ExitPlanMode') plan = o.message.id
    }
  }
  return { step, plan }
}

/** What the ticket's engineer is told with the change notice. */
export const replanAsk = (key: string): string => ` Auto mode is off, so the user approves how a change to a started ticket is built: don't build it on the plan`
  + ` approved before. Call EnterPlanMode (unless you are in plan mode already), write a new plan for ${key} as it is now (its "## In plain words" says what`
  + ' changed for the user) and call ExitPlanMode. Leave what you built so far as it is until the new plan is approved. HQ refuses open_pr until then.'
/** open_pr's refusal while the new plan is owed. */
export const replanRefusal = (key: string): string => `${key}'s spec or criteria changed after its plan was handed in, and with auto mode off the user`
  + ' approves a new plan before the change is built. Call get_ticket, then EnterPlanMode, write the new plan and call ExitPlanMode; once it is approved, build'
  + ' the change, then call open_pr again. Nothing was handed in.'
