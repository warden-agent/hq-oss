// A finished ticket whose branch would conflict with main: noticing it (stored on the ticket, plus a ⚠ notice with Fix
// conflicts), naming the tickets that merged first, and HQ's message to the engineer that merges main in. Git and records only.
import { attention, resolveKindForTicket } from './attention.ts'
import { names } from './localmerge.ts'
import { git } from './reposync.ts'
import { DEFAULTS } from './config.ts'
import { getSetting, now, one, q, run } from './db.ts'
import { failReport, type Failed } from './testrun.ts'
import { j } from './util.ts'
import { getTicket, setTicket, usesGithub, type Fixing, type Repo, type Ticket } from './records.ts'

/** What a ticket's branch merges into: `main` for a local (or local-only) repo; `origin/main` for a GitHub one (HQ fetches it; engineers can't). */
export function mergeBase(repo: Repo): { name: string; ref: string } {
  return usesGithub(repo) ? { name: `origin/${repo.default_branch}`, ref: `refs/remotes/origin/${repo.default_branch}` } : { name: repo.default_branch, ref: `refs/heads/${repo.default_branch}` }
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

/** What a finished ticket went back to its engineer for, as "to …" and "…ing" (Bug 84: a `resolving` ticket isn't always fixing conflicts). */
export function fixWords(fixing: Fixing, base: string): { to: string; ing: string } {
  return fixing === 'tests_hung' ? { to: `find what never finishes in its tests on ${base}`, ing: `finding what never finishes in its tests on ${base}` }
    : fixing === 'tests' ? { to: `fix its tests on ${base}`, ing: `fixing its tests on ${base}` }
    : fixing === 'changes' ? { to: 'build the change to its spec', ing: 'building the change to its spec' }
    : { to: `merge ${base} in and fix its conflicts`, ing: `fixing its conflicts with ${base}` }
}
/** It went back for its tests (failed, or never finished), not for its conflicts or a changed spec. */
export const forTests = (fixing: Fixing): boolean => fixing === 'tests' || fixing === 'tests_hung'
/** The ⚠ notice for a sent-back ticket whose engineer stopped: its kind picks the button that starts another (Fix conflicts, Fix tests, Build the change). */
export const stalledKind = (fixing: Fixing): string => fixing === 'changes' ? 'change_stalled' : forTests(fixing) ? 'fix_stalled' : 'merge_conflict'
/** Someone is on the ticket's tests or its change again (or it's finished): the "its engineer stopped" notices for those go. */
export function clearStalled(ticketId: string): void { for (const k of ['fix_stalled', 'change_stalled']) resolveKindForTicket(k, ticketId) }
/** What auto mode's failed test of a ticket printed, kept with the ticket so an engineer that takes over gets it too (Bug 84). */
export function keepTestsFailed(t: Ticket, failed: Failed): void {
  run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
    `ticket:${t.id}`, 'tests_failed', JSON.stringify({ test: failed.test, output: failed.output, earlier: failed.earlier, hung: !!failed.hung }), now())
}
/** That kept failure; `test` (the project's command) and a note stand in for it if it's gone. */
export function testsFailed(t: Ticket, test: string | null): Failed {
  const kept = j<Partial<Failed> | null>(one<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'tests_failed'", `ticket:${t.id}`)?.text ?? null, null)
  return { kind: 'fail', test: kept?.test ?? test ?? 'the tests', output: kept?.output ?? "(HQ doesn't have what they printed any more: run them to see.)",
    earlier: kept?.earlier ?? '', hung: kept?.hung ?? t.fixing === 'tests_hung' }
}

/** HQ's instructions to the engineer when auto mode's test of its ticket on main fails: alone it passed, together it doesn't. A run
 *  that never finished is told as one: the engineer looks for what waits forever, not for a failure that wasn't printed (Bug 82). */
export function fixTestsText(o: { t: Ticket; base: string; failed: Failed; launch?: { worktree: string } }): string {
  const { t, base, failed: r } = o
  const intro = o.launch ? `You are the engineer for ticket ${t.key} (${t.size}): ${t.title}. Its work is committed on branch ${t.branch}`
    + ` in your worktree ${o.launch.worktree}; call get_ticket for its spec and the handoff so far.\n\n` : ''
  const what = r.hung ? `${t.branch} merged with ${base} never finished its tests: HQ stopped \`${r.test}\` after ${getSetting('test_timeout_min', DEFAULTS.test_timeout_min)}`
    + " minutes, so HQ didn't merge it. Something waits forever (a test, a server or a timer that never ends), maybe only next to what another ticket merged first."
    + ' What it printed:' : `${t.branch} merged with ${base} fails its tests, so HQ didn't merge it. Another ticket may have merged first. \`${r.test}\` said:`
  const steps = [`git merge --no-edit ${base} (merge, never rebase, never push).`, r.hung
    ? `Run \`${r.test}\` with a time limit, find what never finishes and fix it, keeping your ticket's work and what is on ${base}.`
    : `Run \`${r.test}\` and fix what fails, keeping your ticket's work and what is on ${base}.`,
  'Commit.', 'Call update_handoff(kind: before_pr) saying what was wrong.', 'Call open_pr again with the same title and body, keeping the "## Deviations from approved plan" section.']
  return `${intro}HQ: ${what}\n\n${failReport(r, 4000)}\n\n`
    + `Fix it now, in your worktree:\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nIf you can't fix it from this ticket, call report_blocked and say why.`
}

/** HQ's instructions to the engineer when the TPM changes the spec of a ticket that is already finished: build the change on the
 *  same branch and finish it again. The spec isn't repeated here: get_ticket has the one that counts by the time this is read. */
export function changeText(o: { t: Ticket; launch?: { worktree: string } }): string {
  const { t } = o
  const intro = o.launch ? `You are the engineer for ticket ${t.key} (${t.size}): ${t.title}. Its work was finished and is committed on branch ${t.branch}`
    + ` in your worktree ${o.launch.worktree}; get_ticket has the handoff so far.\n\n` : ''
  const steps = ['Call get_ticket and read the spec as it is now.', "Build what the spec asks for that the branch doesn't do yet, and take out what it no longer asks for."
    + ' Keep the rest of the work as it is.', 'Run the tests.', 'Commit (never push).', 'Call update_handoff(kind: before_pr) saying what you changed.',
  'Call open_pr again with a title and body that fit the ticket as it is now, keeping the "## Deviations from approved plan" section.']
  return `${intro}HQ: the TPM changed the spec of ${t.key} after it was finished. It isn't merged yet; it waits for the change.`
    + ` Build it now, in your worktree:\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nIf you can't build it from this ticket, call report_blocked and say why.`
}

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
