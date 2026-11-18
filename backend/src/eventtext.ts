// Bug 121: the Events tab's lines. What an agent did (its prompts, tool calls, turns, tickets) and what HQ did for it, one plain
// line per thing, built from the events table. Both the history (GET /api/agents/:id/events) and the live feed (ui.ts) use eventLine.
import { q } from './db.ts'
import { getAgent } from './agents.ts'
import { getFeature, getRepo, getTicket } from './records.ts'

export type EventLine = { id: number; at: number; agentId: string | null; text: string }

/** Kinds the tab leaves out: the other half of a tool call (Post, Pre for a model switch), HQ's own plumbing (mod polling, batches,
 *  MCP calls already shown as tool calls, the permission check before each tool call: HQ answers those itself), and HQ's page
 *  opening a terminal (tmux.attached: that's the viewer, not the agent). GLOB patterns. */
const HIDDEN = ['mod.*', 'mcp.*', 'tmux.*', 'batch.*', 'hook.PostToolUse:*', 'hook.PermissionRequest:*', 'hook.ConfigChange', 'hook.PreModelSwitch', 'hook.PostCompact',
  'hook.SubagentStart', // Bug 201: the other half of "Started a helper: …" (PreToolUse:Agent)
  'repo.sync*', 'retention.*', 'agent.tmp_removed']
const hidden = (kind: string): boolean => HIDDEN.some((p) => p.endsWith('*') ? kind.startsWith(p.slice(0, -1)) : kind === p)

/** Bug 201: why a background run ended (bgruns.ts endRuns), in plain words. */
const BG_WHY: Record<string, string> = { done: 'it finished', gone: 'its process is gone', stopped: 'HQ stopped it', session: 'its Claude Code session ended',
  'agent.stopped': 'the agent was stopped', 'agent.lost': 'its terminal is gone' }
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
const list = (v: unknown): string => Array.isArray(v) ? v.join(', ') : String(v ?? '')
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
/** The default branch of the ticket's project (Bug 210: not always main); "main" once the ticket is gone. */
const baseOf = (id: unknown): string => getRepo(getFeature(getTicket(String(id ?? ''))?.feature_id ?? '')?.repo_id ?? '')?.default_branch ?? 'main'
const nameOf = (id: unknown): string => { const a = getAgent(String(id ?? '')); return a?.display_name ?? (id === 'user' ? 'you' : String(id ?? 'someone')) }
/** Bug 206: why a finished ticket came back to its engineer from auto mode's check before merging: `why` is what it went back to fix (tickets.ts). Rows from
 *  before Bug 206 have no `why`: a run that never finished said so, anything else may have been the tests, HQ's look at the app or the reader. */
const BACK: Record<string, string> = { tests: 'its tests fail', tests_hung: 'its tests never finish', look: "HQ's look at the app found something wrong",
  review: 'a fresh reader of its changes found something to fix' }
