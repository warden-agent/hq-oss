// Auto mode: a project runs end to end with nobody pressing anything. One tick looks at each project on auto and does the next safe
// thing: approve plans (the record stays), start what's ready once the TPM has finished its split, test main once as a run starts, test finished tickets on main and
// merge them one at a time, send failures back to their engineer a limited number of times. A ticket that can't be fixed is parked and
// the rest carry on; anything that breaks the project itself stops new starts and merges until the user presses Resume. A main whose own
// tests fail gets a repair ticket of HQ's first: nothing merges until it's in, and it stops only if the repair can't be done. Usage
// limits only wait. Every step is safe to repeat, so a tick can run on any event, on a timer, and after a restart.
import { spawn, type ChildProcess } from 'node:child_process'
import { DEFAULTS } from './config.ts'
import { getSetting, one, q, run, now } from './db.ts'
import { emit, patch } from './events.ts'
import { id, j } from './util.ts'
import { getAgent, stopAgent, type Agent } from './agents.ts'
import { actionOf, openAsks } from './asks.ts'
import { attention, openAttention, resolveAttention, resolveForTicket, resolveKind, stillOpen, type Attention } from './attention.ts'
import { mergeBase, setConflict, whoMergedFirst } from './conflicts.ts'
import { createPr, mergePr, pushBranch } from './github.ts'
import { restoreMain } from './localmerge.ts'
import { writeFeatureMd } from './projectmd.ts'
import { parseGithubRemote } from './reposync.ts'
import { sendMessage } from './delivery.ts'
import { resumeRepo, switchNotes } from './freshstart.ts'
import { AUTO_OFF_WORDS, autoOnWords } from './handover.ts'
import { checkPlan, planChecks, planLine, stopPlanChecks } from './plancheck.ts'
import { inMergeQueue, mergeNow } from './mergewatch.ts'
import { autoRetries, features, getFeature, getRepo, getTicket, liveTpm, notClearing, repoOfAgent, setTicket, ticketForAgent, tickets, usesGithub, type Feature, type Repo,
  type MergeTest, type Ticket } from './records.ts'
import { isRefusal, ranTestCmd, refusedTestCmd } from './refused.ts'
import { readyTickets } from './readiness.ts'
import { ensureFresh, ghOpts, git, syncRepo } from './repos.ts'
import { canLaunch } from './scheduler.ts'
import { autoGen, autoWork, detectTests, failedLine, failReport, lookAtBase, sandboxProblem, showing, stopAutoTests, testBase, testCombined, type Failed } from './testrun.ts'
export { failedLine } // it lives with the runs now (testrun.ts): conflicts.ts words a send-back with it too (Bug 373)
import { countWords, took } from './testcounts.ts'
import { addFeature, cancelTicket, createTicket, fillSlots, finishedAndStopped, fixConflicts, fixTests, resumeEngineer, testCmdNote } from './tickets.ts'
import { restartTpm, tpmStarting } from './tpm.ts'
import { dialogGone } from './presence.ts'
import { idleTooLong } from './bgruns.ts'
import { saveTestCmds } from './heavy.ts'
import { confirm, lookLines, proofOf, unproven, watchFor } from './criteria.ts'
import { row as previewRow, runnableRecipe } from './preview.ts'
import { lookHow, type LookPlan } from './smoke.ts'
import { keepProposed, LEFT_OUT_ASK, leftOutLines, saysNothing } from './leftout.ts'
import { judge, lookReport, lookWords, needsBase, type Look, type Seen } from './smokerules.ts'
import { readAgain, readDiff, readReport, whyRead } from './diffcheck.ts'
import { diffCheckLine, diffCheckOf } from './checks.ts'
import { criteriaOf, criteriaSummary } from './criteria.ts'
import { undoMapChanges } from './mapstore.ts'
import { triedLines, triedOf } from './testerrules.ts'
import { runUiTest } from './uitester.ts'
import { uiTestLines, uiTestOf, type UiTest } from './uitesterrules.ts'
import { afterUiTest, beforeUiTest, findingsSection, stageDone, stageFailed, testingOn } from './findings.ts'
import type { Retry } from './loopinputs.ts'
import { beat } from './beats.ts'

/** Times HQ sends one ticket back (conflicts, failed tests, a lost engineer, a failed start) before parking it. */
export const MAX_TRIES = 2
/** Repair tickets in one run before HQ stops and asks: a repair that merges with main still broken would otherwise open another forever. */
export const MAX_REPAIRS = 2
const TICK_MS = Number(process.env.HQ_AUTO_TICK_MS ?? 60_000)
const SOON_MS = Number(process.env.HQ_AUTO_SOON_MS ?? 3_000), TPM_GONE_MS = 90_000
const NO_TESTS = "No tests HQ can run, so finished tickets aren't merged. Add a test command, or ask the TPM for a ticket that adds tests."
const RESUMABLE = ['planning', 'implementing', 'awaiting_answer', 'resolving']
const FINISHED_NOT_MERGED = ['pr_ready', 'pr_open']
const DONE = ['merged', 'cancelled']

export type AutoRun = { id: string; repo_id: string; status: 'running' | 'finished' | 'off' | 'undone'; start_sha: string | null; end_sha: string | null; started_at: number;
  ended_at: number | null; summary: string | null; test_change: string | null; main_checked: string | null
  tried: string | null // what the tester of PR #130 tried in a browser as the run ended (JSON, testerrules.ts Tried[]); runs since have ui_test instead
  ui_test: string | null } // what the UI tester did and found as the run ended (JSON, uitesterrules.ts UiTest); null: nothing yet
type TestChange = { was: string | null; now: string; left_out: string }
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
/** Bug 109: `a` is the command `b`, whatever the spacing. Putting a command in place of itself is no change. */
const sameCmd = (a: string, b: string | null | undefined): boolean => !!b && squash(a) === squash(b)
/** The run's change to the test command, if it made one. A record whose command is the one it replaced isn't one: Bug 109 wrote those,
 *  the summary read "Was: X. Now: X", and the run's one allowed change was gone. */
export const testChange = (r: Pick<AutoRun, 'test_change'> | undefined): TestChange | null => {
  const c = j<TestChange | null>(r?.test_change ?? null, null); return c && !sameCmd(c.now, c.was) ? c : null
}
/** Each project's newest runs: a busy project can't push a quiet one's last run out (Bug 63). */
export const autoRuns = (): AutoRun[] => q<AutoRun>(`SELECT * FROM auto_runs a WHERE (SELECT COUNT(*) FROM auto_runs b WHERE b.repo_id = a.repo_id AND b.started_at > a.started_at) < 20
  ORDER BY started_at DESC`)
const openRun = (repoId: string): AutoRun | undefined => one<AutoRun>("SELECT * FROM auto_runs WHERE repo_id = ? AND status = 'running'", repoId)
const liveFeatures = (repoId: string): Feature[] => features().filter((f) => f.repo_id === repoId && f.status !== 'cancelled').reverse() // oldest first
const repoTickets = (repoId: string): Ticket[] => liveFeatures(repoId).flatMap((f) => tickets(f.id))

