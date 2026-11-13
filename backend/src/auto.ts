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
import { attention, openAttention, resolveAttention, resolveForTicket, resolveKind, type Attention } from './attention.ts'
import { mergeBase, setConflict, whoMergedFirst } from './conflicts.ts'
import { createPr, mergePr, pushBranch } from './github.ts'
import { restoreMain } from './localmerge.ts'
import { writeFeatureMd } from './projectmd.ts'
import { parseGithubRemote } from './reposync.ts'
import { sendMessage } from './delivery.ts'
import { resumeRepo } from './freshstart.ts'
import { answerReview } from './gate.ts'
import { inMergeQueue, mergeNow } from './mergewatch.ts'
import { features, getFeature, getRepo, getTicket, liveTpm, notClearing, setTicket, ticketForAgent, tickets, usesGithub, type Feature, type Repo, type Ticket } from './records.ts'
import { readyTickets } from './readiness.ts'
import { ensureFresh, ghOpts, git, syncRepo } from './repos.ts'
import { canLaunch } from './scheduler.ts'
import { autoGen, detectTests, failReport, sandboxProblem, stopAutoTests, testBase, testCombined, type Failed } from './testrun.ts'
import { addFeature, cancelTicket, createTicket, fillSlots, fixConflicts, fixTests, resumeEngineer, testCmdNote } from './tickets.ts'
import { restartTpm, tpmStarting } from './tpm.ts'
import { dialogGone } from './presence.ts'
import { idleTooLong } from './bgruns.ts'

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
  ended_at: number | null; summary: string | null; test_change: string | null; main_checked: string | null }
type TestChange = { was: string | null; now: string; left_out: string }
/** Each project's newest runs: a busy project can't push a quiet one's last run out (Bug 63). */
export const autoRuns = (): AutoRun[] => q<AutoRun>(`SELECT * FROM auto_runs a WHERE (SELECT COUNT(*) FROM auto_runs b WHERE b.repo_id = a.repo_id AND b.started_at > a.started_at) < 20
  ORDER BY started_at DESC`)
const openRun = (repoId: string): AutoRun | undefined => one<AutoRun>("SELECT * FROM auto_runs WHERE repo_id = ? AND status = 'running'", repoId)
const liveFeatures = (repoId: string): Feature[] => features().filter((f) => f.repo_id === repoId && f.status !== 'cancelled').reverse() // oldest first
const repoTickets = (repoId: string): Ticket[] => liveFeatures(repoId).flatMap((f) => tickets(f.id))

