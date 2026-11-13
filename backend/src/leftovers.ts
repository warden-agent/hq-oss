// Bug 75: programs an agent's command left running in one of HQ's worktrees. Claude Code runs each Bash command in its own
// process group with no terminal; a server started with `&` (a test's, say) is orphaned when the command ends and nothing ever
// stops it: tmux kill-session doesn't reach it and removing the worktree doesn't either. They piled up while engineers worked
// (12 servers of one app, 4 GB, swap full on 2026-11-08). HQ finds them by working folder, never by name (the user's own app
// can have the same one), and stops only what nobody is using: see leftoverGroups. Servers an agent needs across commands
// use run_in_background, which keeps them its own (spike 2026-11-08). A full look is a ps and an lsof of every orphan: about
// 70 ms on a busy Mac. Bug 100: after a command ends, the look is narrowed to what can be that command's (see rootsToAsk).
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { RUN_MARK, parseRunMark, runMark } from './apprun.ts'
import { bashLimitMs, PATHS } from './config.ts'
import { q } from './db.ts'
import { bus, emit, type HqEvent } from './events.ts'
import { attention, resolveKind } from './attention.ts'
import { AGENT_TMP } from './config.ts'
import { repos } from './records.ts'
import { cwdsOf } from './procs.ts'
import { runsOf } from './bgruns.ts'
import { testRunDirs } from './testrun.ts'
import { real, sleep } from './util.ts'

export type Proc = { pid: number; ppid: number; pgid: number; uid: number; tty: string; stat: string; start: number }
const PS = 'pid=,ppid=,pgid=,uid=,tty=,stat=,etime='
/** ps's elapsed time, `[[dd-]hh:]mm:ss`, in ms. */
function elapsedMs(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') as [string, string] : ['0', etime]
  const [s = 0, m = 0, h = 0] = clock.split(':').map(Number).reverse()
  return (((Number(days) * 24 + h) * 60 + m) * 60 + s) * 1000
}
/** `ps -axo` with the fields of PS: fixed ones only (macOS's comm is a path and can hold spaces). `start` is when the process
 *  began, from its elapsed time (whole seconds, so up to a second late; `now` when ps doesn't say). */
export const parsePs = (s: string, now = Date.now()): Proc[] => s.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 7 && Number(f[0]) > 0)
  .map(([pid, ppid, pgid, uid, tty, stat, etime]) => { const ms = elapsedMs(etime!)
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid), tty: tty!, stat: stat!, start: Number.isFinite(ms) ? now - ms : now } })
const noTty = (p: Proc): boolean => /^\?+$/.test(p.tty) // macOS shows ??, Linux ?
const zombie = (p: Proc): boolean => p.stat.startsWith('Z')

/** Which folders count: under a repo's `.claude/worktrees/`, a ticket's worktree, a Launch helper's or a test run's, unless its
 *  owner is using it right now (`skip`). Any other name there is the user's own (`claude --worktree` puts its folders there too).
 *  `busy`: folders whose agent has a Bash command running, and when the oldest of those began.
 *  `app`: the folder the live preview runs in (Try it on a ticket), with when it began starting and when it answered. */
/*  `only`: just `names` count (a narrowed look, agentDirs), not every Launch helper's or test run's folder too. */
export type HqDirs = { root: string; names: Set<string>; skip: Set<string>; busy?: Map<string, number>; app?: Map<string, [number, number]>; only?: boolean }[]
export function inHq(dirs: HqDirs, cwd: string): { name: string; busy: number; app: [number, number] | null } | null {
  for (const d of dirs) {
    if (!cwd.startsWith(d.root + path.sep)) continue
    const name = cwd.slice(d.root.length + 1).split(path.sep)[0]!
    if (d.skip.has(name) || !(d.names.has(name) || (!d.only && /^(launch|hq-test)-/.test(name)))) continue
    return { name, busy: d.busy?.get(name) ?? 0, app: d.app?.get(name) ?? null }
  }
  return null
}
/** ps gives start times in whole seconds: an orphan that began within this long before a command did may be that command's. */
const SLACK_MS = 2000