type RepoFields = Partial<Pick<Repo, 'auto_mode' | 'auto_stopped_why' | 'auto_waiting' | 'test_cmd' | 'test_cmd_proposed' | 'test_cmd_refused' | 'ui_test'>>
function setRepo(repo: Repo, fields0: RepoFields): void {
  const cur = getRepo(repo.id); if (!cur) return // removed from HQ during a test: no patch for a project that's gone
  // Bug 107: a refusal is about one command. However the command changes (the Auto box, a repair's proposal, the user's OK), what HQ knew about the old one goes
  const fields: RepoFields = 'test_cmd' in fields0 && fields0.test_cmd !== cur.test_cmd && cur.test_cmd_refused ? { ...fields0, test_cmd_refused: null } : fields0
  const keys = Object.keys(fields) as (keyof RepoFields)[]
  if (!keys.some((k) => fields[k] !== repo[k])) return
  run(`UPDATE repos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k] ?? null), repo.id)
  patch('repo', repo.id, fields as Record<string, unknown>)
  if (fields.test_cmd_refused === null && cur.test_cmd_refused) resolveKind(REFUSED(repo.id), null) // its ⚠ goes with it
  if ('test_cmd' in fields) saveTestCmds() // Bug 112: what the engineers' Bash hook goes by while HQ is down
}
/** Bug 107: the saved test command Claude Code refused in an engineer's session: its words, whose engineer ran it, and the repair ticket HQ opened for it. */
type Refused = { cmd: string; why: string; by: string; ticket?: string }
const REFUSED = (repoId: string): string => `test_cmd_refused:${repoId}`
const refusedCmd = (repo: Repo): Refused | null => { const r = j<Refused | null>(repo.test_cmd_refused, null); return r && r.cmd === repo.test_cmd ? r : null }
const tellTpm = (repoId: string, body: string): void => { const tpm = liveTpm(repoId); if (tpm) sendMessage({ repoId, channel: 'dm', from: 'hq', to: tpm.id, reason: 'fyi', body }) }
const clearGoAhead = (repoId: string): void => { for (const t of repoTickets(repoId).filter((x) => x.go_ahead && x.status === 'queued')) setTicket(t.id, { go_ahead: 0 }) }

/** A ticket HQ can't get through: the rest carry on, and the summary lists it. Its engineer stops so it doesn't hold a slot. */
export async function park(t: Ticket, why: string): Promise<void> {
  if (getTicket(t.id)?.auto_parked_why) return
  setTicket(t.id, { auto_parked_why: why, go_ahead: 0 })
  const live = t.assignee_agent_id ? getAgent(t.assignee_agent_id) : undefined
  if (live && live.status !== 'exited' && !FINISHED_NOT_MERGED.includes(getTicket(t.id)!.status)) await stopAgent(live.id, 'parked').catch(() => {})
  attention('auto_parked', `${t.key}: ${why}`, { ticketId: t.id })
  const repoId = getFeature(t.feature_id)?.repo_id
  emit({ agentId: null, source: 'system', kind: 'auto.parked', payload: { ticket: t.id, key: t.key, why } })
  // nothing can merge without a repair of main's tests. One of the test command (Bug 107) is different: main is fine and HQ can still test, so the rest carries on
  if (t.repairs_main && !t.repairs_cmd && repoId) { stopProject(getRepo(repoId)!, `${t.key} couldn't repair the tests: ${why}`); return }
  if (repoId) tellTpm(repoId, `HQ: auto mode parked ${t.key}: ${why} The tickets that don't depend on it carry on.`)
}
/** Something that isn't one ticket's fault: no new starts or merges until the user presses Resume. Running engineers finish.
 *  HQ's own test run ends now, as with auto off: its result would be thrown away, and it holds the test turn engineers wait for. Resume tests afresh (Bug 115). */
export function stopProject(repo: Repo, why: string): void {
  const cur = getRepo(repo.id); if (!cur?.auto_mode || cur.auto_stopped_why) return
  setRepo(cur, { auto_stopped_why: why }); clearGoAhead(repo.id); stopAutoTests(cur.path)
  attention(`auto_stopped:${repo.id}`, `${repo.name}: auto mode stopped. ${why}`)
  emit({ agentId: null, source: 'system', kind: 'auto.stopped', payload: { repo: repo.id, why } })
  tellTpm(repo.id, `HQ: auto mode stopped: ${why} Nothing new starts or merges until the user resumes it.`)
}
/** One more go at a ticket, or parks it. `act` does the go. */
async function retry(t: Ticket, why: string, act: () => Promise<unknown>): Promise<void> {
  if (t.auto_tries >= MAX_TRIES) return park(t, why)
  setTicket(t.id, { auto_tries: t.auto_tries + 1 })
  try { await act() } catch (e) { await park(t, `${why} HQ couldn't send it back: ${(e as Error).message}`) }
}

/** Notices that mean something for this project on auto. `dialog`: an engineer waits for a person, and none is coming. A stuck or
 *  errored engineer gets a fresh one first: going quiet for a while isn't the ticket's fault. Not `pr_failed` (Bug 247): that is the user's Make PR, or the
 *  watcher's retry of it, and on auto HQ opens the PR itself as it merges (mergeOnGithub), stopping with GitHub's reason if it's refused. Stopping on the
 *  notice stopped auto again at every Resume, with nothing tried, until the PR was opened, and even once the user had opened it by hand. */
const STOP_KINDS = ['push_failed'], PARK_KINDS = ['blocked', 'dialog'], REPLACE_KINDS = ['stuck', 'api_error']
export async function readNotices(repo: Repo, all: Ticket[]): Promise<void> {
  const mine = new Map(all.map((t) => [t.id, t]))
  for (const seen of openAttention() as Attention[]) {
    const was = seen.agent_id ? getAgent(seen.agent_id) : undefined
    // a session that's over has no dialog (Bug 62) and isn't stuck (Bug 114): lostEngineers starts a fresh one if work is left
    if ((seen.kind === 'dialog' || seen.kind === 'stuck') && was?.status === 'exited') { resolveAttention(seen.id); continue }
    if (seen.kind === 'dialog' && was && await dialogGone(was, seen.created_at)) continue // answered already: the stuck loop clears it on its next two looks
    // Bug 117: that tmux call, and the parks and stops for the notices before this one, let other things happen. A notice resolved or
    // replaced meanwhile (a new dialog takes the old one's place) is left alone: the next look acts on the open one, with its words.
    const a = stillOpen(seen.id); if (!a) continue
    const agent = a.agent_id ? getAgent(a.agent_id) : undefined, before = a.ticket_id ? mine.get(a.ticket_id) : undefined
    if (agent?.role === 'tpm' && agent.repo_id === repo.id && agent.status !== 'exited' && ['blocked', 'dialog', 'api_error'].includes(a.kind)) {
      stopProject(repo, `The TPM needs you: ${a.detail}`); continue
    }
    // parked before this look: skipped. Parked earlier in this look: its other notices are resolved below (park does nothing twice)
    const t = before && !before.auto_parked_why ? getTicket(before.id) : undefined; if (!t) continue
    if (STOP_KINDS.includes(a.kind)) stopProject(repo, a.detail)
    else if (t.auto_parked_why) resolveAttention(a.id) // Bug 355: parked by a notice before this one: no retry or fresh engineer for it
    else if (PARK_KINDS.includes(a.kind)) { resolveAttention(a.id); await park(t, a.detail) }
    else if (a.kind === 'launch_failed') { resolveAttention(a.id); await retry(t, a.detail, async () => {}) } // the next start tries again
    else if (REPLACE_KINDS.includes(a.kind)) { resolveAttention(a.id); await retry(t, a.detail, () => replaceEngineer(t, agent)) }
  }
}
async function replaceEngineer(t: Ticket, a: Agent | undefined): Promise<void> {
  if (a && a.status !== 'exited') await stopAgent(a.id, 'replaced by auto mode')
  await resumeEngineer(t.id, { replace: true })
}
/** Engineers that ended their turn with the ticket unfinished: nothing else notices them, and they'd hold a slot and the run forever.
 *  One with a message or a run in the background on its way isn't one of them (bgruns.ts idleTooLong). */
async function idleEngineers(all: Ticket[]): Promise<void> {
  for (const t0 of all.filter((x) => x.assignee_agent_id)) {
    const t = getTicket(t0.id); if (!t?.assignee_agent_id) continue // read after the last one's wait (Bug 355)
    const a = getAgent(t.assignee_agent_id); if (idleTooLong(t, a)) await retry(t, 'Its engineer stopped before finishing.', () => replaceEngineer(t, a))
  }
}
/** Engineers that went away with work left: one fresh start each, within the ticket's tries. */
async function lostEngineers(all: Ticket[]): Promise<void> {
  const lost = (x: Ticket | undefined): x is Ticket => !!x && RESUMABLE.includes(x.status) && !!x.assignee_agent_id && !x.parked_at && !x.auto_parked_why
  for (const t0 of all.filter(lost)) {
    const t = getTicket(t0.id); if (!lost(t)) continue // read after the last one's wait (Bug 355)
    const a = getAgent(t.assignee_agent_id!); if (!a || a.status !== 'exited' || a.fresh_start_at) continue
    await retry(t, `Its engineer stopped working on it (${a.id}).`, () => resumeEngineer(t.id, { replace: true }))
  }
}
function approvePlans(all: Ticket[]): void {
  for (const r of q<{ id: string; ticket_id: string }>("SELECT id, ticket_id FROM review_requests WHERE status = 'open'")) {
    if (all.some((t) => t.id === r.ticket_id)) checkPlan(r.id) // checked against its criteria first, then approved or sent back (plancheck.ts); safe to repeat
  }
}
/** The TPM has finished for now: its split is done, so its tickets can start (a ticket that started mid-split couldn't be rewired). */
const tpmSettled = (repoId: string): boolean => {
  const tpm = liveTpm(repoId); if (!tpm) return true
  return tpm.status === 'idle' && !one("SELECT 1 AS x FROM messages WHERE to_id = ? AND from_id = 'user' AND delivered_at IS NULL", tpm.id) // HQ's own notices don't change a split
}
async function startReady(repo: Repo): Promise<void> {
  const cur = getRepo(repo.id); if (!cur?.auto_mode || cur.auto_stopped_why || cur.clearing_at) return // Bug 355: keepTpm's wait may have stopped it
  const asking = new Set(openAsks().map((a) => actionOf(a)?.ticket))
  for (const f of liveFeatures(repo.id)) {
    for (const t of readyTickets(tickets(f.id), j<string[]>(f.merge_order, []))) if (!t.go_ahead && !t.auto_parked_why && !asking.has(t.id)) setTicket(t.id, { go_ahead: 1 })
  }
  await fillSlots()
}
/** Tickets that won't move because something they wait on was parked. */
function stuckBehindParked(all: Ticket[]): Set<string> {
  const parked = new Set(all.filter((t) => t.auto_parked_why).map((t) => t.key)), out = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const t of all) if (!out.has(t.id) && t.status === 'queued' && j<string[]>(t.deps, []).some((k) => parked.has(k))) { out.add(t.id); parked.add(t.key); grew = true }
  }
  return out
}
/** Work that can still move on its own. Finished tickets with no tests to run can't, or a run with no tests would never end. */
const moving = (repo: Repo, all: Ticket[]): Ticket[] => {
  const behind = stuckBehindParked(all), noTests = repo.auto_waiting === NO_TESTS
  return all.filter((t) => !DONE.includes(t.status) && !t.auto_parked_why && !behind.has(t.id) && !(noTests && FINISHED_NOT_MERGED.includes(t.status)))
}

/** Why the tests failed, for the user and the TPM. A run that froze has no failed line worth naming: whatever came first is misleading. */
const whyFailed = (r: Failed): string => r.hung
  ? `The tests froze and were stopped after ${getSetting('test_timeout_min', DEFAULTS.test_timeout_min)} minutes.` : `Failed: ${failedLine(`${r.earlier}\n${r.output}`)}`
const mergingNow = new Set<string>() // repos with a test and merge under way: tests can take minutes, so ticks don't wait for them
const ref = (repo: Repo): Promise<string> => git(repo.path, 'rev-parse', '--verify', '--quiet', `${mergeBase(repo).ref}^{commit}`).catch(() => '')
const noTestsAt = new Map<string, string>() // ticket → the main and ticket that had no tests: looked at again only when one of them moves
const testState = (t: Ticket, tip: string): string => `${tip}:${t.updated_at}`
/** The next finished ticket: tested on main, then merged. Oldest feature first, in the TPM's merge order. */
function nextToMerge(repo: Repo, tip: string): Ticket | undefined {
  const repair = openRepair(repo.id)
  if (repair) return FINISHED_NOT_MERGED.includes(repair.status) && repair.branch ? repair : undefined // nothing else merges until it's in
  for (const f of liveFeatures(repo.id)) {
    const order = j<string[]>(f.merge_order, []), rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? Number.MAX_SAFE_INTEGER : i }
    const t = tickets(f.id).filter((x) => FINISHED_NOT_MERGED.includes(x.status) && x.branch && !x.auto_parked_why && noTestsAt.get(x.id) !== testState(x, tip)).sort((a,
      b) => rank(a.key) - rank(b.key) || a.updated_at - b.updated_at)[0]
    if (t) return t
  }
  return undefined
}
/** The repair ticket being worked on: HQ opened it, it isn't finished, and it wasn't given up on. */
export const openRepair = (repoId: string): Ticket | undefined => repoTickets(repoId).find((t) => t.repairs_main && !DONE.includes(t.status) && !t.auto_parked_why)
const repairNote = (repo: Repo, t: Ticket): string => `Fixing ${t.repairs_cmd ? 'the test command' : `${mergeBase(repo).name}'s tests`} (${t.key}). Nothing merges until that's in.`
const repairSpec = (base: string, r: Failed): string => `## What
${base}'s own tests fail, without any ticket on it, so nothing can merge. HQ opened this ticket by itself. ${whyFailed(r)}

