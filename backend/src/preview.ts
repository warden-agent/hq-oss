// Live preview: HQ runs a repo's app from its checkout (normally main) in tmux session hq-preview-<repoId> and tells the UI
// where it answers. The user starts it once; it restarts after a merge and is picked up again after a backend restart.
// Try it (Bug 22): it can run a finished ticket's worktree instead, with a copy of main's data, until the user goes back to main,
// the ticket merges or it stops waiting for the merge.
// What to run is the repo's launch recipe (worked out once by the Launch helper and OK'd by the user, or the user's own ⚙
// command); the supervisor (supervise.mjs) runs its parts in the pane. The rules (recipe, installs, ports, framing) are in apprun.ts.
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.ts'
import { one, q, run, now } from './db.ts'
import { emit, patch, type HqEvent } from './events.ts'
import { assignPorts, commandRecipe, commandWarning, detectCommand, frameBlocked, installLeftovers, PREVIEW_PORTS, portBusy, printedPorts, recipeProblem, refusedWords, runScript, supervisorSpec,
  ownInstall, type Recipe, type Refusal } from './apprun.ts'
import { groupPids, pgidOf, portHolders, whoAnswers, whose, type Holder, type Whose } from './procs.ts'
import { markFor, runOver, runStarting, sweepNow } from './leftovers.ts'
import { git } from './reposync.ts'
import { getFeature, getRepo, getTicket, repos, type Repo, notClearing } from './records.ts'
import { syncRepo } from './repos.ts'
import { shq, sleep } from './util.ts'
import { excludeLeftovers } from './worktrees.ts'
import { copyMainData, tryable } from './trydata.ts'
import { setupView } from './testsetupstore.ts'
import * as tmux from './tmux.ts'

export type PreviewStatus = 'stopped' | 'starting' | 'running' | 'crashed'
export type Preview = {
  id: string; command: string | null; status: PreviewStatus; detail: string | null; port: number | null; url: string | null
  frameable: number | null; branch: string | null; head: string | null; started_at: number | null; updated_at: number; ticket_id: string | null
  recipe: string | null; draft_recipe: string | null; helper_agent_id: string | null; helper_state: string | null; helper_note: string | null; helper_saves: number
  helper_worktree: string | null; port_holders: string | null; helper_ticket_id: string | null; helper_ports: string | null
  /** Bug 215: HQ is ending this run (kept before anything is signalled): for the user's Stop (Clear and Remove too) or to start it again. */
  stopping: Stopping | null
  /** Bug 351: the `started_at` of HQ's first run of the steps the user OK'd for the Launch helper (null until it starts), for a restart during it. */
  helper_run: number | null
}
export type Stopping = 'stop' | 'restart'
/** A program on one of the recipe's fixed ports (Bug 42), and whose it is. */
export type PortHolder = Holder & Whose & { port: number; part: string }
const COLS = ['id', 'command', 'status', 'detail', 'port', 'url', 'frameable', 'branch', 'head', 'started_at', 'updated_at', 'ticket_id',
  'recipe', 'draft_recipe', 'helper_agent_id', 'helper_state', 'helper_note', 'helper_saves', 'helper_worktree', 'port_holders', 'helper_ticket_id', 'stopping',
  'helper_ports', 'helper_run'] as const

export const previewSession = (repoId: string): string => `hq-preview-${repoId}`
export const row = (repoId: string): Preview | undefined => one<Preview>('SELECT * FROM previews WHERE id = ?', repoId)
const blank = (repoId: string): Preview => ({
  id: repoId, command: null, status: 'stopped', detail: null, port: null, url: null, frameable: null, branch: null, head: null, started_at: null, updated_at: 0,
  ticket_id: null, recipe: null, draft_recipe: null, helper_agent_id: null, helper_state: null, helper_note: null, helper_saves: 0, helper_worktree: null, port_holders: null, helper_ticket_id: null,
  stopping: null, helper_ports: null, helper_run: null,
})
/** The ports a Launch helper was given for its test runs (Bug 226); [] when it has none. */
export function helperPorts(p: Pick<Preview, 'helper_ports'> | undefined): number[] {
  try { const v: unknown = JSON.parse(p?.helper_ports ?? '[]'); return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [] } catch { return [] }
}
/** Every live Launch helper's test ports but `repoId`'s own (its run stops that helper's test servers first). */
export const helperPortsHeld = (repoId: string | null = null): number[] =>
  q<Preview>('SELECT * FROM previews WHERE helper_agent_id IS NOT NULL AND helper_ports IS NOT NULL').filter((p) => p.id !== repoId).flatMap((p) => helperPorts(p))
