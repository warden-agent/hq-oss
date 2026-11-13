// Hook + mod + tmux ingress server (127.0.0.1:PORTS.hooks). Every record is logged to `events`, then applied.
import http from 'node:http'
import { BIND, PORTS, DEFAULTS } from './config.ts'
import { checkContext } from './freshstart.ts'
import { run, now, getSetting, one } from './db.ts'
import { emit, patch } from './events.ts'
import { agentByToken, getAgent, update, tmuxToken, revokeToken, type Agent } from './agents.ts'
import { onExitPlanMode, onPostExitPlanMode, openReviews } from './gate.ts'
import { ackBatchFromPrompt, deliveredByStopHook, recordReply, nextBatchFor, markSubmitted, markReceived, requeue, unreadCount, pendingFor, tellIfHqWasAway, nextDeadline } from './delivery.ts'
import { listen, type Waiter } from './wake.ts'
import { onPostModelSwitch, onTurnStep } from './modelguard.ts'
import { attention, resolveKind } from './attention.ts'
import { getRepo, getTicket, repoOfAgent } from './records.ts'
import { gateBash, laneMoved } from './heavy.ts'
import { addRun, endRuns, waitingText, watchedTask } from './bgruns.ts'
import { isBridgePid } from './terminal.ts'
import * as tmux from './tmux.ts'
import { readJson, asObject, TooLarge } from './util.ts'
import { TOKEN_HEADER } from './roles.ts'

const TAKEOVER_ATTACHED_MS = 365 * 86_400_000 // "until they detach"
/** Bug 99: the longest a waiting `next` goes without looking, for a change that woke nothing (a write that wake.ts doesn't hear of). */
const NEXT_BACKSTOP_MS = Number(process.env.HQ_NEXT_BACKSTOP_MS ?? 5000)
/** Notification types that mean a dialog is open and waiting for a person (checked on 2.1.300). */
const DIALOGS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'worker_permission_prompt'])

const json = (res: http.ServerResponse, code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const deny = (message: string) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } })
const allow = () => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
const trim = (v: unknown, n = 400): string => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > n ? s.slice(0, n) + '…' : s }
/** Bug 83: a Bash command Claude Code let a repair engineer run, kept whole on its event. HQ takes a new test command only when the engineer
 *  ran it this way first (auto.ts ranByEngineer): its own sandbox runs commands that Claude Code refuses in an engineer's session. A refused
 *  command fires PostToolUseFailure with Claude Code's reason; one that ran and failed says "Exit code N" (both seen on 2.1.300). */
const ranBash = (agent: Agent, tool: string, input: Record<string, unknown>, error?: unknown): string | undefined => {
  if (tool !== 'Bash' || (error !== undefined && !/^Exit code \d/.test(String(error))) || !getTicket(agent.ticket_id ?? '')?.repairs_main) return undefined
  return String(input.command ?? '').slice(0, 8000)
}

function describeTool(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') return `Running: ${trim(input.command, 80)}`
  if (tool === 'Edit' || tool === 'Write' || tool === 'Read') return `${tool === 'Read' ? 'Reading' : 'Editing'} ${String(input.file_path ?? '').split('/').slice(-2).join('/')}`
  if (tool.startsWith('mcp__hq__')) return `Calling hq.${tool.slice(9)}`
  if (tool === 'ExitPlanMode') return 'Submitting plan'
  if (tool === 'Agent') return `Subagent: ${trim(input.description, 60)}`
  return tool
}

/** When each agent's main loop last started a turn (UserPromptSubmit) and last ended one (Stop), as steps of one counter, not
 *  clock times: a prompt and its Stop can share a millisecond (Bug 80). Memory only: after a restart the stuck loop's screen
 *  check covers the gap. */
const turns = new Map<string, { prompt: number; stop: number }>()
let turnSeq = 0
/** Bug 94: the helpers each agent's main loop started in the background itself (the Agent tool), helper id → description. While
 *  one runs the agent is working, even after its turn ended. Claude Code's own helpers never get here (Bug 25). Memory only. */
