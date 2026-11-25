// A finished ticket whose branch would conflict with main: noticing it (stored on the ticket, plus a ⚠ notice with Fix
// conflicts), naming the tickets that merged first, and HQ's message to the engineer that merges main in. Git and records only.
import { attention, resolveKindForTicket } from './attention.ts'
import { names } from './localmerge.ts'
import { git } from './reposync.ts'
import { DEFAULTS } from './config.ts'
import { getSetting, now, one, q, run } from './db.ts'
import { failedLine, failReport, type Failed } from './testrun.ts'
import { j } from './util.ts'
import { getTicket, setTicket, usesGithub, type Fixing, type Repo, type Ticket } from './records.ts'
import { criteriaOf } from './criteria.ts'
import { unseenWords } from './hqcheckrules.ts'

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
    // Bug 373: no test failed, so nothing says "fix its tests": the TPM read that as "its tests didn't pass" and told the user so
    : fixing === 'tests_unseen' ? { to: `get the tests named for its criteria seen running on ${base} (no test failed)`,
      ing: `getting the tests named for its criteria seen running on ${base} (no test failed)` }
    : fixing === 'look' ? { to: `fix what went wrong when HQ opened the app with it on ${base}`, ing: `fixing what went wrong when HQ opened the app with it on ${base}` }
    : fixing === 'review' ? { to: 'fix what a fresh reader of its changes found', ing: 'fixing what a fresh reader of its changes found' }
    : fixing === 'changes' ? { to: 'build the change to its spec', ing: 'building the change to its spec' }
    : { to: `merge ${base} in and fix its conflicts`, ing: `fixing its conflicts with ${base}` }
}
/** It went back for what auto mode's check of it on main showed: its tests (failed, never finished, or passed without the ones named for its criteria being
 *  seen), HQ's look at the app, or a reader of its changes. Not its conflicts or a changed spec. What the check showed is kept with the ticket, and whoever
 *  takes it up again gets it (keepTestsFailed). */
export const forTests = (fixing: Fixing): boolean => fixing === 'tests' || fixing === 'tests_hung' || fixing === 'tests_unseen' || fixing === 'look' || fixing === 'review'
/** What a send-back for HQ's check is `resolving` for (tickets.fixing), from what the check showed. */
export const fixingFor = (failed: Failed): Fixing => failed.review ? 'review' : failed.look ? 'look' : failed.hung ? 'tests_hung' : failed.unproven ? 'tests_unseen' : 'tests'
/** The ⚠ notice for a sent-back ticket whose engineer stopped: its kind picks the button that starts another (Fix conflicts, Fix tests, Fix the app, Build the
 *  change). */
export const stalledKind = (fixing: Fixing): string => fixing === 'changes' ? 'change_stalled' : fixing === 'look' ? 'look_stalled' : fixing === 'review' ? 'review_stalled'
  : forTests(fixing) ? 'fix_stalled' : 'merge_conflict'
/** The button that starts another engineer on a sent-back ticket, by what it went back for. */
export const fixButton = (fixing: Fixing): string => fixing === 'changes' ? 'Build the change' : fixing === 'look' ? 'Fix the app' : fixing === 'review' ? 'Fix what it found'
  : forTests(fixing) ? 'Fix tests' : 'Fix conflicts'
