// Ticket worktrees under <repo>/.claude/worktrees/. Claude Code's --worktree locks its worktree ("claude session PAN-1 (pid
// 12974 start …)") and a killed session leaves that lock behind; HQ clears such locks once the session is gone, and removes
// a merged ticket's worktree when nothing in it would be lost. Git only, no DB. Never forced.
import path from 'node:path'
import { execFile } from 'node:child_process'
import { branchMerged, git } from './reposync.ts'

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
