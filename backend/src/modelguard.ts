// "Never degrade silently": classify model switches and per-request models.
import { getSetting, setSetting, run, now } from './db.ts'
import { DEFAULTS } from './config.ts'
import { emit } from './events.ts'
import { attention } from './attention.ts'
import { update, type Agent } from './agents.ts'
import { wakeAll } from './wake.ts'

export function familyOf(model: string | null | undefined): string {
  const m = (model ?? '').toLowerCase()
  for (const f of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(f)) return f
  return m || 'unknown'
}
/** Aliases Claude Code runs on one model while it plans and on another once the plan is approved, switching by itself (`source: 'auto'`) at the
 *  approval. Real 2.1.322: `opusplan` plans on Opus and builds on Sonnet; Bug 141: `haiku` plans on Sonnet and builds on Haiku. The full id
 *  (`claude-haiku-5-5`) plans on Haiku itself and never switches, so only the alias is listed. */
const PLAN_SWITCH: Record<string, { plan: string; build: string }> = { opusplan: { plan: 'opus', build: 'sonnet' }, haiku: { plan: 'sonnet', build: 'haiku' } }
const aliasOf = (agent: Agent) => agent.model_alias.toLowerCase().replace(/\[1m\]$/, '')
export function expectedFamilies(agent: Agent, inPlanMode = !!agent.in_plan_mode): string[] {
  const a = aliasOf(agent), sw = PLAN_SWITCH[a]
  if (sw) return [inPlanMode ? sw.plan : sw.build]
  if (a === 'best') return ['fable', 'opus']
  return [familyOf(a) === 'unknown' ? a : familyOf(a)]
}
export function pauseRole(role: string, reason: string): void {
  const paused = getSetting<string[]>('paused_roles', []); if (!paused.includes(role)) setSetting('paused_roles', [...paused, role])
  emit({ agentId: null, source: 'system', kind: 'role.paused', payload: { role, reason } })
}
export function resumeRole(role: string): void { setSetting('paused_roles', getSetting<string[]>('paused_roles', []).filter((r) => r !== role)); emit({ agentId: null, source: 'system', kind: 'role.resumed', payload: { role } }); wakeAll() }

export function onPostModelSwitch(agent: Agent, body: Record<string, unknown>): void {
  const from = String(body.from_model ?? ''), to = String(body.to_model ?? ''), source = String(body.source ?? ''), requested = body.requested_model == null ? null : String(body.requested_model)
  const window = getSetting('opusplan_switch_window_s', DEFAULTS.opusplan_switch_window_s) * 1000
  const t = now()
  // The plan model → build model switch Claude Code makes when the plan is approved: expected only that way round and only soon after HQ allowed a plan
  const sw = PLAN_SWITCH[aliasOf(agent)]
  const planExit = !!sw && familyOf(from) === sw.plan && familyOf(to) === sw.build && !!agent.last_gate_allow_at && t - agent.last_gate_allow_at < window
  const expected = source === 'resume' || planExit || expectedFamilies(agent, false).includes(familyOf(to)) && source !== 'auto'
  run('INSERT INTO model_switches(agent_id, from_model, to_model, source, requested_model, expected, at) VALUES (?,?,?,?,?,?,?)', agent.id, from, to, source, requested, expected ? 1 : 0, t)
  update(agent.id, { model_live: to, in_plan_mode: planExit ? 0 : agent.in_plan_mode })
  if (!expected) {
    const detail = `${agent.role} ${agent.id}: model switched ${from} → ${to} (source ${source}); role paused`
    update(agent.id, { paused_reason: detail })
    pauseRole(agent.role, detail); attention('model_fallback', detail, { agentId: agent.id, ticketId: agent.ticket_id })
  }
}
const alerted = new Map<string, string>()
export function onTurnStep(agent: Agent, ev: Record<string, unknown>): void {
  if (ev.agentId) return // subagent request; main loop only
  const model = String(ev.usageModel ?? ev.model ?? '')
  if (!model) return
  const fam = familyOf(model)
  // Bug 105: a request that asks to leave plan mode was made while planning, whatever the mode is by the time it's reported. Claude Code runs
  // a call's hooks as soon as it has read the call, and the mod reports the request only once its response has ended: a plan HQ approves at
  // once (auto mode) can be approved before the request that asked is reported. Reported that late, it isn't the model the agent is on now.
  const planning = Array.isArray(ev.tools) && ev.tools.includes('ExitPlanMode') && expectedFamilies(agent, true).includes(fam)
  if (agent.model_live !== model && !(planning && !agent.in_plan_mode)) update(agent.id, { model_live: model })
  if (fam === 'haiku') return // background model allowlist
  const expected = expectedFamilies(agent)
  if (!expected.includes(fam) && !planning && alerted.get(agent.id) !== model) {
    alerted.set(agent.id, model)
    attention('model_mismatch', `${agent.role} ${agent.id}: main-loop request on ${model}, expected ${expected.join('/')}${agent.in_plan_mode ? ' (plan mode)' : ''}`, { agentId: agent.id, ticketId: agent.ticket_id })
  }
}
