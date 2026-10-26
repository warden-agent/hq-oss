// Live preview: HQ runs a repo's app from its checkout (normally main) in tmux session hq-preview-<repoId> and tells the UI
// where it answers. The user starts it once; it restarts after a merge and is picked up again after a backend restart.
// The rules (command, install, port, framing) are in apprun.ts.
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.ts'
import { one, q, run, now } from './db.ts'
import { emit, patch, type HqEvent } from './events.ts'
import { detectCommand, frameBlocked, installStep, pickPort, portBusy, printedPorts, runScript } from './apprun.ts'
import { git } from './reposync.ts'
import { getFeature, getRepo, getTicket, repos, type Repo } from './records.ts'
import { syncRepo } from './repos.ts'
import { shq, sleep } from './util.ts'
import * as tmux from './tmux.ts'

export type PreviewStatus = 'stopped' | 'starting' | 'running' | 'crashed'
export type Preview = {
  id: string; command: string | null; status: PreviewStatus; detail: string | null; port: number | null; url: string | null
  frameable: number | null; branch: string | null; head: string | null; started_at: number | null; updated_at: number
}
const COLS = ['id', 'command', 'status', 'detail', 'port', 'url', 'frameable', 'branch', 'head', 'started_at', 'updated_at'] as const

export const previewSession = (repoId: string): string => `hq-preview-${repoId}`
const row = (repoId: string): Preview | undefined => one<Preview>('SELECT * FROM previews WHERE id = ?', repoId)
const blank = (repoId: string): Preview => ({
  id: repoId, command: null, status: 'stopped', detail: null, port: null, url: null, frameable: null, branch: null, head: null, started_at: null, updated_at: 0,
})
/** One repo's preview as the UI sees it: the saved row (or "stopped"), plus the command HQ would pick by itself. */
export function previewView(repo: Repo): Preview & { auto_command: string | null; default_branch: string; path: string } {
  return { ...(row(repo.id) ?? blank(repo.id)), auto_command: detectCommand(repo.path), default_branch: repo.default_branch, path: repo.path }
}
export const previews = () => repos().map(previewView)
/** Saves and sends the UI the whole row (a patch for a row the UI hasn't seen would otherwise arrive half-filled). */
function save(repoId: string, fields: Partial<Preview>): void {
  const next: Preview = { ...(row(repoId) ?? blank(repoId)), ...fields, updated_at: now() }
  run(`INSERT OR REPLACE INTO previews(${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(',')})`, ...COLS.map((k) => next[k]))
  const repo = getRepo(repoId); if (repo) patch('preview', repoId, previewView(repo))
}

// One start/stop at a time per repo, so two quick clicks can't start the app twice.
const queue = new Map<string, Promise<unknown>>()
function serial<T>(repoId: string, job: () => Promise<T>): Promise<T> {
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
    if (!(await tmux.hasSession(session))) { save(repoId, { status: 'stopped', detail: 'its tmux session is gone', url: null }); return unwatch(repoId) }
    const code = await tmux.paneDeadStatus(session)
    if (code !== null) {
      save(repoId, { status: 'crashed', detail: `stopped with code ${code}` })
      emit({ agentId: null, source: 'system', kind: 'preview.crashed', payload: { repo: repoId, code } }); return unwatch(repoId)
    }
    if (cur.status === 'starting') {
      const printed = Date.now() - since > 3000 ? printedPorts(await tmux.capturePane(session, 300)) : []
      for (const p of [cur.port!, ...printed.filter((x) => x !== cur.port)]) {
        const r = await probe(p); if (!r) continue
        save(repoId, { status: 'running', url: `http://localhost:${p}/`, frameable: r.frameable ? 1 : 0, detail: done })
        emit({ agentId: null, source: 'system', kind: 'preview.running', payload: { repo: repoId, port: p } }); break
      }
      if (row(repoId)?.status === 'starting' && Date.now() - since > 5 * 60_000 && !cur.detail?.startsWith('No reply')) save(repoId, { detail: `No reply on port ${cur.port} yet. See Server output.` })
    }
    if (watchers.has(repoId)) watchers.set(repoId, setTimeout(tick, row(repoId)?.status === 'starting' ? 1000 : 5000))
  }
  watchers.set(repoId, setTimeout(tick, 500))
}

