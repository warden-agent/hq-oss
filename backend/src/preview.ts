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
import { assignPorts, commandRecipe, detectCommand, frameBlocked, PREVIEW_PORTS, portBusy, printedPorts, runScript, supervisorSpec, type Recipe } from './apprun.ts'
import { groupPids, pgidOf, portHolders, whoAnswers, whose, type Holder, type Whose } from './procs.ts'
import { markFor, runOver, runStarting, sweepNow } from './leftovers.ts'
import { git } from './reposync.ts'
import { getFeature, getRepo, getTicket, repos, type Repo, notClearing } from './records.ts'
import { syncRepo } from './repos.ts'
import { shq, sleep } from './util.ts'
import { copyMainData, tryable } from './trydata.ts'
import * as tmux from './tmux.ts'

export type PreviewStatus = 'stopped' | 'starting' | 'running' | 'crashed'
export type Preview = {
  id: string; command: string | null; status: PreviewStatus; detail: string | null; port: number | null; url: string | null
  frameable: number | null; branch: string | null; head: string | null; started_at: number | null; updated_at: number; ticket_id: string | null
  recipe: string | null; draft_recipe: string | null; helper_agent_id: string | null; helper_state: string | null; helper_note: string | null; helper_saves: number
  helper_worktree: string | null; port_holders: string | null; helper_ticket_id: string | null
}
/** A program on one of the recipe's fixed ports (Bug 42), and whose it is. */
export type PortHolder = Holder & Whose & { port: number; part: string }
const COLS = ['id', 'command', 'status', 'detail', 'port', 'url', 'frameable', 'branch', 'head', 'started_at', 'updated_at', 'ticket_id',
  'recipe', 'draft_recipe', 'helper_agent_id', 'helper_state', 'helper_note', 'helper_saves', 'helper_worktree', 'port_holders', 'helper_ticket_id'] as const

export const previewSession = (repoId: string): string => `hq-preview-${repoId}`
export const row = (repoId: string): Preview | undefined => one<Preview>('SELECT * FROM previews WHERE id = ?', repoId)
const blank = (repoId: string): Preview => ({
  id: repoId, command: null, status: 'stopped', detail: null, port: null, url: null, frameable: null, branch: null, head: null, started_at: null, updated_at: 0,
  ticket_id: null, recipe: null, draft_recipe: null, helper_agent_id: null, helper_state: null, helper_note: null, helper_saves: 0, helper_worktree: null, port_holders: null, helper_ticket_id: null,
})
const parse = (json: string | null): Recipe | null => { try { return json ? JSON.parse(json) as Recipe : null } catch { return null } }
/** What Launch runs: the user's own ⚙ command, else the recipe they OK'd; null when there's neither (the Launch helper is next). */
export function runnableRecipe(p: Preview | undefined, cwd: string): Recipe | null {
  return p?.command ? commandRecipe(p.command, cwd) : parse(p?.recipe ?? null)
}
/** Thrown when there's nothing to run yet: no ⚙ command and no OK'd recipe. */
export class NeedsSetup extends Error {}
/** One repo's preview as the UI sees it: the saved row (or "stopped") with its recipes parsed, and the root npm script HQ
 *  would suggest for ⚙ (a hint only: it no longer starts anything by itself). */
type PreviewView = Omit<Preview, 'recipe' | 'draft_recipe' | 'port_holders'> & {
  recipe: Recipe | null; draft_recipe: Recipe | null; port_holders: PortHolder[] | null; auto_command: string | null; default_branch: string; path: string
  /** The Launch helper's ticket (Bug 46), by key. */
  helper_ticket_key: string | null }
const holdersOf = (json: string | null): PortHolder[] | null => { try { return json ? JSON.parse(json) as PortHolder[] : null } catch { return null } }
export function previewView(repo: Repo): PreviewView {
  const p = row(repo.id) ?? blank(repo.id), t = p.ticket_id ? getTicket(p.ticket_id) : undefined
  return { ...p, recipe: parse(p.recipe), draft_recipe: parse(p.draft_recipe), port_holders: holdersOf(p.port_holders),
    auto_command: detectCommand(repo.path), default_branch: repo.default_branch, path: t?.worktree_path ?? repo.path,
    helper_ticket_key: p.helper_ticket_id ? getTicket(p.helper_ticket_id)?.key ?? null : null }
}
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
    if (!(await tmux.hasSession(session))) { save(repoId, { status: 'stopped', detail: 'its tmux session is gone', url: null }); void sweepNow(); return unwatch(repoId) }
    const code = await tmux.paneDeadStatus(session)
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
    await kill(repoId)
    const error = `Can't show ${repo.name}: ${heldText(port, part, held)} as well, so the page could be that program instead of ${repo.name}. Stop it here, then Launch.`
    save(repoId, { status: 'stopped', detail: error, url: null, frameable: null, port_holders: JSON.stringify(held) })
    emit({ agentId: null, source: 'system', kind: 'preview.error', payload: { repo: repo.name, error, why: null, ticket: cur.ticket_id ? getTicket(cur.ticket_id)?.key ?? null : null } })
  })
}

