// "Have HQ test this": with auto mode off, the user asks HQ to run auto mode's checks on one finished ticket (plans/ticket-test-button.md). HQ runs what auto
// mode runs before a merge, in the same order and stopping at the first failure (auto.ts testAndMerge): the tests on the ticket merged into main, the tests
// named for its criteria, HQ's look at the app, a reader of its changes (only when auto mode would read them), and the UI tester on this ticket's screens. It
// only reports, on the ticket (tickets.hq_check, hqcheckrules.ts): nothing merges and nothing goes back to the engineer unless the user says so (sendCheck).
// The check is owned by its ticket, with a stop of its own (not auto mode's count): the user's Stop, the ticket leaving "finished", auto mode taking the
// ticket over, a Clear or Remove, and a backend restart each end it, and it says why.
import { DEFAULTS } from './config.ts'
import { getSetting, now, q } from './db.ts'
import { bus, emit, type Patch } from './events.ts'
import { id } from './util.ts'
import { autoGoing, getFeature, getRepo, getTicket, hqMoves, keepCheck, keepPastChecks, notClearing, setTicket, type Repo, type Ticket } from './records.ts'
import { mergeBase, setConflict, whoMergedFirst } from './conflicts.ts'
import { ensureFresh, git } from './repos.ts'
import { failedLine, failReport, lookAtBase, showing, testBase, testCombined, type Failed, type Shown, type TestResult } from './testrun.ts'
import { combinedCommit } from './localmerge.ts'
import { confirm, criteriaOf, proofOf, proofWords, ranWords, unproven, watchFor } from './criteria.ts'
import { judge, lookReport, lookWords, movedWords, needsBase, type Look, type Seen } from './smokerules.ts'
import { lookHow, type LookPlan } from './smoke.ts'
import { row as previewRow, runnableRecipe } from './preview.ts'
import { readAgain, readDiff, readReport, whyRead } from './diffcheck.ts'
import { diffCheckOf } from './checks.ts'
import { planChecks } from './plancheck.ts'
import { runUiTest } from './uitester.ts'
import { uiTestOn } from './auto.ts'
import { fixConflicts, fixTests } from './tickets.ts'
import { countWords, took } from './testcounts.ts'
import { checkOf, FINISHED, outOfDate, pastChecks, pastWith, STEP_NAME, unseenCount, unseenWords, type CheckStep, type HqCheck, type SendBack, type StepKind,
  type StepLine } from './hqcheckrules.ts'

/** The checks under way, by ticket: what stops each one, and why it was stopped (the results say it). */
const going = new Map<string, { stop: AbortController; why?: string }>()
export const checking = (ticketId: string): boolean => going.has(ticketId)

/** Kept on the ticket without touching its updated_at (auto mode reads that), and sent to every open page. A ticket that's gone (removed meanwhile) keeps nothing. */
const save = keepCheck
const repoOf = (t: Ticket): Repo | undefined => { const f = getFeature(t.feature_id); return f ? getRepo(f.repo_id) : undefined }
const tipOf = (repo: Repo, ref: string): Promise<string> => git(repo.path, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).catch(() => '')

/** Starts a check of a finished ticket. Refused, with why, when there's nothing to test or someone else moves it on. Answers once it has begun: the results
 *  come on the ticket. */
