// Hook + mod + tmux ingress server (127.0.0.1:PORTS.hooks). Every record is logged to `events`, then applied.
import http from 'node:http'
import { BIND, PORTS, DEFAULTS } from './config.ts'
import { run, now, getSetting, one } from './db.ts'
import { emit, patch } from './events.ts'
import { agentByToken, getAgent, update, tmuxToken, revokeToken, type Agent } from './agents.ts'
import { onExitPlanMode, onPostExitPlanMode, openReviews } from './gate.ts'
import { ackBatchFromPrompt, nextBatchFor, markSubmitted, markReceived, requeue, unreadCount, pendingFor } from './delivery.ts'
import { onPostModelSwitch, onTurnStep } from './modelguard.ts'
import { attention, resolveKind } from './attention.ts'
import { getTicket } from './records.ts'
import { isBridgePid } from './terminal.ts'
import * as tmux from './tmux.ts'
import { readJson, asObject, TooLarge } from './util.ts'

const TAKEOVER_ATTACHED_MS = 365 * 86_400_000 // "until they detach"

const json = (res: http.ServerResponse, code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const deny = (message: string) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } })
const allow = () => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
const trim = (v: unknown, n = 400): string => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > n ? s.slice(0, n) + '…' : s }

function describeTool(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') return `Running: ${trim(input.command, 80)}`
  if (tool === 'Edit' || tool === 'Write' || tool === 'Read') return `${tool === 'Read' ? 'Reading' : 'Editing'} ${String(input.file_path ?? '').split('/').slice(-2).join('/')}`
  if (tool.startsWith('mcp__hq__')) return `Calling hq.${tool.slice(9)}`
  if (tool === 'ExitPlanMode') return 'Submitting plan'
  if (tool === 'Agent') return `Subagent: ${trim(input.description, 60)}`
  return tool
}