HQ runs \`${r.test}\` in its test sandbox, in a fresh checkout of ${base}, and said:

\`\`\`
${failReport(r, 8000)}
\`\`\`

## What HQ's test sandbox can't do
- Reach the internet: only localhost. A test that needs a real website, or a library that calls one, fails or hangs there.
- Reach Docker or any socket outside its checkout.
- See git-ignored files, such as a build's output. Nothing is built unless the test command builds it.

## Steps
1. Find out why, from the output above. Run the tests with a time limit, so a frozen run can't hold you up: the Bash tool's own \`timeout\` setting, not a \`timeout\` command (a Mac has none).
2. If a test or the code is wrong, fix that, then call open_pr. HQ tests it and merges it first.
3. If the command itself can't work in the sandbox, find one that does:
   - Run it with the Bash tool, exactly as you'll propose it. HQ only takes a command it has seen run in your session, because every engineer has to run it there,
     and Claude Code refuses some commands that HQ's sandbox would run: \`node --test $(ls test/*.js)\`, for one, where the list of files is worked out as it runs.
   - If yours is refused, move the part it refuses into a script in the repo (an npm script, for one) and commit it. Don't swap it for a fixed list of files:
     tests added later would never run.
   - Then call propose_test_command, saying exactly what it leaves out. HQ tries it too, on ${base} plus your branch.

## Rules
- Fix the cause. Don't delete or weaken a test that can run in the sandbox, and leave out only what can't.
- When you call open_pr, ${LEFT_OUT_ASK}
- Keep it small: this ticket is about the tests and nothing else.
- If you can't fix it from here, call report_blocked and say why.`
/** Main fails with no ticket on it. On auto HQ opens a ticket to repair it, and stops only when that can't help. */
async function repairMain(repo: Repo, tip: string, b: Failed): Promise<void> {
  const base = mergeBase(repo).name, run0 = openRun(repo.id)
  const made = run0 ? repoTickets(repo.id).filter((t) => t.repairs_main && !t.repairs_cmd && t.created_at >= run0.started_at).length : 0 // repairs of main's tests only
  if (made >= MAX_REPAIRS) return stopProject(repo, `${base}'s own tests still fail after ${made} repairs, so HQ can't tell good work from bad. ${whyFailed(b)}`)
  const f = addFeature(repo.id, `Get ${base}'s tests passing`, `HQ opened this by itself: ${base}'s own tests fail. ${whyFailed(b)}`)
  const t = createTicket(f.id, { title: `Fix ${base}'s tests`, size: 'S', spec: repairSpec(base, b), repairs_main: tip })
  setRepo(repo, { auto_waiting: repairNote(repo, t) })
  emit({ agentId: null, source: 'system', kind: 'auto.repair_opened', payload: { repo: repo.id, ticket: t.id, key: t.key } })
  tellTpm(repo.id, `HQ: ${base}'s own tests fail, even without any ticket, so HQ opened ${t.key} to repair them. ${whyFailed(b)} `
    + 'Nothing merges until it\'s in; other work carries on. Don\'t open another ticket for this. '
    + 'Its spec is HQ\'s and stays as it is: anything you give update_ticket_spec for it is added under HQ\'s text.') // Bug 108
}
const refusedSpec = (base: string, r: Refused): string => `## What
Claude Code refuses this project's test command in an engineer's session, so engineers can't run the full tests before they finish. HQ opened this ticket by itself.
${base}'s tests aren't known to fail: this ticket is about the command, not the tests.

The command:

\`\`\`
${r.cmd}
\`\`\`

What Claude Code said when ${r.by}'s engineer ran it:

\`\`\`
${r.why}
\`\`\`

## Why
Every engineer works in a worktree of its own, and Claude Code only runs a command there when it can tell beforehand that the command stays inside that worktree.
For some commands it can't tell: a git command inside \`$( )\` or a here-document, for instance.
The same line inside a script in the repo runs, because then the command the engineer types is plain.

## Steps
1. Run the command above with the Bash tool, exactly as written, to see the refusal yourself.
2. Move the part Claude Code refuses into a script in the repo (an npm script, or a shell script) and commit it. It must run the same tests as before.
   Don't swap it for a fixed list of files: tests added later would never run.
3. Run the new command with the Bash tool, exactly as you'll propose it. HQ only takes a command it has seen run in your session.
4. Call propose_test_command with it. For left_out say "nothing" if it runs the same tests. HQ tries it too, on ${base} plus your branch, and tells you what's next.

## Rules
- Change how the tests are started, not the tests. Don't delete or weaken one.
- When you call open_pr, ${LEFT_OUT_ASK}
- Keep it small: this ticket is about the test command and nothing else.
- If the old command runs for you after all, or you can't do this from here, call report_blocked and say why.`
/** Bug 107: Claude Code refuses the saved test command in engineers' sessions. On auto HQ opens one repair ticket for that command: its engineer moves the refused
 *  part into a script and proposes the new command, as a repair of main's tests may (propose_test_command). It holds merges like any repair: the new command is
 *  saved before the script it needs is in main. Opened once per command: if it can't be done it's parked, the ⚠ stays, and the rest carries on. */
async function repairCommand(repo: Repo): Promise<void> {
  const tip = await ref(repo), cur = getRepo(repo.id), r = cur ? refusedCmd(cur) : null // read after the wait: the command, or auto mode, may have changed meanwhile
  if (!tip || !cur?.auto_mode || cur.auto_stopped_why || cur.clearing_at || !r || r.ticket || openRepair(repo.id)) return
  const f = addFeature(repo.id, 'Make the test command work for engineers', "HQ opened this by itself: Claude Code refuses the project's test command in an engineer's session.")
  const t = createTicket(f.id, { title: 'Fix the test command', size: 'S', spec: refusedSpec(mergeBase(repo).name, r), repairs_main: tip, repairs_cmd: r.cmd })
  setRepo(cur, { test_cmd_refused: JSON.stringify({ ...r, ticket: t.key }), auto_waiting: repairNote(repo, t) })
  emit({ agentId: null, source: 'system', kind: 'auto.repair_opened', payload: { repo: repo.id, ticket: t.id, key: t.key, why: 'test_cmd_refused' } })
  tellTpm(repo.id, `HQ: Claude Code refuses this project's test command in an engineer's session, so engineers can't run the full tests. HQ opened ${t.key} to fix the command. `
    + 'Nothing merges until it\'s in; other work carries on. Don\'t open another ticket for this.')
}
/** Main's own tests, once per run (Bug 70): one project's could never pass in HQ's sandbox, and nobody knew until its first ticket finished, 40 minutes in. Tickets start alongside
 *  this. A failure runs once more before a repair opens, so a flaky suite can't spend one: that's two failures, as a ticket failing and then main failing is. A run that hung
 *  isn't repeated. No tests stays quiet: the first ticket often adds them. Not recorded when the run has moved on, so a restart looks again. */
async function checkMain(repo0: Repo, r: AutoRun): Promise<void> {
  const still = () => { const cur = getRepo(repo0.id); return cur?.auto_mode && !cur.auto_stopped_why && !cur.clearing_at && openRun(cur.id)?.id === r.id ? cur : null }
  await inMergeQueue(repo0.id, async () => {
    const gen = autoGen(repo0.path); if (!still()) return // read first: auto going off or stopping from here on stops the run (Bugs 89, 115)
    const repo = await ensureFresh(repo0.id).catch(() => null); if (!repo || !still()) return
    const base = mergeBase(repo), tip = await ref(repo)
    const checked = () => { run('UPDATE auto_runs SET main_checked = ? WHERE id = ?', tip || 'nothing to test', r.id); patch('auto_run', r.id, { main_checked: tip || 'nothing to test' }) }
    // A finished ticket already waiting goes first: its own test checks main, and tests main alone if it fails (PR #59). A new test command that only that ticket satisfies
    // would otherwise look like a broken main and open a repair that holds it up.
    if (!tip || repo.empty || openRepair(repo.id) || nextToMerge(repo, tip)) return checked()
    const test = () => testBase(repo.path, base.ref, `run-${r.id}`, repo.test_cmd, gen, { repoId: repo.id, ticketId: null, what: 'main' })
    let b = await test(); if (b.kind === 'fail' && !b.hung && still()) b = await test()
    if (b.kind === 'stopped') return // auto went off or stopped: no result, and a later run checks again (Bugs 89, 115)
    emit({ agentId: null, source: 'system', kind: 'auto.main_checked', payload: { repo: repo.id, run: r.id, result: b.kind, test: 'test' in b ? b.test : null } })
    const cur = still(); if (!cur) return
    checked()
    if (b.kind === 'error') return stopProject(cur, `HQ couldn't test ${base.name}: ${b.why}`)
    if (b.kind === 'fail' && !openRepair(cur.id) && cur.test_cmd === repo.test_cmd && await ref(cur) === tip) await repairMain(cur, tip, b) // not if main or the command moved meanwhile
  })
}
type NoLook = Extract<Look, { ran: 'skipped' }>
/** Projects whose app didn't start on main, in HQ's sandbox, during the run named: an app that needs something the sandbox hasn't got (Docker, a site on the
 *  internet) would otherwise cost every ticket of the run two waits of a minute, to learn the same thing. For the rest of that run HQ doesn't open it; the
 *  next run looks again. In memory only: after a restart the next ticket finds out afresh. */
const deadApp = new Map<string, { run: string; why: string }>()
/** What HQ starts to look at a project's app before a merge: the launch recipe its preview runs (the user's own command, or the steps they OK'd). Or why it
 *  won't look, which is nobody's fault: `quiet`, so the summary doesn't repeat it for every ticket of a project that has no app to open. */