export async function startCheck(ticketId: string): Promise<{ id: string }> {
  const ready = (): { t: Ticket; repo: Repo } => {
    const t = getTicket(ticketId); if (!t) throw new Error('unknown ticket')
    const repo = repoOf(t); if (!repo) throw new Error('unknown project')
    notClearing(repo.id)
    if (hqMoves(repo, t)) throw new Error(`Auto mode tests and merges ${t.key} itself.`)
    if (!FINISHED.includes(t.status) || !t.branch) throw new Error(`${t.key} isn't finished, so there's nothing to test yet.`)
    return { t, repo }
  }
  ready()
  if (going.has(ticketId)) throw new Error(`HQ is already testing ${getTicket(ticketId)!.key}.`)
  const own = { stop: new AbortController() as AbortController, why: undefined as string | undefined }; going.set(ticketId, own) // a second click meanwhile is refused
  try {
    const repo0 = ready().repo
    const repo = await ensureFresh(repo0.id).catch((e) => { throw new Error(`HQ couldn't bring ${repo0.name} up to date to test it: ${(e as Error).message}`) })
    const base = mergeBase(repo), base_sha = await tipOf(repo, base.ref)
    const { t } = ready() // read again after the waits: it may have been sent back, removed or taken over meanwhile
    const sha = await tipOf(repo, `refs/heads/${t.branch}`)
    if (!sha) throw new Error(`${t.key}'s branch ${t.branch} is gone, so HQ can't test it.`)
    if (!base_sha) throw new Error(`HQ couldn't find ${base.name} in ${repo.name}.`)
    if (own.stop.signal.aborted) throw new Error(own.why ? `It stopped before it began: ${own.why}.` : 'It stopped before it began.')
    const c: HqCheck = { id: id('check'), state: 'running', sha, base: base.name, base_sha, finished_sha: t.finished_sha, started_at: now(), now: 'tests', steps: [] }
    // Bug 373: the check before this one stays with the ticket (the last few do): Test again used to wipe the results the user had sent to its engineer
    const prev = checkOf(t); if (prev) keepPastChecks(t.id, pastWith(pastChecks(t), prev))
    save(t.id, c)
    emit({ agentId: null, source: 'ui', kind: 'check.started', payload: { ticket: t.id, key: t.key, check: c.id, sha } })
    void runCheck(t, getRepo(repo.id) ?? repo, c, own).catch(() => {})
    return { id: c.id }
  } catch (e) { going.delete(ticketId); throw e }
}

/** Ends a check under way, saying why. Nothing under way: nothing to do. */
export function stopCheck(ticketId: string, why: string): boolean {
  const g = going.get(ticketId); if (!g) return false
  g.why ??= why; g.stop.abort(); return true
}
/** Every check in a project ends (Clear, Remove). */
export function stopChecksIn(repoId: string, why: string): void {
  for (const tid of going.keys()) { const t = getTicket(tid); if (!t || getFeature(t.feature_id)?.repo_id === repoId) stopCheck(tid, why) }
}
/** At start-up: a check the last backend was running died with it (its runs went with the backend). It says so, and Test again starts a new one. */
export function endLeftChecks(): number {
  const left = q<{ id: string; hq_check: string }>(`SELECT id, hq_check FROM tickets WHERE hq_check LIKE '%"state":"running"%'`)
  for (const r of left) {
    const c = checkOf(r); if (c?.state === 'running' && !going.has(r.id)) save(r.id, { ...c, state: 'stopped', why: 'HQ restarted while it was testing', now: undefined, ended_at: now() })
  }
  return left.length
}
/** What ends a check by itself: the ticket leaves "finished" (merged, sent back, removed), auto mode takes it over (turned on or resumed, or a parked ticket
 *  handed back), or its project is being cleared. */
export function watchChecks(): void {
  bus.on('patch', (p: Patch) => {
    if (p.entity === 'ticket' && going.has(p.id) && (!p.patch || ('status' in p.patch && !FINISHED.includes(String(p.patch.status))))) {
      const s = p.patch ? String(p.patch.status) : 'gone'
      stopCheck(p.id, s === 'merged' ? 'it was merged' : s === 'resolving' ? 'it went back to its engineer' : s === 'cancelled' || s === 'gone' ? 'it was removed'
        : "it isn't finished any more")
    }
    // a ticket auto mode had parked, handed back to it (Try again): auto mode tests and merges it itself now
    if (p.entity === 'ticket' && going.has(p.id) && p.patch && 'auto_parked_why' in p.patch) {
      const t = getTicket(p.id), repo = t && repoOf(t); if (t && repo && hqMoves(repo, t)) stopCheck(p.id, 'auto mode took over: it tests and merges this ticket itself')
    }
    if (p.entity === 'repo' && p.patch && ['auto_mode', 'auto_stopped_why', 'clearing_at'].some((k) => k in p.patch!)) {
      const repo = getRepo(p.id); if (!repo) return
      for (const tid of going.keys()) {
        const t = getTicket(tid); if (!t || getFeature(t.feature_id)?.repo_id !== repo.id) continue
        if (repo.clearing_at) stopCheck(tid, 'the project is being cleared')
        else if (autoGoing(repo) && hqMoves(repo, t)) stopCheck(tid, 'auto mode took over: it tests and merges this ticket itself')
      }
    }
  })
}