function handleHook(agent: Agent, body: Record<string, unknown>, res: http.ServerResponse): void {
  const ev = String(body.hook_event_name ?? ''); const tool = String(body.tool_name ?? ''); const input = (body.tool_input ?? {}) as Record<string, unknown>
  const mode = body.permission_mode as string | undefined; const t = now()
  const fields: Partial<Agent> = { last_event_at: t } // agent columns
  const live: { activity?: string | null; last_message?: string } = {} // shown in the UI only (patches), not stored
  if (mode) fields.in_plan_mode = mode === 'plan' ? 1 : 0
  const payload: Record<string, unknown> = { event: ev, tool, mode }
  const cleared = ev === 'SessionEnd' && body.reason === 'clear' // /clear: the same session goes on with a fresh context
  switch (ev) {
    case 'SessionStart': Object.assign(payload, { source: body.source, model: body.model, cwd: body.cwd }); Object.assign(fields, { claude_session_id: String(body.session_id ?? '') || null, transcript_path: (body.transcript_path as string | undefined) ?? null, status: 'working' }); run('UPDATE sessions SET claude_session_id = ?, transcript_path = ? WHERE agent_id = ? AND ended_at IS NULL', body.session_id as string, body.transcript_path as string, agent.id); break
    case 'UserPromptSubmit': { payload.prompt = trim(body.prompt, 200); fields.status = 'working'; live.activity = 'Thinking'; const acked = ackBatchFromPrompt(agent, String(body.prompt ?? '')); payload.acked = acked; break }
    case 'PreToolUse': payload.input = trim(input, 300); live.activity = describeTool(tool, input); fields.status = 'working'; break
    case 'PostToolUse': payload.input = trim(input, 200); if (tool === 'ExitPlanMode') payload.responsePlanLen = String((body.tool_response as { plan?: string } | undefined)?.plan ?? '').length; break
    case 'PostToolUseFailure': Object.assign(payload, { input: trim(input, 200), error: trim(body.error, 300), is_interrupt: body.is_interrupt }); break
    case 'Stop': payload.last = trim(body.last_assistant_message, 600); fields.status = 'idle'; Object.assign(live, { activity: null, last_message: trim(body.last_assistant_message, 2000) }); break
    case 'StopFailure': payload.error = trim(body.error ?? body, 400); fields.status = 'blocked'; break
    case 'Notification': Object.assign(payload, { ntype: body.notification_type, message: trim(body.message, 200) }); break
    case 'PostModelSwitch': case 'PreModelSwitch': Object.assign(payload, { from: body.from_model, to: body.to_model, source: body.source, requested: body.requested_model }); break
    case 'PreCompact': case 'PostCompact': payload.trigger = body.trigger; break
    case 'ConfigChange': Object.assign(payload, { csource: body.source, file: body.file_path }); break
    case 'SessionEnd': payload.reason = body.reason; if (cleared) break
      Object.assign(fields, { status: 'exited', ended_at: t }); live.activity = null; run('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE agent_id = ? AND ended_at IS NULL', t, String(body.reason ?? ''), agent.id); break
    case 'TaskCreated': case 'TaskCompleted': payload.task = trim(body.task ?? body, 300); break
  }
  if (agent.status === 'exited') delete fields.status // a late hook from a session HQ already counts as gone doesn't bring it back
  update(agent.id, fields); if (agent.status !== 'exited' && Object.keys(live).length) patch('agent', agent.id, live)
  emit({ agentId: agent.id, sessionId: String(body.session_id ?? ''), source: 'hook', kind: `hook.${ev}${tool ? ':' + tool : ''}`, payload })

  // ---- decisions ----
  if (ev === 'PermissionRequest') {
    if (tool === 'ExitPlanMode') return onExitPlanMode(agent, body, res)
    const inPlan = mode === 'plan'
    if (tool.startsWith('mcp__hq__')) return json(res, 200, allow())
    if (tool === 'Bash' && !inPlan && agent.role === 'engineer') return json(res, 200, allow())
    if (tool === 'Bash' && inPlan) return json(res, 200, deny(`HQ: '${trim(input.command, 80)}' is not allowed during planning; run it after plan approval.`))
    attention('unexpected_prompt', `${agent.display_name ?? agent.id}: ${tool} needed approval (${trim(input, 120)}); denied by policy`, { agentId: agent.id, ticketId: agent.ticket_id })
    return json(res, 200, deny(`HQ: '${tool}' would need approval and is not allowed here. Continue without it, or report_blocked if you cannot.`))
  }
  if (ev === 'PreModelSwitch') return json(res, 200, { hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'deny', permissionDecisionReason: 'HQ controls models for this agent.' } })
  if (ev === 'PostModelSwitch') { onPostModelSwitch(agent, body); return json(res, 200, {}) }
  if (ev === 'ConfigChange') return json(res, 200, agent.role === 'engineer' ? { decision: 'block', reason: 'HQ: configuration changes are not allowed' } : {})
  if (ev === 'PreCompact' && agent.role === 'tpm' && body.trigger === 'auto') { attention('tpm_rotate', `TPM ${agent.id}: auto-compaction blocked; rotate the TPM session`, { agentId: agent.id }); return json(res, 200, { decision: 'block', reason: 'HQ rotates the TPM instead of compacting' }) }
  if (ev === 'PostToolUse' && tool === 'ExitPlanMode') { onPostExitPlanMode(agent, body); return json(res, 200, {}) }
  if (ev === 'PostToolUse' && (tool === 'TaskCreate' || tool === 'TaskUpdate')) { recordTask(agent, tool, input, body.tool_response as Record<string, unknown> | undefined) }
  if (ev === 'UserPromptSubmit' || ev === 'Stop') {
    const ctx: string[] = []
    const unread = unreadCount(agent); if (unread) ctx.push(`HQ: ${unread} unread message(s) are queued and will arrive as a new turn when you are idle.`)
    if (agent.ticket_id) { const rv = openReviews().find((r) => r.ticket_id === agent.ticket_id); if (rv) ctx.push(`HQ: plan review R-${rv.round} is pending; if your ExitPlanMode call was denied without an HQ message, call ExitPlanMode again without changing the plan.`) }
    if (ev === 'Stop') { const modAlive = agent.mod_seen_at && t - agent.mod_seen_at < 120_000; const pend = pendingFor(agent)
      if (!modAlive && pend.length && !(agent.takeover_locked_until && agent.takeover_locked_until > t)) { const b = nextBatchFor(agent); if (b) { run('UPDATE batches SET method = ?, submitted_at = ?, received_at = ? WHERE id = ?', 'stop_hook', t, t, b.id); return json(res, 200, { decision: 'block', reason: `HQ message batch ${b.id}:\n${b.text}` }) } } }
    return json(res, 200, ctx.length ? { hookSpecificOutput: { hookEventName: ev, additionalContext: ctx.join('\n') } } : {})
  }
  if (ev === 'Notification') {
    const nt = String(body.notification_type ?? '')
    if (nt === 'permission_prompt' && /plan/i.test(String(body.message ?? ''))) { /* gate open; not stuck */ }
    else if (nt === 'permission_prompt' || nt.startsWith('elicitation') || nt === 'agent_needs_input') { update(agent.id, { status: 'blocked' }); attention('dialog', `${agent.display_name ?? agent.id}: ${trim(body.message, 160)}`, { agentId: agent.id, ticketId: agent.ticket_id }) }
    else if (nt.startsWith('quota_auto_resume')) { update(agent.id, { status: 'paused', paused_reason: nt }); attention('usage_limit', `${agent.display_name ?? agent.id}: ${nt} ${trim(body.message, 160)}`, { agentId: agent.id }) }
    return json(res, 200, {})
  }
  if (ev === 'StopFailure') { attention('api_error', `${agent.display_name ?? agent.id}: turn ended with an API error: ${trim(body.error ?? body, 200)}`, { agentId: agent.id, ticketId: agent.ticket_id }) }
  if (ev === 'SessionEnd' && !cleared) revokeToken(agent.id) // the session is over: its token is no good to anyone now
  if (ev === 'SessionEnd' && !cleared && agent.role === 'engineer' && agent.ticket_id) { const tk = getTicket(agent.ticket_id); if (tk && !['pr_ready', 'pr_open', 'merged', 'cancelled'].includes(tk.status)) attention('engineer_exited', `${agent.display_name ?? agent.id} exited with ticket ${tk.key} in status ${tk.status}`, { agentId: agent.id, ticketId: agent.ticket_id }) }
  return json(res, 200, {})
}

