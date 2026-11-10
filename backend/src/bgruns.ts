// Bugs 95/96: Bash commands an agent waits on in the background. In Claude Code 2.1.300 a command that hits its `timeout` isn't stopped: it moves to the
// background, and the agent is woken only by a <task-notification> once it exits (spike 2026-11-10, bgspike.sh). On 2026-11-09 a test run froze that way
// (a real one, 0% CPU for 20 minutes): its engineer would have waited forever, and HQ showed it idle. Now HQ keeps the runs each agent waits on. The agent is
// working while one runs, and a run that uses no CPU and writes nothing for `bg_stall_min` minutes is frozen: a notice with Stop it and tell the engineer,
// which HQ presses itself on auto. Watched: a command that went to the background without being asked (a timeout, or moved to let a message through), and a
// test run or build the agent put there itself. A server it started with run_in_background is its own business: quiet for hours, and that's fine.
// The list is in memory and in the events log (bg.started / bg.ended), so a backend restart in the middle of a wait reads it back.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { agentTmpDir, DEFAULTS } from './config.ts'
import { getSetting, now, one, q } from './db.ts'
import { bus, emit, patch, type HqEvent } from './events.ts'
import { getAgent, liveAgents, type Agent } from './agents.ts'
import { resolveKind } from './attention.ts'
import { sendMessage } from './delivery.ts'
import { heavyKind } from './heavy.ts'
import { getRepo, repoOfAgent, type Ticket } from './records.ts'
import * as tmux from './tmux.ts'
import { sleep } from './util.ts'

export type BgRun = { task: string; use: string; command: string; at: number; cpu: number; bytes: number; quietSince: number; missed: number }
const runs = new Map<string, Map<string, BgRun>>()
const mine = (agentId: string): Map<string, BgRun> => { let m = runs.get(agentId); if (!m) runs.set(agentId, m = new Map()); return m }
export const runsOf = (agentId: string): BgRun[] => [...(runs.get(agentId)?.values() ?? [])]
export const hasRuns = (agentId: string): boolean => !!runs.get(agentId)?.size
const cut = (s: string, n: number): string => s.length > n ? s.slice(0, n) + '…' : s
/** What the agent's box says while it waits. */
export function waitingText(agentId: string): string | null {
  const rs = runsOf(agentId); return rs.length ? `Waiting on: ${cut(rs.at(-1)!.command, 60)}${rs.length > 1 ? ` (+${rs.length - 1} more)` : ''}` : null
}
/** A command kept running and watched: --watch modes and dev servers never end by themselves, so they don't count even as tests or builds. */
const WATCH = /(?:^|\s)(?:--watch(?:All)?(?:=(?!false|0)\S*)?|-w|watch|dev|serve|preview)(?=\s|$)/
/** The background task a Bash call's PostToolUse says it left running, if HQ should watch it. */
export function watchedTask(input: Record<string, unknown>, resp: unknown, testCmd: string | null): string | null {
  const task = (resp as { backgroundTaskId?: unknown } | null)?.backgroundTaskId; if (typeof task !== 'string' || !task) return null
  if (input.run_in_background !== true) return task // it was meant to finish: a timeout, or moved so a message could reach the agent
  const cmd = String(input.command ?? ''); return heavyKind(cmd, testCmd) && !WATCH.test(cmd) ? task : null
}

/** When each Bash command began: its PreToolUse, or when its turn came (heavy.ts). A run is matched to its process by this time. */
const began = new Map<string, number>()
export function addRun(agentId: string, r: { task: string; use: string; command: string; at?: number }): void {
  const at = r.at ?? began.get(`${agentId}:${r.use}`) ?? now(); began.delete(`${agentId}:${r.use}`)
  mine(agentId).set(r.task, { task: r.task, use: r.use, command: r.command, at, cpu: -1, bytes: -1, quietSince: now(), missed: 0 })
  emit({ agentId, source: 'system', kind: 'bg.started', payload: { task: r.task, use: r.use, command: r.command.slice(0, 300), at } })
}
/** `tasks`: the ones that ended, or all of the agent's. */
export function endRuns(agentId: string, tasks: string[] | 'all', why: string): void {
  const m = runs.get(agentId); if (!m) return
  for (const task of tasks === 'all' ? [...m.keys()] : tasks) if (m.delete(task)) emit({ agentId, source: 'system', kind: 'bg.ended', payload: { task, why } })
  if (!m.size) runs.delete(agentId)
}
/** After a restart: each live agent's runs from the events log, since its session last began. */
export function rebuildRuns(): void {
  runs.clear()
  for (const a of liveAgents()) {
    const since = one<{ id: number }>("SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND kind = 'hook.SessionStart'", a.id)?.id ?? 0
    for (const e of q<{ kind: string; payload: string }>("SELECT kind, payload FROM events WHERE agent_id = ? AND id > ? AND kind IN ('bg.started', 'bg.ended') ORDER BY id", a.id, since)) {
      const p = JSON.parse(e.payload) as { task: string; use: string; command: string; at: number }
      if (e.kind === 'bg.ended') { runs.get(a.id)?.delete(p.task); continue }
      mine(a.id).set(p.task, { task: p.task, use: p.use, command: p.command, at: p.at, cpu: -1, bytes: -1, quietSince: now(), missed: 0 })
    }
    if (!runs.get(a.id)?.size) runs.delete(a.id)
  }
}

