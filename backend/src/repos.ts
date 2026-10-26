// Repos: adding one (path or the folder dialog) and keeping its checkout in step with GitHub (see reposync.ts).
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { GH_CONFIG_DIR, GITHUB_ACCOUNT } from './config.ts'
import { attention, resolveKind } from './attention.ts'
import { findRepos, repoRoot, syncCheckout, type RepoCandidate } from './reposync.ts'
import { canPush } from './github.ts'
import { pickFolder } from './picker.ts'
import { one, run, now } from './db.ts'
import { bus, emit, patch } from './events.ts'
import { id } from './util.ts'
import { getRepo, repos, type Repo } from './records.ts'

export const ghOpts = () => ({ ghConfigDir: GH_CONFIG_DIR, account: GITHUB_ACCOUNT })

export const git = (cwd: string, ...args: string[]): Promise<string> => new Promise((resolve, reject) =>
  execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd }, (err, out, errOut) => err ? reject(new Error(errOut || err.message)) : resolve(out.trim())))

const syncing = new Map<string, Promise<Repo>>() // one sync per repo at a time (git index/ref locks)
export async function addRepo(p: string, name?: string): Promise<Repo> {
  const root = await repoRoot(path.resolve(p.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '')))
  const existing = one<Repo>('SELECT * FROM repos WHERE path = ?', root); if (existing) return syncRepo(existing.id)
  const r = { id: id('repo'), name: name ?? path.basename(root), path: root, default_branch: 'main' }
  run('INSERT INTO repos(id, name, path, remote, default_branch, context_doc_path, network_allowlist, ignore_patterns, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    r.id, r.name, r.path, null, 'main', null, '[]', '[]', now())
  patch('repo', r.id, getRepo(r.id) as unknown as Record<string, unknown>)
  return syncRepo(r.id)
}
/** "Add repo…": native folder dialog, then the repo in (or directly inside) the chosen folder. Several found → the UI asks. */
export async function pickRepo(): Promise<Repo | { cancelled: true } | { choose: RepoCandidate[]; in: string }> {
  const last = repos().at(-1); const home = process.env.HOME ?? '/'
  const start = [last && path.dirname(last.path), path.join(home, 'Documents')].find((d): d is string => !!d && fs.existsSync(d)) ?? home
  const picked = await pickFolder(start); if (!picked) return { cancelled: true }
  const found = await findRepos(picked)
  if (found.length === 1) return addRepo(found[0]!.path)
  if (found.length > 1) return { choose: found, in: picked }
  throw new Error(`No git repo in ${picked} or the folders directly inside it`)
}
/** Deterministic sync (see reposync.ts): GitHub repos are fetched as the HQ account and local main fast-forwarded when safe. */
export function syncRepo(repoId: string): Promise<Repo> {
  const prev = syncing.get(repoId); if (prev) return prev
  const job = (async () => {
    const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
    emit({ agentId: null, source: 'system', kind: 'repo.sync.start', payload: { repo: repo.name } })
    const r = await syncCheckout(repo.path, ghOpts())
    const fields: Record<string, string | number | null> = { kind: r.kind, sync_ok: r.ok ? 1 : 0, sync_status: r.status, sync_detail: r.detail, synced_at: now() }
    if (r.ok) Object.assign(fields, { remote: r.remote, default_branch: r.defaultBranch, head: r.head })
    if (r.ok && r.kind === 'github' && r.slug) { const cp = await canPush(r.slug, ghOpts()); fields.can_push = cp === null ? null : cp ? 1 : 0 } // shown in the UI before anything needs a push
    const keys = Object.keys(fields); run(`UPDATE repos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]!), repoId)
    patch('repo', repoId, fields)
    emit({ agentId: null, source: 'system', kind: `repo.sync.${r.status}`, payload: { repo: repo.name, detail: r.detail } })
    if (r.ok) resolveKind(`repo_sync:${repoId}`, null); else attention(`repo_sync:${repoId}`, `${repo.name}: ${r.detail}`)
    if (r.ok) bus.emit('repo.synced', repoId) // a fresh fetch may show a merge (listeners.ts)
    return getRepo(repoId)!
  })().finally(() => syncing.delete(repoId))
  syncing.set(repoId, job); return job
}
/** Sync before work starts; a GitHub repo that could not be fetched blocks the launch. */
export async function ensureFresh(repoId: string): Promise<Repo> {
  const repo = await syncRepo(repoId)
  if (repo.kind === 'github' && !repo.sync_ok) throw new Error(`${repo.name} could not be brought up to date: ${repo.sync_detail}`)
  return repo
}