function recordTask(agent: Agent, tool: string, input: Record<string, unknown>, resp: Record<string, unknown> | undefined): void {
  const taskId = String(input.taskId ?? input.id ?? resp?.id ?? resp?.taskId ?? '')
  const subject = input.subject ?? input.content ?? resp?.subject; const status = input.status ?? (tool === 'TaskCreate' ? 'pending' : undefined)
  if (!taskId && !subject) return
  const key = taskId || `${agent.id}:${String(subject).slice(0, 40)}`
  const existing = one<{ id: string; status: string }>('SELECT id, status FROM task_progress WHERE agent_id = ? AND task_id = ?', agent.id, key)
  if (existing) run('UPDATE task_progress SET subject = COALESCE(?, subject), status = COALESCE(?, status), updated_at = ? WHERE id = ?', subject ? String(subject) : null, status ? String(status) : null, now(), existing.id)
  else run('INSERT INTO task_progress(id, agent_id, task_id, subject, status, position, updated_at) VALUES (?,?,?,?,?,?,?)', `${agent.id}:${key}`, agent.id, key, subject ? String(subject) : null, status ? String(status) : 'pending', one<{ c: number }>('SELECT COUNT(*) c FROM task_progress WHERE agent_id = ?', agent.id)!.c + 1, now())
  const rows = one<{ total: number; done: number }>("SELECT COUNT(*) total, SUM(status = 'completed') done FROM task_progress WHERE agent_id = ?", agent.id)!
  patch('agent', agent.id, { steps_done: rows.done ?? 0, steps_total: rows.total })
}