/** `tester`: for the UI tester, which has its own switch: the look's setting doesn't turn it off. */
function lookPlan(repo: Repo, o: { tester?: boolean } = {}): { plan: LookPlan } | { skip: NoLook } {
  if (!o.tester && getSetting('app_look', DEFAULTS.app_look) === 'off') return { skip: { ran: 'skipped', why: 'opening the app before a merge is turned off in HQ\'s settings', quiet: true } }
  const dead = deadApp.get(repo.id); if (dead && dead.run === openRun(repo.id)?.id) return { skip: { ran: 'skipped', why: dead.why, dead: true } }
  const recipe = runnableRecipe(previewRow(repo.id), repo.path)
  if (!recipe) return { skip: { ran: 'skipped', why: 'HQ has no start steps for this project (press Launch app once, and it looks before every merge after that)', quiet: true } }
  return { plan: { recipe, repoPath: repo.path, how: lookHow(recipe) } }
}
/** The commit a ticket's branch is on now; '' when the branch is gone. */
const branchAt = (repo: Repo, t: Ticket): Promise<string> => git(repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}^{commit}`).catch(() => '')
/** Bug 143: the branch has commits from after the engineer's open_pr. HQ merges only what open_pr hands over, so the ticket is unfinished again until its engineer
 *  calls open_pr once more. A running engineer is told so; one that has stopped gets a fresh start (lostEngineers), one that goes quiet a replacement (idleEngineers).
 *  `merged` (Bug 184): they came while HQ merged it, so that commit is in main and the rest isn't; open_pr naming them meanwhile leaves the next tick to test them. */
async function changedAfterOpenPr(t: Ticket, at: string, merged?: string): Promise<void> {
  const cur = getTicket(t.id); if (!cur || !FINISHED_NOT_MERGED.includes(cur.status) || !cur.finished_sha) return
  const named = cur.finished_sha === at; if (named && !merged) return
  const a = cur.assignee_agent_id ? getAgent(cur.assignee_agent_id) : undefined, live = !named && a && a.status !== 'exited' && !finishedAndStopped(a.id) ? a : undefined
  if (!named) setTicket(t.id, { status: 'implementing', prior_status: null, fixing: null })
  emit({ agentId: null, source: 'system', kind: 'auto.moved', payload: { ticket: t.id, key: t.key, finished: merged ?? cur.finished_sha, now: at, told: live?.id ?? null,
    ...(merged ? { merged: true, named } : {}) } })
  const repo = getRepo(getFeature(t.feature_id)?.repo_id ?? ''), main = repo?.default_branch ?? 'main'
  if (merged && !named && repo) { // the TPM hears why a ticket it was told is finished is building again (on auto its engineer has usually stopped by now)
    const log = await git(repo.path, 'log', '--format=%h %s', `${merged}..${at}`, '--').catch(() => ''), commits = log.split('\n').filter(Boolean)
    const list = commits.slice(0, 5).map((c) => `"${c}"`).join(', ') + (commits.length > 5 ? ` and ${commits.length - 5} more` : '')
    tellTpm(repo.id, `HQ: ${t.key}'s tested commit (${merged.slice(0, 7)}) is merged into ${main}, but its branch got commits while it merged that aren't in ${main}: `
      + `${list}. So ${t.key} is building again: ${live ? 'its engineer was told to' : 'a fresh engineer will'} finish them and call open_pr again, and HQ tests and merges them.`)
  }
  if (!live) return
  sendMessage({ featureId: t.feature_id, channel: 'dm', from: 'hq', to: live.id, reason: 'fyi', body: merged
    ? `HQ: the commit your open_pr handed over (${merged.slice(0, 7)}) is merged into ${main}, but ${t.branch} got commits after it while it merged, and those aren't in `
      + `${main}, so ${t.key} isn't finished yet. Finish what you're changing, run the tests, commit, then call open_pr again: HQ tests and merges the rest.`
    : `HQ: ${t.branch} has commits from after your open_pr, so HQ hasn't `
      + `merged ${t.key}: it only merges the commit open_pr hands over, once its tests pass. Finish what you're changing, run the tests, commit, then call open_pr again.` })
}
/** Bug 184: the branch got commits after the one HQ merged, too late to keep the ticket open (a GitHub merge, or once it was marked merged). They aren't in main, and
 *  nothing would say so: its TPM, which can make a ticket for them, and the user hear which they are. */
async function leftBehind(repo: Repo, t: Ticket, merged: string, at: string): Promise<void> {
  const log = await git(repo.path, 'log', '--format=%h %s', `${merged}..${at}`, '--').catch(() => ''), commits = log.split('\n').filter(Boolean)
  if (!commits.length) return
  const list = commits.slice(0, 5).map((c) => `"${c}"`).join(', ') + (commits.length > 5 ? ` and ${commits.length - 5} more` : '')
  const what = `${t.key} merged as HQ tested it, but ${t.branch} got ${commits.length === 1 ? 'a commit' : `${commits.length} commits`} after that, while it merged, `
    + `which ${commits.length === 1 ? "isn't" : "aren't"} in ${repo.default_branch}: ${list}`
  emit({ agentId: null, source: 'system', kind: 'auto.left_behind', payload: { ticket: t.id, key: t.key, merged, now: at, commits: commits.length } })
  attention('left_behind', `${repo.name}: ${what}. ${commits.length === 1 ? 'It is' : 'They are'} still on its branch.`, { ticketId: t.id })
  tellTpm(repo.id, `HQ: ${what}. If ${commits.length === 1 ? "it's" : "they're"} still wanted, make a ticket for ${commits.length === 1 ? 'it' : 'them'}: its engineer can bring `
    + `${commits.length === 1 ? 'it' : 'them'} in with git cherry-pick ${merged.slice(0, 7)}..${at.slice(0, 7)}.`)
}
/** Bug 143: has the branch moved off `head`, the commit HQ tested? Then it isn't merged: open_pr names the new commit, or the ticket is unfinished again (the
 *  next tick tests it), or, with the branch gone, the project stops. Bug 208: asked before the diff read too, so HQ pays for no read of a commit it won't merge. */
async function branchMoved(repo: Repo, t: Ticket, head: string): Promise<boolean> {
  const at = await branchAt(repo, t); if (at === head) return false
  if (at) await changedAfterOpenPr(t, at); else stopProject(repo, `HQ couldn't merge ${t.key}: its branch ${t.branch} is gone.`)
  return true
}
async function testAndMerge(repo0: Repo, t0: Ticket): Promise<void> {
  const still = () => { const r = getRepo(repo0.id), t = getTicket(t0.id); return r?.auto_mode && !r.auto_stopped_why && !r.clearing_at && t && FINISHED_NOT_MERGED.includes(t.status) &&
    !t.auto_parked_why ? { repo: r, t } : null }
  await inMergeQueue(repo0.id, async () => {
    const gen = autoGen(repo0.path); if (!still()) return // read first: auto going off or stopping from here on stops the run (Bugs 89, 115)
    const repo = await ensureFresh(repo0.id).catch((e) => { stopProject(repo0, `HQ couldn't bring it up to date: ${(e as Error).message}`); return null }); if (!repo || !still()) return
    const t = getTicket(t0.id)!, base = mergeBase(repo), tip = await ref(repo)
    // Bug 143: HQ tests the commit its open_pr handed over, by its sha, and merges that one: a commit added later goes nowhere until open_pr names it
    const head = await branchAt(repo, t), named = still()?.t; if (!named) return // read after the wait: open_pr may have been called again meanwhile
    if (!head) return stopProject(repo, `HQ couldn't test ${t.key}: its branch ${t.branch} is gone.`)
    if (named.finished_sha && head !== named.finished_sha) return changedAfterOpenPr(t, head)
    const proof = proofOf(t) // the tests its open_pr named for its criteria: the run is watched for them by name
    const lp = lookPlan(repo) // and once they pass, HQ opens the app in the same checkout
    const r = await testCombined(repo.path, base.ref, head, t.key, repo.test_cmd, gen, { repoId: repo.id, ticketId: t.id, what: 'ticket' }, // on its box meanwhile (Bug 106)
      { watch: watchFor(proof?.tests ?? []), look: 'plan' in lp ? lp.plan : null })
    if (r.kind === 'stopped' || r.kind === 'looked') return // auto went off or stopped: nothing follows, not even with it back on by now (Bugs 89, 115)
    emit({ agentId: null, source: 'system', kind: 'auto.tested', payload: { ticket: t.id, key: t.key, result: r.kind, test: 'test' in r ? r.test : null } })
    if (!still()) return // turned off or removed during the test: a run that was killed reads as a failure, and nothing should follow from it
    if (r.kind === 'no_tests') { noTestsAt.set(t.id, testState(t, tip)); setRepo(repo, { auto_waiting: NO_TESTS }); return }
    if (repo.auto_waiting === NO_TESTS) setRepo(repo, { auto_waiting: null })
    if (r.kind === 'error') return stopProject(repo, `HQ couldn't test ${t.key}: ${r.why}`)
    if (r.kind === 'conflicts') {
      const merged = await whoMergedFirst(repo, t, r.files, base.ref); setConflict(t, r.files, merged, base.name)
      return retry(t, `Its conflicts with ${base.name} weren't fixed in ${MAX_TRIES} tries.`, () => fixConflicts(t.id))
    }
    if (r.kind === 'fail') {
      const fix = () => retry(t, `Its tests still fail on ${base.name} after ${MAX_TRIES} fixes. ${whyFailed(r)}`, () => fixTests(t.id, r))
      if (t.repairs_main) return fix() // main is broken: that's why this ticket exists, so testing main alone says nothing
      const b = await testBase(repo.path, base.ref, t.key, repo.test_cmd, gen, { repoId: repo.id, ticketId: t.id, what: 'main' }); if (b.kind === 'stopped') return
      if (b.kind === 'fail') { if (still()) await repairMain(getRepo(repo.id)!, tip, b); return } // turned off during the test: nothing to repair for
      return fix()
    }
    const cur = still(); if (!cur) return // turned off, stopped or moved on during the test: not merged
    if (proof?.tests.length) { // a passing run that skipped or never ran a criterion's test proves nothing about it: back to its engineer, like a failure
      const tests = proof.tests.map((e) => ({ ...e, state: confirm(e, r.names) })), missing = unproven(tests, r.test)
      setTicket(t.id, { proof: JSON.stringify({ ...proof, tests, confirmed_at: now() }) })
      const failed: Failed = { kind: 'fail', test: r.test, unproven: true, missing: missing.length, earlier: '',
        output: `The tests that didn't run:\n${missing.map((m) => `- ${m}`).join('\n')}` }
      if (missing.length) return retry(t, `The tests named for its criteria still didn't all run after ${MAX_TRIES} fixes. ${missing[0]}`, () => fixTests(t.id, failed))
    }
    // HQ's look at the app with the ticket merged in (smokerules.ts). Only what the ticket changed counts: when something is wrong, HQ looks at main alone too.
    let look: Look = 'skip' in lp ? lp.skip : { ran: 'skipped', why: 'HQ\'s look at the app didn\'t run' }
    if ('plan' in lp && r.seen) {
      let main: Seen | null = null
      if (needsBase(r.seen)) {
        const b = await lookAtBase(repo.path, base.ref, t.key, lp.plan, gen, { repoId: repo.id, ticketId: t.id, what: 'look_main' })
        if (b.kind === 'stopped' || !still()) return
        main = b.kind === 'looked' ? b.seen : { kind: 'skipped', why: `HQ couldn't open the app on ${base.name} to compare${b.kind === 'error' ? ` (${b.why})` : ''}` }
      }
      look = judge(r.seen, main, base.name)
      const run = openRun(repo.id); if (look.ran === 'skipped' && look.dead && run) deadApp.set(repo.id, { run: run.id, why: look.why })
      emit({ agentId: null, source: 'system', kind: 'auto.looked', payload: { ticket: t.id, key: t.key, ran: look.ran, why: 'why' in look ? look.why : null, compared: !!main } })
      if (look.ran === 'fail') {
        const failed: Failed = { kind: 'fail', test: lp.plan.how, look: true, earlier: '', output: lookReport(look, lp.plan.how) }
        return retry(t, `The app still has problems with it merged in after ${MAX_TRIES} fixes. ${look.why}`, () => fixTests(t.id, failed))
      }
    }
    // A fresh reader of its changes (diffcheck.ts), last, once everything that costs nothing has passed, and only for a ticket worth one: by its size, or by
    // what git and the plan check flagged. Once per commit open_pr names (Bug 185): one it sent back merges on its next pass without another read.
    const read = diffCheckOf(getTicket(t.id) ?? t), why = readAgain(read, head) ? whyRead(t, proofOf(getTicket(t.id) ?? t), planChecks(t.id)) : []
    if (why.length && getSetting('diff_check', DEFAULTS.diff_check) !== 'off') {
      if (await branchMoved(repo, t, head) || !still()) return // Bug 208: a commit came during the test: none of this merges, so nothing is read
      const work = autoWork(repo.path, gen), page = showing({ repoId: repo.id, ticketId: t.id, what: 'review' })
      const d = await readDiff({ repoPath: repo.path, base: base.ref, branch: head, criteria: criteriaOf(t), why, test: r.test, output: r.output, signal: work.signal })
        .finally(() => { work.done(); page.over() })
      if (d === 'stopped' || !still()) return
      setTicket(t.id, { diff_check: JSON.stringify({ ...d, sha: head }) })
      emit({ agentId: null, source: 'system', kind: 'auto.read', payload: { ticket: t.id, key: t.key, state: d.state, why, findings: d.state === 'sent_back' ? d.findings : [],
        again: !!read && read.sha !== head } }) // a commit after the one last read
      if (d.state === 'sent_back') {
        const failed: Failed = { kind: 'fail', test: r.test, review: true, earlier: '', output: readReport(d.findings) }
        const first = `${d.findings[0]!.about}: ${d.findings[0]!.problem}`
        return retry(t, `A fresh reader of its changes found problems, and its ${MAX_TRIES} fixes were used up already. ${first}`, () => fixTests(t.id, failed))
      }
    }
    const fresh = await ensureFresh(repo.id).catch(() => repo)
    if (await ref(fresh) !== tip) return // main moved during the test: the next tick tests again
    if (await branchMoved(fresh, t, head)) return // Bug 143: the branch moved during the test (or the read)
    const tested = { ran: 'pass' as const, test: r.test, counts: r.counts, ms: r.ms, on: base.name, at: now(), output: r.output, look } // the run that let it merge (Bug 126)
    let m: Awaited<ReturnType<typeof mergeNow>>
    try { m = await mergeNow(t.id, fresh, tested, head) } catch (e) {
      if (getTicket(t.id)?.conflict_files != null) return // the next tick fixes it
      return stopProject(repo, (e as Error).message)
    }
    // Bug 184: the branch moved while it merged. Main has the commit HQ tested; what came after goes back to its engineer, or, too late for that, is named
    if (m.behind) return changedAfterOpenPr(t, m.behind, head)
    const after = await branchAt(fresh, t); if (after && after !== head && getTicket(t.id)?.status === 'merged') await leftBehind(fresh, t, head, after)
  })
}

