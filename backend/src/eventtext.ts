// Bug 121: the Events tab's lines. What an agent did (its prompts, tool calls, turns, tickets) and what HQ did for it, one plain
// line per thing, built from the events table. Both the history (GET /api/agents/:id/events) and the live feed (ui.ts) use eventLine.
import { q } from './db.ts'
import { getAgent } from './agents.ts'
import { getTicket } from './records.ts'

export type EventLine = { id: number; at: number; agentId: string | null; text: string }

/** Kinds the tab leaves out: the other half of a tool call (Post, Pre for a model switch), HQ's own plumbing (mod polling, batches,
 *  MCP calls already shown as tool calls, the permission check before each tool call: HQ answers those itself), and HQ's page
 *  opening a terminal (tmux.attached: that's the viewer, not the agent). GLOB patterns. */
const HIDDEN = ['mod.*', 'mcp.*', 'tmux.*', 'batch.*', 'hook.PostToolUse:*', 'hook.PermissionRequest:*', 'hook.ConfigChange', 'hook.PreModelSwitch', 'hook.PostCompact',
  'repo.sync*', 'retention.*', 'agent.tmp_removed']
const hidden = (kind: string): boolean => HIDDEN.some((p) => p.endsWith('*') ? kind.startsWith(p.slice(0, -1)) : kind === p)