const helpers = new Map<string, Map<string, string>>()
const helperActivity = (m: Map<string, string>): string => `Subagent: ${[...m.values()].at(-1)}${m.size > 1 ? ` (+${m.size - 1} more)` : ''}`
/** What the agent still waits on once its turn has ended: a helper (Bug 94) or a run in the background (Bug 95, bgruns.ts). Null: nothing. */
const stillOn = (id: string, m: Map<string, string>): string | null => m.size ? helperActivity(m) : waitingText(id)
/** The stuck loop saw the agent's idle prompt for minutes: nothing HQ thought was running is. */
export function forgetHelpers(agentId: string): void { helpers.delete(agentId) }
function handleHook(agent: Agent, body: Record<string, unknown>, res: http.ServerResponse): void {
  const ev = String(body.hook_event_name ?? ''); const tool = String(body.tool_name ?? ''); const input = (body.tool_input ?? {}) as Record<string, unknown>
  const mode = body.permission_mode as string | undefined; const t = now()
  const fields: Partial<Agent> = { last_event_at: t } // agent columns
  const live: { activity?: string | null; last_message?: string } = {} // shown in the UI only (patches), not stored
  if (mode) fields.in_plan_mode = mode === 'plan' ? 1 : 0
  const payload: Record<string, unknown> = { event: ev, tool, mode }
  const cleared = ev === 'SessionEnd' && body.reason === 'clear' // /clear: the same session goes on with a fresh context
  // Bug 25: hooks from a helper agent (a subagent, or Claude Code's own background helpers) carry agent_id. They can run after
  // the main turn has ended, so they never make the agent "working"; only the main loop's turns do.
  const sub = typeof body.agent_id === 'string' && body.agent_id !== ''
  if (sub) payload.sub = true
  const turn = turns.get(agent.id) ?? { prompt: 0, stop: 0 }; turns.set(agent.id, turn)
  const bg = helpers.get(agent.id) ?? new Map<string, string>(); helpers.set(agent.id, bg); const helperId = String(body.agent_id ?? '')
  if (ev !== 'SessionEnd') tellIfHqWasAway(agent) // Bug 85: it was told to wait for HQ, and HQ is answering again
  switch (ev) {
    case 'SessionStart': bg.clear(); endRuns(agent.id, 'all', 'session'); Object.assign(payload, { source: body.source, model: body.model, cwd: body.cwd }); Object.assign(fields, { claude_session_id: String(body.session_id ?? '') || null, transcript_path: (body.transcript_path as string | undefined) ?? null, status: 'working' }); run('UPDATE sessions SET claude_session_id = ?, transcript_path = ? WHERE agent_id = ? AND ended_at IS NULL', body.session_id as string, body.transcript_path as string, agent.id); break
    case 'UserPromptSubmit': { turn.prompt = ++turnSeq; payload.prompt = trim(body.prompt, 200); fields.status = 'working'; live.activity = 'Thinking'
      const done = [...String(body.prompt ?? '').matchAll(/<task-id>([\w-]+)<\/task-id>/g)].map((m) => m[1]!) // a helper's or a background run's "done" notice
      for (const task of done) bg.delete(task); endRuns(agent.id, done, 'done') // Bugs 94, 95
      payload.acked = ackBatchFromPrompt(agent, String(body.prompt ?? '')); break }
    case 'PreToolUse': payload.input = trim(input, 300); if (!sub) fields.status = 'working'
      if (tool === 'Bash') Object.assign(payload, { use: body.tool_use_id, timeout: input.timeout }) // leftovers.ts: which command, and how long it may run
      if (sub && bg.has(helperId)) live.activity = `Subagent: ${bg.get(helperId)} · ${describeTool(tool, input)}`
      else if (!sub || agent.status === 'working') live.activity = describeTool(tool, input); break
    // A helper that finishes after the main turn ended (Stop, and no prompt since) leaves the agent idle, whatever set it working,
    // unless a background helper the agent started is still running (Bug 94)
    case 'SubagentStop': bg.delete(helperId)
      if (turn.stop > turn.prompt && agent.status === 'working') { const on = stillOn(agent.id, bg); if (on) live.activity = on; else { fields.status = 'idle'; live.activity = null } } break
    case 'PostToolUse': Object.assign(payload, { input: trim(input, 200), use: body.tool_use_id })
      if (tool === 'ExitPlanMode') payload.responsePlanLen = String((body.tool_response as { plan?: string } | undefined)?.plan ?? '').length
      if (tool === 'Agent' && !sub) { const r = (body.tool_response ?? {}) as { isAsync?: boolean; agentId?: unknown; description?: unknown }
        if (r.isAsync && typeof r.agentId === 'string') { bg.set(r.agentId, trim(r.description ?? input.description, 60)); payload.helper = r.agentId } }
      if (tool === 'Bash' && !sub) { // Bug 95: still running in the background, and the agent waits on it
        const task = watchedTask(input, body.tool_response, getRepo(repoOfAgent(agent) ?? '')?.test_cmd ?? null)
        if (task) { addRun(agent.id, { task, use: String(body.tool_use_id ?? ''), command: String(input.command ?? '') }); payload.bg = task } }
      payload.ran = ranBash(agent, tool, input); break
    case 'PostToolUseFailure': Object.assign(payload, { input: trim(input, 200), use: body.tool_use_id, error: trim(body.error, 300), is_interrupt: body.is_interrupt })
      payload.ran = ranBash(agent, tool, input, body.error ?? ''); break
    case 'Stop': { turn.stop = ++turnSeq; payload.last = trim(body.last_assistant_message, 600); const on = stillOn(agent.id, bg); fields.status = on ? 'working' : 'idle'
      Object.assign(live, { activity: on, last_message: trim(body.last_assistant_message, 2000) })
      if (agent.role === 'tpm') recordReply(agent, String(body.last_assistant_message ?? '')); break }
    case 'StopFailure': payload.error = trim(body.error ?? body, 400); fields.status = 'blocked'; break
    case 'Notification': Object.assign(payload, { ntype: body.notification_type, message: trim(body.message, 200) }); break
    case 'PostModelSwitch': case 'PreModelSwitch': Object.assign(payload, { from: body.from_model, to: body.to_model, source: body.source, requested: body.requested_model }); break
    case 'PreCompact': case 'PostCompact': payload.trigger = body.trigger; break
    case 'ConfigChange': Object.assign(payload, { csource: body.source, file: body.file_path }); break
    case 'SessionEnd': payload.reason = body.reason; bg.clear(); if (cleared) break
      endRuns(agent.id, 'all', 'session')
      Object.assign(fields, { status: 'exited', ended_at: t }); live.activity = null; run('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE agent_id = ? AND ended_at IS NULL', t, String(body.reason ?? ''), agent.id); break
    case 'TaskCreated': case 'TaskCompleted': payload.task = trim(body.task ?? body, 300); break
  }
  if (fields.status && fields.status !== 'paused' && agent.paused_reason?.startsWith('quota_auto_resume')) { // the usage wait is over: a turn moved on
    fields.paused_reason = null; resolveKind('usage_limit', agent.id)
  }
  if (agent.status === 'exited') delete fields.status // a late hook from a session HQ already counts as gone doesn't bring it back
  update(agent.id, fields, agent.status !== 'exited' ? live : {}) // one patch (Bug 98)
  emit({ agentId: agent.id, sessionId: String(body.session_id ?? ''), source: 'hook', kind: `hook.${ev}${tool ? ':' + tool : ''}`, payload })

  // ---- decisions ----
  if (ev === 'PermissionRequest') {
    if (tool === 'ExitPlanMode') return onExitPlanMode(agent, body, res)
    const inPlan = mode === 'plan'
    if (tool.startsWith('mcp__hq__')) return json(res, 200, allow())
    if (tool === 'Bash' && !inPlan && (agent.role === 'engineer' || agent.role === 'launcher')) return json(res, 200, allow()) // sandboxed either way
    if (tool === 'Bash' && inPlan) return json(res, 200, deny(`HQ: '${trim(input.command, 80)}' is not allowed during planning; run it after plan approval.`))
    attention('unexpected_prompt', `${agent.display_name ?? agent.id}: ${tool} needed approval (${trim(input, 120)}); denied by policy`, { agentId: agent.id, ticketId: agent.ticket_id })
    return json(res, 200, deny(`HQ: '${tool}' would need approval and is not allowed here. Continue without it, or report_blocked if you cannot.`))
  }
  // Bug 76: a build or a full test run waits here for its turn; the answer is what lets the command start. The agent itself and each helper of its run one tool
  // at a time, so the next tool starting (or a helper finishing) means the turn its last command held is free
  const lane = sub ? String(body.agent_id) : 'main'
  if (ev === 'PreToolUse' || ev === 'SubagentStop') laneMoved(agent.id, lane)
  if (ev === 'PreToolUse' && tool === 'Bash' && gateBash(agent, { use: String(body.tool_use_id ?? ''), command: String(input.command ?? ''), timeout: input.timeout,
    background: input.run_in_background === true, lane, plan: mode === 'plan', activity: describeTool(tool, input) }, res, () => json(res, 200, {}))) return
  if (ev === 'PreModelSwitch') return json(res, 200, { hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'deny', permissionDecisionReason: 'HQ controls models for this agent.' } })
  if (ev === 'PostModelSwitch') { onPostModelSwitch(agent, body); return json(res, 200, {}) }
  if (ev === 'ConfigChange') return json(res, 200, agent.role === 'engineer' || agent.role === 'launcher' ? { decision: 'block', reason: 'HQ: configuration changes are not allowed' } : {})
  if (ev === 'PreCompact' && agent.role === 'tpm' && body.trigger === 'auto') { attention('tpm_rotate', `TPM ${agent.id}: Claude Code wanted to compact its memory; HQ blocked it. Fresh start the TPM`, { agentId: agent.id }); return json(res, 200, { decision: 'block', reason: 'HQ fresh-starts the TPM instead of compacting' }) }
  if (ev === 'PostToolUse' && tool === 'ExitPlanMode') { onPostExitPlanMode(agent, body); return json(res, 200, {}) }
  if (ev === 'PostToolUse' && (tool === 'TaskCreate' || tool === 'TaskUpdate')) { recordTask(agent, tool, input, body.tool_response as Record<string, unknown> | undefined) }
  if (ev === 'UserPromptSubmit' || ev === 'Stop') {
    const ctx: string[] = []
    const unread = unreadCount(agent); if (unread) ctx.push(`HQ: ${unread} unread message(s) are queued and will arrive as a new turn when you are idle.`)
    if (agent.ticket_id) { const rv = openReviews().find((r) => r.ticket_id === agent.ticket_id); if (rv) ctx.push(`HQ: plan review R-${rv.round} is pending; if your ExitPlanMode call was denied without an HQ message, call ExitPlanMode again without changing the plan.`) }
    if (ev === 'Stop') { const modAlive = agent.mod_seen_at && t - agent.mod_seen_at < 120_000; const pend = pendingFor(agent)
      // The mod has gone quiet: the batch goes in this answer, and the turn goes on with it (Bug 103). So the agent is working again, as
      // after a prompt: a finished engineer isn't stopped while it reads the message, and a helper ending now doesn't make it idle.
      if (!modAlive && pend.length && !(agent.takeover_locked_until && agent.takeover_locked_until > t)) { const b = nextBatchFor(agent); if (b) {
        deliveredByStopHook(agent, b.id); turn.prompt = ++turnSeq; update(agent.id, { status: 'working' }, { activity: 'Thinking' }) // one patch (Bug 98)
        return json(res, 200, { decision: 'block', reason: `HQ message batch ${b.id}:\n${b.text}` }) } } }
    return json(res, 200, ctx.length ? { hookSpecificOutput: { hookEventName: ev, additionalContext: ctx.join('\n') } } : {})
  }
  if (ev === 'Notification') { // Bug 62: exact names. elicitation_response and _complete mean a dialog ended, and quota_auto_resume_fired that Claude Code carries on
    const nt = String(body.notification_type ?? ''), who = agent.display_name ?? agent.id
    if (nt === 'permission_prompt' && /plan/i.test(String(body.message ?? ''))) { /* gate open; not stuck */ }
    else if (DIALOGS.has(nt)) { update(agent.id, { status: 'blocked' }); attention('dialog', `${who}: ${trim(body.message, 160)}`, { agentId: agent.id, ticketId: agent.ticket_id }) }
    else if (nt === 'quota_auto_resume_stale' || nt === 'quota_auto_resume_disabled') {
      update(agent.id, { status: 'paused', paused_reason: nt }); attention('usage_limit', `${who}: ${trim(body.message, 160)}`, { agentId: agent.id })
    } else if (nt === 'quota_auto_resume_fired') {
      if (agent.status === 'paused') update(agent.id, { status: 'working' })
      if (agent.paused_reason?.startsWith('quota_auto_resume')) update(agent.id, { paused_reason: null })
      resolveKind('usage_limit', agent.id)
    }
    return json(res, 200, {})
  }
  if (ev === 'StopFailure') { attention('api_error', `${agent.display_name ?? agent.id}: turn ended with an API error: ${trim(body.error ?? body, 200)}`, { agentId: agent.id, ticketId: agent.ticket_id }) }
  if (ev === 'SessionEnd' && !cleared) { revokeToken(agent.id); resolveKind('dialog', agent.id) } // the session is over: its token is no good to anyone now, and it has no dialog
  if (ev === 'SessionEnd' && !cleared && !agent.fresh_start_at && agent.role === 'engineer' && agent.ticket_id) { const tk = getTicket(agent.ticket_id); if (tk && !['pr_ready', 'pr_open', 'merged', 'cancelled'].includes(tk.status)) attention('engineer_exited', `${agent.display_name ?? agent.id} exited with ticket ${tk.key} in status ${tk.status}`, { agentId: agent.id, ticketId: agent.ticket_id }) }
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
    const end = t + Math.min(Number(url.searchParams.get('wait') ?? 15000), 25000)
    // Bug 99: it looks once now, then again when something that could give it a batch changes (wake.ts), when a hold ends or a batch
    // falls due (nextDeadline), or every NEXT_BACKSTOP_MS at most. A wake looks on the next turn of the event loop, after the code that
    // woke it has finished: an urgent message is marked delivered right after it is stored, and must not be handed out as well.
    // The agent row is read again every look: a hold or pause set while the mod waits counts at once. Nothing is handed to a
    // connection that's already closed (a batch handed out but never received is handed out again; see nextBatchFor).
    let timer: NodeJS.Timeout | undefined, soon = false, done = false
    const w: Waiter = { status: agent.status, wake: () => { if (done || soon) return; soon = true; setImmediate(look) } }
    const stop = listen(agent.id, w)
    const finish = (code: number, out: object): void => { done = true; clearTimeout(timer); stop(); json(res, code, out) }
    res.on('close', () => { done = true; clearTimeout(timer); stop() })
    const look = (): void => {
      soon = false; clearTimeout(timer)
      if (done || res.destroyed || res.writableEnded) return
      try { // later looks run from a timer, outside the server's own catch
        const a = getAgent(agent.id); if (!a || a.status === 'exited') return finish(200, {})
        w.status = a.status
        const b = nextBatchFor(a); if (b) return finish(200, { batch: { id: b.id, text: b.text, asUser: b.asUser, raw: b.raw } })
        const left = end - now(); if (left <= 0) return finish(200, {})
        const due = nextDeadline(a); if (!soon) timer = setTimeout(look, Math.max(5, Math.min(left, NEXT_BACKSTOP_MS, due === null ? Infinity : due - now())))
      } catch (e) { emit({ agentId: agent.id, source: 'system', kind: 'backend.error', payload: { server: 'mod', error: String(e) } }); return finish(500, { error: 'HQ error' }) }
    }
    update(agent.id, { mod_seen_at: t }); return look()
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
      checkContext(agent, u.context?.tokens)
      if ((fh ?? 0) >= getSetting('pause_five_hour_pct', DEFAULTS.pause_five_hour_pct) || (sd ?? 0) >= getSetting('pause_seven_day_pct', DEFAULTS.pause_seven_day_pct)) attention('rate_limit', `Usage at five-hour ${fh}% / seven-day ${sd}%: new launches paused`, { keep: true }) // the percentages change every sample
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
  // Bug 87: the token comes in a header. `/hooks/<token>` is still taken from agents started before that change, until they restart.
  const hookToken = parts[0] === 'hooks' ? (parts.length === 1 ? req.headers[TOKEN_HEADER.toLowerCase()] : parts.length === 2 ? parts[1] : undefined) : undefined
  if (typeof hookToken === 'string' && hookToken) {
    const a = agentByToken(hookToken); if (!a) return json(res, 403, { error: 'bad token' })
    if (!body.hook_event_name) return json(res, 200, {})
    try { return handleHook(a, body, res) } catch (e) { emit({ agentId: a.id, source: 'system', kind: 'hook.error', payload: { error: String(e) } }); return json(res, 200, {}) }
  }
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