// ---- the processes ----
export type PsRow = { pid: number; ppid: number; pgid: number; start: number; cpu: number }
/** ps's `[[dd-]hh:]mm:ss[.cc]` (elapsed or CPU time) in ms. */
export function clockMs(s: string): number {
  const [days, clock] = s.includes('-') ? s.split('-') as [string, string] : ['0', s]
  const [sec = 0, min = 0, h = 0] = clock.split(':').map(Number).reverse()
  return Math.round((((Number(days) * 24 + h) * 60 + min) * 60 + sec) * 1000)
}
export const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,etime=,time=']
export const parseRows = (s: string, t = Date.now()): PsRow[] => s.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 5 && Number(f[0]) > 0)
  .map(([pid, ppid, pgid, etime, time]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), start: t - clockMs(etime!), cpu: clockMs(time!) }))
/** ps gives start times in whole seconds. */
const SLACK_MS = 2000
/** The process group a run's command is, under the agent's Claude Code: Claude Code starts each command as a shell in a process group of its own, a child of
 *  itself, the second its PreToolUse is answered. `pane` is the agent's tmux pane: Claude Code itself (launch.sh execs it) or a wrapper around it, and either
 *  way the pane's process group is Claude Code's side. Never by name. With the CPU time of everything under the command. */
export function groupOf(rows: PsRow[], pane: number, run: Pick<BgRun, 'at'>): { pgid: number; cpu: number } | null {
  const pg = new Map(rows.map((r) => [r.pid, r.pgid])), own = pg.get(pane); if (own === undefined || own <= 1) return null
  const lead = rows.filter((r) => r.pid === r.pgid && r.pgid !== own && pg.get(r.ppid) === own && Math.abs(r.start - run.at) <= SLACK_MS)
    .sort((a, b) => Math.abs(a.start - run.at) - Math.abs(b.start - run.at))[0]
  if (!lead) return null
  const kids = new Map<number, PsRow[]>(); for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r])
  let cpu = 0; const todo = [lead]; while (todo.length) { const p = todo.pop()!; cpu += p.cpu; todo.push(...(kids.get(p.pid) ?? [])) }
  return { pgid: lead.pgid, cpu }
}
/** The size of the file Claude Code writes the run's output to: <CLAUDE_CODE_TMPDIR>/claude-<uid>/<its folder>/<session>/tasks/<task>.output. -1: none. */
export function outputBytes(a: Pick<Agent, 'id' | 'claude_session_id'>, task: string): number {
  const base = path.join(agentTmpDir(a.id), `claude-${process.getuid?.() ?? 0}`); let dirs: string[] = []
  try { dirs = fs.readdirSync(base) } catch { return -1 }
  for (const d of dirs) { try { return fs.statSync(path.join(base, d, a.claude_session_id ?? '', 'tasks', `${task}.output`)).size } catch { /* not this one */ } }
  return -1
}
const ps = (): Promise<PsRow[]> => new Promise((resolve) => execFile('ps', PS_ARGS, { maxBuffer: 16 * 1024 * 1024 }, (_e, out) => resolve(parseRows(String(out ?? '')))))

/** CPU time a run must use, or output it must write, to count as moving: a frozen node process still ticks a few ms now and then. */
const MOVED_CPU_MS = 1000
/** One look at a run: moved (its baseline and quiet clock start again), or how long it has done nothing. Pure, for tests. */
export function judge(r: BgRun, seen: { cpu: number; bytes: number }, t: number): number {
  if (r.cpu < 0 || seen.cpu - r.cpu >= MOVED_CPU_MS || seen.bytes > r.bytes) { r.cpu = seen.cpu; r.bytes = seen.bytes; r.quietSince = t }
  return t - r.quietSince
}
export const stallMs = (): number => Number(getSetting('bg_stall_min', DEFAULTS.bg_stall_min)) * 60_000
/** The stuck loop, each minute: the agent's runs whose process is gone on two looks in a row end (their notice was missed); the rest are judged.
 *  Returns the frozen ones, with how many minutes they've done nothing. */
export async function lookAtRuns(a: Agent, rows?: PsRow[]): Promise<{ run: BgRun; quietMin: number }[]> {
  const rs = runsOf(a.id); if (!rs.length) return []
  const pane = await tmux.panePid(a.tmux_session); if (!pane) return []
  const all = rows ?? await ps(), t = now(), frozen: { run: BgRun; quietMin: number }[] = []
  for (const r of rs) {
    const g = groupOf(all, pane, r)
    if (!g) { if (++r.missed >= 2) endRuns(a.id, [r.task], 'gone'); continue }
    r.missed = 0
    const quiet = judge(r, { cpu: g.cpu, bytes: outputBytes(a, r.task) }, t)
    if (quiet >= stallMs()) frozen.push({ run: r, quietMin: Math.round(quiet / 60_000) })
  }
  return frozen
}
/** Stops the agent's frozen runs and tells it. Claude Code then sends the agent its "failed" notice, which wakes it, and HQ's message follows as the next
 *  turn. The Stop it button, and auto mode. Never a group of HQ's own, of the agent's Claude Code, or 1. */