/** The process groups that are leftovers, and what's in them. A leftover is a process orphaned to init (its parent gone) with no
 *  terminal, working in one of HQ's folders, plus everything it started. Spared: anything with a terminal in its tree (the
 *  user's shells, tmux panes and so the live preview, tmux itself), HQ's own process and group, a group with any member that
 *  isn't a leftover (a command still running shares its group with what it started: that's stopped once the command ends),
 *  where a command is running, an orphan no older than it (a daemon the command started, in a group of its own), and, where
 *  the live preview runs, an orphan that began while the app was starting (a database the app put in the background, say: it
 *  has no terminal either). The preview's folder as a whole isn't spared: its engineer may be working there too (a revise
 *  round), and what its test runs leave would pile up for as long as the preview stays on. Zombies are gone. */
export type Leftover = { pgid: number; pids: number[]; folder: string }
/** `runs`: orphans known to be what a preview run that is over left behind (runLeftovers), whatever folder they work in, with the project's name. */
export function leftoverGroups(procs: Proc[], cwds: Map<number, string>, dirs: HqDirs, self: number, runs = new Map<number, string>()): Leftover[] {
  const live = procs.filter((p) => !zombie(p)), kids = new Map<number, Proc[]>(), selfGroup = live.find((p) => p.pid === self)?.pgid ?? -1
  for (const p of live) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  const left = new Map<number, string>() // pid → the HQ folder its orphaned ancestor works in
  for (const r of live) {
    if (r.ppid !== 1 || r.pgid <= 1 || !noTty(r)) continue
    const cwd = cwds.get(r.pid), at = cwd ? inHq(dirs, cwd) : null, run = runs.get(r.pid)
    if (!run && (!at || (at.busy && r.start >= at.busy - SLACK_MS) || (at.app && r.start >= at.app[0] - SLACK_MS && r.start <= at.app[1] + SLACK_MS))) continue
    const tree: Proc[] = []; const todo = [r]
    while (todo.length) { const p = todo.pop()!; tree.push(p); todo.push(...(kids.get(p.pid) ?? [])) }
    if (tree.some((p) => !noTty(p) || p.pid === self || p.pgid === selfGroup || p.pgid <= 1)) continue
    for (const p of tree) left.set(p.pid, run ?? at!.name)
  }
  const groups = [...new Set(live.filter((p) => left.has(p.pid)).map((p) => p.pgid))].filter((g) => live.every((p) => p.pgid !== g || left.has(p.pid)))
  return groups.map((g) => { const pids = live.filter((p) => p.pgid === g).map((p) => p.pid); return { pgid: g, pids, folder: left.get(pids[0]!)! } })
}