const parse = (json: string | null): Recipe | null => { try { return json ? JSON.parse(json) as Recipe : null } catch { return null } }
/** What Launch runs: the user's own ⚙ command, else the recipe they OK'd; null when there's neither (the Launch helper is next). */
export function runnableRecipe(p: Preview | undefined, cwd: string): Recipe | null {
  return p?.command ? commandRecipe(p.command, cwd) : parse(p?.recipe ?? null)
}
/** Thrown when there's nothing to run yet: no ⚙ command and no OK'd recipe. */
export class NeedsSetup extends Error {}
/** Thrown when the OK'd recipe's install fails today's lockfile check in this checkout (Bug 156: saved before the check, or a
 *  lockfile came or went since). `reason`: the check's words, for the helper that fixes the steps, and the lockfile it names. */
export class StepsOutdated extends Error { reason: Refusal; constructor(msg: string, reason: Refusal) { super(msg); this.reason = reason } }
/** One repo's preview as the UI sees it: the saved row (or "stopped") with its recipes parsed, and the root npm script HQ
 *  would suggest for ⚙ (a hint only: it no longer starts anything by itself). */
type PreviewView = Omit<Preview, 'recipe' | 'draft_recipe' | 'port_holders' | 'helper_ports'> & {
  recipe: Recipe | null; draft_recipe: Recipe | null; port_holders: PortHolder[] | null; auto_command: string | null; default_branch: string; path: string
  /** The ports the Launch helper was given for its test runs (Bug 226); null with no helper (or one from before). */
  helper_ports: number[] | null
  /** The Launch helper's ticket (Bug 46), by key. */
  helper_ticket_key: string | null
  /** How HQ tests this app (testsetupstore.ts), and its helper. */
  test_setup: ReturnType<typeof setupView>
  /** Bug 316: what the user's own ⚙ command would do to the lockfile, checked in the checkout it runs in; null when fine or with no command. */
  command_warning: string | null }
const holdersOf = (json: string | null): PortHolder[] | null => { try { return json ? JSON.parse(json) as PortHolder[] : null } catch { return null } }
export function previewView(repo: Repo): PreviewView {
  const p = row(repo.id) ?? blank(repo.id), t = p.ticket_id ? getTicket(p.ticket_id) : undefined, cwd = t?.worktree_path ?? repo.path
  return { ...p, recipe: parse(p.recipe), draft_recipe: parse(p.draft_recipe), port_holders: holdersOf(p.port_holders), helper_ports: p.helper_ports ? helperPorts(p) : null,
    auto_command: detectCommand(repo.path), default_branch: repo.default_branch, path: cwd,
    helper_ticket_key: p.helper_ticket_id ? getTicket(p.helper_ticket_id)?.key ?? null : null, test_setup: setupView(repo.id),
    command_warning: p.command ? commandWarning(p.command, cwd) : null }
}
/** Sends the UI the repo's preview again: something it shows besides the row changed (the test setup). */
export function repush(repoId: string): void { const repo = getRepo(repoId); if (repo) patch('preview', repoId, previewView(repo)) }
export const previews = () => repos().map(previewView)
/** Saves and sends the UI the whole row (a patch for a row the UI hasn't seen would otherwise arrive half-filled). */
export function save(repoId: string, fields: Partial<Preview>): void {
  if (!getRepo(repoId)) return // removed from HQ while something was on its way: it would come back as a row with no project
  const next: Preview = { ...(row(repoId) ?? blank(repoId)), ...fields, updated_at: now() }
  run(`INSERT OR REPLACE INTO previews(${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(',')})`, ...COLS.map((k) => next[k]))
  const repo = getRepo(repoId); if (repo) patch('preview', repoId, previewView(repo))
}

// One start/stop (or Launch helper start) at a time per repo, so two quick clicks can't start the app, or a helper, twice.
const queue = new Map<string, Promise<unknown>>()
export function serial<T>(repoId: string, job: () => Promise<T>): Promise<T> {
  const p = (queue.get(repoId) ?? Promise.resolve()).then(job, job)
  queue.set(repoId, p.catch(() => {})); return p
}

