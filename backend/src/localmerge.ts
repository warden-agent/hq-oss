// "Merge into main" for local-only repos, with fixed rules like the rest of HQ's git work. The merge is worked out off to
// the side (merge-tree), committed (commit-tree), and main then moves to it as a fast-forward, which updates the branch and
// the files together or not at all, so a refusal never leaves anything half done in the user's checkout. Git only, no DB;
// hooks off.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { git } from './reposync.ts'

export type MergeResult = { ok: true; sha: string; already: boolean } | { ok: false; why: string; conflicts?: string[] }
export const names = (files: string[]): string => files.length > 5 ? `${files.slice(0, 5).join(', ')} and ${files.length - 5} more` : files.join(', ')

/** Merge `branch` into `into` in the checkout at `repoPath` with a merge commit (subject, then each body paragraph). */
export async function mergeIntoMain(repoPath: string, o: { branch: string; into: string; subject: string; body: string[] }): Promise<MergeResult> {
  const repo = path.basename(repoPath)
  const tip = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}^{commit}`]).catch(() => '')
  if (!tip) return { ok: false, why: `Branch ${o.branch} is gone, so there's nothing to merge.` }
  const main = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.into}^{commit}`]).catch(() => '')
  if (!main) return { ok: false, why: `${repo} has no ${o.into} branch.` }
  if (await git(repoPath, ['merge-base', '--is-ancestor', tip, main]).then(() => true, () => false)) return { ok: true, sha: main, already: true }
  const busy = await checkoutProblem(repoPath, o.into, 'press Merge again'); if (busy) return { ok: false, why: busy }
  const m = await mergeTree(repoPath, main, tip)
  if ('error' in m) return { ok: false, why: `git couldn't work out the merge: ${m.error}` }
  if ('conflicts' in m) {
    const why = `${o.branch} conflicts with ${o.into} in ${names(m.conflicts)}. Nothing was changed.`
      + ` Press Fix conflicts to have its engineer merge ${o.into} in, or merge it by hand; HQ notices within 2 minutes.`
    return { ok: false, conflicts: m.conflicts, why }
  }
  const sha = await git(repoPath, ['commit-tree', m.tree, '-p', main, '-p', tip, '-m', o.subject, ...o.body.flatMap((b) => ['-m', b])])
  try { await git(repoPath, ['merge', '--ff-only', '-q', sha]) } catch (e) {
    const s = (e as Error).message; const files = s.split('\n').filter((l) => l.startsWith('\t')).map((l) => l.trim())
    return { ok: false, why: files.length ? `The merge would overwrite files in ${repo} that git doesn't track: ${names(files)}. Move them away and press Merge again.` : `git wouldn't move ${o.into}: ${s.split('\n')[0]}` }
  }
  return { ok: true, sha, already: false }
}

/** The files `branch` would conflict in if merged into `base` (any refs or commits): [] when it merges cleanly, null when git
 *  couldn't tell (a ref is missing, say). Touches no checkout. */
export async function conflictsWith(repoPath: string, base: string, branch: string): Promise<string[] | null> {
  const m = await mergeTree(repoPath, base, branch)
  return 'tree' in m ? [] : 'conflicts' in m ? m.conflicts : null
}
/** Why the checkout at `repoPath` can't safely move `into` right now, or null. */
async function checkoutProblem(repoPath: string, into: string, press: string): Promise<string | null> {
  const repo = path.basename(repoPath)
  const head = await git(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')
  if (head !== into) return `${repo} is on ${head ? `branch ${head}` : 'a detached HEAD'}, not ${into}. Switch it back (git switch ${into}) and ${press}.`
  for (const [p, what] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
    const gp = await git(repoPath, ['rev-parse', '--git-path', p!])
    if (fs.existsSync(path.isAbsolute(gp) ? gp : path.join(repoPath, gp))) return `A ${what} is in progress in ${repo}. Finish or abort it, then ${press}.`
  }
  const dirty = (await git(repoPath, ['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean) // tracked files, staged or not
  return dirty.length ? `${repo} has uncommitted changes in ${names(dirty)}. Commit or stash them, then ${press}.` : null
}
/** One new commit on `into` whose files are `start`'s: main goes back with nothing rewritten. Same rules as a merge. */
export async function restoreMain(repoPath: string, into: string, start: string, subject: string): Promise<MergeResult> {
  const busy = await checkoutProblem(repoPath, into, 'press Undo again'); if (busy) return { ok: false, why: busy }
  const main = await git(repoPath, ['rev-parse', `refs/heads/${into}`])
  const sha = await git(repoPath, ['commit-tree', `${start}^{tree}`, '-p', main, '-m', subject])
  try { await git(repoPath, ['merge', '--ff-only', '-q', sha]) } catch (e) { return { ok: false, why: `git wouldn't move ${into}: ${(e as Error).message.split('\n')[0]}` } }
  return { ok: true, sha, already: false }
}
/** The commit `branch` would make merged into `base`, for testing: nothing points at it and no checkout changes. */
export async function combinedCommit(repoPath: string, base: string, branch: string): Promise<{ sha: string } | { conflicts: string[] } | { error: string }> {
  const m = await mergeTree(repoPath, base, branch)
  if (!('tree' in m)) return m
  // HQ's own name: it's thrown away after the test, and a machine with no git identity must still be able to test
  const who = ['-c', 'user.name=HQ', '-c', 'user.email=hq@localhost']
  try { return { sha: await git(repoPath, [...who, 'commit-tree', m.tree, '-p', base, '-p', branch, '-m', `HQ test: ${branch} on ${base}`]) } }
  catch (e) { return { error: (e as Error).message } }
}
/** `git merge-tree --write-tree`: the merged tree (exit 0), or the conflicted files (exit 1, after the tree's id; a bad ref also
 *  exits 1, with no tree). Touches no checkout. */
export function mergeTree(repoPath: string, a: string, b: string): Promise<{ tree: string } | { conflicts: string[] } | { error: string }> {
  return new Promise((resolve) => execFile('git', ['-c', 'core.hooksPath=/dev/null', 'merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { cwd: repoPath }, (err, out, errOut) => {
    const lines = String(out).split('\n'); const code = err ? (err as { code?: number }).code : 0
    if (code === 0) resolve({ tree: lines[0]!.trim() })
    else if (code === 1 && /^[0-9a-f]{40,64}$/.test(lines[0]!.trim())) resolve({ conflicts: [...new Set(lines.slice(1).map((l) => l.trim()).filter(Boolean))] })
    else resolve({ error: String(errOut || err?.message).trim().split('\n')[0] ?? 'unknown error' })
  }))
}