const tryingNow = new Set<string>() // projects whose app the UI tester is using now: the run ends once it has
/** Is the UI tester on for this project: HQ's setting, and the project's own switch. */
export const uiTestOn = (repo: Repo): boolean => getSetting('tester', DEFAULTS.tester) !== 'off' && repo.ui_test !== 'off'
/** As a run ends: should the UI tester use the app now? Once a run, never per ticket, and only on a run that merged something. */
const wantsUiTest = (repo: Repo, r: AutoRun): boolean => uiTestOn(repo) && !r.ui_test && inRun(r).length > 0
/** The UI tester on the whole app, on main as the run leaves it (uitester.ts). It ends tested or skipped with why, kept with the run, so a run tests once and
 *  can't wait on it for ever. Only a stop (auto off, the project stopped) keeps nothing: that run doesn't end by itself, and one that starts later tests. */
async function uiTestRun(repo0: Repo, r: AutoRun, retry: Retry[] = []): Promise<void> {
  const gen = autoGen(repo0.path) // read first: auto going off or stopping from here on stops the tester (Bugs 89, 115)
  const still = () => { const cur = getRepo(repo0.id); return cur?.auto_mode && !cur.auto_stopped_why && !cur.clearing_at && openRun(cur.id)?.id === r.id ? cur : null }
  const repo = still(); if (!repo) return
  const lp = lookPlan(repo, { tester: true }), skipped = (why: string, quiet?: boolean): UiTest => ({ at: now(), state: 'skipped', why, ...(quiet ? { quiet } : {}) })
  const tickets = inRun(r).map((t) => ({ key: t.key, title: t.title, criteria: criteriaOf(t) }))
  const u: UiTest | 'stopped' = 'skip' in lp ? skipped(lp.skip.why, lp.skip.quiet)
    : await runUiTest({ repoPath: repo.path, repoId: repo.id, runId: r.id, sha: await ref(repo), plan: lp.plan, gen, tickets, retry })
      .catch((e) => skipped(`HQ hit an error (${(e as Error).message.split('\n')[0]})`))
  if (u === 'stopped' || !still()) return
  const json = JSON.stringify(u)
  run('UPDATE auto_runs SET ui_test = ? WHERE id = ?', json, r.id); patch('auto_run', r.id, { ui_test: json })
  emit({ agentId: null, source: 'system', kind: 'auto.uitest', payload: { repo: repo.id, run: r.id, state: u.state, why: u.state === 'skipped' ? u.why : null,
    scenarios: u.state === 'done' ? u.scenarios.length : 0, findings: u.state === 'done' ? u.findings.length : 0 } })
}
/** A project's own switch for the UI tester (`on`: follow HQ's setting). */
export function setUiTest(repoId: string, on: boolean): { ui_test: string | null } {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  const v = on ? null : 'off'; setRepo(repo, { ui_test: v }); return { ui_test: v }
}
/** A run's end: the findings loop replays the findings whose fixes merged (findings.ts beforeUiTest), the UI tester uses the app (`ui`: uiTestRun), then the
 *  loop keeps what it found and the backend checker reads it (afterUiTest). The findings whose replay broke (`retry`: the old steps no longer fit the app) go
 *  to the tester, which tries each again by its goal before its own scenarios. A stop keeps nothing, so it all runs again; an error in the loop is said
 *  once in the summary and doesn't hold the run. */
async function endStage(repo: Repo, r: AutoRun, ui: boolean): Promise<void> {
  const gen = autoGen(repo.path)
  let stage = testingOn(repo.id) && !stageDone(repo.id, r.id), retry: Retry[] = []
  const failed = (e: unknown): void => { stageFailed(repo.id, r.id, (e as Error).message); stage = false }
  if (stage) try { const b = await beforeUiTest(repo, r.id, gen); if (b === 'stopped') return; retry = b.retry } catch (e) { failed(e) }
  if (ui) { await uiTestRun(repo, r, retry); if (!openRun(repo.id)?.ui_test) return } // stopped, or auto went off: nothing kept
  if (stage) try { await afterUiTest(repo, r.id, gen) } catch (e) { failed(e) }
}
const tpmGoneSince = new Map<string, number>()
/** A project on auto with work left needs its TPM: engineers' questions go there. */
async function keepTpm(repo: Repo, all: Ticket[]): Promise<void> {
  if (liveTpm(repo.id) || tpmStarting(repo.id) || !moving(repo, all).length) { tpmGoneSince.delete(repo.id); return }
  const since = tpmGoneSince.get(repo.id); if (!since) { tpmGoneSince.set(repo.id, now()); return }
  if (now() - since < TPM_GONE_MS) return // a fresh start is over in moments
  tpmGoneSince.delete(repo.id)
  await restartTpm(repo.id, { why: 'auto' }).catch((e) => stopProject(repo, `Its TPM stopped and couldn't be restarted: ${(e as Error).message}`))
}

const inRun = (r: AutoRun): Ticket[] => repoTickets(r.repo_id).filter((t) => t.status === 'merged' && t.updated_at >= r.started_at)
/** Bug 126: what HQ ran on a merged ticket, after its line in the run's summary. Nothing for one with no record. */
const testedNote = (t: Ticket): string => {
  const m = j<MergeTest | null>(t.merge_test, null); if (!m) return ''
  const app = m.ran === 'pass' && m.look?.ran === 'pass' ? `; ${lookWords(m.look)!.short}` : ''
  return m.ran === 'pass' ? ` (tests passed${m.counts ? `: ${countWords(m.counts)}` : ''}, ${took(m.ms)}${app})` : ' (HQ did not test it as it merged)'
}
/** What to say in the summary about HQ's look at the app before a ticket merged: only when it couldn't look (and that isn't simply how the project is set
 *  up), or looked without being able to judge every page. A clean look says so on the ticket's own line. */
