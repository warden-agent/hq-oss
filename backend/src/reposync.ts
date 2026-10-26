// Deterministic repo sync. A repo whose origin is on GitHub is fetched as the HQ GitHub account (gh credential helper with
// that account's GH_CONFIG_DIR, every other helper cleared) and its local default branch is fast-forwarded when that is safe.
// Anything else is a local-only repo: no network. Never destructive: no reset, no checkout, no stash. No DB access here.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

export type SyncResult = {
  kind: 'local' | 'github'; ok: boolean
  status: 'local' | 'up_to_date' | 'pulled' | 'fetched' | 'error'
  detail: string; path: string; slug: string | null; remote: string | null; defaultBranch: string; head: string | null
}
export type SyncOpts = { ghConfigDir: string; account: string; fetchUrl?: string /* tests: fetch from here instead of github.com */; timeoutMs?: number }

type GitOpts = { net?: SyncOpts; allowFail?: boolean }
class GitError extends Error {
  stderr: string; timedOut: boolean
  constructor(message: string, stderr: string, timedOut: boolean) { super(message); this.stderr = stderr; this.timedOut = timedOut }
}

export function git(cwd: string, args: string[], o: GitOpts = {}): Promise<string> {
  const pre = ['-c', 'core.hooksPath=/dev/null']
  if (o.net) pre.push('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential')
  const env = o.net ? { ...process.env, GH_CONFIG_DIR: o.net.ghConfigDir, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } : process.env
  return new Promise((resolve, reject) => execFile('git', [...pre, ...args], { cwd, env, timeout: o.net ? (o.net.timeoutMs ?? 60_000) : 30_000 }, (err, out, errOut) => {
    if (err) reject(new GitError(String(errOut || err.message).trim(), String(errOut ?? ''), (err as { killed?: boolean }).killed === true)); else resolve(out.trim())
  }))
}
const tryGit = (cwd: string, args: string[]): Promise<string> => git(cwd, args).catch(() => '')

/** `owner/repo` for a github.com remote URL (https, scp-style ssh, ssh://), else null. */
export function parseGithubRemote(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

export function explain(e: unknown, slug: string, account: string): string {
  const g = e instanceof GitError ? e : null; const s = g?.stderr ?? String(e)
  if (g?.timedOut) return `timed out reaching GitHub for ${slug}`
  if (/repository .* not found|authentication failed|could not read username|terminal prompts disabled|403|denied/i.test(s)) return `${account} can't access ${slug}: add ${account} as a collaborator on GitHub`
  if (/could not resolve host|unable to access|failed to connect|network/i.test(s)) return `can't reach github.com (network): ${s.split('\n')[0]}`
  return s.split('\n')[0] || 'git failed'
}

/** Whether `branch` is contained in `into` (merge commit or fast-forward; squash merges need GitHub, see github.ts). */
export function branchMerged(repoPath: string, branch: string, into: string): Promise<boolean> {
  return git(repoPath, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, into]).then(() => true, () => false)
}

/** Resolve the work-tree root of `p`, or throw a plain-English error. */
export async function repoRoot(p: string): Promise<string> {
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`${p} does not exist or is not a folder`)
  try { return await git(p, ['rev-parse', '--show-toplevel']) } catch { throw new Error(`${p} is not a git repository`) }
}

export type RepoCandidate = { path: string; name: string; github: string | null }
/** The repo(s) for a folder the user picked: the repo it is in (walking up), else the repos directly inside it (a plain
 *  wrapper folder around a clone; hidden folders and node_modules skipped). GitHub ones first. Read-only, no network. */
export async function findRepos(p: string): Promise<RepoCandidate[]> {
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`${p} does not exist or is not a folder`)
  const up = await tryGit(p, ['rev-parse', '--show-toplevel'])
  const roots = up ? [up] : []
  if (!up) for (const d of fs.readdirSync(p, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue
    const c = path.join(p, d.name); if (!fs.existsSync(path.join(c, '.git'))) continue
    const top = await tryGit(c, ['rev-parse', '--show-toplevel']); if (top && top === fs.realpathSync(c)) roots.push(top)
  }
  const found = await Promise.all(roots.map(async (r) => ({ path: r, name: path.basename(r), github: parseGithubRemote(await tryGit(r, ['remote', 'get-url', 'origin'])) })))
  return found.sort((a, b) => Number(!a.github) - Number(!b.github) || a.name.localeCompare(b.name))
}

export async function syncCheckout(p: string, o: SyncOpts): Promise<SyncResult> {
  const root = await repoRoot(p)
  const origin = await tryGit(root, ['remote', 'get-url', 'origin'])
  const slug = parseGithubRemote(origin)
  if (!slug) {
    const branch = (await tryGit(root, ['symbolic-ref', '--short', 'HEAD'])) || 'main'
    return { kind: 'local', ok: true, status: 'local', detail: origin ? `Local only (origin ${origin} is not GitHub); nothing to pull` : 'Local only (no GitHub remote); nothing to pull', path: root, slug: null, remote: null, defaultBranch: branch, head: await tryGit(root, ['rev-parse', 'HEAD']) || null }
  }
  const url = o.fetchUrl ?? `https://github.com/${slug}.git`
  const base = { kind: 'github' as const, path: root, slug, remote: url }
  let branch: string
  try {
    const sym = await git(root, ['ls-remote', '--symref', url, 'HEAD'], { net: o })
    const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(sym); if (!m) throw new Error(`could not read the default branch of ${slug}`)
    branch = m[1]!
    await git(root, ['fetch', '--no-tags', url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { net: o })
  } catch (e) {
    return { ...base, ok: false, status: 'error', detail: explain(e, slug, o.account), defaultBranch: 'main', head: null }
  }
  await tryGit(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`])
  const remoteSha = await git(root, ['rev-parse', `refs/remotes/origin/${branch}`])
  const done = (status: SyncResult['status'], detail: string): SyncResult => ({ ...base, ok: true, status, detail, defaultBranch: branch, head: remoteSha })
  const short = (s: string) => s.slice(0, 7)
  const localSha = await tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (localSha === remoteSha) return done('up_to_date', `${branch} is up to date with GitHub (${short(remoteSha)})`)
  if (localSha) {
    const behind = await git(root, ['merge-base', '--is-ancestor', localSha, remoteSha]).then(() => true, () => false)
    if (!behind) return done('fetched', `fetched origin/${branch} (${short(remoteSha)}); local ${branch} has commits not on GitHub, not pulled`)
  }
  const current = await tryGit(root, ['symbolic-ref', '--short', 'HEAD'])
  try {
    if (current === branch) {
      const dirty = await git(root, ['status', '--porcelain', '--untracked-files=no'])
      if (dirty) return done('fetched', `fetched origin/${branch} (${short(remoteSha)}); local ${branch} has uncommitted changes, not pulled`)
      await git(root, ['merge', '--ff-only', '--no-edit', `refs/remotes/origin/${branch}`])
    } else {
      await git(root, ['fetch', '.', `refs/remotes/origin/${branch}:refs/heads/${branch}`])
    }
  } catch (e) {
    return done('fetched', `fetched origin/${branch} (${short(remoteSha)}); local ${branch} not pulled: ${(e as Error).message.split('\n')[0]}`)
  }
  return done('pulled', localSha ? `pulled ${branch} ${short(localSha)} → ${short(remoteSha)}` : `created local ${branch} at ${short(remoteSha)}`)
}