/** Is there an HTTP reply on this port, and may HQ show it in a frame? */
async function probe(port: number): Promise<{ frameable: boolean } | null> {
  try {
    const r = await fetch(`http://localhost:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
    void r.body?.cancel().catch(() => {})
    return { frameable: !frameBlocked((n) => r.headers.get(n)) }
  } catch { return null }
}
async function waitFor(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) { if (await cond()) return true; if (Date.now() > end) return false; await sleep(100) }
}

const watchers = new Map<string, NodeJS.Timeout>()
const unwatch = (repoId: string) => { clearTimeout(watchers.get(repoId)); watchers.delete(repoId) }
/** Every 1s while starting (until it answers), then every 5s: a dead pane means it crashed. Its own port first; ports the
 *  app printed count after 3s, for apps that pick their own (Vite). */
function watch(repoId: string, since: number, done: string | null): void {
  unwatch(repoId)
  const session = previewSession(repoId)
  const tick = async () => {
    const cur = row(repoId); if (!cur || (cur.started_at ?? 0) !== since || cur.status === 'stopped' || cur.status === 'crashed') return unwatch(repoId)
    const tried = cur.ticket_id ? getTicket(cur.ticket_id) : undefined
    if (cur.ticket_id && tried?.status !== 'merged' && !tryable(tried)) { // cancelled, sent to Fix conflicts…: back to main (a merge restarts it anyway)
      unwatch(repoId); void startPreview(repoId, `back on main: ${tried?.key ?? 'the ticket'} isn't waiting to be merged any more`, { ticket: null }).catch(() => {}); return
    }
    const has = await tmux.hasSession(session), code = has ? await tmux.paneDeadStatus(session) : null
    if (row(repoId)?.stopping) return unwatch(repoId) // Bug 215: HQ ended it meanwhile (Stop, a restart): that end is no crash
    if (!has) { save(repoId, { status: 'stopped', detail: 'its tmux session is gone', url: null }); void sweepNow(); return unwatch(repoId) }
    if (code !== null) {
      save(repoId, { status: 'crashed', detail: `stopped with code ${code}` })
      emit({ agentId: null, source: 'system', kind: 'preview.crashed', payload: { repo: repoId, code, ...stopReport(repoId, since) } })
      void sweepNow(); return unwatch(repoId) // the run is over: what it left with no parent goes too (Bug 77)
    }
    if (cur.status === 'starting') {
      const r = cur.command ? null : parse(cur.recipe), tag = r && r.parts.length > 1 ? r.show : null // several parts: output lines are prefixed
      const out = Date.now() - since > 3000 ? await tmux.capturePane(session, 300) : ''
      const printed = printedPorts(tag ? out.split('\n').filter((l) => l.startsWith(`[${tag}] `)).join('\n') : out) // another part's URL isn't the page
      for (const p of [cur.port!, ...printed.filter((x) => x !== cur.port)]) {
        const r = await probe(p); if (!r) continue
        const pane = await tmux.panePid(session), who = whoAnswers(await portHolders(p), pane ? await pgidOf(pane) : null, Date.now() - since)
        if (who.kind === 'wait') continue // something else answers there and this app isn't listening yet
        if (who.kind === 'clash') { unwatch(repoId); void clash(repoId, since, p, who.others); return }
        save(repoId, { status: 'running', url: `http://localhost:${p}/`, frameable: r.frameable ? 1 : 0, detail: done })
        emit({ agentId: null, source: 'system', kind: 'preview.running', payload: { repo: repoId, port: p } }); break
      }
      if (row(repoId)?.status === 'starting' && Date.now() - since > 5 * 60_000 && !cur.detail?.startsWith('No reply')) save(repoId, { detail: `No reply on port ${cur.port} yet. See Server output.` })
    }
    if (watchers.has(repoId)) watchers.set(repoId, setTimeout(tick, row(repoId)?.status === 'starting' ? 1000 : 5000))
  }
  watchers.set(repoId, setTimeout(tick, 500))
}

/** Bug 44: another program listens on the page's port too, so the page could be that one. HQ stops this app rather than show
 *  the wrong one and names the other; Stop it and Launch (Bug 42) frees the port. */
function clash(repoId: string, since: number, port: number, others: Holder[]): Promise<void> {
  return serial(repoId, async () => {
    const cur = row(repoId), repo = getRepo(repoId); if (!cur || !repo || (cur.started_at ?? 0) !== since) return // restarted meanwhile
    const part = cur.command ? 'app' : parse(cur.recipe)?.show ?? 'app', all = repos()
    const held = others.map((h): PortHolder => ({ ...h, ...whose(h.cwd, all, repoId), port, part }))
    await kill(repoId, 'stop')
    const error = `Can't show ${repo.name}: ${heldText(port, part, held)} as well, so the page could be that program instead of ${repo.name}. Stop it here, then Launch.`
    save(repoId, { status: 'stopped', detail: error, url: null, frameable: null, port_holders: JSON.stringify(held), stopping: null })
    emit({ agentId: null, source: 'system', kind: 'preview.error', payload: { repo: repo.name, error, why: null, ticket: cur.ticket_id ? getTicket(cur.ticket_id)?.key ?? null : null } })
  })
}

/** How long the app's supervisor gets to end the app: its own grace (5 s for what was asked to stop, then it kills), with room to spare. */
const STOP_MS = Number(process.env.HQ_PREVIEW_STOP_MS) || 8000
/** What the supervisor wrote as this run ended (supervise.mjs): how much of the app ran outside its own process group, and what had to be killed;
 *  `no_ps` when it couldn't run `ps` and so only told its own process group to stop (Bug 182). */
