// Finished tickets: open_pr (push + PR, or wait for "Merge into main"), and noticing merges and conflicts with main by themselves.
import fs from 'node:fs'
import path from 'node:path'
import { attention, resolveForTicket, resolveKind } from './attention.ts'
import { branchMerged, parseGithubRemote } from './reposync.ts'
import { createPr, decidingPr, mergePr, openOrLink, prsForBranch, pushBranch, type Pr } from './github.ts'
import { FINISHED, readyDependents } from './readiness.ts'
import { one, q, run, now } from './db.ts'
import { bus, emit } from './events.ts'
import { j } from './util.ts'
import { conflictsWith, mergeIntoMain, names } from './localmerge.ts'
import { clearConflict, clearStalled, fixButton, fixWords, forTests, mergeBase, setConflict, stalledKind, whoMergedFirst } from './conflicts.ts'
import { getAgent, stopAgent, type Agent } from './agents.ts'
import { sendMessage } from './delivery.ts'
import { autoGoing, getFeature, getRepo, getTicket, sweepNotices, setTicket, ticketForAgent, tickets, usesGithub, type Feature, type MergeTest, type Repo, type Ticket, liveTpm,
  closedWhy, hqMoves } from './records.ts'
import { countWords, took } from './testcounts.ts'
import { ghOpts, git, syncRepo } from './repos.ts'
import { releaseWorktree } from './slots.ts'
import { writeFeatureMd } from './projectmd.ts'
import { criteriaOf, proofOf, type ProofEntry } from './criteria.ts'
import { checkProof } from './proof.ts'
import { applyMapOnMerge, mapWanted, markUnchanged, pendingMapChange } from './mapstore.ts'

/** Bug 184: the part of a ticket HQ has merged already: it merged the commit an open_pr handed over, and the branch got more after it (more than once, even).
 *  `sha`: the newest commit of the branch HQ merged that way; `from`: main as it was before the first such merge, where the ticket's work counts from. Found
 *  from git, by the line HQ's merges carry ("HQ ticket <key> · <branch>"), so a restart, a later open_pr or main merged into the branch doesn't lose it. */
export async function mergedPart(repoPath: string, base: string, t: { key: string; branch: string | null }): Promise<{ sha: string; from: string } | null> {
  if (!t.branch) return null
  const log = await git(repoPath, 'log', '--first-parent', '--merges', '-F', `--grep=HQ ticket ${t.key} · ${t.branch}`, '--format=%P', base, '--').catch(() => '')
  const ours: string[][] = []
  for (const [p1, p2] of log.split('\n').filter(Boolean).map((l) => l.split(' '))) {
    if (p1 && p2 && await git(repoPath, 'merge-base', '--is-ancestor', p2, `refs/heads/${t.branch}`).then(() => true, () => false)) ours.push([p1, p2])
  }
  return ours.length ? { sha: ours[0]![1]!, from: ours.at(-1)![0]! } : null // newest first
}
/** open_pr: the engineer is done. GitHub repos: push its branch as the HQ account; the user tries it, then chooses Merge (HQ
 *  opens a PR and merges it, mergeTicket) or Make PR (makePr) (Bug 45; a PR it already has stays open). Local repos, and GitHub
 *  ones HQ can't push to: the ticket waits for the user's "Merge into main" (mergeTicket). Either way HQ notices the merge (checkMerges). Waiting for a merge isn't an alert: the
 *  box and the ⚠ menu show it until it's merged. */