/** What HQ starts to open the app: the launch recipe its preview runs, or why it won't (auto.ts lookPlan, without auto mode's run). `tester`: the UI tester,
 *  which has its own switch, so the look's setting doesn't turn it off. */
function lookPlanFor(repo: Repo, tester = false): { plan: LookPlan } | { skip: string } {
  if (!tester && getSetting('app_look', DEFAULTS.app_look) === 'off') return { skip: "opening the app is turned off in HQ's settings" }
  const recipe = runnableRecipe(previewRow(repo.id), repo.path)
  if (!recipe) return { skip: 'HQ has no start steps for this project yet: press Launch app once, and HQ can open it from then on' }
  return { plan: { recipe, repoPath: repo.path, how: lookHow(recipe) } }
}
const lastChars = (s: string, max: number): string => s.length <= max ? s : `…\n${s.slice(s.indexOf('\n', s.length - max) + 1 || s.length - max)}`
const lookLines = (l: Look): StepLine[] => l.ran === 'fail' ? l.problems.slice(0, 12).map((x) => ({ text: `${x.page}: ${x.text}`, tone: 'bad' as const })) : []

async function runCheck(t0: Ticket, repo: Repo, c: HqCheck, own: { stop: AbortController; why?: string }): Promise<void> {
  const signal = own.stop.signal, key = `${t0.key}-check`
  const show = (what: Shown['what']): Shown => ({ repoId: repo.id, ticketId: t0.id, what })
  const step = (s: CheckStep): void => { c.steps.push(s) }
  const at = (k: StepKind): void => { c.now = k; save(t0.id, c) }
  const end = (state: HqCheck['state'], why?: string, send?: SendBack): void => {
    Object.assign(c, { state, ended_at: now(), now: undefined }, why ? { why } : {}, send ? { send } : {}); save(t0.id, c)
    const unseen = unseenCount(c) // Bug 373: nothing failed, HQ just didn't see named tests run: the Events tab says that, not "found a problem"
    emit({ agentId: null, source: 'system', kind: 'check.ended', payload: { ticket: t0.id, key: t0.key, check: c.id, state, why: why ?? null, ...(unseen ? { unseen } : {}) } })
  }
  const stopped = (): void => end('stopped', own.why ?? 'stopped')
  const fix = (f: Omit<Extract<SendBack, { kind: 'fix' }>, 'kind'>): SendBack => ({ kind: 'fix', ...f })
  try {
    const t = getTicket(t0.id) ?? t0, proof = proofOf(t), lp = lookPlanFor(repo)
    // 1. The tests, with it merged into main as it was when the check began, and once they pass, the app opened in the same checkout (testrun.ts runAt)
    let r: TestResult = await testCombined(repo.path, c.base_sha, c.sha, key, repo.test_cmd, signal, show('ticket'),
      { watch: watchFor(proof?.tests ?? []), look: 'plan' in lp ? lp.plan : null })
    if (r.kind === 'stopped' || signal.aborted) return stopped()
    if (r.kind === 'error') return end('error', `HQ couldn't test it: ${r.why}`)
    if (r.kind === 'conflicts') {
      const cur = getTicket(t0.id) ?? t, merged = await whoMergedFirst(repo, cur, r.files, c.base_sha); setConflict(cur, r.files, merged, c.base)
      const where = r.files.length === 1 ? r.files[0] : `${r.files.length} files`, first = merged.length ? ` (${merged.join(', ')} merged first)` : ''
      step({ kind: 'tests', state: 'fail', words: `It conflicts with ${c.base} in ${where}${first}, so nothing could be tested.`,
        lines: r.files.slice(0, 12).map((f) => ({ text: f, tone: 'bad' as const })) })
      return end('fail', undefined, { kind: 'conflicts' })
    }
    let ranTests: Extract<TestResult, { kind: 'pass' }> | null = null
    if (r.kind === 'no_tests') {
      step({ kind: 'tests', state: 'skipped', words: "No tests HQ can run: the project has no test command and HQ found none. Set one in the Auto box." })
      step({ kind: 'criteria', state: 'skipped', words: 'No tests ran, so none of its criteria\'s tests could be checked.' })
      if ('plan' in lp) { // the app can still be opened and tried
        at('look'); r = await testCombined(repo.path, c.base_sha, c.sha, key, null, signal, show('look'), { look: lp.plan, only: 'look' })
        if (r.kind === 'stopped' || signal.aborted) return stopped()
      }
    } else if (r.kind === 'fail') {
      // was main already like that? Then it isn't this ticket's fault, and there's nothing to send its engineer
      at('tests'); const b = await testBase(repo.path, c.base_sha, key, repo.test_cmd, signal, show('main')); if (b.kind === 'stopped' || signal.aborted) return stopped()
      const words = r.hung ? `They froze and were stopped after ${getSetting('test_timeout_min', DEFAULTS.test_timeout_min)} minutes` : `They failed: ${failedLine(`${r.earlier}\n${r.output}`)}`
      if (b.kind === 'fail') {
        step({ kind: 'tests', state: 'fail', words: `${words} · ${c.base} fails them too, without ${t.key}.`, output: failReport(r, 4000) })
        return end('error', `${c.base}'s own tests fail, so HQ can't tell whether ${t.key} is fine. Fix ${c.base} first.`)
      }
      step({ kind: 'tests', state: 'fail', words: `${words} · ${c.base} passes them without ${t.key}, so the failure is ${t.key}'s.`, output: failReport(r, 4000) })
      return end('fail', undefined, fix({ test: r.test, output: r.output, earlier: r.earlier, ...(r.hung ? { hung: true } : {}) }))
    } else if (r.kind === 'pass') {
      ranTests = r
      step({ kind: 'tests', state: 'pass', words: `\`${r.test}\` passed${r.counts ? `: ${countWords(r.counts)}` : ''} · ${took(r.ms)}` })
      // 2. The tests its open_pr named for its criteria: did each one run? A pass that skipped one proves nothing about it
      if (proof?.tests.length) {
        at('criteria')
        const names = r.names, tests = proof.tests.map((e) => ({ ...e, state: confirm(e, names) }))
        const missing = unproven(tests, r.test)
        setTicket(t0.id, { proof: JSON.stringify({ ...proof, tests, confirmed_at: now() }) }) // HQ's own run: the Ticket tab shows each one's result too
        const lines = tests.map((e): StepLine => {
          const w = proofWords(e); return { text: `${e.criterion}: ${w.text}`, tone: e.state === 'skipped' || e.state === 'not_run' ? 'bad' : w.tone === 'ok' ? 'ok' : 'plain' }
        })
        if (missing.length) {
          // Bug 373: what HQ knows, no more: the run passed and it didn't see these by name ("didn't run" was untrue when the runner printed no names, Bug 372)
          const n = missing.length, words = unseenWords(n)
          step({ kind: 'criteria', state: 'fail', words: `${words[0]!.toUpperCase()}${words.slice(1)}. The tests themselves passed: none failed.`, lines })
          return end('fail', undefined, fix({ test: r.test, unproven: true, missing: n, earlier: '', output: `The tests that didn't run:\n${missing.map((m) => `- ${m}`).join('\n')}` }))
        }
        const named = tests.some((e) => !e.cant_test)
        step(named ? { kind: 'criteria', state: 'pass', words: ranWords(tests), lines }
          : { kind: 'criteria', state: 'skipped', words: 'Its engineer named no test for any of its criteria: each one says why.', lines })
      } else step({ kind: 'criteria', state: 'skipped', words: criteriaOf(t).length ? 'Its engineer named no tests for its criteria.' : 'It has no acceptance criteria.' })
    }
    // 3. HQ's look at the app with it merged in. Only what the ticket changed counts: when something is wrong, HQ looks at main alone too
    const seen: Seen | undefined = r.kind === 'pass' ? r.seen : r.kind === 'looked' ? r.seen : undefined
    if (!('plan' in lp)) step({ kind: 'look', state: 'skipped', words: `Not opened: ${lp.skip}.` })
    else if (!seen) step({ kind: 'look', state: 'skipped', words: "Not opened: HQ's look didn't run.", trouble: true })
    else {
      let main: Seen | null = null
      if (needsBase(seen)) {
        at('look'); const b = await lookAtBase(repo.path, c.base_sha, key, lp.plan, signal, show('look_main')); if (b.kind === 'stopped' || signal.aborted) return stopped()
        main = b.kind === 'looked' ? b.seen : { kind: 'skipped', why: `HQ couldn't open the app on ${c.base} to compare${b.kind === 'error' ? ` (${b.why})` : ''}` }
      }
      const look = judge(seen, main, c.base), w = lookWords(look)
      if (look.ran === 'fail') {
        step({ kind: 'look', state: 'fail', words: look.why, lines: lookLines(look), ...(look.output ? { output: lastChars(look.output, 4000) } : {}) })
        return end('fail', undefined, fix({ test: lp.plan.how, look: true, earlier: '', output: lookReport(look, lp.plan.how) }))
      }
      step(look.ran === 'pass' ? { kind: 'look', state: 'pass', words: w?.long ?? 'Opened.' } : { kind: 'look', state: 'skipped', words: `Couldn't open it: ${look.why}.`, trouble: true })
      if (ranTests) c.tested = { test: ranTests.test, counts: ranTests.counts, ms: ranTests.ms, output: lastChars(ranTests.output, 4000), look }
    }
    if (ranTests && !c.tested) c.tested = { test: ranTests.test, counts: ranTests.counts, ms: ranTests.ms, output: lastChars(ranTests.output, 4000) }
    // 4. A fresh reader of its changes, only for a ticket auto mode would have read (its size, what git or the plan check flagged), once per commit
    if (signal.aborted) return stopped()
    const cur = getTicket(t0.id) ?? t, read = diffCheckOf(cur), why = whyRead(cur, proofOf(cur), planChecks(cur.id))
    if (getSetting('diff_check', DEFAULTS.diff_check) === 'off') step({ kind: 'read', state: 'skipped', words: "Not read: turned off in HQ's settings." })
    else if (!why.length) step({ kind: 'read', state: 'skipped', words: 'Not needed: a small ticket, and nothing was flagged.' })
    else {
      let d = read && !readAgain(read, c.sha) && read.sha === c.sha ? read : null // read already, this very commit: its answer stands, and costs nothing
      if (!d) {
        at('read'); const page = showing(show('review'))
        const got = await readDiff({ repoPath: repo.path, base: c.base_sha, branch: c.sha, criteria: criteriaOf(cur), why, test: ranTests?.test ?? '(no tests ran)',
          output: ranTests?.output ?? '', signal }).finally(() => page.over())
        if (got === 'stopped' || signal.aborted) return stopped()
        d = { ...got, sha: c.sha }; setTicket(t0.id, { diff_check: JSON.stringify(d) })
        if (got.state !== 'unchecked') c.read_tokens = got.tokens
      }
      if (d.state === 'sent_back') {
        step({ kind: 'read', state: 'fail', words: `It found ${d.findings.length === 1 ? 'a problem' : `${d.findings.length} problems`}.`,
          lines: d.findings.map((f) => ({ text: `${f.about}: ${f.problem}`, tone: 'bad' as const })) })
        return end('fail', undefined, fix({ test: ranTests?.test ?? '', review: true, earlier: '', output: readReport(d.findings) }))
      }
      step(d.state === 'ok' ? { kind: 'read', state: 'pass', words: 'It found nothing wrong.' } : { kind: 'read', state: 'skipped', words: `Not read: ${d.error}.`, trouble: true })
    }
    // 5. The UI tester on this ticket's screens, in a checkout of it merged into main
    if (signal.aborted) return stopped()
    const tp = lookPlanFor(repo, true)
    if (!uiTestOn(repo)) step({ kind: 'ui', state: 'skipped', words: "Not tried: the UI tester is turned off (HQ's settings or this project's)." })
    // how the machine is, not something gone wrong: never a reason for amber (runUiTest says the same, but as a skip that would count against the check)
    else if (process.platform !== 'darwin') step({ kind: 'ui', state: 'skipped', words: 'Not tried: the UI tester runs on macOS only for now.' })
    else if (!('plan' in tp)) step({ kind: 'ui', state: 'skipped', words: `Not tried: ${tp.skip}.` })
    else {
      at('ui')
      const comb = await combinedCommit(repo.path, c.base_sha, c.sha); if (signal.aborted) return stopped()
      if (!('sha' in comb)) step({ kind: 'ui', state: 'skipped', words: `Not tried: HQ couldn't merge it into ${c.base} for the tester.`, trouble: true })
      else {
        const u = await runUiTest({ repoPath: repo.path, repoId: repo.id, runId: c.id, sha: comb.sha, plan: tp.plan, gen: signal, ticketId: t0.id,
          tickets: [{ key: cur.key, title: cur.title, criteria: criteriaOf(cur) }] })
          .catch((e) => ({ at: now(), state: 'skipped' as const, why: `HQ hit an error (${(e as Error).message.split('\n')[0]})` }))
        if (u === 'stopped' || signal.aborted) return stopped()
        if (u.state === 'skipped') {
          // Bug 380: a plan paid for before the app turned out not to start here: its cost is the check's too, and the step says what it was for
          const paid = 'cost_usd' in u && u.cost_usd ? u.cost_usd : 0; if (paid) c.cost_usd = paid
          step({ kind: 'ui', state: 'skipped', words: `Not tried: ${u.why}.${paid ? ` Its plan of scenarios had cost $${paid.toFixed(2)}.` : ''}`,
            ...('quiet' in u && u.quiet ? {} : { trouble: true }) }) // quiet: how the project is set up
        } else {
          c.cost_usd = u.cost_usd
          const title = (sid: string) => u.scenarios.find((s) => s.id === sid)?.title ?? sid
          const lines: StepLine[] = u.scenarios.map((s) => ({ tone: s.outcome === 'ok' ? 'ok' as const : s.outcome === 'problem' ? 'bad' as const : 'plain' as const,
            text: `${s.title}: ${s.outcome === 'ok' ? 'fine' : s.outcome === 'problem' ? u.findings.filter((f) => f.scenario === s.id).map((f) => f.what).join(' · ') || 'a problem'
              : s.outcome === 'unspecified' ? 'no verdict (nothing says what should happen)' : s.outcome === 'couldnt_test' ? `couldn't test from a browser${s.why ? ` (${s.why})` : ''}`
              : `not run${s.why ? ` (${s.why})` : ''}`}` }))
          if (u.moved?.length) lines.unshift({ text: `HQ ran its own copy of the app on ${movedWords(u.moved)}.`, tone: 'plain' }) // Bug 374
          const ok = u.scenarios.filter((s) => s.outcome === 'ok').length, n = u.scenarios.length
          if (u.findings.length) {
            step({ kind: 'ui', state: 'fail', words: `${u.findings.length === 1 ? 'A problem' : `${u.findings.length} problems`} in ${n} scenario${n === 1 ? '' : 's'}.`, lines })
            const report = ["HQ's UI tester used the app in a browser, as a person would, with the ticket merged in. What it found:",
              ...u.findings.map((f) => `- ${f.criterion ? `${f.criterion}: ` : ''}${f.what} (expected: ${f.expected}). In "${title(f.scenario)}", after: `
                + (f.steps.map((s) => s.code).join(' → ') || 'opening the app'))].join('\n')
            return end('fail', undefined, fix({ test: "HQ's UI tester", look: true, tester: true, earlier: '', output: report }))
          }
          step(ok ? { kind: 'ui', state: 'pass', words: `${ok} of ${n} scenario${n === 1 ? '' : 's'} fine, nothing found.`, lines }
            : { kind: 'ui', state: 'skipped', words: `No verdicts: none of its ${n} scenario${n === 1 ? '' : 's'} could be judged.`, lines,
              ...(u.scenarios.every((s) => s.outcome === 'not_run') ? { trouble: true } : {}) }) // none even ran: the sessions ended early
        }
      }
    }
    const hitch = c.steps.find((s) => s.trouble) // everything that ran passed, but this couldn't run: not "all good"
    const COULDNT: Partial<Record<StepKind, string>> = { look: "HQ couldn't open the app", read: "the reader couldn't be asked", ui: "the UI tester couldn't run" }
    if (hitch) return end('error', `${COULDNT[hitch.kind] ?? `${STEP_NAME[hitch.kind]} couldn't run`}; nothing that ran failed`) // its step says why
    if (!c.steps.some((s) => s.state === 'pass')) return end('error', 'nothing could be tested: every check was skipped (see why under each)')
    end('pass')
  } catch (e) { end('error', `HQ hit an error: ${(e as Error).message.split('\n')[0]}`) }
  finally { if (going.get(t0.id) === own) going.delete(t0.id) }
}

/** Send to engineer: what failed goes to the ticket's engineer, as auto mode sends it (a fresh one starts if it has stopped). Only for the latest check, only
 *  once, and only while its results are about the code the ticket has now. */
export async function sendCheck(ticketId: string): Promise<{ engineer: string | null }> {
  const t = getTicket(ticketId); if (!t) throw new Error('unknown ticket')
  const repo = repoOf(t); if (repo) notClearing(repo.id)
  const c = checkOf(t)
  if (!c || c.state !== 'fail' || !c.send) throw new Error(`HQ's test of ${t.key} found nothing to send to its engineer.`)
  if (c.sent_at) throw new Error(`What HQ's test of ${t.key} found was sent to its engineer already.`)
  if (outOfDate(t, c)) throw new Error(`${t.key} changed after HQ tested it: press Test again first.`)
  const s = c.send
  const r = s.kind === 'conflicts' ? await fixConflicts(ticketId) : await fixTests(ticketId, { kind: 'fail', asked: true, test: s.test, output: s.output, earlier: s.earlier,
    ...(s.hung ? { hung: true } : {}), ...(s.unproven ? { unproven: true } : {}), ...(s.missing ? { missing: s.missing } : {}), ...(s.look ? { look: true } : {}),
    ...(s.review ? { review: true } : {}),
    ...(s.tester ? { tester: true } : {}) } satisfies Failed)
  const now0 = getTicket(ticketId), c2 = now0 && checkOf(now0)
  if (c2?.id === c.id) save(ticketId, { ...c2, sent_at: now() })
  emit({ agentId: r.engineer ?? null, source: 'ui', kind: 'check.sent', payload: { ticket: ticketId, key: t.key, check: c.id, kind: s.kind } })
  return { engineer: r.engineer ?? null }
}