function stopReport(repoId: string, since: number): { outside?: number; killed?: number[]; no_ps?: true } {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(PATHS.home, 'previews', repoId, 'stopped.json'), 'utf8')) as
      { at: number; outside?: number; killed?: number[]; no_ps?: boolean }
    return r.at >= since ? { outside: r.outside, killed: r.killed, ...(r.no_ps ? { no_ps: true as const } : {}) } : {}
  } catch { return {} }
}
/** Stops the app. Its supervisor is asked (SIGTERM) and ends everything the app started, whatever group or session that put itself in (supervise.mjs); if the
 *  supervisor itself doesn't go, its whole process group is killed. Then the session, and what the run had left with no parent: leftovers.ts knows those
 *  by the run's mark (Bug 77). A signal to the group alone left running whatever ignored it, was slow, or had left the group.
 *  `why` is kept on the row first (Bug 215): a backend restart in the middle finishes the job (recoverPreviews), and the ended app isn't read as a crash.
 *  The caller's next save clears it. `sweep` false: no leftover look now (at start-up, before agents' commands are read back). */
async function kill(repoId: string, why: Stopping, sweep = true): Promise<{ forced: boolean }> {
  const session = previewSession(repoId), cur = row(repoId), on = await tmux.hasSession(session)
  if (on || (cur && cur.status !== 'stopped')) save(repoId, { stopping: why })
  let forced = false // Bug 182: the supervisor didn't end within STOP_MS and HQ killed it, so it had no time to report what it stopped
  if (on) {
    const pid = (await tmux.paneDeadStatus(session)) === null ? await tmux.panePid(session) : null
    if (pid) {
      try { process.kill(pid, 'SIGTERM') } catch {}
      if (!(await waitFor(async () => (await tmux.paneDeadStatus(session)) !== null, STOP_MS))) { forced = true; try { process.kill(-pid, 'SIGKILL') } catch {} }
    }
    await tmux.killSession(session)
  }
  if (cur?.started_at && cur.status !== 'stopped') { runOver(markFor(repoId, cur.started_at)); if (sweep) await sweepNow() }
  const port = row(repoId)?.port; if (port) await waitFor(async () => !(await portBusy(port)), 3000)
  return { forced }
}

/** Start (or restart) the repo's app. `ticket`: a finished ticket to try (its worktree, with a copy of main's data), null for
 *  main, left out to keep whatever runs now (a ticket that can't be tried any more falls back to main). Throws NeedsSetup
 *  when there's nothing to run yet (no OK'd recipe, no ⚙ command), PortTaken when another program holds one of its fixed
 *  ports, and plain errors when no preview port is free or the asked-for ticket can't be tried. Every failure is also a
 *  `preview.error` event (Bug 39), except NeedsSetup: that is the normal way to the Launch helper (for a ticket too, Bug 46). */
/** A fixed port of the recipe is held by another program. */
export class PortTaken extends Error { ports: number[]; constructor(msg: string, ports: number[]) { super(msg); this.ports = ports } }
/** What the user reads about one held port (Bug 42): whose program it is, its name and pid(s). */
export function heldText(port: number, part: string, hs: PortHolder[]): string {
  const h = hs[0]; if (!h) return `port ${port} (${part}) is in use by another program`
  const ids = `${hs.length > 1 ? 'pids' : 'pid'} ${hs.map((x) => x.pid).join(', ')}`
  if (h.kind === 'hq') return `port ${port} (${part}) is taken by ${h.name} (${h.cmd}, ${ids})`
  if (h.kind === 'repo') return `port ${port} (${part}) is being used by ${h.name} (${h.cmd}, ${ids})`
  return `port ${port} (${part}) is being used by ${h.cmd} in ${h.name} (${ids})`
}
const SUPERVISOR = path.join(import.meta.dirname, 'supervise.mjs')
/** Bug 354: ports chosen for a start still on its way (its row not yet saved "starting"), by repo; startPreview drops them when that start ends. */
const handing = new Map<string, number[]>()
/** Bug 354: every port this HQ gave another repo's app that is starting or running, or is giving one now. An app that hasn't bound its port yet (still
 *  installing, or slow to listen) leaves it looking free. Every part's port, from its run's spec.json (the row keeps the page's only); read from the
 *  rows, so it holds after a backend restart too. A stopped or crashed app's ports are free again. */