const appLine = (t: Ticket): string[] => {
  const m = j<MergeTest | null>(t.merge_test, null), l = m?.ran === 'pass' ? m.look : undefined, w = lookWords(l)
  return !l || !w || w.tone === 'ok' || (l.ran === 'skipped' && l.quiet) ? [] : [w.short]
}
function summary(repo: Repo, r: AutoRun, all: Ticket[]): string {
  const done = all.filter((t) => t.status === 'merged' && t.updated_at >= r.started_at), parked = all.filter((t) => t.auto_parked_why), behind = stuckBehindParked(all)
  const fs0 = [...new Set(done.map((t) => t.feature_id))].map((id0) => getFeature(id0)!).filter(Boolean)
  // The TPM records choices while it splits, before the first ticket opens the run: a feature's all count, the project's by time
  const decided = [...fs0.map((f) => [`feature:${f.id}`, 0] as const), [`repo:${repo.id}`, r.started_at] as const].flatMap(([scope, since]) =>
    q<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'Decided in auto mode' AND updated_at >= ?", scope, since).map((d) => d.text))
  const waiting = all.filter((t) => repo.auto_waiting === NO_TESTS && FINISHED_NOT_MERGED.includes(t.status)), changed = testChange(r)
  // What nobody checked for the user on what merged: a criterion with no test, a test HQ couldn't see by name, deleted tests, files outside the plan
  // An app HQ couldn't open is the same news for every ticket it happened to: said once, with their keys
  const apps = new Map<string, string[]>(); for (const t of done) for (const l of appLine(t)) apps.set(l, [...apps.get(l) ?? [], t.key])
  const left = new Map(q<{ payload: string }>("SELECT payload FROM events WHERE kind = 'auto.left_behind' AND created_at >= ?", r.started_at) // Bug 184
    .map((e) => j<{ ticket: string; commits: number }>(e.payload, { ticket: '', commits: 0 })).map((e) => [e.ticket, e.commits]))
  const leftLine = (t: Ticket): string => { const n = left.get(t.id); return n ? `${n === 1 ? 'a commit' : `${n} commits`} made while it merged ${n === 1 ? "isn't" : "aren't"}`
    + ` in ${repo.default_branch}: ${n === 1 ? 'it is' : 'they are'} still on ${t.branch}` : '' }
  const look = [...done.flatMap((t) => [planLine(t.id) ?? '', diffCheckLine(diffCheckOf(t)) ?? '', ...lookLines(proofOf(t)), leftLine(t)].filter(Boolean)
    .map((l) => `- ${t.key}: ${l}`)), ...[...apps].map(([l, keys]) => `- ${keys.join(', ')}: ${l}`)]
  // What the UI tester did and found as the run ended (uitester.ts); a run from before it has the earlier tester's lines (testerrules.ts)
  const tried = [...triedLines(triedOf(r.tried)), ...uiTestLines(uiTestOf(r.ui_test))]
  const leftOut = leftOutLines(done.filter((t) => t.repairs_main)) // Bug 142: what a repair said it left out, the command the same or not
  const had = criteriaSummary(done.map((t) => ({ key: t.key, title: t.title, criteria: criteriaOf(t) }))) // nobody reviewed them before work started: here they are
  return [`## Built\n${done.map((t) => `- ${t.key}: ${t.title}${testedNote(t)}`).join('\n') || '- Nothing was merged.'}`,
    had.length ? `## What each one had to do\n${had.join('\n\n')}` : '',
    tried.length ? `## Tried in a browser\n${tried.join('\n')}` : '',
    findingsSection(repo.id, r.id),
    look.length ? `## Worth a look\n${look.join('\n')}` : '',
    decided.length ? `## Decided for you\n${decided.join('\n')}` : '',
    parked.length ? `## Parked, needs you\n${parked.map((t) => `- ${t.key}: ${t.auto_parked_why}`).join('\n')}` : '',
    behind.size ? `## Waiting on a parked ticket\n${all.filter((t) => behind.has(t.id)).map((t) => `- ${t.key}: ${t.title}`).join('\n')}` : '',
    waiting.length ? `## Finished, not merged (no tests HQ can run)\n${waiting.map((t) => `- ${t.key}: ${t.title}`).join('\n')}` : '',
    changed ? `## Test command changed\n- Was: \`${changed.was ?? 'the one HQ found'}\`\n- Now: \`${changed.now}\`\n- Left out: ${changed.left_out}` : '',
    leftOut.length ? `## Tests a repair left out\n${leftOut.join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}
async function closeRun(repo: Repo, r: AutoRun, status: 'finished' | 'off'): Promise<void> {
  const text = summary(repo, r, repoTickets(repo.id)), end = await ref(repo), t = now()
  run('UPDATE auto_runs SET status = ?, end_sha = ?, ended_at = ?, summary = ? WHERE id = ?', status, end || null, t, text, r.id)
  patch('auto_run', r.id, { ...r, status, end_sha: end || null, ended_at: t, summary: text })
  emit({ agentId: null, source: 'system', kind: 'auto.finished', payload: { repo: repo.id, run: r.id, status } })
  const built = inRun(r).map((x) => x.key) // named, so a second run's notice isn't taken for the first one's
  if (status === 'finished' || built.length) attention(`auto_finished:${repo.id}`, `${repo.name}: auto mode finished${built.length ? ` (${built.join(', ')})` : ''}.`)
}

/** Undo a whole run: one new commit puts main back where the run started (on GitHub through a PR, as HQ's account), so nothing is
 *  rewritten and the work stays on its branches. Refused when main has other work on it since: undoing would lose that too. */
export async function undoRun(runId: string): Promise<{ sha: string }> {
  const r = one<AutoRun>('SELECT * FROM auto_runs WHERE id = ?', runId); if (!r) throw new Error('unknown run')
  if (r.status !== 'finished' && r.status !== 'off') throw new Error(r.status === 'undone' ? 'That run is already undone.' : 'That run is still going: turn auto mode off first.')
  if (!r.start_sha) throw new Error('HQ has no record of where main was when the run started.')
  const repo0 = getRepo(r.repo_id); if (!repo0) throw new Error('unknown repo')
  return inMergeQueue(repo0.id, async () => {
    const repo = await ensureFresh(repo0.id), base = mergeBase(repo), tip = await ref(repo), done = inRun(r)
    if (tip === r.start_sha) throw new Error(`${base.name} is already where the run started.`)
    const log = (await git(repo.path, 'log', '--first-parent', '--format=%s', `${r.start_sha}..${tip}`)).split('\n').filter(Boolean)
    const ours = (s: string) => done.some((t) => s.startsWith(`Merge ${t.key}:`) || (t.pr_number && new RegExp(`^Merge pull request #${t.pr_number}\\b`).test(s)))
    const others = log.filter((s) => !ours(s))
    if (others.length) throw new Error(`${base.name} has other work since the run, so undoing would lose it: ${others.slice(0, 3).join('; ')}. Nothing was changed.`)
    const subject = `Undo auto mode run: back to ${r.start_sha!.slice(0, 7)}`
    let sha: string
    if (usesGithub(repo)) {
      const slug = parseGithubRemote(repo.remote ?? '')!, o = ghOpts(), branch = `hq/undo-${r.id}`
      sha = await git(repo.path, 'commit-tree', `${r.start_sha}^{tree}`, '-p', tip, '-m', subject)
      await git(repo.path, 'branch', '-f', branch, sha); await pushBranch(repo.path, slug, branch, o)
      const pr = await createPr(slug, repo.default_branch, branch, subject, `Puts ${repo.default_branch} back where the auto mode run started. The work stays on its branches.`, o)
      sha = await mergePr(slug, pr.number, o); await syncRepo(repo.id)
    } else {
      const m = await restoreMain(repo.path, repo.default_branch, r.start_sha!, subject); if (!m.ok) throw new Error(m.why); sha = m.sha
    }
    run("UPDATE auto_runs SET status = 'undone' WHERE id = ?", r.id); patch('auto_run', r.id, { status: 'undone' })
    for (const t of done) setTicket(t.id, { status: 'cancelled' }) // its work isn't in main any more, so "Built so far" drops it
    undoMapChanges(repo.id, done) // and the feature map goes back to before their changes
    for (const fid of new Set(done.map((t) => t.feature_id))) {
      const f = getFeature(fid); if (!f) continue
      if (tickets(fid).every((t) => t.status === 'cancelled')) { run("UPDATE features SET status = 'cancelled' WHERE id = ?", fid); patch('feature', fid, { status: 'cancelled' }) }
      writeFeatureMd(getFeature(fid)!)
    }
    for (const a of openAttention().filter((x) => x.kind === `auto_finished:${repo.id}`)) resolveAttention(a.id)
    tellTpm(repo.id, `HQ: the user undid the auto mode run: ${done.map((t) => t.key).join(', ')} are no longer in ${base.name}. Their branches are kept. Don't build on them.`)
    emit({ agentId: null, source: 'ui', kind: 'auto.undone', payload: { repo: repo.id, run: r.id, sha } })
    return { sha }
  })
}

async function tickRepo(repo0: Repo): Promise<void> {
  const all = repoTickets(repo0.id); let repo = getRepo(repo0.id)!
  approvePlans(all) // even when stopped: running engineers finish
  // Bug 355: read the tickets again after each step: the one before may have parked a ticket and stopped its engineer
  await readNotices(repo, all); await lostEngineers(repoTickets(repo.id)); await idleEngineers(repoTickets(repo.id))
  repo = getRepo(repo.id)!
  const left = moving(repo, repoTickets(repo.id))
  if (left.length && !openRun(repo.id)) {
    const r: AutoRun = { id: id('run'), repo_id: repo.id, status: 'running', start_sha: (await ref(repo)) || null, end_sha: null, started_at: now(), ended_at: null, summary: null,
      test_change: null, main_checked: null, tried: null, ui_test: null }
    run('INSERT INTO auto_runs(id, repo_id, status, start_sha, started_at) VALUES (?,?,?,?,?)', r.id, r.repo_id, r.status, r.start_sha, r.started_at)
    patch('auto_run', r.id, r as unknown as Record<string, unknown>); emit({ agentId: null, source: 'system', kind: 'auto.run_started', payload: { repo: repo.id, run: r.id } })
  }
  if (!repo.auto_stopped_why) {
    await keepTpm(repo, repoTickets(repo.id))
    const bad = refusedCmd(repo); if (bad && !bad.ticket && !openRepair(repo.id)) { await repairCommand(repo); repo = getRepo(repo.id)! } // Bug 107
    const cap = canLaunch(), repair = openRepair(repo.id)
    const wait = !cap.ok && /usage/i.test(cap.why ?? '') ? `Waiting for usage: ${cap.why}` : repair ? repairNote(repo, repair) : null
    if (repo.auto_waiting !== NO_TESTS) setRepo(repo, { auto_waiting: wait })
    if (tpmSettled(repo.id)) await startReady(repo)
    const opened = openRun(repo.id)
    if (opened && !opened.main_checked && !mergingNow.has(repo.id)) {
      mergingNow.add(repo.id)
      void checkMain(repo, opened).catch((e) => stopProject(repo, `HQ hit an error testing ${mergeBase(repo).name}: ${(e as Error).message}`)).finally(() => { mergingNow.delete(repo.id); autoSoon() })
      return
    }
    const t = !mergingNow.has(repo.id) ? nextToMerge(repo, await ref(repo)) : undefined
    if (t) {
      mergingNow.add(repo.id)
      void testAndMerge(repo, t).catch((e) => stopProject(repo, `HQ hit an error testing ${t.key}: ${(e as Error).message}`)).finally(() => { mergingNow.delete(repo.id); autoSoon() })
      return
    }
  }
  const r = openRun(repo.id), cur = getRepo(repo.id)!
  if (r && !moving(cur, repoTickets(repo.id)).length && !mergingNow.has(repo.id) && !cur.auto_stopped_why && tpmSettled(repo.id) && !openAsks().some((a) =>
    a.repo_id === repo.id)) {
    if (tryingNow.has(repo.id)) return // the run ends once the tester has
    // The last thing a run does: the findings loop and the UI tester (endStage), and the summary says what they found
    const ui = wantsUiTest(cur, r)
    if (!ui && (!testingOn(cur.id) || stageDone(cur.id, r.id))) return closeRun(cur, r, 'finished')
    tryingNow.add(repo.id)
    void endStage(cur, r, ui).catch((e) => emit({ agentId: null, source: 'system', kind: 'auto.error', payload: { repo: repo.id, error: String(e) } }))
      .finally(() => { tryingNow.delete(repo.id); autoSoon() })
  }
}

