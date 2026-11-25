// Ticket worktrees under <repo>/.claude/worktrees/. Claude Code's --worktree locks its worktree ("claude session APP-1 (pid
// 12974 start …)") and a killed session leaves that lock behind; HQ clears such locks once the session is gone, and removes
// a merged ticket's worktree when nothing in it would be lost. Git only, no DB. Never forced.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { branchMerged, git } from './reposync.ts'
import { packageManager } from './apprun.ts'

export type Worktree = { path: string; branch: string | null; locked: string | null }
/** The repo's linked worktrees (`git worktree list --porcelain`, main checkout left out). `locked` is the lock's reason. */
export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const blocks = (await git(repoPath, ['worktree', 'list', '--porcelain'])).split('\n\n').slice(1)
  return blocks.map((b) => {
    const lines = b.split('\n'); const field = (k: string) => lines.find((l) => l === k || l.startsWith(`${k} `))
    const lock = field('locked'), branch = field('branch')
    return { path: field('worktree')!.slice('worktree '.length), branch: branch ? branch.slice('branch refs/heads/'.length) : null, locked: lock === undefined ? null : lock.slice('locked'.length).trim() }
  })
}
/** The pid in Claude Code's own lock reason, else null (a lock someone else set isn't HQ's to clear). */
export const claudeLockPid = (reason: string | null): number | null => { const m = /^claude session .+ \(pid (\d+)\b/.exec(reason ?? ''); return m ? Number(m[1]) : null }
/** Whether `pid` may still be the Claude Code session that locked a worktree: it runs, and it's a claude binary or node (an
 *  npm install). A pid since reused by some other program counts as gone. */
export function claudeRunning(pid: number): Promise<boolean> {
  try { process.kill(pid, 0) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return Promise.resolve(false) }
  // macOS's comm is the program's path; Linux's is a thread name, which node can change, so its command line is checked too
  const ps = (field: string): Promise<string> => new Promise((resolve) => execFile('ps', ['-o', `${field}=`, '-p', String(pid)], (err, out) => resolve(err ? '' : String(out).trim())))
  const ok = (prog: string) => /^(claude(-[\w.]+)?|node)$/.test(path.basename(prog))
  return ps('comm').then(async (comm) => !!comm && (ok(comm) || ok((await ps('args')).split(/\s+/)[0] ?? '')))
}
const ticketWorktree = (repoPath: string, p: string): boolean => p.startsWith(path.join(repoPath, '.claude', 'worktrees') + path.sep)

/** Unlock ticket worktrees whose Claude Code session is gone. Returns the paths it unlocked. */
export async function unlockStale(repoPath: string, running = claudeRunning): Promise<string[]> {
  const done: string[] = []
  for (const w of await listWorktrees(repoPath).catch(() => [])) {
    const pid = claudeLockPid(w.locked)
    if (!ticketWorktree(repoPath, w.path) || pid === null || await running(pid)) continue
    if (await git(repoPath, ['worktree', 'unlock', w.path]).then(() => true, () => false)) done.push(w.path)
  }
  return done
}

/** Remove a merged ticket's worktree when nothing in it would be lost: its branch is in `into`, it has no changes or untracked
 *  files (ignored ones such as node_modules/ don't count), and no live session holds it. The branch is kept. */
export async function removeMerged(repoPath: string, wtPath: string, branch: string, into: string, running = claudeRunning): Promise<{ removed: boolean; why?: string }> {
  const w = (await listWorktrees(repoPath)).find((x) => x.path === wtPath)
  if (!w || !ticketWorktree(repoPath, wtPath)) return { removed: false, why: 'not a ticket worktree of this repo' }
  if (w.branch !== branch) return { removed: false, why: `it is on ${w.branch ?? 'a detached HEAD'}, not ${branch}` }
  if (!(await branchMerged(repoPath, branch, `refs/heads/${into}`))) return { removed: false, why: `${branch} is not in ${into}` }
  if (await git(wtPath, ['status', '--porcelain']).catch(() => 'unreadable')) return { removed: false, why: 'it has uncommitted changes or untracked files' }
  if (w.locked !== null) {
    const pid = claudeLockPid(w.locked)
    if (pid === null || await running(pid)) return { removed: false, why: `it is locked (${w.locked || 'no reason given'})` }
    await git(repoPath, ['worktree', 'unlock', wtPath])
  }
  await git(repoPath, ['worktree', 'remove', wtPath]) // git itself refuses if anything would be lost
  return { removed: true }
}

/** A new ticket worktree has no installed packages (git leaves ignored folders out), so every engineer used to run `npm ci`
 *  first, and one skipped the tests. Give the worktree a copy of the main checkout's `node_modules`, at the root and in each
 *  top-level folder with its own package.json. Only where the worktree has none yet and git ignores it there: a copy must
 *  never show up as new files to commit (the trailing / matters: a `node_modules/` rule only matches a folder). On macOS
 *  `cp -c` clones on APFS (fast, no extra disk); elsewhere a plain copy. `-p` keeps times, so the preview's install check
 *  still sees the packages as current. Returns the folders seeded. */
export async function seedPackages(repoPath: string, wtPath: string): Promise<string[]> {
  const subs = fs.readdirSync(wtPath, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name)
  const done: string[] = []
  for (const rel of ['.', ...subs]) {
    const from = path.join(repoPath, rel, 'node_modules'), to = path.join(wtPath, rel, 'node_modules')
    if (!fs.existsSync(path.join(wtPath, rel, 'package.json')) || !fs.existsSync(from) || fs.existsSync(to)) continue
    if (!(await git(wtPath, ['check-ignore', '-q', path.join(rel, 'node_modules') + '/']).then(() => true, () => false))) continue
    if (await copyPackages(repoPath, rel, to)) done.push(rel)
  }
  return done
}
/** Bug 393: the file each package manager writes into node_modules last, once its install is done: npm's own record and Yarn 1's .yarn-integrity
 *  (`npm ci` and Yarn 1 delete theirs first), Yarn 2+'s .yarn-state.yml and pnpm's .modules.yaml (rewritten at the end). Watched on npm 11.7.0, Yarn
 *  1.22.22 and 4, pnpm 9.15.9: each is written after node_modules/.bin. Bun 1.4.5 writes none. */
const INSTALLED = ['.package-lock.json', '.yarn-integrity', '.yarn-state.yml', '.modules.yaml']
/** How the finished install in the node_modules `nm` looks now (its last file's inode, size and time), or null when none has finished there or one is
 *  under way: no such file, or node_modules/.bin changed after it (pnpm and an npm install that adds packages keep the old file until they end). */
function installedMark(nm: string): string | null {
  const stat = (f: string) => { try { return fs.statSync(path.join(nm, f)) } catch { return null } }
  const m = INSTALLED.map(stat).find((s) => s?.isFile()); if (!m) return null
  const bin = stat('.bin'); return bin && bin.mtimeMs > m.mtimeMs ? null : `${m.ino}:${m.size}:${m.mtimeMs}`
}
const workspaceRoot = (d: string): boolean => {
  if (fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) return true
  try { return !!JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'))?.workspaces } catch { return false }
}
/** The finished install that main's `<rel>/node_modules` comes from: its own, else (a workspace member) the workspace root's. 'bun': Bun's, which leaves
 *  no file to tell, so it is copied as before (its installs take well under a second). */
function installedFrom(repoPath: string, rel: string): string | null {
  const dir = path.join(repoPath, rel), member = rel !== '.' && workspaceRoot(repoPath)
  if (packageManager(dir).tool === 'bun' || (member && packageManager(repoPath).tool === 'bun')) return 'bun'
  return installedMark(path.join(dir, 'node_modules')) ?? (member ? installedMark(path.join(repoPath, 'node_modules')) : null)
}
/** Bug 393: copies main's `<rel>/node_modules` to `to` only as a finished install left it. The preview's first start (`npm ci`) empties and refills it,
 *  and a copy taken then lacked packages: HQ's look skipped the install (there was a node_modules) and blamed the ticket for "vite: command not found".
 *  Not copied while an install is under way or when none finished; one that starts during the copy is caught after it (its file is gone or new) and the
 *  copy removed. Either way the checkout installs its own. Returns whether it copied. */
export async function copyPackages(repoPath: string, rel: string, to: string, copy = copyTree): Promise<boolean> {
  const before = installedFrom(repoPath, rel); if (before === null) return false
  await copy(path.join(repoPath, rel, 'node_modules'), to)
  if (installedFrom(repoPath, rel) === before) return true
  fs.rmSync(to, { recursive: true, force: true }); return false
}
const cp = (args: string[]): Promise<void> => new Promise((resolve, reject) => execFile('cp', args, (err) => err ? reject(err) : resolve()))
/** Copy a folder: an APFS clone if the system can, else a plain copy (Linux's cp has no -c). */
export async function copyTree(from: string, to: string): Promise<void> {
  try { await cp(['-cRp', from, to]) } catch { fs.rmSync(to, { recursive: true, force: true }); await cp(['-Rp', from, to]) }
}

/** HQ's own folders (plans, worktrees) never show up as changes in the repo: listed in its .git/info/exclude. */
export const excludeHqFolders = (repoPath: string): Promise<void> => excludeLines(repoPath, ['.hq-plans/', '.claude/worktrees/'])
/** Adds the lines its .git/info/exclude lacks (one file for the main checkout and all its worktrees: git keeps it in the shared folder). */
async function excludeLines(checkout: string, lines: string[]): Promise<void> {
  if (!lines.length) return
  const excl = await git(checkout, ['rev-parse', '--git-path', 'info/exclude'])
  const exclPath = path.isAbsolute(excl) ? excl : path.join(checkout, excl)
  fs.mkdirSync(path.dirname(exclPath), { recursive: true }); const cur = fs.existsSync(exclPath) ? fs.readFileSync(exclPath, 'utf8') : ''
  const missing = lines.filter((p) => !cur.split('\n').includes(p))
  if (missing.length) fs.appendFileSync(exclPath, (cur.endsWith('\n') || !cur ? '' : '\n') + missing.map((p) => `${p}\n`).join(''))
}
/** Bug 263: what the preview's installs leave in a checkout (apprun.ts installLeftovers: node_modules, Yarn 2+'s .pnp.cjs and install
 *  state) never shows up as new files in it, so nobody commits them: listed in the repo's .git/info/exclude (this clone's own, never
 *  committed), each only where the project's .gitignore doesn't cover it already and git tracks nothing there (a Yarn zero-install
 *  project commits its .pnp.cjs and cache). `rels`: relative to the checkout. Returns the lines added. */
export async function excludeLeftovers(checkout: string, rels: string[]): Promise<string[]> {
  if (!rels.length) return []
  const prefix = await git(checkout, ['rev-parse', '--show-prefix']), add: string[] = [] // a part's folder below the repo's top: anchored there
  for (const f of rels) {
    if (await git(checkout, ['check-ignore', '-q', f]).then(() => true, () => false)) continue
    if (await git(checkout, ['ls-files', '--', f]) !== '') continue
    add.push(`/${prefix}${f}`)
  }
  await excludeLines(checkout, add); return add
}