function givenElsewhere(repoId: string): number[] {
  const live = q<Preview>(`SELECT * FROM previews WHERE status IN ('starting', 'running') AND id != ?`, repoId)
  const inSpec = (id: string): number[] => {
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(PATHS.home, 'previews', id, 'spec.json'), 'utf8')) as { parts: { env: Record<string, string> }[] }
      return spec.parts.map((x) => Number(x.env.PORT)).filter((n) => Number.isInteger(n) && n > 0)
    } catch { return [] }
  }
  return [...live.flatMap((p) => [...(p.port ? [p.port] : []), ...inSpec(p.id)]), ...[...handing].flatMap(([id, ps]) => id === repoId ? [] : ps)]
}
/** Bug 354: one port choice at a time across this HQ (each repo's own queue lets two repos' starts overlap). Reading what the others were given, the busy
 *  checks and keeping this start's choice happen in one go, so two starts a moment apart can't both take the same free port. */
let choosing: Promise<unknown> = Promise.resolve()
function choosePorts(repoId: string, recipe: Recipe, saved: number | null): ReturnType<typeof assignPorts> {
  const job = async () => {
    const got = await assignPorts(recipe, saved, portBusy, helperPortsHeld(repoId), givenElsewhere(repoId))
    if (got && !got.taken.length) handing.set(repoId, Object.values(got.ports)) // kept before the next choice can start
    return got
  }
  const p = choosing.then(job, job); choosing = p.catch(() => {}); return p
}

/** `helperRun` (Bug 351): this is the Launch helper's first run of the steps the user OK'd; the row keeps its `started_at` as `helper_run`. */
export function startPreview(repoId: string, why: string | null = null, opts: { ticket?: string | null; helperRun?: boolean } = {}): Promise<ReturnType<typeof previewView>> {
  return serial(repoId, () => startJob(repoId, why, opts).finally(() => handing.delete(repoId)).catch(async (e) => { await gaveUp(repoId, e); throw e }))
    .catch((e) => { // Bug 39: a start that never got going still leaves a trace in the Events tab and the log
      if (!(e instanceof NeedsSetup)) {
        const error = e instanceof Error ? e.message : String(e), ticket = (opts.ticket && getTicket(opts.ticket)?.key) || null
        emit({ agentId: null, source: 'system', kind: 'preview.error', payload: { repo: getRepo(repoId)?.name ?? repoId, error, why, ticket } })
      }
      throw e
    })
}
/** Bug 236: a start that fails once it has begun ending the old run (a file HQ can't write, tmux can't make the session) left the row saying
 *  "running" with nothing running, and its `stopping` mark had the next backend start it again. Now the row says what is true: nothing runs, and why.
 *  The failures startJob names itself have saved their own words and cleared `stopping` already; before the old run is touched nothing changed. */