function setRepo(repo: Repo, fields: Partial<Pick<Repo, 'auto_mode' | 'auto_stopped_why' | 'auto_waiting' | 'test_cmd' | 'test_cmd_proposed'>>): void {
  const keys = Object.keys(fields) as (keyof typeof fields)[]
  if (!keys.some((k) => fields[k] !== repo[k]) || !getRepo(repo.id)) return // removed from HQ during a test: no patch for a project that's gone
  run(`UPDATE repos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k] ?? null), repo.id)
  patch('repo', repo.id, fields as Record<string, unknown>)
}
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
  if (t.repairs_main && repoId) { stopProject(getRepo(repoId)!, `${t.key} couldn't repair the tests: ${why}`); return } // nothing can merge without it
  if (repoId) tellTpm(repoId, `HQ: auto mode parked ${t.key}: ${why} The tickets that don't depend on it carry on.`)
}
/** Something that isn't one ticket's fault: no new starts or merges until the user presses Resume. Running engineers finish. */
export function stopProject(repo: Repo, why: string): void {
  const cur = getRepo(repo.id); if (!cur?.auto_mode || cur.auto_stopped_why) return
  setRepo(cur, { auto_stopped_why: why }); clearGoAhead(repo.id)
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
 *  errored engineer gets a fresh one first: going quiet for a while isn't the ticket's fault. */
const STOP_KINDS = ['push_failed', 'pr_failed'], PARK_KINDS = ['blocked', 'dialog'], REPLACE_KINDS = ['stuck', 'api_error']
async function readNotices(repo: Repo, all: Ticket[]): Promise<void> {
  const mine = new Map(all.map((t) => [t.id, t]))
  for (const a of openAttention() as Attention[]) {
    const t = a.ticket_id ? mine.get(a.ticket_id) : undefined, agent = a.agent_id ? getAgent(a.agent_id) : undefined
    if (a.kind === 'dialog' && agent?.status === 'exited') { resolveAttention(a.id); continue } // a session that's over has no dialog (Bug 62)
    if (a.kind === 'dialog' && agent && await dialogGone(agent, a.created_at)) continue // answered already: the stuck loop clears it on its next two looks
    if (agent?.role === 'tpm' && agent.repo_id === repo.id && agent.status !== 'exited' && ['blocked', 'dialog', 'api_error'].includes(a.kind)) {
      stopProject(repo, `The TPM needs you: ${a.detail}`); continue
    }
    if (!t || t.auto_parked_why) continue
    if (STOP_KINDS.includes(a.kind)) stopProject(repo, a.detail)
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
  for (const t of all.filter((x) => x.assignee_agent_id)) {
    const a = getAgent(t.assignee_agent_id!); if (idleTooLong(t, a)) await retry(t, 'Its engineer stopped before finishing.', () => replaceEngineer(t, a))
  }
}
/** Engineers that went away with work left: one fresh start each, within the ticket's tries. */
async function lostEngineers(all: Ticket[]): Promise<void> {
  for (const t of all.filter((x) => RESUMABLE.includes(x.status) && x.assignee_agent_id && !x.parked_at && !x.auto_parked_why)) {
    const a = getAgent(t.assignee_agent_id!); if (!a || a.status !== 'exited' || a.fresh_start_at) continue
    await retry(t, `Its engineer stopped working on it (${a.id}).`, () => resumeEngineer(t.id, { replace: true }))
  }
}
function approvePlans(all: Ticket[]): void {
  for (const r of q<{ id: string; ticket_id: string }>("SELECT id, ticket_id FROM review_requests WHERE status = 'open'")) {
    if (all.some((t) => t.id === r.ticket_id)) answerReview(r.id, 'approve', { by: 'auto' })
  }
}
/** The TPM has finished for now: its split is done, so its tickets can start (a ticket that started mid-split couldn't be rewired). */
const tpmSettled = (repoId: string): boolean => {
  const tpm = liveTpm(repoId); if (!tpm) return true
  return tpm.status === 'idle' && !one("SELECT 1 AS x FROM messages WHERE to_id = ? AND from_id = 'user' AND delivered_at IS NULL", tpm.id) // HQ's own notices don't change a split
}
async function startReady(repo: Repo): Promise<void> {
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

/** What failed, for the user: the first line that names it, never a stack trace. The engineer gets the whole output. */
export function failedLine(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  const hit = lines.find((l) => /^(✖|×|---\s*FAIL\b|FAIL\b|FAILED\b|not ok\b|error\b|E\s)/i.test(l) && !/^✖ failing tests/i.test(l)) ?? lines.find((l) =>
    /\berror\b|\bfailed?\b/i.test(l) && !/^(at |ℹ|#)/.test(l)) ?? lines.at(-1) ?? ''
  return hit.replace(/\s*\(\d[\d.]*ms\)$/, '').slice(0, 140)
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
const repairNote = (repo: Repo, t: Ticket): string => `Fixing ${mergeBase(repo).name}'s tests (${t.key}). Nothing merges until that's in.`
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
- Keep it small: this ticket is about the tests and nothing else.
- If you can't fix it from here, call report_blocked and say why.`
/** Main fails with no ticket on it. On auto HQ opens a ticket to repair it, and stops only when that can't help. */
async function repairMain(repo: Repo, tip: string, b: Failed): Promise<void> {
  const base = mergeBase(repo).name, run0 = openRun(repo.id)
  const made = run0 ? repoTickets(repo.id).filter((t) => t.repairs_main && t.created_at >= run0.started_at).length : 0
  if (made >= MAX_REPAIRS) return stopProject(repo, `${base}'s own tests still fail after ${made} repairs, so HQ can't tell good work from bad. ${whyFailed(b)}`)
  const f = addFeature(repo.id, `Get ${base}'s tests passing`, `HQ opened this by itself: ${base}'s own tests fail. ${whyFailed(b)}`)
  const t = createTicket(f.id, { title: `Fix ${base}'s tests`, size: 'S', spec: repairSpec(base, b), repairs_main: tip })
  setRepo(repo, { auto_waiting: repairNote(repo, t) })
  emit({ agentId: null, source: 'system', kind: 'auto.repair_opened', payload: { repo: repo.id, ticket: t.id, key: t.key } })
  tellTpm(repo.id, `HQ: ${base}'s own tests fail, even without any ticket, so HQ opened ${t.key} to repair them. ${whyFailed(b)} `
    + 'Nothing merges until it\'s in; other work carries on. Don\'t open another ticket for this.')
}
/** Main's own tests, once per run (Bug 70): one project's could never pass in HQ's sandbox, and nobody knew until its first ticket finished, 40 minutes in. Tickets start alongside
 *  this. A failure runs once more before a repair opens, so a flaky suite can't spend one: that's two failures, as a ticket failing and then main failing is. A run that hung
 *  isn't repeated. No tests stays quiet: the first ticket often adds them. Not recorded when the run has moved on, so a restart looks again. */
async function checkMain(repo0: Repo, r: AutoRun): Promise<void> {
  const still = () => { const cur = getRepo(repo0.id); return cur?.auto_mode && !cur.auto_stopped_why && !cur.clearing_at && openRun(cur.id)?.id === r.id ? cur : null }
  await inMergeQueue(repo0.id, async () => {
    const gen = autoGen(repo0.path); if (!still()) return // read first: auto going off from here on stops the run (Bug 89)
    const repo = await ensureFresh(repo0.id).catch(() => null); if (!repo || !still()) return
    const base = mergeBase(repo), tip = await ref(repo)
    const checked = () => { run('UPDATE auto_runs SET main_checked = ? WHERE id = ?', tip || 'nothing to test', r.id); patch('auto_run', r.id, { main_checked: tip || 'nothing to test' }) }
    // A finished ticket already waiting goes first: its own test checks main, and tests main alone if it fails (PR #59). A new test command that only that ticket satisfies
    // would otherwise look like a broken main and open a repair that holds it up.
    if (!tip || repo.empty || openRepair(repo.id) || nextToMerge(repo, tip)) return checked()
    const test = () => testBase(repo.path, base.ref, `run-${r.id}`, repo.test_cmd, gen)
    let b = await test(); if (b.kind === 'fail' && !b.hung && still()) b = await test()
    if (b.kind === 'stopped') return // auto went off: no result, and a later run checks again (Bug 89)
    emit({ agentId: null, source: 'system', kind: 'auto.main_checked', payload: { repo: repo.id, run: r.id, result: b.kind, test: 'test' in b ? b.test : null } })
    const cur = still(); if (!cur) return
    checked()
    if (b.kind === 'error') return stopProject(cur, `HQ couldn't test ${base.name}: ${b.why}`)
    if (b.kind === 'fail' && !openRepair(cur.id) && cur.test_cmd === repo.test_cmd && await ref(cur) === tip) await repairMain(cur, tip, b) // not if main or the command moved meanwhile
  })
}
async function testAndMerge(repo0: Repo, t0: Ticket): Promise<void> {
  const still = () => { const r = getRepo(repo0.id), t = getTicket(t0.id); return r?.auto_mode && !r.auto_stopped_why && !r.clearing_at && t && FINISHED_NOT_MERGED.includes(t.status) &&
    !t.auto_parked_why ? { repo: r, t } : null }
  await inMergeQueue(repo0.id, async () => {
    const gen = autoGen(repo0.path); if (!still()) return // read first: auto going off from here on stops the run (Bug 89)
    const repo = await ensureFresh(repo0.id).catch((e) => { stopProject(repo0, `HQ couldn't bring it up to date: ${(e as Error).message}`); return null }); if (!repo || !still()) return
    const t = getTicket(t0.id)!, base = mergeBase(repo), tip = await ref(repo), branch = `refs/heads/${t.branch}`
    const r = await testCombined(repo.path, base.ref, branch, t.key, repo.test_cmd, gen)
    if (r.kind === 'stopped') return // auto went off: nothing follows, not even with it back on by now (Bug 89)
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
      const b = await testBase(repo.path, base.ref, t.key, repo.test_cmd, gen); if (b.kind === 'stopped') return
      if (b.kind === 'fail') { if (still()) await repairMain(getRepo(repo.id)!, tip, b); return } // turned off during the test: nothing to repair for
      return fix()
    }
    const cur = still(); if (!cur) return // turned off, stopped or moved on during the test: not merged
    const fresh = await ensureFresh(repo.id).catch(() => repo)
    if (await ref(fresh) !== tip) return // main moved during the test: the next tick tests again
    try { await mergeNow(t.id, fresh) } catch (e) {
      if (getTicket(t.id)?.conflict_files != null) return // the next tick fixes it
      stopProject(repo, (e as Error).message)
    }
  })
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
function summary(repo: Repo, r: AutoRun, all: Ticket[]): string {
  const done = all.filter((t) => t.status === 'merged' && t.updated_at >= r.started_at), parked = all.filter((t) => t.auto_parked_why), behind = stuckBehindParked(all)
  const fs0 = [...new Set(done.map((t) => t.feature_id))].map((id0) => getFeature(id0)!).filter(Boolean)
  // The TPM records choices while it splits, before the first ticket opens the run: a feature's all count, the project's by time
  const decided = [...fs0.map((f) => [`feature:${f.id}`, 0] as const), [`repo:${repo.id}`, r.started_at] as const].flatMap(([scope, since]) =>
    q<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'Decided in auto mode' AND updated_at >= ?", scope, since).map((d) => d.text))
  const waiting = all.filter((t) => repo.auto_waiting === NO_TESTS && FINISHED_NOT_MERGED.includes(t.status)), changed = j<TestChange | null>(r.test_change, null)
  return [`## Built\n${done.map((t) => `- ${t.key}: ${t.title}`).join('\n') || '- Nothing was merged.'}`,
    decided.length ? `## Decided for you\n${decided.join('\n')}` : '',
    parked.length ? `## Parked, needs you\n${parked.map((t) => `- ${t.key}: ${t.auto_parked_why}`).join('\n')}` : '',
    behind.size ? `## Waiting on a parked ticket\n${all.filter((t) => behind.has(t.id)).map((t) => `- ${t.key}: ${t.title}`).join('\n')}` : '',
    waiting.length ? `## Finished, not merged (no tests HQ can run)\n${waiting.map((t) => `- ${t.key}: ${t.title}`).join('\n')}` : '',
    changed ? `## Test command changed\n- Was: \`${changed.was ?? 'the one HQ found'}\`\n- Now: \`${changed.now}\`\n- Left out: ${changed.left_out}` : '',
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
  await readNotices(repo, all); await lostEngineers(all); await idleEngineers(repoTickets(repo.id))
  repo = getRepo(repo.id)!
  const left = moving(repo, repoTickets(repo.id))
  if (left.length && !openRun(repo.id)) {
    const r: AutoRun = { id: id('run'), repo_id: repo.id, status: 'running', start_sha: (await ref(repo)) || null, end_sha: null, started_at: now(), ended_at: null, summary: null,
      test_change: null, main_checked: null }
    run('INSERT INTO auto_runs(id, repo_id, status, start_sha, started_at) VALUES (?,?,?,?,?)', r.id, r.repo_id, r.status, r.start_sha, r.started_at)
    patch('auto_run', r.id, r as unknown as Record<string, unknown>); emit({ agentId: null, source: 'system', kind: 'auto.run_started', payload: { repo: repo.id, run: r.id } })
  }
  if (!repo.auto_stopped_why) {
    await keepTpm(repo, repoTickets(repo.id))
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
    a.repo_id === repo.id)) await closeRun(cur, r, 'finished')
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
      keepAwake()
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

const rules = 'HQ: the user turned auto mode on for this project. From now on HQ starts ready tickets when your turn ends, approves plans, '
  + 'tests finished tickets on main, merges them and fixes conflicts. Finish each split before you end your turn. '
  + 'Make product choices yourself and record each one with write_feature, section "Decided in auto mode". '
  + 'Only something hard to undo goes to ask_user, with hard_to_undo: true. '
  + 'HQ won\'t merge without tests it can run: every ticket\'s spec names its tests, and in a project with none the first ticket adds them.'
export async function setAuto(repoId: string, on: boolean): Promise<{ on: boolean }> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  notClearing(repoId)
  if (on === !!repo.auto_mode) return { on }
  if (on) {
    const problem = await sandboxProblem(); if (problem) throw new Error(problem) // now, not at the first merge with the tokens spent
    setRepo(repo, { auto_mode: 1, auto_stopped_why: null, auto_waiting: null })
    if (repo.tpm_parked_at) await resumeRepo(repoId).catch(() => {}) // it can't work parked
    tellTpm(repoId, rules)
  } else {
    const r = openRun(repoId); setRepo(repo, { auto_mode: 0, auto_stopped_why: null, auto_waiting: null }); clearGoAhead(repoId)
    stopAutoTests(repo.path) // its test run ends now, not at its time limit, with no result (Bug 89)
    resolveKind(`auto_stopped:${repoId}`, null) // the banner goes with auto_stopped_why; so does its ⚠ line
    if (r) await closeRun(getRepo(repoId)!, r, 'off')
    tellTpm(repoId, 'HQ: the user turned auto mode off. They start, approve and merge from HQ again, and your normal rules apply. Running engineers finish their tickets.')
  }
  emit({ agentId: null, source: 'ui', kind: 'auto.switched', payload: { repo: repoId, on } })
  keepAwake(); if (on) autoSoon()
  return { on }
}
/** Resume after a stop: HQ looks again, and stops again if the reason is still there. */
export async function autoResume(repoId: string): Promise<{ ok: true }> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  const problem = await sandboxProblem(); if (problem) throw new Error(problem)
  setRepo(repo, { auto_stopped_why: null })
  for (const a of openAttention().filter((x) => x.kind === `auto_stopped:${repoId}`)) resolveAttention(a.id)
  autoSoon(); return { ok: true }
}
/** Engineers at work when the test command changes: otherwise they keep running the old one, which may never finish. */
function tellEngineers(repoId: string, cmd: string | null): void {
  if (cmd) for (const t of repoTickets(repoId).filter((x) => x.assignee_agent_id && !DONE.includes(x.status) && !FINISHED_NOT_MERGED.includes(x.status))) {
    const a = getAgent(t.assignee_agent_id!); if (a && a.status !== 'exited') sendMessage({ repoId, channel: 'dm', from: 'hq', to: a.id, reason: 'fyi', body: `HQ: ${testCmdNote(cmd)}` })
  }
}
const proposing = new Set<string>() // repair tickets whose test command HQ is trying now
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
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
/** A repair's proposal: a test command that can work in HQ's sandbox. The engineer has to have run it itself first (Bug 83). HQ tries it on
 *  main plus the repair's branch, so a repair that needs a fix and a new command can land. A pass on auto is taken at once and goes in the
 *  summary (the user's call: HQ can prove a command passes, not that it's a good test, and the summary is the check); off auto the user OKs
 *  it. A second change in a run stops and asks, so the tests can't be whittled down until they pass. */
export function proposeTestCommand(agent: Agent, command: string, leftOut: string): string {
  const t = ticketForAgent(agent), repo = t ? getRepo(getFeature(t.feature_id)?.repo_id ?? '') : undefined
  if (!t?.repairs_main || !t.branch || !repo) throw new Error('Only a repair ticket can change the test command.')
  if (!ranByEngineer(t.id, command)) throw new Error(NOT_RUN)
  if (proposing.has(t.id)) throw new Error('HQ is still trying your last one. End your turn; its message will come.')
  proposing.add(t.id)
  const tell = (body: string) => sendMessage({ repoId: repo.id, channel: 'dm', from: 'hq', to: agent.id, reason: 'fyi', body })
  void inMergeQueue(repo.id, async () => {
    const base = mergeBase(repo), r = await testCombined(repo.path, base.ref, `refs/heads/${t.branch}`, `${t.key}-cmd`, command)
    if (r.kind !== 'pass') {
      const why = r.kind === 'fail' ? `${whyFailed(r)}\n\n${failReport(r, 3000)}` : r.kind === 'error' ? r.why : r.kind
      return tell(`HQ: your test command didn't pass, so nothing changed. ${why}`)
    }
    const change: TestChange = { was: repo.test_cmd, now: command, left_out: leftOut }, cur = getRepo(repo.id)!
    if (!cur.auto_mode) {
      setRepo(cur, { test_cmd_proposed: JSON.stringify(change) })
      attention(`test_cmd_proposed:${repo.id}`, `${repo.name}: a repair wants to change the test command to: ${command}. It leaves out: ${leftOut}`)
      return tell('HQ: your test command passed. Auto mode is off, so the user decides. Stop here; HQ tells you what they chose.')
    }
    const open = openRun(repo.id)
    if (open?.test_change) return stopProject(cur, `A repair wanted a second change to the test command in one run, leaving out: ${leftOut}. HQ won't cut the tests down further by itself.`)
    setRepo(cur, { test_cmd: command, auto_waiting: null }); noTestsAt.clear(); tellEngineers(repo.id, command)
    if (open) run('UPDATE auto_runs SET test_change = ? WHERE id = ?', JSON.stringify(change), open.id)
    if (open) patch('auto_run', open.id, { test_change: JSON.stringify(change) })
    emit({ agentId: agent.id, source: 'system', kind: 'auto.test_changed', payload: { repo: repo.id, ticket: t.key, was: repo.test_cmd, now: command, left_out: leftOut } })
    tellTpm(repo.id, `HQ: ${t.key} changed the test command to \`${command}\`. It leaves out: ${leftOut}. The summary will list it.`)
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
  if (e && e.status !== 'exited') sendMessage({ repoId, channel: 'dm', from: 'hq', to: e.id, reason: 'fyi',
    body: use ? 'HQ: the user OK\'d your test command and it\'s saved. Call open_pr if you have code, or report_blocked if there\'s nothing left to do.'
      : 'HQ: the user said no to that test command. Find another way, or call report_blocked.' })
  if (use) tellEngineers(repoId, change.now)
  autoSoon(); return { cmd: use ? change.now : repo.test_cmd }
}
/** Another go for a parked ticket. */
export function autoRetry(ticketId: string): { ok: true } {
  const t = getTicket(ticketId); if (!t) throw new Error('unknown ticket')
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