export async function finishTicket(agent: Agent, title: string, body: string, named?: ProofEntry[], mapUnchanged = false): Promise<string> {
  const t = ticketForAgent(agent); if (!t || !t.branch || !t.worktree_path) throw new Error('no ticket bound')
  const f = getFeature(t.feature_id)!; const repo = getRepo(f.repo_id)!
  const sha = await git(repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}^{commit}`).catch(() => '') // what this open_pr hands over (Bug 143)
  // Bug 143: a finished ticket that has commits from after its open_pr finishes again with them; otherwise there's nothing more to do
  const again = ['pr_ready', 'pr_open'].includes(t.status) && !!t.finished_sha && !!sha && sha !== t.finished_sha
  if (FINISHED.includes(t.status) && !again) return `${t.key} is already ${t.status}; nothing more to do. Stop here.`
  const mh = await git(t.worktree_path, 'rev-parse', '--git-path', 'MERGE_HEAD')
  if (fs.existsSync(path.resolve(t.worktree_path, mh))) throw new Error('A merge is in progress in your worktree: resolve what git status lists, commit it, then call open_pr again.')
  const dirty = await git(t.worktree_path, 'status', '--porcelain')
  if (dirty) throw new Error(`Commit your work first. Uncommitted:\n${dirty.split('\n').slice(0, 15).join('\n')}`)
  const slug = usesGithub(repo) ? parseGithubRemote(repo.remote ?? '') : null
  const base = mergeBase(repo)
  const ahead = Number(await git(repo.path, 'rev-list', '--count', `${base.ref}..refs/heads/${t.branch}`).catch(() => '0'))
  if (!ahead) throw new Error(`${t.branch} has no commits beyond ${repo.default_branch}. Commit your work, then call open_pr again.`)
  const conflicts = await conflictsWith(repo.path, base.ref, `refs/heads/${t.branch}`) // main moved on while this was built
  if (conflicts?.length) {
    throw new Error(`${t.branch} conflicts with ${base.name} in ${names(conflicts)}: ${repo.default_branch} has moved on. Merge it in (git merge --no-edit ${base.name};`
      + " merge, never rebase), keep both sides' intent, run the tests, commit, then call open_pr again.")
  }
  // The test named for each acceptance criterion, checked with git before anything changes (criteria.ts, proof.ts). Left out on a ticket that was finished
  // before (a fix of its conflicts or tests): the ones it gave then are checked again, against the criteria and the branch as they are now.
  const cur = getTicket(t.id) ?? t, given = named?.length ? named : proofOf(cur)?.tests.map(({ state: _, ...e }) => e) ?? null
  const from = (await mergedPart(repo.path, base.ref, t))?.from ?? base.ref // its tests count from where it began, part of it in main or not
  const checked = await checkProof({ repoPath: repo.path, base: from, branch: t.branch, criteria: criteriaOf(cur), tests: given, expected: j<string[]>(cur.expected_files, []), at: now() })
  if ('problem' in checked) throw new Error(checked.problem)
  if (mapWanted(cur) && !pendingMapChange(t.id)) { // the map is the tester's only picture of the app: a ticket that changes a screen says how (mapstore.ts)
    if (!mapUnchanged) throw new Error(`${t.key} has screen criteria, so HQ needs to know what changed on the feature map (get_ticket shows it). Call `
      + 'update_feature_map with the lines to add and remove on each screen you changed, or, if nothing a user sees changed, call open_pr again with feature_map_unchanged: true.')
    markUnchanged(cur, f.repo_id)
  }
  setTicket(t.id, { proof: JSON.stringify(checked.proof), finished_sha: sha || null })
  const fixed = t.status === 'resolving' || (t.status === 'awaiting_answer' && t.prior_status === 'resolving')
  const tests = fixed && forTests(t.fixing) // it went back for its tests, not conflicts (Bug 84)
  const fixedWhat = t.fixing === 'look' ? 'what went wrong when HQ opened the app' : t.fixing === 'review' ? 'what a fresh reader of its changes found' : 'its tests'
  const changed = fixed && t.fixing === 'changes' // or for a spec the TPM changed after it was finished
  // Bug 246: HQ tests and merges it only while auto mode is going: stopped, or with the ticket parked, the user does until Resume (as the board says)
  let auto = hqMoves(getRepo(repo.id) ?? repo, getTicket(t.id) ?? t)
  clearConflict(t.id); clearStalled(t.id)
  run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
    `ticket:${t.id}`, 'pr', `# ${title}\n\n${body}`, now())
  if (!slug) {
    setTicket(t.id, { status: 'pr_ready', pr_url: null, pr_state: 'local', prior_status: null, fixing: null })
    emit({ agentId: agent.id, source: 'system', kind: 'ticket.pr_ready', payload: { ticket: t.id, key: t.key, branch: t.branch, pushed: false, fixed } })
    if (fixed && !tests && !changed && !auto) attention('conflicts_fixed', `${t.key}: conflicts fixed (${repo.default_branch} merged in). Ready to merge again.`, { agentId: agent.id, ticketId: t.id })
    tellTpm(f, auto ? `HQ: ${t.key} is finished (${t.branch}). HQ tests it on ${repo.default_branch} and merges it; you'll be told when it merges.`
      : tests ? `HQ: ${t.key}'s engineer fixed ${fixedWhat} on ${repo.default_branch}. The user merges it from HQ; you'll be told when it merges.`
      : changed ? `HQ: ${t.key}'s engineer built the change to its spec (${t.branch}). The user merges it from HQ; you'll be told when it merges.`
      : fixed ? `HQ: ${t.key}'s conflicts with ${repo.default_branch} are fixed. The user merges it from HQ; you'll be told when it merges.`
      : `HQ: ${t.key} is finished (${t.branch}). The user merges it into ${repo.default_branch} from HQ; you'll be told when it merges.`)
    bus.emit('slot.freed') // its parallel slot is free now (listeners.ts)
    return auto ? `Done. HQ tests ${t.branch} on ${repo.default_branch} and merges it. You're done: stop now.` :
      `Done. The user merges ${t.branch} into ${repo.default_branch} from HQ. You're done: stop now.`
  }
  try { await pushBranch(repo.path, slug, t.branch, ghOpts()) } catch (e) {
    attention('push_failed', `${t.key}: ${(e as Error).message}`, { agentId: agent.id, ticketId: t.id })
    throw new Error(`HQ could not push ${t.branch}: ${(e as Error).message}. The user has been told; stop and wait for a message.`)
  }
  auto = hqMoves(getRepo(repo.id) ?? repo, getTicket(t.id) ?? t) // read after the push: auto may have stopped, gone off or come back meanwhile
  const hasPr = !!t.pr_number && t.pr_state === 'open' // fixed after a conflict: the push updated its open PR
  setTicket(t.id, hasPr ? { status: 'pr_open', prior_status: null, fixing: null } : { status: 'pr_ready', pr_url: null, pr_state: 'waiting', prior_status: null, fixing: null })
  emit({ agentId: agent.id, source: 'system', kind: 'ticket.pr_ready', payload: { ticket: t.id, key: t.key, branch: t.branch, pushed: true, waiting: !hasPr, fixed } })
  if (fixed && !tests && !changed && !auto) attention('conflicts_fixed', `${t.key}: conflicts fixed (${base.name} merged in). Ready to merge again.`, { agentId: agent.id, ticketId: t.id })
  tellTpm(f, auto ? `HQ: ${t.key} is finished (${t.branch}, pushed). HQ tests it on ${base.name} and merges it; you'll be told when it merges.`
    : tests ? `HQ: ${t.key}'s engineer fixed ${fixedWhat} on ${base.name}. The user merges it from HQ; you'll be told when it merges.`
    : changed ? `HQ: ${t.key}'s engineer built the change to its spec (${t.branch}, pushed). The user merges it from HQ; you'll be told when it merges.`
    : fixed ? `HQ: ${t.key}'s conflicts with ${base.name} are fixed. The user merges it from HQ; you'll be told when it merges.`
    : `HQ: ${t.key} is finished (${t.branch}, pushed). The user tries it, then merges it or makes a PR from HQ; you'll be told when it merges.`)
  bus.emit('slot.freed') // its parallel slot is free now (listeners.ts)
  return auto ? `Pushed ${t.branch}. HQ tests it on ${base.name} and merges it. You're done: stop now.`
    : `Pushed ${t.branch}. The user tries it and merges it (or makes a PR) from HQ; HQ tells the TPM when it merges. You're done: stop now.`
}
/** HQ's own notice to the project's TPM about a feature (from 'hq': the TPM can tell it from the user's words). Only to a running
 *  TPM: one that starts later is briefed with the board as it stands then (Bug 52). */
export const tellTpm = (f: Feature, body: string): void => {
  const tpm = liveTpm(f.repo_id); if (tpm) sendMessage({ repoId: f.repo_id, featureId: f.id, channel: 'dm', from: 'hq', to: tpm.id, reason: 'fyi', body })
}
/** Open the ticket's PR (branch already pushed). Opened → `pr_open`, merged by the user or, on auto, by HQ (Bug 209: the user's Make PR as auto goes on, or
 *  the watcher's retry of one GitHub refused). GitHub refused → `pr_ready` with a pre-filled "Create PR" link and the reason; checkMerges retries while nobody has opened a PR. */
async function openTicketPr(t: Ticket, repo: Repo, slug: string, title: string, body: string): Promise<Pr | null> {
  const f = getFeature(t.feature_id)!; const branch = t.branch!
  const r = await openOrLink(slug, repo.default_branch, branch, title, body, ghOpts())
  if ('pr' in r) {
    setTicket(t.id, { status: 'pr_open', pr_number: r.pr.number, pr_url: r.pr.url, pr_state: 'open', prior_status: null })
    emit({ agentId: t.assignee_agent_id, source: 'system', kind: 'ticket.pr_open', payload: { ticket: t.id, key: t.key, branch, pr: r.pr.number } })
    for (const k of ['pr_ready', 'pr_failed']) resolveKind(k, t.assignee_agent_id) // an older link or failure note is moot now
    const cur = getRepo(repo.id) ?? repo, hq = hqMoves(cur, getTicket(t.id) ?? t) // read after GitHub answered: auto may have gone on, off or stopped meanwhile
    tellTpm(f, `HQ: PR #${r.pr.number} is open for ${t.key} (${branch}). ${hq ? `HQ tests it on ${mergeBase(cur).name} and merges it` : 'The user merges it'};`
      + " you'll be told when it merges.")
    return r.pr
  }
  const first = t.status !== 'pr_ready' // a watcher retry doesn't re-announce
  setTicket(t.id, { status: 'pr_ready', pr_url: r.link, pr_state: 'not_opened', prior_status: null })
  emit({ agentId: t.assignee_agent_id, source: 'system', kind: 'ticket.pr_ready', payload: { ticket: t.id, key: t.key, branch, pushed: true, error: r.error } })
  attention('pr_failed', `${t.key}: HQ pushed ${branch} but couldn't open the PR (${r.error}). Open it yourself → ${r.link}`, { agentId: t.assignee_agent_id, ticketId: t.id })
  if (first) tellTpm(f, `HQ: ${t.key} is finished and pushed (${branch}). The user opens and merges the PR; you'll be told when it merges.`)
  return null
}

/** The PR title and body the engineer wrote at open_pr. */
function prText(t: Ticket): { title: string; body: string } {
  const m = one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', `ticket:${t.id}`, 'pr')?.text.match(/^# (.*)\n\n([\s\S]*)$/)
  return m ? { title: m[1]!, body: m[2]! } : { title: `${t.key}: ${t.title}`, body: `HQ ticket ${t.key} · ${t.branch}` }
}
const repoOfTicket = (t: Ticket): Repo | undefined => { const f = getFeature(t.feature_id); return f ? getRepo(f.repo_id) : undefined }
/** Make PR (Bug 45): the user wants a PR to look at on GitHub before merging. Opened → `pr_open`; refused → the "Create PR" link. */
export async function makePr(ticketId: string): Promise<Ticket> {
  const t = getTicket(ticketId), repo = t && repoOfTicket(t); if (!t || !repo) throw new Error('unknown ticket')
  const slug = usesGithub(repo) ? parseGithubRemote(repo.remote ?? '') : null
  if (!slug || t.pr_state === 'local') throw new Error(`${repo.name} isn't on GitHub: merge ${t.key} from HQ.`)
  if (t.status !== 'pr_ready' || !t.branch) throw new Error(t.status === 'pr_open' ? `${t.key} already has PR #${t.pr_number}.` : `${t.key} isn't finished yet (${t.status}).`)
  const { title, body } = prText(t), pr = await openTicketPr(t, repo, slug, title, body)
  if (!pr) throw new Error(`GitHub wouldn't open the PR for ${t.key}. Create PR ↗ on its box opens GitHub's own form, filled in.`) // the button board.ts mergeActs gives a refused one (Bug 244)
  return getTicket(t.id)!
}

let checking: Promise<void> | null = null, again = false
/** Notice merges by itself. GitHub repos ask GitHub for the ticket branch's PR (catches squash merges too); local repos check git.
 *  Then every ticket still waiting is checked against main for conflicts (the early warning). A call while a pass runs gets
 *  one more pass after it, so a merge that just happened is always looked at. */
export function checkMerges(): Promise<void> {
  if (checking) { again = true; return checking }
  checking = (async () => { do { again = false; await checkOnce() } while (again) })().finally(() => { checking = null })
  return checking
}
async function checkOnce(): Promise<void> {
  const waiting = q<Ticket & { repo_id: string }>(`SELECT t.*, f.repo_id FROM tickets t JOIN features f ON f.id = t.feature_id
    JOIN repos r ON r.id = f.repo_id
    WHERE t.status IN ('pr_ready', 'pr_open', 'resolving') AND f.status != 'cancelled' AND t.branch IS NOT NULL AND r.clearing_at IS NULL`)
  for (const t of waiting) {
    const repo = getRepo(t.repo_id); if (!repo || !t.branch) continue
    const slug = usesGithub(repo) ? parseGithubRemote(repo.remote ?? '') : null
    if (!slug) { if (await branchMerged(repo.path, t.branch, `refs/heads/${repo.default_branch}`)) markMerged(t, null); else await checkConflict(t, repo); continue }
    const prs = await prsForBranch(slug, t.branch, ghOpts()).catch(() => null) // null: GitHub couldn't be asked
    if (!getTicket(t.id)) continue // removed from HQ while GitHub was being asked
    const pr = decidingPr(prs ?? [])
    if (pr?.state === 'MERGED') { markMerged(t, pr); continue }
    if (pr?.state === 'OPEN') {
      const resolving = t.status === 'resolving' // its engineer is merging main in: only the PR fields change
      if ((!resolving && t.status !== 'pr_open') || t.pr_number !== pr.number || t.pr_state !== 'open') {
        setTicket(t.id, { ...(resolving ? {} : { status: 'pr_open' as const }), pr_number: pr.number, pr_url: pr.url, pr_state: 'open' })
      }
    } else if (pr?.state === 'CLOSED') {
      if (t.pr_state !== 'closed') {
        setTicket(t.id, { pr_number: pr.number, pr_url: pr.url, pr_state: 'closed' })
        attention('pr_closed', `${t.key}: PR #${pr.number} was closed without merging`, { agentId: t.assignee_agent_id, ticketId: t.id })
      }
    }
    else if (await branchMerged(repo.path, t.branch, `refs/remotes/origin/${repo.default_branch}`)) { markMerged(t, null); continue } // merged without a PR
    else if (prs && t.status === 'pr_ready' && t.pr_state === 'not_opened' && !hqMoves(getRepo(repo.id) ?? repo, getTicket(t.id) ?? t)) { // retry; 'waiting' waits for the user
      const p = prText(t); await openTicketPr(t, repo, slug, p.title, p.body) // on auto HQ opens it as it merges (Bug 247): two tries at once would clash
    }
    await checkConflict(t, repo, pr?.state === 'OPEN' ? pr : undefined)
  }
}
const fetchedFor = new Map<string, string>() // repo id → the origin main HQ fetched again because GitHub saw a conflict it didn't
const toldStopped = new Set<string>() // engineers whose stalled fix the user has been told about (once per engineer per run)
/** The early warning: a waiting ticket that would now conflict with main gets the notice and Fix conflicts; one that merges
 *  cleanly again loses them. A resolving ticket whose engineer has gone gets the notice again, so Fix conflicts can restart it; one
 *  that went back for its tests gets its own notice and Fix tests (Bug 84), one that went back for a changed spec, Build the change. */
async function checkConflict(t0: Ticket, repo: Repo, pr?: Pr): Promise<void> {
  const t = getTicket(t0.id); if (!t?.branch || !['pr_ready', 'pr_open', 'resolving'].includes(t.status)) return
  if (t.status === 'resolving') {
    const eng = t.assignee_agent_id ? getAgent(t.assignee_agent_id) : undefined
    const why = t.fixing ? `${t.key}: its engineer stopped while ${fixWords(t.fixing, mergeBase(repo).name).ing}. Press ${fixButton(t.fixing)} to start another.`
      : `${t.key}: its engineer stopped before the conflicts with ${mergeBase(repo).name} were fixed. Press Fix conflicts to start another.`
    if ((!eng || eng.status === 'exited') && !toldStopped.has(t.assignee_agent_id ?? t.id)) {
      toldStopped.add(t.assignee_agent_id ?? t.id); attention(stalledKind(t.fixing), why, { agentId: t.assignee_agent_id, ticketId: t.id })
    }
    return
  }
  const base = mergeBase(repo)
  const files = await conflictsWith(repo.path, base.ref, `refs/heads/${t.branch}`); if (files === null) return // git couldn't tell
  const merged = files.length ? await whoMergedFirst(repo, t, files, base.ref) : []
  const cur = getTicket(t.id); if (cur?.status !== t.status) return // Fix conflicts (or a merge) moved it on while git worked
  if (files.length) return setConflict(cur, files, merged, base.name)
  if (pr?.mergeable === 'CONFLICTING') { // GitHub sees a conflict HQ's copy of main doesn't have yet: fetch once per main it sees
    const tip = await git(repo.path, 'rev-parse', base.ref).catch(() => '')
    if (fetchedFor.get(repo.id) !== tip) { fetchedFor.set(repo.id, tip); void syncRepo(repo.id).catch(() => {}); return } // its repo.synced re-checks
    return setConflict(t, [], [], base.name)
  }
  clearConflict(t.id)
}
/** Auto mode's passing test of a ticket, handed to the merge it allowed (Bug 126): the record is the merge's own, never a test read back later. */
export type Tested = Extract<MergeTest, { ran: 'pass' }> & { output: string }
/** What HQ ran on a ticket before it merged, for its TPM: an agent says what HQ did, so HQ says it first (Bug 126: a TPM told the user "HQ ran the tests before
 *  each merge" after six merges HQ never tested). */
export function testedWords(m: MergeTest, base: string): string {
  if (m.ran === 'none') return m.by === 'user'
    ? 'The user merged it with Merge, which runs no tests: HQ did not test it as it merged.' : 'It was merged outside HQ, so HQ did not test it as it merged.'
  return `HQ's tests passed on ${base} first (\`${m.test.length > 120 ? `${m.test.slice(0, 117)}...` : m.test}\`${m.counts ? `: ${countWords(m.counts)}` : ''}, ${took(m.ms)}).`
}
const passed = ({ output: _, ...m }: Tested): MergeTest => m
/** Saves what HQ ran on it before the merge; a passing run's output goes beside it, for the Ticket tab. */
function saveMergeTest(ticketId: string, m: MergeTest, output: string | null): void {
  if (output !== null) run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
    `ticket:${ticketId}`, 'merge_test_output', output, now())
  setTicket(ticketId, { merge_test: JSON.stringify(m) })
}
/** `byUser`: they pressed Merge in HQ, so a plain "X merged" tells them nothing. "Start ready" still does. `tested`: auto mode's passing test that let it merge;
 *  without one HQ did not test it as it merged, and the ticket says so (Bug 126). */