async function gaveUp(repoId: string, e: unknown): Promise<void> {
  if (!row(repoId)?.stopping) return
  await tmux.killSession(previewSession(repoId)) // a session made before the failure would run with no row that knows it
  const error = e instanceof Error ? e.message : String(e), name = getRepo(repoId)?.name ?? 'the app'
  save(repoId, { status: 'stopped', detail: `HQ couldn't start ${name}: ${error}`, url: null, frameable: null, port_holders: null, stopping: null })
}
async function startJob(repoId: string, why: string | null, opts: { ticket?: string | null; helperRun?: boolean }): Promise<ReturnType<typeof previewView>> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  notClearing(repoId)
  const cur = row(repoId)
  const asked = opts.ticket !== undefined, tid = asked ? opts.ticket ?? null : cur?.ticket_id ?? null
  let tk = tid ? getTicket(tid) : undefined
  if (tid && (!tryable(tk) || getFeature(tk.feature_id)?.repo_id !== repoId)) {
    if (asked) throw new Error(`${tk?.key ?? 'That ticket'} can't be tried: only a finished ticket waiting for its merge, with no conflicts to fix, can.`)
    tk = undefined
  }
  const cwd = tk?.worktree_path ?? repo.path
  const recipe = runnableRecipe(cur, cwd)
  if (!recipe) throw new NeedsSetup(`HQ doesn't know how to start ${repo.name} yet. Launch asks Claude to work it out (or set your own command with ⚙).`)
  unwatch(repoId); await kill(repoId, 'restart')
  const stale = cur?.command ? null : recipeProblem(recipe, cwd) // the user's own command: HQ picks its install (ownInstall); the pane warns (Bug 316)
  const cant = cur?.command ? ownInstall(cwd).stop : undefined // Bug 343: its package manager isn't installed, say, and npm is no stand-in for it
  if (cant) {
    const msg = `HQ didn't start ${repo.name}: ${cant}`
    save(repoId, { status: 'stopped', detail: msg, url: null, port_holders: null, stopping: null }); throw new Error(msg)
  }
  if (stale) {
    const msg = `HQ didn't start ${repo.name}: its saved start steps ${refusedWords(stale.lock)}.` // Bug 238: the lockfile they'd touch
    save(repoId, { status: 'stopped', detail: `${msg} Start it again and Claude fixes them for your OK.`, url: null, port_holders: null, stopping: null })
    throw new StepsOutdated(msg, stale) // the check's own words go to the helper, not to the user
  }
  const got = await choosePorts(repoId, recipe, cur?.port ?? null) // its row says "starting" with them before the claim goes
  const range = `ports ${PREVIEW_PORTS[0]}–${PREVIEW_PORTS.at(-1)} are all in use`
  if (!got) { save(repoId, { status: 'stopped', detail: range, port_holders: null, stopping: null }); throw new Error(range) }
  if (got.taken.length) { // something else answers there (the user's own dev server, say): this app would talk to it, not to its own part
    const all = repos(), held = await Promise.all(got.taken.map(async (x) =>
      (await portHolders(x.port)).map((h): PortHolder => ({ ...h, ...whose(h.cwd, all, repoId), port: x.port, part: x.part }))))
    const known = held.flat(), msg = `Can't start ${repo.name}: ${got.taken.map((x, i) => heldText(x.port, x.part, held[i]!)).join('; ')}.`
      + (known.length ? ' Stop it here, then Launch.' : ' Stop it, then Launch.')
    save(repoId, { status: 'stopped', detail: msg, url: null, port_holders: known.length ? JSON.stringify(known) : null, stopping: null })
    throw new PortTaken(msg, got.taken.map((x) => x.port))
  }
  const port = got.ports[recipe.show]!
  const copied = tk && asked ? await copyMainData(repo.path, cwd, recipe.worktree_files).catch(() => []) : [] // a restart keeps what the user did while trying
  const hidden = await excludeLeftovers(cwd, installLeftovers(recipe, cwd)).catch(() => []) // Bug 263: the installs' node_modules, .pnp.cjs, ... stay out of git status
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
  const head = await git(cwd, ['rev-parse', '--short', 'HEAD']).catch(() => null)
  const dir = path.join(PATHS.home, 'previews', repoId); fs.mkdirSync(dir, { recursive: true })
  const marksFile = path.join(dir, 'installed.json')
  const marks = (() => { try { return JSON.parse(fs.readFileSync(marksFile, 'utf8')) as Record<string, string> } catch { return {} } })()
  const command = recipe.parts.map((x) => x.run).join(' + ')
  const spec = supervisorSpec({ recipe, root: cwd, ports: got.ports, marks, marksFile,
    header: `HQ preview: ${recipe.parts.map((x) => `${recipe.parts.length > 1 ? `${x.name}: ` : ''}${x.run} · port ${got.ports[x.name]}`).join(' | ')}`
      + ` · ${tk ? `${tk.key} · ` : ''}${branch ?? '?'}@${head ?? '?'}` })
  const install = spec.parts.filter((x) => x.install).map((x) => x.install).join(', ') || null
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 1))
  const script = path.join(dir, 'run.sh'), t = now(), mark = markFor(repoId, t)
  fs.writeFileSync(script, runScript({ cwd, node: process.execPath, supervisor: SUPERVISOR, spec: path.join(dir, 'spec.json'), mark }), { mode: 0o700 })
  runStarting(mark, true) // from the first moment its programs exist, they are a live run's
  try {
    await tmux.newSession(previewSession(repoId), `bash ${shq(script)}`, { cwd })
    await tmux.tmux('set-option', '-t', previewSession(repoId), 'status', 'off').catch(() => {}) // the Server tab is just the app's output
    save(repoId, { status: 'starting', detail: install ? `installing packages (${install})…` : 'starting…', port, url: null, port_holders: null,
      frameable: null, branch, head, started_at: t, ticket_id: tk?.id ?? null, stopping: null, ...(opts.helperRun ? { helper_run: t } : {}) }) // with the run: no gap
  } finally { runStarting(mark, false) }
  emit({ agentId: null, source: 'system', kind: 'preview.started',
    payload: { repo: repo.name, command, port, ports: got.ports, head, install, why, ticket: tk?.key ?? null, copied, ...(hidden.length ? { hidden } : {}) } })
  watch(repoId, t, why)
  return previewView(repo)
}
/** `resumed` (Bug 215): finishing, at start-up, a Stop the last backend began; no leftover look yet (index.ts does it once agents' commands are read back). */
export function stopPreview(repoId: string, resumed = false): Promise<ReturnType<typeof previewView>> {
  return serial(repoId, async () => {
    const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
    const cur = row(repoId), since = cur?.started_at ?? 0, on = cur?.status === 'starting' || cur?.status === 'running' // a crashed run ended by itself
    if (!resumed && since && on) stopped.set(repoId, [since, ...(stopped.get(repoId) ?? [])].slice(0, 10)) // before the row says so: a waiter reads both
    unwatch(repoId); const { forced } = await kill(repoId, 'stop', !resumed)
    save(repoId, { status: 'stopped', detail: null, url: null, frameable: null, port_holders: null, stopping: null })
    // `forced`: HQ had to kill the supervisor (its whole process group), so the supervisor's own report is missing or cut short
    emit({ agentId: null, source: 'system', kind: 'preview.stopped',
      payload: { repo: repo.name, ...stopReport(repoId, since), ...(forced ? { forced: true } : {}), ...(resumed ? { after_restart: true } : {}) } })
    return previewView(repo)
  })
}

