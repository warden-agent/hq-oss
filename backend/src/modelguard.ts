// "Never degrade silently": classify model switches and per-request models.
import { getSetting, setSetting, run, now } from './db.ts'
import { DEFAULTS } from './config.ts'
import { emit } from './events.ts'
import { attention } from './attention.ts'
import { update, type Agent } from './agents.ts'

export function familyOf(model: string | null | undefined): string {
  const m = (model ?? '').toLowerCase()
  for (const f of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(f)) return f
  return m || 'unknown'
}
export function expectedFamilies(agent: Agent, inPlanMode = !!agent.in_plan_mode): string[] {
  const a = agent.model_alias.toLowerCase().replace(/\[1m\]$/, '')
  if (a === 'opusplan') return inPlanMode ? ['opus'] : ['sonnet']
  if (a === 'best') return ['fable', 'opus']
  return [familyOf(a) === 'unknown' ? a : familyOf(a)]
}
export function pauseRole(role: string, reason: string): void {
  const paused = getSetting<string[]>('paused_roles', []); if (!paused.includes(role)) setSetting('paused_roles', [...paused, role])
  emit({ agentId: null, source: 'system', kind: 'role.paused', payload: { role, reason } })
}
export function resumeRole(role: string): void { setSetting('paused_roles', getSetting<string[]>('paused_roles', []).filter((r) => r !== role)); emit({ agentId: null, source: 'system', kind: 'role.resumed', payload: { role } }) }

export function onPostModelSwitch(agent: Agent, body: Record<string, unknown>): void {
  const from = String(body.from_model ?? ''), to = String(body.to_model ?? ''), source = String(body.source ?? ''), requested = body.requested_model == null ? null : String(body.requested_model)
  const window = getSetting('opusplan_switch_window_s', DEFAULTS.opusplan_switch_window_s) * 1000
  const t = now()
  const opusplanExit = agent.model_alias.startsWith('opusplan') && familyOf(from) === 'opus' && familyOf(to) === 'sonnet' && !!agent.last_gate_allow_at && t - agent.last_gate_allow_at < window
  const expected = source === 'resume' || opusplanExit || expectedFamilies(agent, false).includes(familyOf(to)) && source !== 'auto'
  run('INSERT INTO model_switches(agent_id, from_model, to_model, source, requested_model, expected, at) VALUES (?,?,?,?,?,?,?)', agent.id, from, to, source, requested, expected ? 1 : 0, t)
  update(agent.id, { model_live: to, in_plan_mode: opusplanExit ? 0 : agent.in_plan_mode })
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
  if (agent.model_live !== model) update(agent.id, { model_live: model })
  const fam = familyOf(model)
  if (fam === 'haiku') return // background model allowlist
  const expected = expectedFamilies(agent)
  if (!expected.includes(fam) && alerted.get(agent.id) !== model) {
    alerted.set(agent.id, model)
    attention('model_mismatch', `${agent.role} ${agent.id}: main-loop request on ${model}, expected ${expected.join('/')}${agent.in_plan_mode ? ' (plan mode)' : ''}`, { agentId: agent.id, ticketId: agent.ticket_id })
  }
}
