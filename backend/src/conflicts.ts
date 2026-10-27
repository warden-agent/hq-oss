// A finished ticket whose branch would conflict with main: noticing it (stored on the ticket, plus a ⚠ notice with Fix
// conflicts), naming the tickets that merged first, and HQ's message to the engineer that merges main in. Git and records only.
import { attention, resolveKindForTicket } from './attention.ts'
import { names } from './localmerge.ts'
import { git, parseGithubRemote } from './reposync.ts'
import { q } from './db.ts'
import { j } from './util.ts'
import { getTicket, setTicket, type Repo, type Ticket } from './records.ts'

/** What a ticket's branch merges into: `main` for a local repo; `origin/main` for a GitHub one (HQ fetches it; engineers can't). */
export function mergeBase(repo: Repo): { name: string; ref: string } {
  const github = repo.kind === 'github' && !!parseGithubRemote(repo.remote ?? '')
  return github ? { name: `origin/${repo.default_branch}`, ref: `refs/remotes/origin/${repo.default_branch}` } : { name: repo.default_branch, ref: `refs/heads/${repo.default_branch}` }
}
const ok = (p: Promise<unknown>): Promise<boolean> => p.then(() => true, () => false)

/** Merged tickets of the repo (any feature) that most likely caused the conflict: their branch is still there, isn't already in
 *  `t`'s branch, and changed one of `files` since `t`'s branch forked from `base`. Oldest merge first; [] when none fits. */
export async function whoMergedFirst(repo: Repo, t: Ticket, files: string[], base: string): Promise<string[]> {
  if (!t.branch) return []
  const fork = await git(repo.path, ['merge-base', `refs/heads/${t.branch}`, base]).catch(() => ''); if (!fork) return []
  const merged = q<Ticket>(`SELECT t.* FROM tickets t JOIN features f ON f.id = t.feature_id
    WHERE f.repo_id = ? AND t.status = 'merged' AND t.id != ? AND t.branch IS NOT NULL ORDER BY t.updated_at`, repo.id, t.id)
  const out: string[] = []
  for (const m of merged) {
    const tip = await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${m.branch}^{commit}`]).catch(() => ''); if (!tip) continue
    if (await ok(git(repo.path, ['merge-base', '--is-ancestor', tip, `refs/heads/${t.branch}`]))) continue // already in this branch
    const changed = (await git(repo.path, ['diff', '--name-only', fork, tip]).catch(() => '')).split('\n')
    if (changed.some((f) => files.includes(f))) out.push(m.key)
  }
  return out
}

/** Records that `t` conflicts with `base` in `files` and raises the ⚠ notice, once: a notice the user ticked off stays off until
 *  the files or the tickets that merged first change (the box keeps Fix conflicts either way). */
export function setConflict(t: Ticket, files: string[], merged: string[], base: string): void {
  if (JSON.stringify(files) === (t.conflict_files ?? '') && JSON.stringify(merged) === (t.conflict_with ?? '')) return
  setTicket(t.id, { conflict_files: JSON.stringify(files), conflict_with: JSON.stringify(merged) }); resolveKindForTicket('merge_conflict', t.id)
  const where = files.length ? `in ${names(files)}` : "(GitHub says so; HQ's copy doesn't show which files yet)"
  attention('merge_conflict', `${t.key} conflicts with ${base} ${where}${merged.length ? ` (${merged.join(', ')} merged first)` : ''}. Press Fix conflicts and its engineer merges ${base} in.`,
    { agentId: t.assignee_agent_id, ticketId: t.id })
}
/** `t` merges cleanly again (fixed, by hand or by its engineer): the record and the notice go. */
export function clearConflict(ticketId: string): void {
  const t = getTicket(ticketId); if (!t) return
  if (t.conflict_files !== null || t.conflict_with !== null) setTicket(t.id, { conflict_files: null, conflict_with: null })
  resolveKindForTicket('merge_conflict', t.id)
}
export const conflictFiles = (t: Ticket): string[] => j<string[]>(t.conflict_files, [])

/** HQ's instructions to the engineer that fixes the conflict: to a live engineer as a message, or as a fresh one's launch prompt.
 *  No `files`: the branch already merges cleanly (a fix the last engineer didn't finish), so only the finishing steps are left. */
export function fixConflictsText(o: { t: Ticket; base: string; files: string[]; merged: string[]; inProgress: boolean; launch?: { worktree: string } }): string {
  const { t, base } = o
  const list = o.files.length > 20 ? `${o.files.slice(0, 20).join(', ')} and ${o.files.length - 20} more` : o.files.join(', ')
  const intro = o.launch ? `You are the engineer for ticket ${t.key} (${t.size}): ${t.title}. Its work is already finished and committed on branch ${t.branch}`
    + ` in your worktree ${o.launch.worktree}; call get_ticket for its spec and the handoff so far.\n\n` : ''
  const first = o.merged.length ? `${o.merged.join(', ')} merged first, and now` : 'Now'
  const what = o.files.length ? `main has moved on since you finished ${t.key}. ${first} ${t.branch} conflicts with ${base} in ${list}.`
    : `${t.branch} has to merge ${base} in to fix its conflicts, and it already merges cleanly with ${base} now (the merge may be done already).`
  const steps = [
    o.inProgress ? 'A merge is already in progress in your worktree: finish it (git status shows what is left).' : `git merge --no-edit ${base} (merge, never rebase, never push).`,
    ...(o.files.length ? ["In each conflicted file keep both sides' intent: your ticket's change and theirs."] : []),
    'Run the tests.', 'Commit the merge (if git made one already, there is nothing to commit).', 'Call update_handoff(kind: before_pr) saying what you kept.',
    'Call open_pr again with the same title and body, keeping the "## Deviations from approved plan" section.',
  ]
  return `${intro}HQ: ${what} Fix it now, in your worktree:\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nIf you can't keep both, call report_blocked and say why.`
}