/** Bug 332: the runs (by `started_at`) a Stop ended, newest first, per repo: the user's Stop, the one-app dialog's, a Clear's or a Remove's (every
 *  stopPreview but the start-up one; the Launch helper's own, of a run that never answered, comes after it read the run), never the app ending by
 *  itself or HQ restarting it. Kept in memory, as the Launch helper's wait on its run is. */
const stopped = new Map<string, number[]>()
/** Bug 332: did a Stop end this run of the repo's app? */
export const stoppedByStop = (repoId: string, since: number): boolean => !!stopped.get(repoId)?.includes(since)

/** "Stop it and Launch" (Bug 42): stops the programs the user was shown on the recipe's fixed ports, then starts the app. Only
 *  those: if anything else holds a port now, nothing is stopped. Never HQ itself or a live agent's session. A program that
 *  comes straight back (a watcher restarting its server) is stopped with its whole process group. */
export function freePort(repoId: string, pids: number[]): Promise<ReturnType<typeof previewView>> {
  return serial(repoId, async () => {
    const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
    const shown = holdersOf(row(repoId)?.port_holders ?? null) ?? []
    if (!shown.length) throw new Error('HQ has no busy port to free for this app. Launch again.')
    const ports = [...new Set(shown.map((h) => h.port))], want = new Set(pids)
    const holding = async () => (await Promise.all(ports.map(async (port) => (await portHolders(port)).map((h) => ({ ...h, port }))))).flat()
    const now0 = await holding()
    if (now0.some((h) => !want.has(h.pid))) throw new Error('Something else holds the port now. Launch again to see what.')
    const spare = new Set([(await pgidOf(process.pid)) ?? -1, ...(await agentGroups())])
    if (now0.some((h) => h.pid <= 1 || h.pid === process.pid || (h.pgid !== null && spare.has(h.pgid)))) throw new Error('That is HQ itself or one of its agents; HQ won\'t stop it.')
    const signal = (target: number, sig: NodeJS.Signals) => { try { process.kill(target, sig) } catch { /* gone */ } }
    const free = () => waitFor(async () => (await holding()).length === 0, 3000)
    for (const h of now0) signal(h.pid, 'SIGTERM')
    await free(); await sleep(300)
    // What it was started with (a watcher that restarts it, `uv run`, `npm run`) shares its process group: that goes too
    const groups = [...new Set(now0.map((h) => h.pgid).filter((g): g is number => g !== null && g > 1 && !spare.has(g)))]
    const rest = (await Promise.all(groups.map(async (g) => (await groupPids(g)).length ? [g] : []))).flat()
    for (const g of rest) signal(-g, 'SIGTERM')
    const gone = () => waitFor(async () => (await holding()).length === 0 && (await Promise.all(rest.map(groupPids))).every((x) => !x.length), 3000)
    if (!(await gone())) { for (const g of rest) signal(-g, 'SIGKILL'); for (const h of now0) signal(h.pid, 'SIGKILL') }
    if (!(await free())) {
      const left = await holding(); const id = (h: Holder & { port: number }) => `port ${h.port}: ${h.cmd} (pid ${h.pid})`
      throw new Error(`HQ couldn't free the port: ${left.map(id).join('; ')} is still there.`)
    }
    for (const h of shown.filter((x) => now0.some((y) => y.pid === x.pid))) { // only what was still there: HQ stopped it
      emit({ agentId: null, source: 'ui', kind: 'preview.port_freed', payload: { repo: repo.name, port: h.port, pid: h.pid, cmd: h.cmd, cwd: h.cwd, kind: h.kind, name: h.name } })
    }
    const p = row(repoId)
    save(repoId, { port_holders: null, detail: null, ...(p?.helper_state === 'port_taken' ? { helper_state: null, helper_note: null } : {}) })
  }).then(() => startPreview(repoId, 'the port was freed', {}))
}
/** The process groups of every live agent's tmux pane: never stopped by freePort. */
async function agentGroups(): Promise<number[]> {
  const ids = q<{ tmux_session: string }>("SELECT tmux_session FROM agents WHERE status != 'exited' AND tmux_session IS NOT NULL")
  const out: number[] = []
  for (const a of ids) { const pid = await tmux.panePid(a.tmux_session).catch(() => null); const g = pid ? await pgidOf(pid) : null; if (g) out.push(g) }
  return out
}
/** The user's own start command for this repo (null: back to HQ's pick). A preview that's on restarts with it. */
export async function setPreviewCommand(repoId: string, command: string | null): Promise<ReturnType<typeof previewView>> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  save(repoId, { command: command?.trim() || null })
  const cur = row(repoId)
  if ((cur?.status ?? 'stopped') !== 'stopped' && runnableRecipe(cur, repo.path)) return startPreview(repoId, `restarted with ${command?.trim() || 'the start steps you OK\'d'}`)
  return previewView(repo)
}