let ticking: Promise<void> | null = null, again = false, timer: NodeJS.Timeout | null = null
/** One look at every project on auto. Calls during a tick run one more after it. */
export function autoTick(): Promise<void> {
  if (ticking) { again = true; return ticking }
  ticking = (async () => {
    do {
      again = false
      for (const r of q<Repo>('SELECT * FROM repos WHERE auto_mode = 1 AND clearing_at IS NULL')) {
        await tickRepo(r).catch((e) => { emit({ agentId: null, source: 'system', kind: 'auto.error', payload: { repo: r.id, error: String(e) } }) })
      }
      keepAwake(); beat('auto')
    } while (again)
  })().finally(() => { ticking = null })
  return ticking
}
/** Resolves once a tick under way is over. */
export const autoSettled = (): Promise<void> => (ticking ?? Promise.resolve()).catch(() => {})
/** Something happened: a tick shortly, once, so a burst of events is one look. */
export function autoSoon(): void { if (!timer) timer = setTimeout(() => { timer = null; void autoTick().catch(() => {}) }, SOON_MS) }
/** The timer is what notices usage dropping: nothing else happens then. */
export function startAutoLoop(): void { autoSoon(); setInterval(() => { void autoTick().catch(() => {}) }, TICK_MS).unref() }

let awake: ChildProcess | null = null
/** While a run is open the computer stays up (a Mac's idle sleep is a minute). Tied to this process, so a dead backend holds nothing. A closed lid still sleeps it. */
function keepAwake(): void {
  const want = !!one("SELECT 1 AS x FROM auto_runs a JOIN repos r ON r.id = a.repo_id WHERE a.status = 'running' AND r.auto_mode = 1 AND r.auto_stopped_why IS NULL")
  if (want && !awake && (process.platform === 'darwin' || process.platform === 'linux')) { // a Linux with no systemd just doesn't hold it
    const [bin, ...args] = process.platform === 'darwin' ? ['/usr/bin/caffeinate', '-i', '-w', String(process.pid)]
      : ['systemd-inhibit', '--what=idle:sleep', '--who=HQ', '--why=auto mode is running', 'tail', `--pid=${process.pid}`, '-f', '/dev/null']
    awake = spawn(bin!, args, { stdio: 'ignore', detached: true }); awake.on('exit', () => { awake = null }); awake.on('error', () => { awake = null }); awake.unref()
  }
  if (!want && awake) { try { process.kill(-awake.pid!) } catch { /* gone */ } awake = null } // the group: systemd-inhibit's tail goes too
}

const going = (base: string): string => `From now on ${autoOnWords(base)}. Finish each split before you end your turn.`
const rules = (base: string): string => `HQ: the user turned auto mode on for this project. ${going(base)} `
  + 'Make product choices yourself and record each one with write_feature, section "Decided in auto mode". '
  + 'Only something hard to undo goes to ask_user, with hard_to_undo: true. '
  + 'HQ won\'t merge without tests it can run, and it checks that each acceptance criterion of a ticket has a test: in a project with none the first ticket adds them.'
export async function setAuto(repoId: string, on: boolean): Promise<{ on: boolean }> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  notClearing(repoId)
  if (on === !!repo.auto_mode) return { on }
  if (on) {
    const problem = await sandboxProblem(); if (problem) throw new Error(problem) // now, not at the first merge with the tokens spent
    setRepo(repo, { auto_mode: 1, auto_stopped_why: null, auto_waiting: null })
    if (repo.tpm_parked_at || switchNotes(repoId).length) await resumeRepo(repoId).catch(() => {}) // it can't work parked (nor be parked: Bug 350)
    tellTpm(repoId, rules(repo.default_branch))
  } else {
    const r = openRun(repoId); setRepo(repo, { auto_mode: 0, auto_stopped_why: null, auto_waiting: null }); clearGoAhead(repoId)
    stopAutoTests(repo.path) // its test run ends now, not at its time limit, with no result (Bug 89)
    stopPlanChecks(repoId) // and plans waiting for HQ's check wait for the user instead
    resolveKind(`auto_stopped:${repoId}`, null) // the banner goes with auto_stopped_why; so does its ⚠ line
    if (r) await closeRun(getRepo(repoId)!, r, 'off')
    tellTpm(repoId, `HQ: the user turned auto mode off. From now on ${AUTO_OFF_WORDS}. Your normal rules apply: the user decides `
      + 'what each ticket covers, so ask_user before a ticket grows or shrinks or a known failure stays. Running engineers finish their tickets.')
  }
  emit({ agentId: null, source: 'ui', kind: 'auto.switched', payload: { repo: repoId, on } })
  keepAwake(); if (on) autoSoon()
  return { on }
}
/** Resume after a stop: HQ looks again, and stops again if the reason is still there (stopProject then tells the TPM why). Bug 279: the TPM is told
 *  it's running again, once, or its last word stays "Nothing new starts or merges until the user resumes it" until a merge. Read after the sandbox
 *  check: a second press, or auto going off meanwhile, has nothing to resume and says nothing. A new TPM needs no note: its prompt says (handover.ts autoLine). */
export async function autoResume(repoId: string): Promise<{ ok: true }> {
  if (!getRepo(repoId)) throw new Error('unknown repo')
  const problem = await sandboxProblem(); if (problem) throw new Error(problem)
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  const stopped = !!repo.auto_mode && !!repo.auto_stopped_why
  setRepo(repo, { auto_stopped_why: null })
  for (const a of openAttention().filter((x) => x.kind === `auto_stopped:${repoId}`)) resolveAttention(a.id)
  if (stopped) tellTpm(repoId, `HQ: the user resumed auto mode, so it's running again. ${going(repo.default_branch)} If what stopped it is still there, it stops again and HQ tells you.`)
  autoSoon(); return { ok: true }
}
/** Engineers at work when the test command changes: otherwise they keep running the old one, which may never finish. Bug 147:
 *  - Not the repair's engineer whose proposal it was (it ran the command, Bug 83): it knows the command, and HQ answers it on its own.
 *  - When that repair has commits, the command may need them, and they reach another branch only once the repair is in main: the note says
 *    to merge main in first. (No commits: HQ closes the repair, and the command works on main as it is.)
 *  - The note's reason is 'test_cmd': one its engineer hasn't read when it calls open_pr is dropped (delivery.ts dropLateNotes), so it can't
 *    start a turn the engineer can do nothing with. */
function tellEngineers(repoId: string, cmd: string | null): void {
  const repo = getRepo(repoId); if (!cmd || !repo) return
  const from = repoTickets(repoId).find((x) => x.repairs_main && !DONE.includes(x.status) && ranByEngineer(x.id, cmd)), base = mergeBase(repo)
  const send = (ahead: string): void => {
    if (!sameCmd(cmd, getRepo(repoId)?.test_cmd)) return // read again after the look at the branch: a newer command has its own note
    const note = testCmdNote(cmd, from && ahead !== '0' ? { key: from.key, base: base.name } : undefined)
    for (const t of repoTickets(repoId).filter((x) => x.assignee_agent_id && x.id !== from?.id && !DONE.includes(x.status) && !FINISHED_NOT_MERGED.includes(x.status))) {
      const a = getAgent(t.assignee_agent_id!) // Bug 187: with its ticket's feature, so Messages shows it with that box picked
      if (a && a.status !== 'exited') sendMessage({ repoId, featureId: t.feature_id, channel: 'dm', from: 'hq', to: a.id, reason: 'test_cmd', body: `HQ: ${note}` })
    }
  }
  if (!from?.branch) return send('0')
  void git(repo.path, 'rev-list', '--count', `${base.ref}..refs/heads/${from.branch}`).catch(() => '0').then(send)
    .catch((e) => emit({ agentId: null, source: 'system', kind: 'backend.error', payload: { server: 'auto', error: String(e) } }))
}
/** Bug 107: what an engineer's Bash hook says about the project's saved test command (hooks.ts calls this for every Bash command of an engineer's that ended;
 *  `error` as ranBash takes it). Bug 83 only checks a command a repair proposes: one typed in the Auto box, or saved before that check, is never run by an agent first.
 *  - Claude Code refused the line, and the command is what it refused: nothing else in the line could be (refused.ts; engineers add options and cut output down,
 *    so it's rarely the saved command to the letter). HQ says so once per command, with a ⚠ the user can tick away for good, and keeps it on the project. On auto
 *    the next tick opens a repair ticket for the command; so does turning auto on later.
 *  - It ran after all (a newer Claude Code refuses less): what HQ knew goes, and its ⚠ with it. */