type Ran = { ok: boolean; out: string; missing: boolean }
const exec = (cmd: string, args: string[]): Promise<Ran> => new Promise((resolve) => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
  resolve({ ok: !err, out: String(stdout ?? ''), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' }))) // lsof exits 1 when a pid is gone
/** The orphans whose working folder a look asks lsof for: no terminal, parent gone. `since` (a narrowed look, Bug 100): only
 *  those that began after a command did (less ps's slack), the only ones that command can have left. Most of the time none. */
export function rootsToAsk(procs: Proc[], since?: number): number[] {
  return procs.filter((p) => p.ppid === 1 && noTty(p) && !zombie(p) && (since === undefined || p.start >= since - SLACK_MS)).map((p) => p.pid)
}
/** This user's processes, and the working folders of those that could be leftovers. Null: HQ can't look. HQ's own folder is
 *  asked for too: an lsof that doesn't give it isn't working, and every look would quietly find nothing. A narrowed look
 *  (`since`) with no orphan to ask about doesn't run lsof at all, and leaves raising the alert to the full look. */
async function look(since?: number): Promise<{ procs: Proc[]; cwds: Map<number, string> } | null> {
  const narrow = since !== undefined, cant = (why: string) => { if (!narrow) cantCheck(why); return null }
  const ps = await exec('ps', ['-axo', PS])
  const uid = process.getuid?.() ?? -1, procs = parsePs(ps.out).filter((p) => p.uid === uid)
  if (!procs.length) return cant(ps.missing ? "`ps` isn't installed" : '`ps` listed no programs')
  const roots = rootsToAsk(procs, since); if (narrow && !roots.length) return { procs, cwds: new Map() }
  const lsof = await exec('lsof', ['-a', '-d', 'cwd', '-p', [...roots, process.pid].join(','), '-Fpn'])
  const cwds = cwdsOf(lsof.out)
  if (!cwds.has(process.pid)) return cant(lsof.missing ? "`lsof` isn't installed (on Linux: `sudo apt install lsof`)" : "`lsof` didn't answer")
  return { procs, cwds }
}
const CANT = 'leftovers_cant_check', STUCK = 'leftovers_stuck'
function cantCheck(why: string): void {
  attention(CANT, `HQ can't look for programs that agents' commands left running: ${why}. It tries again every minute.`)
}

// Bug 77: what a preview run left behind. On main the app runs in the project's own folder, where the user's programs work too, so the folder alone says
// nothing. Every program a run starts inherits the run's mark in its environment (apprun.ts runMark). The app's supervisor stops what it can see when the app
// ends (supervise.mjs); what had already lost its parent by then (a daemon), or outlived a supervisor that was killed, is found here: an orphan with no
// terminal that carries the mark of a run that is over and works in that run's project. Not found: a program that wipes its own environment (PostgreSQL), one
// of macOS's own binaries (/bin/sh, say: the system hides their environment), and one that moved to another folder (shared daemons do; they aren't the app's alone).
const HOME = real(PATHS.home), HQ_ID = parseRunMark(runMark(HOME, 'x', 0))!.hq
/** The mark of this HQ's run of `repoId`'s app that began at `startedAt`. */
export const markFor = (repoId: string, startedAt: number): string => runMark(HOME, repoId, startedAt)
const starting = new Set<string>(), over = new Set<string>()
/** preview.ts, around a start: the run exists before its row says so. */
export function runStarting(mark: string, on: boolean): void { if (on) starting.add(mark); else starting.delete(mark) }
/** preview.ts, as it stops a run: its row still says running until the stop is through. */
export function runOver(mark: string): void { over.add(mark); if (over.size > 200) over.delete(over.values().next().value!) }
export type Run = { name: string; roots: string[]; live: string | null }
/** Each project's folder (by both names when it's a link) and the mark of its run that is on now. */
function previewRuns(): Map<string, Run> {
  const rows = new Map(q<{ id: string; status: string; started_at: number | null }>('SELECT id, status, started_at FROM previews').map((p) => [p.id, p]))
  return new Map(repos().map((r) => {
    const p = rows.get(r.id), mark = p?.started_at && ['starting', 'running'].includes(p.status) ? markFor(r.id, p.started_at) : null
    return [r.id, { name: path.basename(r.path), roots: [...new Set([real(r.path), r.path])], live: mark && !over.has(mark) ? mark : null }]
  }))
}
const within = (cwd: string | undefined, r: Run): boolean => !!cwd && r.roots.some((d) => cwd === d || cwd.startsWith(d + path.sep))
/** The orphans that could be what a run left: no terminal, working in a project's folder. Each with everything under it. */
export function runCandidates(procs: Proc[], cwds: Map<number, string>, runs: Map<string, Run>): Map<number, number[]> {
  const live = procs.filter((p) => !zombie(p)), kids = new Map<number, Proc[]>(), out = new Map<number, number[]>()
  for (const p of live) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  for (const r of live) {
    if (r.ppid !== 1 || r.pgid <= 1 || !noTty(r) || ![...runs.values()].some((x) => within(cwds.get(r.pid), x))) continue
    const tree: number[] = [], todo = [r]
    while (todo.length) { const p = todo.pop()!; tree.push(p.pid); todo.push(...(kids.get(p.pid) ?? [])) }
    out.set(r.pid, tree)
  }
  return out
}
/** Which of them are: something in the tree carries the mark of a run of this HQ that is over, the orphan works in that run's project, and nothing in the tree
 *  carries a run's that is on. Anywhere in the tree, because a mark is inherited: a marked child means its parent had it too, shown or not (a `/bin/sh -c`
 *  wrapper's isn't, on a Mac). The answer is pid → the project's folder name. */
export function runsLeft(cands: Map<number, number[]>, cwds: Map<number, string>, runs: Map<string, Run>, marks: Map<number, string>, begun: Set<string> = starting): Map<number, string> {
  const out = new Map<number, string>()
  for (const [root, tree] of cands) {
    const found = tree.flatMap((pid) => marks.get(pid) ?? []).flatMap((mark) => { const m = parseRunMark(mark); return m?.hq === HQ_ID ? [{ mark, run: runs.get(m.repoId) }] : [] })
    if (found.some((x) => begun.has(x.mark) || x.run?.live === x.mark)) continue
    const r = found.find((x) => x.run && within(cwds.get(root), x.run))?.run; if (r) out.set(root, r.name)
  }
  return out
}
/** The run marks these processes carry: from /proc on Linux, from ps on a Mac. */
export async function marksOf(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>(), find = (pid: number, env: string) => { const m = new RegExp(`(?:^|[ \\0])${RUN_MARK}=([^ \\0]+)`).exec(env); if (m) out.set(pid, m[1]!) }
  if (!pids.length) return out
  if (process.platform === 'linux') { for (const pid of pids) { try { find(pid, fs.readFileSync(`/proc/${pid}/environ`, 'utf8')) } catch { /* gone, or not readable */ } } return out }
  for (const l of (await exec('ps', ['-Eww', '-o', 'pid=,command=', '-p', pids.join(',')])).out.split('\n')) { const pid = Number(/^\s*(\d+)\s/.exec(l)?.[1]); if (pid) find(pid, l) }
  return out
}
/** Orphans that a preview run which is over left behind. Only those working in a project's folder are asked for their mark, so most looks ask nobody. */
async function runLeftovers(l: { procs: Proc[]; cwds: Map<number, string> }): Promise<Map<number, string>> {
  const runs = previewRuns(), cands = runCandidates(l.procs, l.cwds, runs)
  return cands.size ? runsLeft(cands, l.cwds, runs, await marksOf([...cands.values()].flat())) : new Map()
}

/** Bash commands under way, per agent. What a command starts is its own until it ends, even a daemon orphaned in a group of
 *  its own, so in its agent's worktree an orphan no older than the oldest command still running waits; older ones don't.
 *  Memory only. A command whose end never arrives (HQ refused it after its PreToolUse, a lost hook) stops counting when its
 *  own time limit has passed and when its agent's turn ends, so a miscount never puts a clean-up off for long. */
type Cmd = { use: string; at: number; until: number; sub: boolean }
const inFlight = new Map<string, Cmd[]>()
const running = (agentId: string, t: number): Cmd[] => (inFlight.get(agentId) ?? []).filter((c) => c.until > t)
/** A PreToolUse:Bash hook's payload: the tool-use id, the command's own time limit (ms) and whether a subagent ran it. */
export function bashBegan(agentId: string, p: { use?: unknown; timeout?: unknown; sub?: unknown }, t = Date.now()): void {
  const use = String(p.use ?? '') // told twice about one command (it waited its turn, heavy.ts): it began the second time
  inFlight.set(agentId, [...running(agentId, t).filter((c) => !use || c.use !== use), { use, at: t, until: t + bashLimitMs(p.timeout) + 15_000, sub: !!p.sub }])
}
/** `use`: the command that ended (with no id, the oldest). `turn`: the agent's own turn ended, so its own commands all have.
 *  Returns when the earliest command that ended began (null: none HQ knew of was running). */
export function bashEnded(agentId: string, o: { use?: unknown; turn?: boolean }, t = Date.now()): number | null {
  const cmds = running(agentId, t), use = String(o.use ?? ''), first = (xs: Cmd[]) => xs.length ? Math.min(...xs.map((c) => c.at)) : null
  if (o.turn) { inFlight.set(agentId, cmds.filter((c) => c.sub)); return first(cmds.filter((c) => !c.sub)) }
  const i = cmds.findIndex((c) => c.use === use)
  const done = i >= 0 || (!use && cmds.length) ? cmds.splice(Math.max(i, 0), 1) : []
  inFlight.set(agentId, cmds)
  return first(done)
}
/** When the oldest command `agentId` still has running began; 0 when it has none. A run it waits on in the background counts (Bug 96, bgruns.ts): its turn
 *  has ended, but what it starts is its own until it ends too. */
export function busySince(agentId: string, t = Date.now()): number {
  const at = [...running(agentId, t), ...runsOf(agentId)].map((c) => c.at); return at.length ? Math.min(...at) : 0
}
/** Repos just removed from HQ: their folders still count for a while, for what their stopped agents leave as they exit. */
const gone: { until: number; dirs: HqDirs }[] = []

/** The folders of every repo HQ knows (or `only`), minus those in use: a Launch helper's worktree while it works, a test run's.
 *  A ticket whose agent has a command running is `busy` since that command began; the one the preview runs in is its `app`. */
export function hqDirs(only?: string): HqDirs {
  const runs = new Set(testRunDirs().map((d) => path.basename(d)))
  return repos().filter((r) => !only || r.id === only).map((r) => {
    const raw = path.join(r.path, '.claude', 'worktrees'), names = new Set<string>(), skip = new Set(runs), busy = new Map<string, number>()
    const app = new Map<string, [number, number]>()
    const tks = q<{ worktree_path: string; agent_id: string | null }>(`SELECT t.worktree_path, a.id AS agent_id FROM tickets t JOIN features f ON f.id = t.feature_id
      LEFT JOIN agents a ON a.ticket_id = t.id AND a.status != 'exited' WHERE f.repo_id = ? AND t.worktree_path IS NOT NULL`, r.id)
    for (const t of tks) if (path.dirname(t.worktree_path) === raw) {
      const name = path.basename(t.worktree_path), since = t.agent_id ? busySince(t.agent_id) : 0
      names.add(name); if (since) busy.set(name, Math.min(since, busy.get(name) ?? since))
    }
    type Pv = { wt: string | null; helper: string | null; status: string; started_at: number | null; updated_at: number }
    const p = q<Pv>(`SELECT t.worktree_path AS wt, p.helper_worktree AS helper, p.status, p.started_at, p.updated_at FROM previews p
      LEFT JOIN tickets t ON t.id = p.ticket_id AND p.status IN ('starting', 'running') WHERE p.id = ?`, r.id)[0]
    if (p?.helper) skip.add(path.basename(p.helper))
    // a running preview's row was last written when the app answered (or later: that only spares more). A run being stopped
    // spares nothing: what it started is a leftover now (its row still says running until the stop is through, Bug 100)
    if (p?.wt && !(p.started_at && over.has(markFor(r.id, p.started_at)))) app.set(path.basename(p.wt), [p.started_at ?? 0, p.status === 'starting' ? Infinity : p.updated_at])
    const root = path.join(real(r.path), '.claude', 'worktrees') // lsof gives folders with their links resolved (/tmp is /private/tmp on a Mac)
    return [{ root, names, skip, busy, app }, ...(root === raw ? [] : [{ root: raw, names, skip, busy, app }])]
  }).flat()
}
/** Bug 100: the folders a narrowed look covers, the worktrees of these agents' tickets (none for a TPM: it has no worktree). */
export function agentDirs(agentIds: string[]): HqDirs {
  if (!agentIds.length) return []
  const rows = q<{ repo_id: string; wt: string }>(`SELECT f.repo_id, t.worktree_path AS wt FROM agents a JOIN tickets t ON t.id = a.ticket_id
    JOIN features f ON f.id = t.feature_id WHERE a.id IN (${agentIds.map(() => '?').join(',')}) AND t.worktree_path IS NOT NULL`, ...agentIds)
  return [...new Set(rows.map((r) => r.repo_id))].flatMap((repoId) => {
    const mine = new Set(rows.filter((r) => r.repo_id === repoId).map((r) => path.basename(r.wt)))
    return hqDirs(repoId).map((d) => ({ ...d, names: new Set([...d.names].filter((n) => mine.has(n))), only: true })).filter((d) => d.names.size)
  })
}
/** Remove from HQ calls this just before HQ forgets the repo. */
export function rememberGone(repoId: string, ms = 120_000): void { // its agents are all stopped: nothing there is in use
  gone.push({ until: Date.now() + ms, dirs: hqDirs(repoId).map((d) => ({ root: d.root, names: d.names, skip: new Set<string>() })) })
}

/** One look and clean-up: SIGTERM each leftover group, a fresh look after 2 s, SIGKILL what's still a leftover (a fresh look
 *  means a reused pid is never hit), and an alert if anything outlives that. `dirs` for tests. `narrow` (Bug 100): the look after
 *  a command, only at orphans that began since `since` in these agents' worktrees and not at preview runs' leftovers. It sees too
 *  little to raise or clear the alerts: the full look (every minute, and wherever HQ stops or removes something) does that. */
export async function stopLeftovers(dirs?: HqDirs, narrow?: { since: number; agents: string[] }): Promise<{ stopped: Leftover[]; stuck: Leftover[] }> {
  const where = narrow ? agentDirs(narrow.agents) : dirs; if (narrow && !where?.length) return { stopped: [], stuck: [] }
  const scan = async (only?: Leftover[]) => {
    for (let i = gone.length - 1; i >= 0; i--) if (gone[i]!.until < Date.now()) gone.splice(i, 1)
    const l = await look(narrow?.since); if (!l) return null
    if (narrow && !l.cwds.size) return []
    const runs = narrow ? new Map<number, string>() : await runLeftovers(l)
    const found = leftoverGroups(l.procs, l.cwds, where ?? [...hqDirs(), ...gone.flatMap((g) => g.dirs)], process.pid, runs)
    return only ? found.filter((x) => only.some((o) => o.pgid === x.pgid)) : found
  }
  const first = await scan(); if (!first) return { stopped: [], stuck: [] }
  if (!narrow) resolveKind(CANT, null)
  if (!first.length) { if (!narrow) resolveKind(STUCK, null); return { stopped: [], stuck: [] } }
  const signal = (xs: Leftover[], sig: NodeJS.Signals) => { for (const x of xs) if (x.pgid > 1) try { process.kill(-x.pgid, sig) } catch { /* gone */ } } // never kill(-1)
  signal(first, 'SIGTERM'); await sleep(2000)
  const still = await scan(first) ?? []
  signal(still, 'SIGKILL'); const stuck = still.length ? (await sleep(1000), await scan(still) ?? []) : []
  emit({ agentId: null, source: 'system', kind: 'procs.leftovers_stopped', payload: { stopped: first, killed: still.map((x) => x.pgid), stuck: stuck.map((x) => x.pgid) } })
  if (narrow) return { stopped: first, stuck }
  if (stuck.length) {
    const pids = stuck.flatMap((x) => x.pids), folders = [...new Set(stuck.map((x) => x.folder))].join(', ')
    attention(STUCK, `HQ couldn't stop ${pids.length} program${pids.length === 1 ? '' : 's'} left running in ${folders} (pid ${pids.slice(0, 6).join(', ')}). `
      + 'It tries again every minute; restarting the Mac clears them.', { keep: true })
  } else resolveKind(STUCK, null)
  return { stopped: first, stuck }
}

let going: Promise<unknown> | null = null
/** One look at a time: two would signal the same groups. */
async function serial(job: () => Promise<unknown>): Promise<void> {
  while (going) await going.catch(() => {})
  going = job().catch((e) => emit({ agentId: null, source: 'system', kind: 'procs.leftovers_error', payload: { error: String(e) } }))
  try { await going } finally { going = null }
}
/** A fresh look now. Callers about to remove a worktree await it; one already under way may have looked before their agents
 *  stopped, so this waits for it and then looks again. */
export const sweepNow = (): Promise<void> => serial(() => stopLeftovers())
/** Bug 81: an agent's own temp folder goes once the agent has, and with it whatever its killed test runs left there. Which folders
 *  are whose is read in one go, so an agent launching meanwhile (its folder and its row come together) is never taken for gone. A
 *  /clear's SessionEnd doesn't make an agent exited (hooks.ts), so a live one's folder is never taken either. */
export async function sweepAgentTmp(): Promise<string[]> {
  const dir = path.dirname(AGENT_TMP), pre = path.basename(AGENT_TMP)
  let names: string[]; try { names = fs.readdirSync(dir).filter((d) => d.startsWith(pre)) } catch { return [] }
  const live = new Set(q<{ id: string }>("SELECT id FROM agents WHERE status != 'exited'").map((a) => a.id))
  const ours = (d: string) => { try { return fs.lstatSync(path.join(dir, d)).uid === process.getuid?.() } catch { return false } } // /tmp is everyone's
  const gone = names.filter((d) => !live.has(d.slice(pre.length)) && ours(d))
  for (const d of gone) await fs.promises.rm(path.join(dir, d), { recursive: true, force: true }).catch(() => {})
  if (gone.length) emit({ agentId: null, source: 'system', kind: 'agent.tmp_removed', payload: { agents: gone.map((d) => d.slice(pre.length)) } })
  return gone.map((d) => d.slice(pre.length))
}
/** One look 2 s after the last call, and no later than 6 s after the first (several agents' commands can end one after another
 *  without a 2 s gap for as long as they work). */
function debounced(fire: () => void, ms = 2000): () => void {
  let soon: NodeJS.Timeout | null = null, by = 0
  return () => {
    const t = Date.now(); if (soon) clearTimeout(soon); else by = t + 3 * ms
    soon = setTimeout(() => { soon = null; fire() }, Math.max(0, Math.min(ms, by - t))); soon.unref()
  }
}
/** A full look, soon. */
export const sweepSoon = debounced(() => void sweepNow())
/** Bug 100: after a command ends, a look at what it can have left: orphans that began since it did (`since`; 0 when HQ didn't
 *  hear it begin), in its agent's worktree. Several agents' calls in one burst share one look, from the earliest `since`. */
const after = new Map<string, number>()
const narrowSoon = debounced(() => {
  const agents = [...after.keys()], since = Math.min(...after.values()); after.clear()
  void serial(() => stopLeftovers(undefined, { since, agents }))
})
export function sweepAfter(agentId: string, since: number): void {
  if (!agentId) return
  after.set(agentId, Math.min(since, after.get(agentId) ?? since)); narrowSoon()
}

let started = false
/** A narrowed look at every Bash command's end and every turn's end that ends commands (Bug 100); a full one when an agent has
 *  gone (5 s later: Claude Code may still be exiting, and until it has, what it started still has a live parent), when a run in
 *  the background ends, and once a minute in case anything was missed (a command whose end never came, say). */
export function startLeftoverSweeps(): void {
  if (started) return
  started = true
  const at = (e: HqEvent) => e.agentId ?? ''
  bus.on('event:hook.PreToolUse:Bash', (e: HqEvent) => bashBegan(at(e), e.payload))
  bus.on('event:turns.started', (e: HqEvent) => { if (e.agentId) bashBegan(e.agentId, e.payload) }) // held until its turn came: it begins now
  const ended = (e: HqEvent) => sweepAfter(at(e), bashEnded(at(e), { use: e.payload.use }) ?? 0)
  bus.on('event:hook.PostToolUse:Bash', ended); bus.on('event:hook.PostToolUseFailure:Bash', ended)
  bus.on('event:hook.Stop', (e: HqEvent) => { // a turn that ends with no command running ended none: nothing new can be left
    if (e.payload.sub) return
    const since = bashEnded(at(e), { turn: true }); if (since !== null) sweepAfter(at(e), since)
  })
  bus.on('event:bg.ended', () => sweepSoon()) // a run in the background ended (Bug 96): what it started is no one's now
  const exited = (e: HqEvent) => { if (e.payload.reason === 'clear') return; inFlight.delete(at(e)); setTimeout(() => sweepSoon(), 5000).unref() }
  for (const k of ['agent.stopped', 'agent.lost', 'hook.SessionEnd']) bus.on(`event:${k}`, exited)
  for (const k of ['agent.stopped', 'agent.lost', 'hook.SessionEnd']) bus.on(`event:${k}`, () => void setTimeout(() => void sweepAgentTmp(), 5000).unref())
  setInterval(() => { void sweepNow(); void sweepAgentTmp() }, 60_000).unref()
}