/** Stops the app: SIGTERM to the pane's whole process group (npm and the node it started), SIGKILL after 3s, then the session. */
async function kill(repoId: string): Promise<void> {
  const session = previewSession(repoId)
  if (await tmux.hasSession(session)) {
    const pid = (await tmux.paneDeadStatus(session)) === null ? await tmux.panePid(session) : null
    if (pid) {
      try { process.kill(-pid, 'SIGTERM') } catch {}
      if (!(await waitFor(async () => (await tmux.paneDeadStatus(session)) !== null, 3000))) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    }
    await tmux.killSession(session)
  }
  const port = row(repoId)?.port; if (port) await waitFor(async () => !(await portBusy(port)), 3000)
}

/** Start (or restart) the repo's app. Throws when HQ can't tell how to start it or no preview port is free. */
export function startPreview(repoId: string, why: string | null = null): Promise<ReturnType<typeof previewView>> {
  return serial(repoId, async () => {
    const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
    const cur = row(repoId)
    const command = cur?.command ?? detectCommand(repo.path)
    if (!command) throw new Error(`HQ can't tell how to start ${repo.name}: its package.json has no dev or start script. Set a command with ⚙.`)
    unwatch(repoId); await kill(repoId)
    const port = await pickPort(cur?.port ?? null); if (!port) { save(repoId, { status: 'stopped', detail: 'ports 3090–3099 are all in use' }); throw new Error('ports 3090–3099 are all in use') }
    const branch = await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    const head = await git(repo.path, ['rev-parse', '--short', 'HEAD']).catch(() => null)
    const install = installStep(repo.path)
    const dir = path.join(PATHS.home, 'previews', repoId); fs.mkdirSync(dir, { recursive: true })
    const script = path.join(dir, 'run.sh')
    fs.writeFileSync(script, runScript({ repoPath: repo.path, command, port, install, label: `${branch ?? '?'}@${head ?? '?'}` }), { mode: 0o700 })
    const t = now()
    await tmux.newSession(previewSession(repoId), `bash ${shq(script)}`, { cwd: repo.path })
    await tmux.tmux('set-option', '-t', previewSession(repoId), 'status', 'off').catch(() => {}) // the Server tab is just the app's output
    save(repoId, { status: 'starting', detail: install ? `installing packages (${install})…` : 'starting…', port, url: null, frameable: null, branch, head, started_at: t })
    emit({ agentId: null, source: 'system', kind: 'preview.started', payload: { repo: repo.name, command, port, head, install, why } })
    watch(repoId, t, why)
    return previewView(repo)
  })
}
export function stopPreview(repoId: string): Promise<ReturnType<typeof previewView>> {
  return serial(repoId, async () => {
    const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
    unwatch(repoId); await kill(repoId)
    save(repoId, { status: 'stopped', detail: null, url: null, frameable: null })
    emit({ agentId: null, source: 'system', kind: 'preview.stopped', payload: { repo: repo.name } })
    return previewView(repo)
  })
}
/** The user's own start command for this repo (null: back to HQ's pick). A preview that's on restarts with it. */
export async function setPreviewCommand(repoId: string, command: string | null): Promise<ReturnType<typeof previewView>> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  save(repoId, { command: command?.trim() || null })
  if ((row(repoId)?.status ?? 'stopped') !== 'stopped') return startPreview(repoId, `restarted with ${command?.trim() || `${detectCommand(repo.path) ?? '?'} (auto)`}`)
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
  await startPreview(repoId, `restarted after ${keys.join(', ')} merged`)
    .catch((err) => emit({ agentId: null, source: 'system', kind: 'preview.error', payload: { repo: repo.name, error: String(err) } }))
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