export function sawTestCmd(agent: Agent, command: string, error?: string): void {
  if (agent.role !== 'engineer') return
  const refusal = error !== undefined && isRefusal(error), ran = error === undefined || /^Exit code \d/.test(error)
  const repo = getRepo(repoOfAgent(agent) ?? ''); if (!repo?.test_cmd) return
  const known = refusedCmd(repo); if (!(refusal && !known) && !(ran && known)) return // nothing this command could tell HQ: nearly every command ends here
  const t = ticketForAgent(agent); if (!t || !(ran ? ranTestCmd : refusedTestCmd)(command, repo.test_cmd, t.worktree_path)) return
  if (ran) { setRepo(repo, { test_cmd_refused: null }); emit({ agentId: agent.id, source: 'system', kind: 'testcmd.runs_again', payload: { repo: repo.id, ticket: t.key } }); return }
  const r: Refused = { cmd: repo.test_cmd, why: error!.slice(0, 1500), by: t.key }
  setRepo(repo, { test_cmd_refused: JSON.stringify(r) })
  attention(REFUSED(repo.id), `${repo.name}: engineers can't run this project's test command. Claude Code refuses it in their sessions (${t.key}'s engineer tried), `
    + `so they finish without a full test run: \`${r.cmd}\`. With auto mode on, HQ opens a ticket that fixes the command. `
    + 'With it off, turn auto mode on, or write a command that works in its Test command box: press Show.')
  emit({ agentId: agent.id, source: 'system', kind: 'testcmd.refused', payload: { repo: repo.id, ticket: t.key, cmd: r.cmd, why: r.why } })
  autoSoon()
}
const proposing = new Set<string>() // repair tickets whose test command HQ is trying now
/** Bug 83: has Claude Code let an engineer on this ticket run `command`, by itself or inside a longer line (`… 2>&1 | tail`)? HQ's own try can't
 *  tell: it runs /bin/sh, and one project's saved command (`node --test … $(grep -rL …)`) was refused in every engineer's session. Read from the
 *  events (hooks.ts ranBash), so a restart, or a fresh engineer on the ticket, doesn't lose it. */
export function ranByEngineer(ticketId: string, command: string): boolean {
  const want = squash(command); if (!want) return false
  return q<{ payload: string }>(`SELECT e.payload FROM events e JOIN agents a ON a.id = e.agent_id
    WHERE a.ticket_id = ? AND e.kind IN ('hook.PostToolUse:Bash', 'hook.PostToolUseFailure:Bash') AND e.payload LIKE '%"ran":%'`, ticketId)
    .some((e) => squash(j<{ ran?: string }>(e.payload, {}).ran ?? '').includes(want))
}
const NOT_RUN = "HQ hasn't seen that command run in your session, so nothing changed. Run it with the Bash tool exactly as you propose it, then call this again. "
  + "Every engineer has to run it in a session like yours, and Claude Code refuses some commands that HQ's sandbox would run. "
  + "If it's refused, move the part it refuses into a script in the repo (an npm script, for one), commit it, and run that."
/** Bug 109: a repair that changed what the command runs (an npm script, say) and proposed the command itself got "Was: X. Now: X" in the
 *  summary, and the run's one allowed change was spent. */
const alreadyRuns = (base: string, leftOut: string): string => "That's already the test command HQ runs for this project, so there's nothing to change. "
  + (saysNothing(leftOut) ? '' : "HQ kept what you said it leaves out: the run's summary lists it for the user. ") // Bug 142
  + `If your branch changes what it runs (a script in the repo, or a test), commit that and call open_pr: HQ runs the command on ${base} plus your branch, then merges it. `
  + `When you call open_pr, ${LEFT_OUT_ASK} If it can't pass in HQ's sandbox as it is, propose a different command, or call report_blocked.`
/** A repair's proposal: a test command that can work in HQ's sandbox. The command HQ runs already isn't one (Bug 109): the saved one, or with
 *  none saved the one HQ finds in the engineer's files, as it will when it tests the ticket. The engineer has to have run it itself first
 *  (Bug 83). HQ tries it on main plus the repair's branch, so a repair that needs a fix and a new command can land. A pass on auto is taken at
 *  once and goes in the summary (the user's call: HQ can prove a command passes, not that it's a good test, and the summary is the check); off
 *  auto the user OKs it. A second change in a run stops and asks, so the tests can't be whittled down until they pass. */
export function proposeTestCommand(agent: Agent, command: string, leftOut: string): string {
  const t = ticketForAgent(agent), repo = t ? getRepo(getFeature(t.feature_id)?.repo_id ?? '') : undefined
  if (!t?.repairs_main || !t.branch || !repo) throw new Error('Only a repair ticket can change the test command.')
  if (sameCmd(command, repo.test_cmd ?? (t.worktree_path ? detectTests(t.worktree_path)?.test : null))) {
    keepProposed(t.id, command, leftOut) // Bug 142: what it said it leaves out goes in the summary once the repair merges; not a change of the command
    throw new Error(alreadyRuns(mergeBase(repo).name, leftOut))
  }
  if (!ranByEngineer(t.id, command)) throw new Error(NOT_RUN)
  if (proposing.has(t.id)) throw new Error('HQ is still trying your last one. End your turn; its message will come.')
  proposing.add(t.id)
  const tell = (body: string) => sendMessage({ repoId: repo.id, featureId: t.feature_id, channel: 'dm', from: 'hq', to: agent.id, reason: 'fyi', body })
  void inMergeQueue(repo.id, async () => {
    const base = mergeBase(repo)
    const r = await testCombined(repo.path, base.ref, `refs/heads/${t.branch}`, `${t.key}-cmd`, command, null, { repoId: repo.id, ticketId: t.id, what: 'command' })
    if (r.kind !== 'pass') {
      const why = r.kind === 'fail' ? `${whyFailed(r)}\n\n${failReport(r, 3000)}` : r.kind === 'error' ? r.why : r.kind
      return tell(`HQ: your test command didn't pass, so nothing changed. ${why}`)
    }
    // Read again: the try took minutes, and the user may have saved this very command meanwhile. Then there's nothing to ask, record or pass on.
    const cur = getRepo(repo.id)!, saved = sameCmd(command, cur.test_cmd), change: TestChange = { was: cur.test_cmd, now: command, left_out: leftOut }
    if (!cur.auto_mode) {
      if (saved) return tell('HQ: your test command passed, and the user saved the same one meanwhile. Call open_pr if you have code, or report_blocked if there\'s nothing left to do.')
      setRepo(cur, { test_cmd_proposed: JSON.stringify(change) })
      attention(`test_cmd_proposed:${repo.id}`, `${repo.name}: a repair wants to change the test command to: ${command}. It leaves out: ${leftOut}`)
      return tell('HQ: your test command passed. Auto mode is off, so the user decides. Stop here; HQ tells you what they chose.')
    }
    const open = openRun(repo.id)
    if (!saved && testChange(open)) return stopProject(cur, `A repair wanted a second change to the test command in one run, leaving out: ${leftOut}. HQ won't cut the tests down further by itself.`)
    if (!saved) {
      setRepo(cur, { test_cmd: command, auto_waiting: null }); noTestsAt.clear(); tellEngineers(repo.id, command)
      if (open) run('UPDATE auto_runs SET test_change = ? WHERE id = ?', JSON.stringify(change), open.id)
      if (open) patch('auto_run', open.id, { test_change: JSON.stringify(change) })
      emit({ agentId: agent.id, source: 'system', kind: 'auto.test_changed', payload: { repo: repo.id, ticket: t.key, ...change } })
      tellTpm(repo.id, `HQ: ${t.key} changed the test command to \`${command}\`. It leaves out: ${leftOut}. The summary will list it.`)
    }
    const ahead = await git(repo.path, 'rev-list', '--count', `${base.ref}..refs/heads/${t.branch}`).catch(() => '0')
    if (ahead !== '0') return tell('HQ: your test command passed and is saved. Commit anything left, then call open_pr.')
    await cancelTicket(t.id, { tell: false }); autoSoon() // a new command was the whole repair: there's no code to merge
  }).catch((e) => tell(`HQ couldn't try your test command: ${(e as Error).message}`)).finally(() => { proposing.delete(t.id); autoSoon() })
  return 'HQ is trying it in its sandbox, which can take minutes. End your turn; its message will come.'
}
/** The user's answer to a proposal made while auto mode was off. */
export async function answerTestCommand(repoId: string, use: boolean): Promise<{ cmd: string | null }> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  const change = j<TestChange | null>(repo.test_cmd_proposed, null); if (!change) throw new Error('Nothing is waiting for your OK.')
  setRepo(repo, { test_cmd_proposed: null, ...(use ? { test_cmd: change.now } : {}) }); resolveKind(`test_cmd_proposed:${repoId}`, null)
  const t = repoTickets(repoId).find((x) => x.repairs_main && !DONE.includes(x.status)), e = t?.assignee_agent_id ? getAgent(t.assignee_agent_id) : undefined
  if (e && e.status !== 'exited') sendMessage({ repoId, featureId: t!.feature_id, channel: 'dm', from: 'hq', to: e.id, reason: 'fyi',
    body: use ? 'HQ: the user OK\'d your test command and it\'s saved. Call open_pr if you have code, or report_blocked if there\'s nothing left to do.'
      : 'HQ: the user said no to that test command. Find another way, or call report_blocked.' })
  if (use && !sameCmd(change.now, repo.test_cmd)) tellEngineers(repoId, change.now) // already theirs: nothing to pass on
  autoSoon(); return { cmd: use ? change.now : repo.test_cmd }
}
/** Another go for a parked ticket. */
export function autoRetry(ticketId: string): { ok: true } {
  const t = getTicket(ticketId); if (!t) throw new Error('unknown ticket')
  const repoId = getFeature(t.feature_id)?.repo_id ?? ''
  notClearing(repoId) // Bug 335: the ticket goes with the board, and nothing starts meanwhile
  // Bug 364: with auto mode off nothing would take it: the park's reason went and nothing started. A page from before auto went off still shows the button
  const repo = getRepo(repoId); if (!repo || !autoRetries(repo)) throw new Error('Auto mode is off for this project: turn it on, then Try again.')
  setTicket(t.id, { auto_parked_why: null, auto_tries: 0 }); resolveForTicket(t.id); autoSoon(); return { ok: true }
}
/** What the Auto dialog shows: the user's test command, or the one HQ found in the checkout, and why this machine can't do it, if so. */
export async function autoCheck(repoId: string): Promise<{ custom: string | null; found: string | null; sandbox: string | null }> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  return { custom: repo.test_cmd, found: detectTests(repo.path)?.test ?? null, sandbox: await sandboxProblem() }
}
export function setTestCmd(repoId: string, cmd: string): { cmd: string | null } {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  const c = cmd.trim() || null; noTestsAt.clear(); setRepo(repo, { test_cmd: c, ...(repo.auto_waiting === NO_TESTS ? { auto_waiting: null } : {}) })
  if (c !== repo.test_cmd) tellEngineers(repoId, c)
  autoSoon(); return { cmd: c }
}