/** How long the app's supervisor gets to end the app: its own grace (5 s for what was asked to stop, then it kills), with room to spare. */
const STOP_MS = Number(process.env.HQ_PREVIEW_STOP_MS) || 8000
/** What the supervisor wrote as this run ended (supervise.mjs): how much of the app ran outside its own process group, and what had to be killed. */
function stopReport(repoId: string, since: number): { outside?: number; killed?: number[] } {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(PATHS.home, 'previews', repoId, 'stopped.json'), 'utf8')) as { at: number; outside: number; killed: number[] }
    return r.at >= since ? { outside: r.outside, killed: r.killed } : {}
  } catch { return {} }
}
/** Stops the app. Its supervisor is asked (SIGTERM) and ends everything the app started, whatever group or session that put itself in (supervise.mjs); if the
 *  supervisor itself doesn't go, its whole process group is killed. Then the session, and what the run had left with no parent: leftovers.ts knows those
 *  by the run's mark (Bug 77). A signal to the group alone left running whatever ignored it, was slow, or had left the group. */
async function kill(repoId: string): Promise<void> {
  const session = previewSession(repoId), cur = row(repoId)
  if (await tmux.hasSession(session)) {
    const pid = (await tmux.paneDeadStatus(session)) === null ? await tmux.panePid(session) : null
    if (pid) {
      try { process.kill(pid, 'SIGTERM') } catch {}
      if (!(await waitFor(async () => (await tmux.paneDeadStatus(session)) !== null, STOP_MS))) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    }
    await tmux.killSession(session)
  }
  if (cur?.started_at && cur.status !== 'stopped') { runOver(markFor(repoId, cur.started_at)); await sweepNow() }
  const port = row(repoId)?.port; if (port) await waitFor(async () => !(await portBusy(port)), 3000)
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

export function startPreview(repoId: string, why: string | null = null, opts: { ticket?: string | null } = {}): Promise<ReturnType<typeof previewView>> {
  return serial(repoId, async () => {
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
    unwatch(repoId); await kill(repoId)
    const got = await assignPorts(recipe, cur?.port ?? null)
    const range = `ports ${PREVIEW_PORTS[0]}–${PREVIEW_PORTS.at(-1)} are all in use`
    if (!got) { save(repoId, { status: 'stopped', detail: range, port_holders: null }); throw new Error(range) }
    if (got.taken.length) { // something else answers there (the user's own dev server, say): this app would talk to it, not to its own part
      const all = repos(), held = await Promise.all(got.taken.map(async (x) =>
        (await portHolders(x.port)).map((h): PortHolder => ({ ...h, ...whose(h.cwd, all, repoId), port: x.port, part: x.part }))))
      const known = held.flat(), msg = `Can't start ${repo.name}: ${got.taken.map((x, i) => heldText(x.port, x.part, held[i]!)).join('; ')}.`
        + (known.length ? ' Stop it here, then Launch.' : ' Stop it, then Launch.')
      save(repoId, { status: 'stopped', detail: msg, url: null, port_holders: known.length ? JSON.stringify(known) : null })
      throw new PortTaken(msg, got.taken.map((x) => x.port))
    }
    const port = got.ports[recipe.show]!
    const copied = tk && asked ? await copyMainData(repo.path, cwd, recipe.worktree_files).catch(() => []) : [] // a restart keeps what the user did while trying
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
        frameable: null, branch, head, started_at: t, ticket_id: tk?.id ?? null })
    } finally { runStarting(mark, false) }
    emit({ agentId: null, source: 'system', kind: 'preview.started', payload: { repo: repo.name, command, port, ports: got.ports, head, install, why, ticket: tk?.key ?? null, copied } })
    watch(repoId, t, why)
    return previewView(repo)
  }).catch((e) => { // Bug 39: a start that never got going still leaves a trace in the Events tab and the log
    if (!(e instanceof NeedsSetup)) {
      const error = e instanceof Error ? e.message : String(e), ticket = (opts.ticket && getTicket(opts.ticket)?.key) || null
      emit({ agentId: null, source: 'system', kind: 'preview.error', payload: { repo: getRepo(repoId)?.name ?? repoId, error, why, ticket } })
    }
    throw e
  })
}
export function stopPreview(repoId: string): Promise<ReturnType<typeof previewView>> {
  return serial(repoId, async () => {
    const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
    const since = row(repoId)?.started_at ?? 0
    unwatch(repoId); await kill(repoId)
    save(repoId, { status: 'stopped', detail: null, url: null, frameable: null, port_holders: null })
    emit({ agentId: null, source: 'system', kind: 'preview.stopped', payload: { repo: repo.name, ...stopReport(repoId, since) } })
    return previewView(repo)
  })
}

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

/** On backend start (before the merge watcher's first check): previews whose app still runs in tmux are watched again. */
export async function recoverPreviews(): Promise<void> {
  for (const p of q<Preview>("SELECT * FROM previews WHERE status IN ('starting', 'running')")) {
    const session = previewSession(p.id)
    if (!getRepo(p.id) || !(await tmux.hasSession(session))) { save(p.id, { status: 'stopped', detail: 'it was not running when HQ restarted', url: null }); continue }
    const code = await tmux.paneDeadStatus(session)
    if (code !== null) { save(p.id, { status: 'crashed', detail: `stopped with code ${code}` }); continue }
    watch(p.id, p.started_at ?? 0, p.status === 'running' ? p.detail : null)
    emit({ agentId: null, source: 'system', kind: 'preview.recovered', payload: { repo: p.id, status: p.status } })
  }
}
