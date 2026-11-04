// Try it (Bug 22): the preview can run a finished ticket's worktree before the user merges it. The tried app gets a copy of the
// main checkout's own data (git-ignored files such as a data/ folder), so the user sees their own data, not the engineer's test
// items; what they do while trying never touches main's copy.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { git } from './reposync.ts'
import type { Ticket } from './records.ts'

/** A ticket whose work is finished and waiting for the merge, with its worktree still on disk and nothing to fix first. */
export const tryable = (t: Ticket | undefined): t is Ticket & { worktree_path: string } =>
  !!t && (t.status === 'pr_ready' || t.status === 'pr_open') && t.conflict_files == null && !!t.worktree_path && fs.existsSync(t.worktree_path)

/** Never copied: HQ's and git's folders, and build output or caches, which belong to the code they were built from. Installed
 *  packages are copied only when the worktree has none: an install there would leave new files behind (a fresh lockfile) that
 *  block the worktree's removal after the merge, or end up committed. */
const SKIP = new Set(['.git', '.claude', '.hq-plans', 'dist', 'build', 'out', '.next', '.nuxt', '.vite', '.turbo', '.cache', '.parcel-cache', 'coverage'])
const cp = (args: string[]): Promise<void> => new Promise((resolve, reject) => execFile('cp', args, (err) => err ? reject(err) : resolve()))

/** Copies the main checkout's top-level git-ignored files and folders (SKIP aside) over the worktree's own (node_modules only
 *  when missing), plus `files`: the deeper ones the launch recipe names (an app in a subfolder keeps its .env and database
 *  there: Bug 38), each only if git ignores it, so a tracked file is never overwritten. APFS clone on macOS (`cp -c`), plain
 *  copy elsewhere. Returns what it copied. */
export async function copyMainData(repoPath: string, wtPath: string, files: string[] = []): Promise<string[]> {
  const out = await git(repoPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']).catch(() => '')
  const top = [...new Set(out.split('\n').map((l) => l.trim()).filter((l) => l && !l.replace(/\/$/, '').includes('/')).map((l) => l.replace(/\/$/, '')))]
  const ignored = (f: string) => git(repoPath, ['check-ignore', '-q', f]).then(() => true, () => false)
  const deeper: string[] = []
  for (const f of files.map((x) => path.normalize(x).replace(/\/$/, ''))) if (f.includes('/') && !top.includes(f) && await ignored(f)) deeper.push(f)
  const done: string[] = []
  for (const name of [...top.filter((n) => !SKIP.has(n)), ...deeper]) {
    const from = path.join(repoPath, name), to = path.join(wtPath, name)
    if (!fs.existsSync(from) || (path.basename(name) === 'node_modules' && fs.existsSync(to))) continue
    fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(path.dirname(to), { recursive: true })
    try { await cp(['-cRp', from, to]) } catch { fs.rmSync(to, { recursive: true, force: true }); await cp(['-Rp', from, to]) }
    done.push(name)
  }
  return done
}