/** Someone is on the ticket's tests, its app or its change again (or it's finished): the "its engineer stopped" notices for those go. */
export function clearStalled(ticketId: string): void { for (const k of ['fix_stalled', 'look_stalled', 'review_stalled', 'change_stalled']) resolveKindForTicket(k, ticketId) }
const handoffOf = (ticketId: string): string => one<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'handoff'", `ticket:${ticketId}`)?.text ?? ''
type Kept = Partial<Failed> & { noted?: number }
const keptFor = (ticketId: string): Kept | null =>
  j<Kept | null>(one<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'tests_failed'", `ticket:${ticketId}`)?.text ?? null, null)
/** What auto mode's failed test of a ticket printed, kept with the ticket so an engineer that takes over gets it too (Bug 84). `noted` (Bug 373): how long
 *  the engineer's handoff log was as the ticket went back, so what it writes while fixing can be told from what it wrote before (notedSince). */
export function keepTestsFailed(t: Ticket, failed: Failed): void {
  run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
    `ticket:${t.id}`, 'tests_failed',
    JSON.stringify({ test: failed.test, output: failed.output, earlier: failed.earlier, hung: !!failed.hung, unproven: !!failed.unproven, look: !!failed.look, review: !!failed.review,
      asked: !!failed.asked, tester: !!failed.tester, ...(failed.missing ? { missing: failed.missing } : {}), ...(failed.outside ? { outside: failed.outside } : {}),
      noted: handoffOf(t.id).length }), now())
}
const NO_OUTPUT = "(HQ doesn't have what they printed any more: run them to see.)"
/** That kept failure; `test` (the project's command) and a note stand in for it if it's gone. */
export function testsFailed(t: Ticket, test: string | null): Failed {
  const kept = keptFor(t.id)
  return { kind: 'fail', test: kept?.test ?? test ?? 'the tests', output: kept?.output ?? NO_OUTPUT,
    earlier: kept?.earlier ?? '', hung: kept?.hung ?? t.fixing === 'tests_hung', ...(kept?.unproven ?? t.fixing === 'tests_unseen' ? { unproven: true } : {}),
    ...(kept?.missing ? { missing: kept.missing } : {}), ...(kept?.outside ? { outside: kept.outside } : {}), ...(kept?.look ?? t.fixing === 'look' ? { look: true } : {}),
    ...(kept?.review ?? t.fixing === 'review' ? { review: true } : {}), ...(kept?.asked ? { asked: true } : {}), ...(kept?.tester ? { tester: true } : {}) }
}
/** Bug 373: what the ticket's engineer wrote in its handoff log since the ticket went back to it (update_handoff's entries without their date lines, oldest
 *  first, one a line), '' when it wrote nothing. Its fix instructions ask for "what was wrong" there, and that used to be read by nobody: what it found stayed
 *  in its terminal. A ticket sent back before HQ kept the log's length has '' too: HQ can't tell old entries from new. */
