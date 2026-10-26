// "Merge into main" for local-only repos, with fixed rules like the rest of HQ's git work. The merge is worked out off to
// the side (merge-tree), committed (commit-tree), and main then moves to it as a fast-forward, which updates the branch and
// the files together or not at all, so a refusal never leaves anything half done in the user's checkout. Git only, no DB;
// hooks off.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { git } from './reposync.ts'

export type MergeResult = { ok: true; sha: string; already: boolean } | { ok: false; why: string }
const names = (files: string[]): string => files.length > 5 ? `${files.slice(0, 5).join(', ')} and ${files.length - 5} more` : files.join(', ')

/** Merge `branch` into `into` in the checkout at `repoPath` with a merge commit (subject, then each body paragraph). */
export async function mergeIntoMain(repoPath: string, o: { branch: string; into: string; subject: string; body: string[] }): Promise<MergeResult> {
  const repo = path.basename(repoPath)
  const tip = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}^{commit}`]).catch(() => '')
  if (!tip) return { ok: false, why: `Branch ${o.branch} is gone, so there's nothing to merge.` }
  const main = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.into}^{commit}`]).catch(() => '')
  if (!main) return { ok: false, why: `${repo} has no ${o.into} branch.` }
  if (await git(repoPath, ['merge-base', '--is-ancestor', tip, main]).then(() => true, () => false)) return { ok: true, sha: main, already: true }
  const head = await git(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')
  if (head !== o.into) return { ok: false, why: `${repo} is on ${head ? `branch ${head}` : 'a detached HEAD'}, not ${o.into}. Switch it back (git switch ${o.into}) and press Merge again.` }
  for (const [p, what] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
    const gp = await git(repoPath, ['rev-parse', '--git-path', p!])
    if (fs.existsSync(path.isAbsolute(gp) ? gp : path.join(repoPath, gp))) return { ok: false, why: `A ${what} is in progress in ${repo}. Finish or abort it, then press Merge again.` }
  }
  const dirty = (await git(repoPath, ['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean) // tracked files, staged or not
  if (dirty.length) return { ok: false, why: `${repo} has uncommitted changes in ${names(dirty)}. Commit or stash them, then press Merge again.` }
  const m = await mergeTree(repoPath, main, tip)
  if ('error' in m) return { ok: false, why: `git couldn't work out the merge: ${m.error}` }
  if ('conflicts' in m) return { ok: false, why: `${o.branch} conflicts with ${o.into} in ${names(m.conflicts)}. Nothing was changed. Merge it by hand; HQ notices within 2 minutes.` }
  const sha = await git(repoPath, ['commit-tree', m.tree, '-p', main, '-p', tip, '-m', o.subject, ...o.body.flatMap((b) => ['-m', b])])
  try { await git(repoPath, ['merge', '--ff-only', '-q', sha]) } catch (e) {
    const s = (e as Error).message; const files = s.split('\n').filter((l) => l.startsWith('\t')).map((l) => l.trim())
    return { ok: false, why: files.length ? `The merge would overwrite files in ${repo} that git doesn't track: ${names(files)}. Move them away and press Merge again.` : `git wouldn't move ${o.into}: ${s.split('\n')[0]}` }
  }
  return { ok: true, sha, already: false }
}

/** `git merge-tree --write-tree`: the merged tree (exit 0), or the conflicted files (exit 1). Touches no checkout. */
function mergeTree(repoPath: string, a: string, b: string): Promise<{ tree: string } | { conflicts: string[] } | { error: string }> {
  return new Promise((resolve) => execFile('git', ['-c', 'core.hooksPath=/dev/null', 'merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { cwd: repoPath }, (err, out, errOut) => {
    const lines = String(out).split('\n'); const code = err ? (err as { code?: number }).code : 0
    if (code === 0) resolve({ tree: lines[0]!.trim() })
    else if (code === 1) resolve({ conflicts: [...new Set(lines.slice(1).map((l) => l.trim()).filter(Boolean))] })
    else resolve({ error: String(errOut || err?.message).trim().split('\n')[0] ?? 'unknown error' })
  }))
}