// After a merge the preview restarts on the new main (GitHub repos fast-forward local main first). Merges noticed in the same
// check restart it once.
const pending = new Map<string, { timer: NodeJS.Timeout; keys: string[] }>()
export function onTicketMerged(e: HqEvent): void { // wired in listeners.ts
  const t = getTicket(String(e.payload.ticket ?? '')); const f = t ? getFeature(t.feature_id) : undefined; if (!t || !f) return
  if ((row(f.repo_id)?.status ?? 'stopped') === 'stopped') return
  const prev = pending.get(f.repo_id); if (prev) clearTimeout(prev.timer)
  const keys = [...(prev?.keys ?? []), t.key]
  pending.set(f.repo_id, { keys, timer: setTimeout(() => { pending.delete(f.repo_id); void restartAfterMerge(f.repo_id, keys) }, 3000) })
}
async function restartAfterMerge(repoId: string, keys: string[]): Promise<void> {
  const repo = getRepo(repoId); if (!repo) return
  if (repo.kind === 'github') await syncRepo(repoId).catch(() => {})
  if ((row(repoId)?.status ?? 'stopped') === 'stopped') return // stopped while this waited
  if (!runnableRecipe(row(repoId), repo.path)) return
  await startPreview(repoId, `restarted on ${repo.default_branch} after ${keys.join(', ')} merged`, { ticket: null }) // a tried ticket is done with
    .catch(() => {}) // startPreview wrote the preview.error
}

/** Bug 215: apps the last backend was restarting when it went; started again by resumeRestarts once the start-up leftover look is done. */
const restartLater: string[] = []
/** On backend start (before the merge watcher's first check): a Stop or restart the last backend was in the middle of is finished (Bug 215: the app
 *  it ended reads as stopped, not crashed); previews whose app still runs in tmux are watched again. */
export async function recoverPreviews(): Promise<void> {
  for (const p of q<Preview>('SELECT * FROM previews WHERE stopping IS NOT NULL')) {
    if (!getRepo(p.id)) continue
    if (p.stopping !== 'restart') { await stopPreview(p.id, true).catch((e) => console.error('finishing a Stop failed', e)); continue }
    await serial(p.id, async () => {
      unwatch(p.id); await kill(p.id, 'restart', false)
      save(p.id, { status: 'stopped', detail: 'HQ restarted while it was restarting the app. Starting it again…', url: null, frameable: null, port_holders: null, stopping: null })
    }).catch((e) => console.error('finishing a restart failed', e))
    restartLater.push(p.id)
  }
  for (const p of q<Preview>("SELECT * FROM previews WHERE status IN ('starting', 'running')")) {
    const session = previewSession(p.id)
    if (!getRepo(p.id) || !(await tmux.hasSession(session))) { save(p.id, { status: 'stopped', detail: 'it was not running when HQ restarted', url: null }); continue }
    const code = await tmux.paneDeadStatus(session)
    if (code !== null) { save(p.id, { status: 'crashed', detail: `stopped with code ${code}` }); continue }
    watch(p.id, p.started_at ?? 0, p.status === 'running' ? p.detail : null)
    emit({ agentId: null, source: 'system', kind: 'preview.recovered', payload: { repo: p.id, status: p.status } })
  }
}
/** Bug 351: the Launch helper's first run of the OK'd steps starts the app again itself (resumeTries), so resumeRestarts doesn't. True when it was due to. */
export function takeRestart(repoId: string): boolean {
  const i = restartLater.indexOf(repoId); if (i < 0) return false
  restartLater.splice(i, 1); return true
}
/** Bug 215: starts again the apps recoverPreviews found half-restarted. index.ts calls it after the start-up leftover look, which a start's own would come before. */
export function resumeRestarts(): void {
  for (const id of restartLater.splice(0)) void startPreview(id, 'started again (HQ restarted while restarting the app)').catch(() => {}) // startPreview wrote the preview.error
}