const cameBack = (p: Record<string, unknown>): string => `${keyOf(p.ticket, p.key)} came back: ${p.unproven ? "the tests named for its criteria didn't all run"
  : BACK[String(p.why)] ?? (p.hung ? BACK.tests_hung : "HQ's check before merging found something to fix")}`

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
    case 'message.dropped': return 'HQ dropped its unread note of the new test command: the ticket was finished' // Bug 147
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
      const of = `A fresh reader of ${p.key}'s changes${p.again ? ' (read again: it has new commits)' : ''}`
      if (p.state === 'unchecked') return `Nobody could read ${p.key}'s changes: the reader couldn't be asked` // written before HQ knows whether it merges (Bug 208)
      return n ? `${of} found ${n === 1 ? 'a problem' : `${n} problems`}` : `${of} found nothing wrong` }
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
    case 'launch.test_port': return `HQ stopped its test server on port ${list(p.ports)}: not one HQ gave it for tests (${list(p.given)}), so it could clash with `
      + 'another app. Its save was refused'
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
    case 'bg.ended': return `Background run ended${p.why ? ` (${BG_WHY[String(p.why)] ?? String(p.why)})` : ''}`
    case 'bg.stopped': { const n = Array.isArray(p.tasks) ? p.tasks.length : 1, cmds = Array.isArray(p.commands) ? p.commands.map((c) => one(c, 100)).join(', ') : '' // Bug 201
      return `${p.by === 'user' ? 'You' : p.by === 'auto' ? 'Auto mode' : 'HQ'} stopped ${n > 1 ? `${n} frozen background runs` : 'its frozen background run'}`
        + `${cmds ? `: ${cmds}` : ''}${p.minutes ? ` (no CPU, no output for ${p.minutes} min)` : ''}` }
    case 'bg.stop_failed': return `HQ couldn't stop its frozen background run: ${one(p.error)}`
    case 'backend.error': return `HQ hit an error${p.server === 'typing' ? ' typing into its terminal' : p.server === 'mod' ? ' handing it its messages' : ''}: ${one(p.error)}`
    case 'hook.error': return `HQ hit an error reading one of its hooks: ${one(p.error)}`
    case 'dialog.look_error': return `HQ couldn't look at its screen for an open question: ${one(p.error)}`
    case 'dialog.still_open': return 'A question on its screen still looks open: HQ keeps checking'
    case 'message.held': return `HQ held a message back${p.why === 'draft' ? ': there was half-typed text in its prompt box' : ''}`
    case 'gate.allow_stored': return 'Sent a plan HQ had already approved: let through'
    case 'gate.pending_answered': return 'HQ told it its plan still waits for review'
    case 'gate.reattached': return `Asked about its plan again${Number(p.round) > 1 ? ` (round ${p.round})` : ''}: it still waits for review`
    case 'gate.review_superseded': return `Its plan${p.round ? ` (round ${p.round})` : ''} was replaced by a newer one${p.by ? ` (round ${p.by})` : ''}`
    case 'gate.user_override': return 'Its plan was approved in its terminal\'s menu, not through HQ'
    case 'gate.plan_file_write_failed': return `HQ couldn't write the approved plan into its plan file: ${one(p.error)}`
    case 'testcmd.refused': return `Claude Code refused the project's test command for it${p.cmd ? `: ${one(p.cmd, 100)}` : ''}`
    case 'testcmd.runs_again': return 'Ran the project\'s test command: Claude Code lets engineers run it again'
    case 'auto.test_changed': return `HQ made its test command the project's: ${one(p.now, 100)}${p.left_out ? ` (it leaves out: ${one(p.left_out, 100)})` : ''}`
    case 'testsetup.helper_started': return 'Started working out how HQ tests the app'
    case 'testsetup.saved': return `Saved how HQ tests the app${Number(p.saves) > 1 ? ` (save ${p.saves})` : ''}: HQ is checking it`
    case 'testsetup.helper_done': return p.state === 'cant_test' ? `Done with the test setup: it says HQ can't test this app${p.note ? `: ${one(p.note, 100)}` : ''}`
      : p.state === 'failed' ? `Done with the test setup, with no setup that works${p.note ? `: ${one(p.note, 100)}` : ''}` : 'Done with the test setup'
    case 'testsetup.change_proposed': return `Proposed a change to how HQ tests the app${p.ticket ? `, with ${p.ticket}` : ''}`
    case 'ticket.launched': return `${p.fix ? 'Back on' : 'Started on'} ${keyOf(p.ticket, p.key)}`
    case 'ticket.resumed': return `Picked up ${keyOf(p.ticket, p.key)} again`
    case 'ticket.pr_open': return `Opened a pull request for ${keyOf(p.ticket, p.key)}`
    case 'ticket.pr_refused': return `HQ didn't take ${keyOf(p.ticket, p.key)} as finished (open pr): ${one(p.why, 600)}` // Bug 248
    case 'ticket.pr_ready': return `${keyOf(p.ticket, p.key)} is ready to merge`
    case 'ticket.merged_by_hq': return `HQ merged ${keyOf(p.ticket, p.key)}`
    case 'ticket.merged': return `${keyOf(p.ticket, p.key)} is in ${baseOf(p.ticket)}`
    case 'ticket.merge_refused': return `HQ didn't merge ${keyOf(p.ticket, p.key)}${p.why ? `: ${one(p.why, 100)}` : ''}`
    case 'ticket.fix_tests': return cameBack(p)
    case 'ticket.fix_conflicts': return p.clean ? `${keyOf(p.ticket, p.key)} merges cleanly now` : `${keyOf(p.ticket, p.key)} came back: merge conflicts`
    case 'ticket.deps_changed': return `${keyOf(p.ticket, p.key)} now waits on ${(p.depends_on as string[] | undefined)?.join(', ') || 'nothing'}`
    case 'auto.tested': return `HQ tested ${keyOf(p.ticket, p.key)} before merging: ${({ pass: 'the tests pass', fail: 'the tests fail', no_tests: 'no tests to run',
      conflicts: `it conflicts with ${baseOf(p.ticket)}`, error: "the test run couldn't start" } as Record<string, string>)[String(p.result)] ?? String(p.result)}`
    case 'auto.looked': return p.ran === 'pass' ? `HQ opened the app with ${keyOf(p.ticket, p.key)} merged in: it looks fine` // Bug 201
      : p.ran === 'fail' ? `HQ opened the app with ${keyOf(p.ticket, p.key)} merged in and found a problem${p.why ? `: ${one(p.why, 200)}` : ''}`
      : `HQ didn't look at the app with ${keyOf(p.ticket, p.key)} merged in${p.why ? `: ${one(p.why, 200)}` : ''}`
    case 'auto.parked': return `Auto mode left ${keyOf(p.ticket, p.key)} for you: ${one(p.why, 200)}`
    case 'auto.moved': return !p.merged ? `HQ didn't merge ${keyOf(p.ticket, p.key)}: its branch got commits after open_pr, so it goes back to its engineer to call open_pr again`
      : p.named ? `HQ merged the commit ${keyOf(p.ticket, p.key)}'s open_pr handed over; the ones its branch got meanwhile are tested and merged next` // Bug 184
      : `HQ merged the commit ${keyOf(p.ticket, p.key)}'s open_pr handed over, but its branch got commits meanwhile that aren't in ${baseOf(p.ticket)}, so it goes back to its engineer`
        + ' to call open_pr again'
    case 'auto.left_behind': return `${keyOf(p.ticket, p.key)} merged, but its branch got ${Number(p.commits) === 1 ? 'a commit' : `${p.commits} commits`} meanwhile that ` // Bug 184
      + `${Number(p.commits) === 1 ? "isn't" : "aren't"} in ${baseOf(p.ticket)}; its TPM was told`
    case 'ticket.merged_late': { // Bug 212: the user's Merge into main, with commits reaching the branch meanwhile
      const single = Number(p.commits) === 1, got = single ? 'a commit' : `${p.commits} commits`
      return p.merged ? `${keyOf(p.ticket, p.key)} merged, but its branch got ${got} meanwhile that ${single ? "isn't" : "aren't"} in ${baseOf(p.ticket)}; its TPM was told`
        : `HQ merged ${keyOf(p.ticket, p.key)} as it was when Merge into ${baseOf(p.ticket)} was pressed, but its branch got ${got} meanwhile: it stays ready to merge the rest`
    }
    case 'auto.repair_opened': return `HQ opened ${keyOf(p.ticket, p.key)} to fix ${baseOf(p.ticket)}`
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