export function notedSince(ticketId: string): string {
  const from = keptFor(ticketId)?.noted; if (typeof from !== 'number') return ''
  return handoffOf(ticketId).slice(from).split(/^### \d{4}-\d\d-\d\d \d\d:\d\d — \w+$/m).map((e) => e.trim().replace(/\s*\n\s*/g, ' ')).filter(Boolean).join('\n')
}
/** Bug 373: why a finished ticket went back to its engineer, in HQ's own words: one clause that reads after "because". For the TPM, which tells the user: from
 *  "to fix its tests" alone it guessed "its tests didn't pass" when they had passed. Only what HQ saw: tests it didn't see by name "weren't seen running". */
/** Bug 411: every named test HQ didn't see run is in a folder its test command runs nothing in: the command's gap, and nothing the engineer can fix in the ticket. */
export const allOutside = (r: Failed): boolean => !!r.unproven && !!r.outside && r.outside >= (r.missing ?? r.outside)
export function backWords(r: Failed, base: string): string {
  const line = r.output === NO_OUTPUT ? '' : failedLine(`${r.earlier}\n${r.output}`)
  return r.review ? 'a fresh reader of its changes found problems'
    : r.tester ? `HQ's UI tester found problems when it used the app in a browser with it merged into ${base}`
    : r.look ? `the app had problems when HQ opened it with it merged into ${base}`
    : r.unproven ? `its tests passed with it merged into ${base} and none failed, but ${unseenWords(r.missing ?? 0)}`
      + (r.outside ? `${allOutside(r) ? '' : `, ${r.outside} of them`} in a folder HQ's test command runs nothing in` : '')
    : r.hung ? `its tests never finished with it merged into ${base}: HQ stopped \`${r.test}\` after ${getSetting('test_timeout_min', DEFAULTS.test_timeout_min)} minutes`
    : `its tests failed with it merged into ${base}${line ? `: ${line}` : ''}`
}
/** Who sent it back, as a sentence: the user, after having HQ test it (hqcheck.ts), or auto mode's test before a merge. */
export const backBy = (r: Failed): string => r.asked ? 'The user had HQ test it and sent it back.' : 'HQ tested it before merging, and sent it back instead of merging it.'

/** How the step that calls open_pr again ends. A ticket with acceptance criteria named a test for each when it finished: open_pr takes those again when
 *  `tests` is left out, and checks them afresh. A ticket with none hears nothing about tests it was never asked for. */
const again = (t: Ticket): string => criteriaOf(t).length ? ' (leave `tests` out unless a criterion\'s test moved or changed its name: HQ checks the ones you gave last time again).' : '.'
/** HQ's instructions to the engineer when auto mode's test of its ticket on main fails: alone it passed, together it doesn't. A run
 *  that never finished is told as one: the engineer looks for what waits forever, not for a failure that wasn't printed (Bug 82). */
export function fixTestsText(o: { t: Ticket; base: string; failed: Failed; launch?: { worktree: string } }): string {
  const { t, base, failed: r } = o
  // `asked`: the user had HQ test it (hqcheck.ts, auto mode off) and sent it back: HQ merges nothing by itself then, so "HQ didn't merge it" would be untrue
  const didnt = r.asked ? 'so the user sent it back to you' : "so HQ didn't merge it"
  const intro = o.launch ? `You are the engineer for ticket ${t.key} (${t.size}): ${t.title}. Its work is committed on branch ${t.branch}`
    + ` in your worktree ${o.launch.worktree}; call get_ticket for its spec and the handoff so far.\n\n` : ''
  const what = r.review ? `${t.branch} merged with ${base} passes its tests, but a fresh reader of your changes found problems, ${didnt}. The reader saw only the`
    + ` ticket's acceptance criteria, your changes against ${base} and what the tests printed.`
    : r.tester ? `${t.branch} merged with ${base} passes its tests, but HQ's UI tester found problems when it used the app in a browser, as a person would, with your`
    + ` ticket merged in, ${didnt}.`
    : r.look ? `${t.branch} merged with ${base} passes its tests, but the app has problems when HQ opens it with your ticket merged in, ${didnt}.`
    : r.unproven ? `${t.branch} merged with ${base} passes \`${r.test}\`, but that run didn't run every test you named for the ticket's criteria, ${didnt}.`
    : r.hung ? `${t.branch} merged with ${base} never finished its tests: HQ stopped \`${r.test}\` after ${getSetting('test_timeout_min', DEFAULTS.test_timeout_min)}`
    + ` minutes, ${didnt}. Something waits forever (a test, a server or a timer that never ends), maybe only next to what another ticket merged first.`
    + ' What it printed:' : `${t.branch} merged with ${base} fails its tests, ${didnt}. Another ticket may have merged first. \`${r.test}\` said:`
  const steps = [`git merge --no-edit ${base} (merge, never rebase, never push).`, r.review
    ? `Fix what the reader found, keeping your ticket's work and what is on ${base}. If a finding is wrong, say why in your handoff instead of changing the code`
      + `${r.asked ? '' : ': this read happens once, and your next open_pr is merged on its tests'}. Then run the tests.`
    : r.look
    ? `Fix what the report above shows, keeping your ticket's work and what is on ${base}. A real browser can't start in your session: go by the report, by what the`
      + ' app prints when you start it, and by what its server answers (curl). Then run the tests.'
    : r.unproven
    ? `Make each test listed above run and pass under \`${r.test}\` (HQ reads that command's output), or name a test that does. Don't drop a criterion's test.`
      + (r.outside ? ' For a test in a folder HQ\'s test command runs nothing in (the list says which), don\'t move it and don\'t wrap it in or call it from another test '
        + 'runner: call report_blocked and say which folder HQ\'s test command doesn\'t run.' : '')
    : r.hung ? `Run \`${r.test}\` with a time limit, find what never finishes and fix it, keeping your ticket's work and what is on ${base}.`
    : `Run \`${r.test}\` and fix what fails, keeping your ticket's work and what is on ${base}.`,
  'Commit.', 'Call update_handoff(kind: before_pr) saying what was wrong.', `Call open_pr again with the same title and body, keeping the "## Deviations from approved plan" section${again(t)}`]
  // Bug 411: sent back with "put it where that command runs it", an engineer wrapped its backend's tests in the frontend's runner. A test where the command
  // runs nothing is the command's gap: the engineer changes nothing and says so (checked on a real engineer, 2026-11-25: report_blocked, no change)
  if (allOutside(r)) return `${intro}HQ: ${what}\n\n${r.output}\n\nThat is a gap in HQ's test command, not in your ticket. Do this:\n`
    + `1. Leave your code and your tests as they are. Don't move these tests, and don't wrap them in or call them from another test runner to get them seen.\n`
    + `2. Call report_blocked and say which folder HQ's test command doesn't run. Then end your turn. HQ tells you when its test command has changed: run it `
    + `then, and call open_pr again with the same title and body${again(t)}`
  return `${intro}HQ: ${what}\n\n${r.unproven || r.look || r.review ? r.output : failReport(r, 4000)}\n\n`
    + `Fix it now, in your worktree:\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nIf you can't fix it from this ticket, call report_blocked and say why.`
}

/** HQ's instructions to the engineer when the TPM changes the spec of a ticket that is already finished: build the change on the
 *  same branch and finish it again. The spec isn't repeated here: get_ticket has the one that counts by the time this is read. */
export function changeText(o: { t: Ticket; launch?: { worktree: string } }): string {
  const { t } = o
  const intro = o.launch ? `You are the engineer for ticket ${t.key} (${t.size}): ${t.title}. Its work was finished and is committed on branch ${t.branch}`
    + ` in your worktree ${o.launch.worktree}; get_ticket has the handoff so far.\n\n` : ''
  const crit = criteriaOf(t).length > 0, read = crit ? 'the spec and the acceptance criteria as they are now' : 'the spec as it is now'
  const steps = [`Call get_ticket and read ${read}.`, "Build what the spec asks for that the branch doesn't do yet, and take out what it no longer asks for."
    + ' Keep the rest of the work as it is.', 'Run the tests.', 'Commit (never push).', 'Call update_handoff(kind: before_pr) saying what you changed.',
  'Call open_pr again with a title and body that fit the ticket as it is now, keeping the "## Deviations from approved plan" section'
    + `${crit ? ', and with `tests` for the criteria as they are now' : ''}.`]
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
  const branch = base.replace(/^origin\//, '') // the project's default branch (Bug 210), not always main: mergeBase names origin's copy of it on GitHub
  const what = o.files.length ? `${branch} has moved on since you finished ${t.key}. ${first} ${t.branch} conflicts with ${base} in ${list}.`
    : `${t.branch} has to merge ${base} in to fix its conflicts, and it already merges cleanly with ${base} now (the merge may be done already).`
  const steps = [
    o.inProgress ? 'A merge is already in progress in your worktree: finish it (git status shows what is left).' : `git merge --no-edit ${base} (merge, never rebase, never push).`,
    ...(o.files.length ? ["In each conflicted file keep both sides' intent: your ticket's change and theirs."] : []),
    'Run the tests.', 'Commit the merge (if git made one already, there is nothing to commit).', 'Call update_handoff(kind: before_pr) saying what you kept.',
    `Call open_pr again with the same title and body, keeping the "## Deviations from approved plan" section${again(t)}`,
  ]
  return `${intro}HQ: ${what} Fix it now, in your worktree:\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nIf you can't keep both, call report_blocked and say why.`
}