function markMerged(t: Ticket, pr: Pr | null, o: { byUser?: boolean; tested?: Tested } = {}): void {
  const m: MergeTest = o.tested ? passed(o.tested) : { ran: 'none', by: o.byUser ? 'user' : 'outside', at: now() }
  if (getTicket(t.id)?.status === 'merged') { // the watcher and Merge can both see the same merge, the watcher first: HQ's own merge has the true record
    if (o.tested || o.byUser) saveMergeTest(t.id, m, o.tested?.output ?? null)
    return
  }
  saveMergeTest(t.id, m, o.tested?.output ?? null)
  setTicket(t.id, { status: 'merged', pr_state: 'merged', conflict_files: null, conflict_with: null, ...(pr ? { pr_number: pr.number, pr_url: pr.url } : {}) })
  emit({ agentId: t.assignee_agent_id, source: 'system', kind: 'ticket.merged', payload: { ticket: t.id, key: t.key, pr: pr?.number ?? null } })
  const a = t.assignee_agent_id ? getAgent(t.assignee_agent_id) : undefined
  if (t.assignee_agent_id) for (const k of ['pr_ready', 'pr_open', 'pr_failed']) resolveKind(k, t.assignee_agent_id)
  resolveForTicket(t.id) // its work is in main: older notices about it (exited, stuck, blocked…) are moot
  if (a && a.status !== 'exited') void stopAgent(a.id, 'merged') // its work is in main now; once it's gone its worktree goes too
  else void releaseWorktree(t).catch(() => {})
  const f = getFeature(t.feature_id)!; applyMapOnMerge(t, f.repo_id) // its change to the feature map goes in with its work (mapstore.ts)
  writeFeatureMd(f) // "Built so far" in PROJECT.md grows (Bug 52)
  const ready = readyDependents(t.key, tickets(f.id), j<string[]>(f.merge_order, [])).map((x) => x.key)
  const what = `${t.key} merged${pr ? ` (PR #${pr.number})` : ''}.${ready.length ? ` Ready now: ${ready.join(', ')}.` : ''}`
  const cur = getRepo(f.repo_id), auto = !!cur && autoGoing(cur) // auto mode starts what's ready and sums the run up at the end; stopped, the user does (Bug 246)
  if (!auto && (ready.length || !o.byUser)) attention('merged', ready.length ? `${what} Start them with "Start ready".` : what, { agentId: t.assignee_agent_id, ticketId: t.id })
  const tested = `${t.key} merged${pr ? ` (PR #${pr.number})` : ''}. ${testedWords(m, getRepo(f.repo_id)?.default_branch ?? 'main')}` // what HQ ran on it first (Bug 126)
  tellTpm(f, `HQ: ${tested}${ready.length ? ` Ready now: ${ready.join(', ')}.${auto ? ' HQ starts them.' : ' The user starts them from HQ.'}` : ''}`)
}
const merging = new Map<string, Promise<unknown>>() // one merge per repo at a time
/** Merge for a finished ticket. GitHub repos: mergeOnGithub. Local repos (or a GitHub one HQ can't push to): HQ merges its branch with fixed rules (localmerge.ts: refuses,
 *  and says why, if the checkout isn't on main, has uncommitted changes, or the branch conflicts), then handles it like any
 *  merge it notices: the engineer stops, the user and the TPM hear what's ready now, the preview restarts. */
export function mergeTicket(ticketId: string): Promise<{ merged: true; sha: string; already: boolean; behind?: string }> {
  const t0 = getTicket(ticketId); const f = t0 && getFeature(t0.feature_id); const repo = f && getRepo(f.repo_id)
  if (!t0 || !repo) return Promise.reject(new Error('unknown ticket'))
  const closed = closedWhy(repo.id); if (closed) return Promise.reject(new Error(closed))
  return inMergeQueue(repo.id, async () => {
    // Bug 212: the branch as it is now, by its commit, and the branch looked at again after: a commit that lands while it merges is said, never left unsaid
    const t = getTicket(ticketId), head = t?.branch ? await tipOf(repo.path, t.branch) : ''
    const m = await mergeNow(ticketId, repo, undefined, head || undefined)
    const cur = getTicket(ticketId); if (!cur?.branch || !head) return m
    if (m.behind) await lateWhileMerging(repo, cur, head, m.behind, false)
    else if (cur.status === 'merged' && !m.already) { const after = await tipOf(repo.path, cur.branch); if (after && after !== head) await lateWhileMerging(repo, cur, head, after, true) }
    return m
  })
}
const tipOf = (repoPath: string, branch: string): Promise<string> => git(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`).catch(() => '')
/** Bug 212: the user's Merge into main merged the branch as it was when the merge started, and it got commits meanwhile. Local repos (`merged` false): main
 *  has that part; the ticket isn't marked merged and stays ready, so the user's next Merge into main brings the rest (the user decides, as with any commit
 *  after open_pr in manual mode). GitHub (`merged`): its PR is merged, so the commits left on the branch are named to the user and the TPM (as on auto, Bug 184). */
async function lateWhileMerging(repo: Repo, t: Ticket, head: string, at: string, merged: boolean): Promise<void> {
  const log = await git(repo.path, 'log', '--reverse', '--format=%h %s', `${head}..${at}`, '--').catch(() => ''), commits = log.split('\n').filter(Boolean) // oldest first
  if (!commits.length) return
  const n = commits.length, it = n === 1 ? 'it' : 'them', main = repo.default_branch
  const list = commits.slice(0, 5).map((c) => `"${c}"`).join(', ') + (n > 5 ? ` and ${n - 5} more` : '')
  const got = `${t.branch} got ${n === 1 ? 'a commit' : `${n} commits`} while HQ merged it`
  emit({ agentId: null, source: 'system', kind: 'ticket.merged_late', payload: { ticket: t.id, key: t.key, head, now: at, commits: n, merged } })
  if (!merged) {
    attention('merged_part', `${t.key}: ${n === 1 ? 'a commit' : `${n} commits`} reached its branch while HQ merged it, so it is only partly in ${main}. Press Merge `
      + `into ${main} again to merge the rest: ${list}. (${main} has ${t.key} as it was when you pressed Merge, ${head.slice(0, 7)}.)`, { ticketId: t.id })
    return
  }
  const what = `${t.key} merged as it was when the user pressed Merge into ${main} (${head.slice(0, 7)}), but ${got}, and ${n === 1 ? "that commit isn't" : "those aren't"} `
    + `in ${main}: ${list}`
  attention('left_behind', `${repo.name}: ${what}. ${n === 1 ? 'It is' : 'They are'} still on its branch.`, { ticketId: t.id })
  const f = getFeature(t.feature_id); if (f) tellTpm(f, `HQ: ${what}. If ${n === 1 ? "it's" : "they're"} still wanted, make a ticket for ${it}: its engineer can bring `
    + `${it} in with git cherry-pick ${head.slice(0, 7)}..${at.slice(0, 7)}.`)
}
/** Runs `fn` when the repo's earlier merges are done: nothing else merges there meanwhile. */
export function inMergeQueue<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const job = (merging.get(repoId) ?? Promise.resolve()).then(fn); merging.set(repoId, job.catch(() => {})); return job
}
/** The merge itself. Only inside inMergeQueue. `head`: the branch's commit to merge, not its tip (Bug 143: auto mode merges the commit it tested). The user's
 *  Merge into main merges the branch as it is when it starts (mergeTicket reads it): that's what Try it ran. `behind` (Bugs 184, 212, local repos): the branch
 *  got commits after `head` while it merged, so main has only part of the ticket and it isn't marked merged; the caller says so, or sends it back for them. */
export async function mergeNow(ticketId: string, repo: Repo, tested?: Tested, head?: string): Promise<{ merged: true; sha: string; already: boolean; behind?: string }> {
    const t = getTicket(ticketId)!
    if (t.status === 'merged') return { merged: true as const, sha: '', already: true }
    if (usesGithub(repo) && t.pr_state !== 'local') return mergeOnGithub(t, repo, tested, head) // finished while local-only: still merged here
    if (t.status === 'resolving') throw new Error(`${t.key}'s engineer is ${fixWords(t.fixing, repo.default_branch).ing}; merge it once that's done.`)
    if (t.status !== 'pr_ready' || t.pr_state !== 'local' || !t.branch) throw new Error(`${t.key} isn't finished yet (${t.status}).`)
    const doc = one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', `ticket:${t.id}`, 'pr')?.text ?? ''
    const body = doc.replace(/^# .*\n?/, '').trim() // the engineer's PR text, without its title line
    const r = await mergeIntoMain(repo.path, { branch: t.branch, sha: head, into: repo.default_branch,
      subject: `Merge ${t.key}: ${t.title}`, body: [body, `HQ ticket ${t.key} · ${t.branch}`].filter(Boolean) })
    if (!r.ok) {
      let why = r.why
      if (r.conflicts?.length) {
        const merged = await whoMergedFirst(repo, t, r.conflicts, `refs/heads/${repo.default_branch}`); setConflict(t, r.conflicts, merged, repo.default_branch)
        why = `${t.key} conflicts with ${repo.default_branch} in ${names(r.conflicts)}${merged.length ? ` (${merged.join(', ')} merged first)` : ''}. Nothing was changed.`
          + ` Press Fix conflicts to have its engineer merge ${repo.default_branch} in, or merge it by hand; HQ notices within 2 minutes.`
      }
      emit({ agentId: null, source: 'ui', kind: 'ticket.merge_refused', payload: { ticket: t.id, key: t.key, why, conflicts: r.conflicts ?? null } }); throw new Error(why)
    }
    const tip = head && await git(repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}^{commit}`).catch(() => '') // read after the merge
    if (head && tip && tip !== head && !await git(repo.path, 'merge-base', '--is-ancestor', tip, r.sha).then(() => true, () => false)) {
      void syncRepo(repo.id).catch(() => {}) // main did move: the repo's head, for the UI
      return { merged: true as const, sha: r.sha, already: r.already, behind: tip }
    }
    emit({ agentId: t.assignee_agent_id, source: 'ui', kind: 'ticket.merged_by_hq', payload: { ticket: t.id, key: t.key, sha: r.sha, already: r.already } })
    markMerged(t, null, { byUser: true, tested })
    void syncRepo(repo.id).catch(() => {}) // the repo's head, for the UI
    return { merged: true as const, sha: r.sha, already: r.already }
}
/** Merge for a GitHub repo (Bug 45: through a PR, so GitHub keeps the record): the branch is checked against GitHub's
 *  main and pushed again, a PR is opened if it has none, and GitHub merges it with a normal merge commit. Then it's like any merge
 *  HQ notices, and local main fast-forwards. Nothing changes when GitHub refuses; the user reads why. */
async function mergeOnGithub(t: Ticket, repo: Repo, tested?: Tested, head?: string): Promise<{ merged: true; sha: string; already: boolean }> {
  const slug = parseGithubRemote(repo.remote ?? '')!, o = ghOpts()
  if (t.status === 'resolving') throw new Error(`${t.key}'s engineer is ${fixWords(t.fixing, repo.default_branch).ing}; merge it once that's done.`)
  if (!['pr_ready', 'pr_open'].includes(t.status) || !t.branch) throw new Error(`${t.key} isn't finished yet (${t.status}).`)
  if (t.conflict_files != null) throw new Error(`${t.key} conflicts with ${repo.default_branch}: press Fix conflicts first.`)
  await syncRepo(repo.id) // GitHub's main as it is now
  const base = mergeBase(repo), files = await conflictsWith(repo.path, base.ref, head ?? `refs/heads/${t.branch}`)
  if (files?.length) {
    const first = await whoMergedFirst(repo, t, files, base.ref); setConflict(t, files, first, base.name)
    throw new Error(`${t.key} conflicts with ${base.name} in ${names(files)}${first.length ? ` (${first.join(', ')} merged first)` : ''}. Nothing was merged. Press Fix conflicts.`)
  }
  await pushBranch(repo.path, slug, t.branch, { ...o, sha: head }) // GitHub merges the commits HQ ran in Try it, or the one auto mode tested
  let pr = decidingPr(await prsForBranch(slug, t.branch, o))
  if (pr?.state === 'MERGED') { markMerged(t, pr, { byUser: true, tested }); return { merged: true, sha: '', already: true } }
  if (pr?.state !== 'OPEN') {
    const { title, body } = prText(t)
    try { pr = await createPr(slug, repo.default_branch, t.branch, title, body, o) } catch (e) { throw new Error(`HQ couldn't open a PR to merge ${t.key}: ${(e as Error).message}`) }
    setTicket(t.id, { status: 'pr_open', pr_number: pr.number, pr_url: pr.url, pr_state: 'open' })
    emit({ agentId: t.assignee_agent_id, source: 'system', kind: 'ticket.pr_open', payload: { ticket: t.id, key: t.key, branch: t.branch, pr: pr.number } })
  }
  let sha: string
  try { sha = await mergePr(slug, pr.number, o, head) } catch (e) {
    const why = (e as Error).message; emit({ agentId: null, source: 'ui', kind: 'ticket.merge_refused', payload: { ticket: t.id, key: t.key, why, pr: pr.number } }); throw e
  }
  emit({ agentId: t.assignee_agent_id, source: 'ui', kind: 'ticket.merged_by_hq', payload: { ticket: t.id, key: t.key, sha, pr: pr.number } })
  markMerged(getTicket(t.id)!, { ...pr, state: 'MERGED' }, { byUser: true, tested })
  void syncRepo(repo.id).catch(() => {}) // local main gets the merge
  return { merged: true, sha, already: false }
}
/** Every 2 min, only while some ticket waits for its PR to be opened or merged (or for its conflicts to be fixed). */
export function startMergeWatcher(): void {
  const tick = () => {
    sweepNotices(); if (!one("SELECT 1 AS x FROM tickets WHERE status IN ('pr_ready', 'pr_open', 'resolving')")) return
    checkMerges().catch((e) => emit({ agentId: null, source: 'system', kind: 'merge.check.error', payload: { error: String(e) } }))
  }
  tick(); setInterval(tick, 120_000)
}