export async function stopFrozen(agentId: string, by: 'user' | 'auto'): Promise<{ stopped: string[] }> {
  const a = getAgent(agentId); if (!a || a.status === 'exited') throw new Error('That agent has stopped.')
  const pane = await tmux.panePid(a.tmux_session); if (!pane) throw new Error("HQ can't see that agent's terminal.")
  const rows = await ps(), t = now(), mineG = rows.find((r) => r.pid === process.pid)?.pgid, paneG = rows.find((r) => r.pid === pane)?.pgid
  const hit = runsOf(a.id).flatMap((r) => { const g = groupOf(rows, pane, r); return g && t - r.quietSince >= stallMs() ? [{ r, g: g.pgid }] : [] })
    .filter((x) => x.g > 1 && x.g !== mineG && x.g !== paneG)
  if (!hit.length) throw new Error('Nothing frozen to stop: the run has ended or is moving again.')
  const kill = (sig: NodeJS.Signals) => { for (const x of hit) try { process.kill(-x.g, sig) } catch { /* gone */ } }
  kill('SIGTERM'); await sleep(2000)
  const left = new Set((await ps()).map((r) => r.pgid)); for (const x of hit) if (left.has(x.g)) try { process.kill(-x.g, 'SIGKILL') } catch { /* gone */ }
  const minutes = Math.max(1, Math.round((t - Math.min(...hit.map((x) => x.r.quietSince))) / 60_000)), cmds = hit.map((x) => `\`${cut(x.r.command, 120)}\``).join(', ')
  const testCmd = getRepo(repoOfAgent(a) ?? '')?.test_cmd
  sendMessage({ repoId: a.repo_id, featureId: a.feature_id, channel: 'dm', from: 'hq', to: a.id, reason: 'fyi', body: `Your background run ${cmds} did nothing `
    + `for ${minutes} min (no CPU, no output), so HQ stopped it. Don't wait on a run in the background: run only the test files for what you changed, with the test `
    + "runner's force-exit and per-test time limit (for node --test: --test-force-exit --test-timeout=120000). "
    + (testCmd ? `For the full suite, run the project's test command once, just before open_pr: ${testCmd}` : "If the full suite won't finish, say so in your handoff.") })
  endRuns(a.id, hit.map((x) => x.r.task), 'stopped'); resolveKind('bg_stalled', a.id)
  if (!hasRuns(a.id)) patch('agent', a.id, { activity: 'HQ stopped its frozen run: waking it' }) // its "failed" notice comes as a new turn
  emit({ agentId: a.id, source: by === 'user' ? 'ui' : 'system', kind: 'bg.stopped', payload: { by, tasks: hit.map((x) => x.r.task), groups: hit.map((x) => x.g), minutes } })
  return { stopped: hit.map((x) => x.r.task) }
}

/** Bug 96 gap 4, and auto mode's idle engineers: an engineer that ended its turn with its ticket unfinished and has nothing on its way: no message, no run in the
 *  background. Nothing else would ever wake it. */
export function idleTooLong(t: Ticket, a: Agent | undefined): a is Agent {
  if (!['planning', 'implementing', 'resolving'].includes(t.status) || t.parked_at || t.auto_parked_why) return false
  if (!a || a.status !== 'idle' || a.fresh_start_at || hasRuns(a.id)) return false
  if (now() - (a.last_event_at ?? a.started_at) < getSetting('stuck_idle_min', DEFAULTS.stuck_idle_min) * 60_000) return false
  return !one('SELECT 1 AS x FROM messages WHERE to_id = ? AND delivered_at IS NULL', a.id)
}

let started = false
export function startBgRuns(): void {
  if (started) return
  started = true; rebuildRuns()
  const at = (e: HqEvent) => { const use = String(e.payload.use ?? ''); if (!e.agentId || !use || e.payload.sub) return
    began.set(`${e.agentId}:${use}`, e.at); if (began.size > 500) began.delete(began.keys().next().value!) } // one refused never ends
  bus.on('event:hook.PreToolUse:Bash', at); bus.on('event:turns.started', at)
  bus.on('event:hook.PostToolUse:Bash', (e: HqEvent) => { if (!e.payload.bg) began.delete(`${e.agentId}:${String(e.payload.use ?? '')}`) })
  bus.on('event:hook.PostToolUseFailure:Bash', (e: HqEvent) => began.delete(`${e.agentId}:${String(e.payload.use ?? '')}`))
  for (const k of ['agent.stopped', 'agent.lost']) bus.on(`event:${k}`, (e: HqEvent) => {
    if (!e.agentId) return; endRuns(e.agentId, 'all', k); resolveKind('bg_stalled', e.agentId); resolveKind('engineer_idle', e.agentId)
  })
}