const VERDICT: Record<string, string> = { approve: 'approved', revise: 'sent back to revise', reject: 'rejected' }
const one = (v: unknown, n = 140): string => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
/** A field of a tool's input. hooks.ts keeps the input as JSON cut at 300 characters, so it often won't parse: then the field is read up to the cut. */
export function field(input: unknown, name: string): string {
  if (input && typeof input === 'object') return String((input as Record<string, unknown>)[name] ?? '')
  const s = String(input ?? '')
  try { const o = JSON.parse(s) as Record<string, unknown>; return typeof o[name] === 'string' ? o[name] as string : '' } catch { /* cut off: read it as text */ }
  const m = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)`).exec(s); if (!m) return ''
  const raw = m[1]!.replace(/…$/, '').replace(/\\$/, ''), cut = s.charAt(m.index + m[0].length) !== '"' // the value runs into the cut
  let v = raw; try { v = JSON.parse(`"${raw}"`) as string } catch { /* a broken escape: as written */ }
  return cut ? v + '…' : v
}
const file = (p: string): string => p.split('/').slice(-2).join('/')
function toolLine(tool: string, input: unknown): string {
  const f = (n: string) => field(input, n)
  if (tool === 'Bash') return `Command: ${one(f('command').replace(/^cd ("[^"]*"|'[^']*'|\S+) *(&&|;) */, ''), 300)}` // written as it starts: it may still run
  if (tool === 'Read') return `Read ${file(f('file_path'))}`
  if (tool === 'Edit' || tool === 'MultiEdit') return `Edited ${file(f('file_path'))}`
  if (tool === 'Write') return `Wrote ${file(f('file_path'))}`
  if (tool === 'Grep') return `Searched the code for ${one(f('pattern'), 80)}`
  if (tool === 'Glob') return `Looked for files ${one(f('pattern'), 80)}`
  if (tool === 'ExitPlanMode') return 'Sent its plan for review'
  if (tool === 'Agent' || tool === 'Task') return `Started a helper: ${one(f('description'), 80)}`
  if (tool === 'WebFetch') return `Opened ${one(f('url'), 100)}`
  if (tool === 'WebSearch') return `Searched the web for ${one(f('query'), 80)}`
  if (tool === 'ToolSearch') return 'Looked up a tool'
  if (tool.startsWith('mcp__hq__')) return `Asked HQ: ${tool.slice(9).replace(/_/g, ' ')}`
  return `Used ${tool}`
}
/** A prompt: HQ's message batches read as messages, without their ids. */
function prompt(t: string): string {
  const m = /^HQ message batch [\w-]+:\s*([\s\S]*)/.exec(t)
  return m ? `Messages: ${one(m[1]!.replace(/ ?\[msg [\w-]+\]/g, ''), 300)}` : `Got a prompt: ${one(t, 300)}`
}
const keyOf = (id: unknown, key?: unknown): string => String(key ?? '') || (getTicket(String(id ?? ''))?.key ?? 'its ticket')
const nameOf = (id: unknown): string => { const a = getAgent(String(id ?? '')); return a?.display_name ?? (id === 'user' ? 'you' : String(id ?? 'someone')) }

/** One plain line for an event, or null when the Events tab leaves it out. */
export function eventLine(kind: string, payload: Record<string, unknown>): string | null {
  if (hidden(kind)) return null
  const p = payload, [what, tool = ''] = kind.split(':') as [string, string?]
  const helper = p.sub ? 'Helper · ' : ''
  switch (what) {
    case 'hook.PreToolUse': return helper + toolLine(tool, p.input)
    case 'hook.PostToolUseFailure': return helper + (p.is_interrupt ? `${tool} stopped (interrupted)` : `${tool} failed: ${one(p.error, 300)}`)
    case 'hook.UserPromptSubmit': return prompt(String(p.prompt ?? ''))
    case 'hook.Stop': return p.last ? `Turn ended: ${one(p.last, 300)}` : 'Turn ended'
    case 'hook.StopFailure': return `Turn failed: ${one(p.error)}`
    case 'hook.SessionStart': return `Claude Code started${p.source ? ` (${p.source})` : ''}`
    case 'hook.SessionEnd': return `Claude Code ended${p.reason ? ` (${p.reason})` : ''}`
    case 'hook.SubagentStop': return 'A helper finished'
    case 'hook.Notification': return `Claude Code says: ${one(p.message)}`
    case 'hook.PreCompact': return `Compacting its context${p.trigger ? ` (${p.trigger})` : ''}`
    case 'hook.PostModelSwitch': return `Model changed: ${p.from ?? '?'} → ${p.to ?? '?'}`
    case 'hook.TaskCreated': return `New task: ${one(p.task, 100)}`
    case 'hook.TaskCompleted': return `Task done: ${one(p.task, 100)}`
    case 'message.sent': return `Sent a message to ${nameOf(p.to)}`
    case 'message.typed': return 'HQ typed a message into its terminal'
    case 'ask.opened': return `Asked you: ${one(p.question)}`
    case 'gate.review_opened': return `Its plan waits for review${Number(p.round) > 1 ? ` (round ${p.round})` : ''}`
    case 'gate.verdict': { const by = p.by === 'auto' ? ' by HQ' : p.by === 'plan_check' ? ' by HQ\'s plan check' : p.by === 'user' ? ' by you' : ''
      return `Plan ${VERDICT[String(p.verdict)] ?? String(p.verdict)}${by}` }
    case 'auto.tried': return p.state === 'tried' ? `HQ's tester tried ${p.feature} in a browser${Number(p.problems) ? ` and found ${p.problems === 1 ? 'a problem' : `${p.problems} problems`}` : ''}`
      : `HQ's tester didn't try ${p.feature}: ${one(p.why)}`
    case 'auto.uitest': return p.state === 'done'
      ? `HQ's UI tester tried ${p.scenarios} scenarios in a browser and found ${Number(p.findings) === 1 ? 'one thing' : `${p.findings} things`} worth a look`
      : `HQ's UI tester didn't use the app: ${one(p.why)}`
    case 'auto.read': { const n = Array.isArray(p.findings) ? p.findings.length : 0
      return p.state === 'unchecked' ? `Nobody could read ${p.key}'s changes before it merged` : n ? `A fresh reader of ${p.key}'s changes found ${n === 1 ? 'a problem' : `${n} problems`}`
        : `A fresh reader of ${p.key}'s changes found nothing wrong` }
    case 'plan_check.started': return 'HQ\'s plan check is reading its plan against the ticket\'s criteria'
    case 'plan_check.answered': { const n = Array.isArray(p.findings) ? p.findings.length : 0
      return n ? `HQ's plan check found ${n === 1 ? 'a problem' : `${n} problems`} with its plan` : 'HQ\'s plan check found nothing wrong with its plan' }
    case 'plan_check.failed': return `HQ's plan check couldn't run: ${one(p.why)}`
    case 'tpm.started': return "Took over as the project's TPM"
    case 'fresh_start.requested': return 'Asked to save a note and start fresh'
    case 'fresh_start.done': return 'Started fresh from its note'
    case 'takeover.input': return 'You typed in its terminal'
    case 'launch.helper_started': return 'Started working out how to launch the app'
    case 'launch.saved': return 'Saved how to launch the app'
    case 'launch.helper_done': return 'Done with the launch steps'
    case 'agent.launched': return `Started${p.model ? ` (${p.model})` : ''}`
    case 'agent.stopped': return `Stopped${p.reason ? `: ${one(p.reason, 100)}` : ''}`
    case 'agent.lost': return 'Its terminal is gone'
    case 'agent.interrupted': return p.why === 'not_acked' ? "Interrupted: it didn't take HQ's messages" : 'Interrupted (Escape)'
    case 'agent.missing': return "HQ can't find its terminal"
    case 'agent.recovered': return 'Its terminal is back'
    case 'agent.hq_back': return 'Told that HQ is back'
    case 'agent.idle_fixed': return 'Shown as idle: it had been quiet a while'
    case 'agent.dialog_cleared': return 'A question on its screen was answered'
    case 'urgent.interrupt': return 'You interrupted it with a message'
    case 'question.answered': return 'Its question was answered'
    case 'turns.waiting': return `Waiting its turn for ${one(p.what, 80) || 'a build or test run'}`
    case 'turns.started': return `Its turn: ${one(p.what, 80) || 'a build or test run'} started${p.waitedS ? ` after ${p.waitedS} s` : ''}`
    case 'turns.left': return `Done with its turn (${one(p.what, 80)})`
    case 'bg.started': return `Left running in the background: ${one(p.command ?? p.task, 100)}`
    case 'bg.ended': return `Background run ended${p.why ? ` (${p.why})` : ''}`
    case 'ticket.launched': return `${p.fix ? 'Back on' : 'Started on'} ${keyOf(p.ticket, p.key)}`
    case 'ticket.resumed': return `Picked up ${keyOf(p.ticket, p.key)} again`
    case 'ticket.pr_open': return `Opened a pull request for ${keyOf(p.ticket, p.key)}`
    case 'ticket.pr_ready': return `${keyOf(p.ticket, p.key)} is ready to merge`
    case 'ticket.merged_by_hq': return `HQ merged ${keyOf(p.ticket, p.key)}`
    case 'ticket.merged': return `${keyOf(p.ticket, p.key)} is in main`
    case 'ticket.merge_refused': return `HQ didn't merge ${keyOf(p.ticket, p.key)}${p.why ? `: ${one(p.why, 100)}` : ''}`
    case 'ticket.fix_tests': return `${keyOf(p.ticket, p.key)} came back: tests fail`
    case 'ticket.fix_conflicts': return p.clean ? `${keyOf(p.ticket, p.key)} merges cleanly now` : `${keyOf(p.ticket, p.key)} came back: merge conflicts`
    case 'ticket.deps_changed': return `${keyOf(p.ticket, p.key)} now waits on ${(p.depends_on as string[] | undefined)?.join(', ') || 'nothing'}`
    case 'auto.tested': return `HQ tested ${keyOf(p.ticket, p.key)} before merging: ${({ pass: 'the tests pass', fail: 'the tests fail', no_tests: 'no tests to run',
      conflicts: 'it conflicts with main', error: "the test run couldn't start" } as Record<string, string>)[String(p.result)] ?? String(p.result)}`
    case 'auto.parked': return `Auto mode left ${keyOf(p.ticket, p.key)} for you: ${one(p.why, 200)}`
    case 'auto.repair_opened': return `HQ opened ${keyOf(p.ticket, p.key)} to fix main`
    case 'ticket.change': return `Asked to change ${keyOf(p.ticket, p.key)}`
    case 'ticket.cancelled': return `${keyOf(p.ticket, p.key)} was cancelled`
  }
  if (what.startsWith('attention.') && p.detail) return `Alert: ${one(p.detail, 200)}`
  return kind // a kind with no wording yet: shown by name rather than hidden
}

/** Who a line belongs to. HQ's own events about a ticket (its test run before merging, a refused merge, auto mode leaving it for the user)
 *  carry no agent: they go to the ticket's engineer. */
export function lineOwner(agentId: string | null, payload: Record<string, unknown>): string | null {
  if (agentId) return agentId
  const t = typeof payload.ticket === 'string' && payload.ticket.startsWith('tkt-') ? getTicket(payload.ticket) : undefined
  return t?.assignee_agent_id ?? null
}

type Row = { id: number; agent_id: string | null; kind: string; payload: string; created_at: number }
/** The newest `limit` lines for one agent, newest first: its own events, and HQ's about its ticket since it started. The left-out kinds
 *  are dropped in SQL, before the limit, so a busy agent's chatter can't push its few real lines out. */
export function agentEvents(agentId: string, limit = 300): EventLine[] {
  const where = HIDDEN.map(() => 'kind NOT GLOB ?').join(' AND '), a = getAgent(agentId), cols = 'SELECT id, agent_id, kind, payload, created_at FROM events'
  const own = q<Row>(`${cols} WHERE agent_id = ? AND ${where} ORDER BY id DESC LIMIT ?`, agentId, ...HIDDEN, limit)
  const hq = a?.ticket_id ? q<Row>(`${cols} WHERE agent_id IS NULL AND created_at >= ? AND json_extract(payload, '$.ticket') = ? AND ${where} ORDER BY id DESC LIMIT ?`,
    a.started_at, a.ticket_id, ...HIDDEN, limit) : []
  return [...own, ...hq].sort((x, y) => y.id - x.id).slice(0, limit).flatMap((r) => {
    let p: Record<string, unknown> = {}; try { p = JSON.parse(r.payload) as Record<string, unknown> } catch { /* a bad row still gets its kind */ }
    const text = eventLine(r.kind, p); return text ? [{ id: r.id, at: r.created_at, agentId, text }] : []
  })
}