function handleMod(agent: Agent, action: string, url: URL, body: Record<string, unknown>, res: http.ServerResponse): void {
  const t = now()
  if (action === 'next') {
    const wait = Math.min(Number(url.searchParams.get('wait') ?? 15000), 25000); const started = t
    let gone = false; res.on('close', () => { gone = true })
    // The agent row is read again every pass: a hold or pause set while the mod waits counts at once. Nothing is handed to a
    // connection that's already closed (a batch handed out but never received is handed out again; see nextBatchFor).
    const tick = (): void => {
      if (gone || res.destroyed || res.writableEnded) return
      try { // later passes run from a timer, outside the server's own catch
        const a = getAgent(agent.id); if (!a || a.status === 'exited') return json(res, 200, {})
        const b = nextBatchFor(a); if (b) return json(res, 200, { batch: { id: b.id, text: b.text, asUser: b.asUser, raw: b.raw } })
      } catch (e) { emit({ agentId: agent.id, source: 'system', kind: 'backend.error', payload: { server: 'mod', error: String(e) } }); return json(res, 500, { error: 'HQ error' }) }
      if (now() - started >= wait) return json(res, 200, {}); setTimeout(tick, 500)
    }
    update(agent.id, { mod_seen_at: t }); return tick()
  }
  if (action === 'event') {
    const kind = String(body.kind ?? ''); update(agent.id, { mod_seen_at: t })
    emit({ agentId: agent.id, source: 'mod', kind: `mod.${kind}`, payload: body })
    if (kind === 'session.start') { resolveKind('mod_missing', agent.id); if (!body.hasToken) attention('mod_token_missing', `${agent.id}: mod could not read its token file`, { agentId: agent.id }) }
    if (kind === 'turn.step') onTurnStep(agent, body)
    if (kind === 'batch_received') markReceived(String(body.id ?? ''))
    if (kind === 'batch_submitted') markSubmitted(String(body.id ?? ''))
    if (kind === 'batch_submit_failed') requeue(String(body.id ?? ''), 'submit_failed')
    if (kind === 'plugin.register' && body.name && body.name !== 'hq') attention('foreign_mod', `${agent.id}: another mod tried to load: ${body.name}`, { agentId: agent.id })
    if (kind === 'session.measure') {
      const u = (body.usage ?? {}) as { context?: { tokens?: number; percent?: number }; rateLimits?: { kind: string; percentUsed: number }[]; cost?: { usd?: number } }
      const fh = u.rateLimits?.find((r) => r.kind === 'five_hour')?.percentUsed ?? null; const sd = u.rateLimits?.find((r) => r.kind === 'seven_day')?.percentUsed ?? null
      run('INSERT INTO usage_samples(agent_id, at, context_tokens, context_pct, five_hour_pct, seven_day_pct, cost_usd) VALUES (?,?,?,?,?,?,?)', agent.id, t, u.context?.tokens ?? null, u.context?.percent ?? null, fh, sd, u.cost?.usd ?? null)
      patch('agent', agent.id, { context_tokens: u.context?.tokens ?? null, five_hour_pct: fh, seven_day_pct: sd })
      if (agent.role === 'tpm' && (u.context?.tokens ?? 0) > getSetting('rotation_context_tokens', DEFAULTS.rotation_context_tokens)) attention('tpm_rotate', `TPM ${agent.id} context is ${u.context?.tokens} tokens; rotate`, { agentId: agent.id })
      if ((fh ?? 0) >= getSetting('pause_five_hour_pct', DEFAULTS.pause_five_hour_pct) || (sd ?? 0) >= getSetting('pause_seven_day_pct', DEFAULTS.pause_seven_day_pct)) attention('rate_limit', `Usage at five-hour ${fh}% / seven-day ${sd}%: new launches paused`, {})
    }
    return json(res, 200, { ok: true })
  }
  json(res, 404, {})
}

export function startHooksServer(): http.Server {
  const srv = http.createServer(async (req, res) => {
    try { await route(req, res) } catch (e) {
      emit({ agentId: null, source: 'system', kind: 'backend.error', payload: { server: 'hooks', url: req.url?.replace(/\/(hooks|mod)\/[^/]+/, '/$1/…'), error: String(e) } })
      if (!res.headersSent) json(res, e instanceof TooLarge ? 413 : 500, { error: e instanceof TooLarge ? e.message : 'HQ error' }); else res.end()
    }
  })
  srv.listen(PORTS.hooks, BIND); return srv
}
async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x'); const parts = url.pathname.split('/').filter(Boolean)
  const body = req.method === 'POST' ? asObject(await readJson(req, 8 * 1024 * 1024)) : {} // hooks carry whole tool outputs
  if (parts[0] === 'hooks' && parts[1]) { const a = agentByToken(parts[1]); if (!a) return json(res, 403, { error: 'bad token' }); if (!body.hook_event_name) return json(res, 200, {}); try { return handleHook(a, body, res) } catch (e) { emit({ agentId: a.id, source: 'system', kind: 'hook.error', payload: { error: String(e) } }); return json(res, 200, {}) } }
  if (parts[0] === 'mod' && parts[1] && parts[2]) { const a = agentByToken(parts[1]); if (!a) return json(res, 403, { error: 'bad token' }); return handleMod(a, parts[2], url, body, res) }
  if (parts[0] === 'tmux' && parts[1] && parts[2] && parts[3]) {
    const a = getAgent(parts[1]); if (!a || tmuxToken(parts[1]) !== parts[2]) return json(res, 403, {})
    // Someone attached from a real terminal holds delivery until they detach (+ the usual grace). HQ's own terminal view doesn't.
    const lock = getSetting('takeover_lock_s', DEFAULTS.takeover_lock_s) * 1000
    const external = (await tmux.clientPids(a.tmux_session)).filter((pid) => !isBridgePid(pid)).length
    const longHold = (a.takeover_locked_until ?? 0) > now() + 86_400_000
    if (parts[3] === 'attached' && external) update(a.id, { takeover_locked_until: now() + TAKEOVER_ATTACHED_MS })
    else if (parts[3] === 'detached' && !external && longHold) update(a.id, { takeover_locked_until: now() + lock })
    emit({ agentId: a.id, source: 'system', kind: `tmux.${parts[3]}`, payload: { external } }); return json(res, 200, {})
  }
  json(res, 404, {})
}
