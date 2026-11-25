// "Have HQ test this" (hqcheck.ts): with auto mode off, the user asks HQ to run auto mode's checks on one finished ticket, and HQ only reports. This is the
// record HQ keeps of it on the ticket (tickets.hq_check) and the rules for the button and the results, in words. Pure: no DB, no processes. The page imports it.
import type { Counts } from './testcounts.ts'
import type { Look } from './smokerules.ts'

/** The checks, in the order HQ runs them: the tests on the ticket merged into main, the tests named for its criteria, HQ's look at the app, a reader of its
 *  changes, the UI tester. HQ stops at the first that fails, as auto mode does before a merge: the rest say so. */
export type StepKind = 'tests' | 'criteria' | 'look' | 'read' | 'ui'
export const STEPS: StepKind[] = ['tests', 'criteria', 'look', 'read', 'ui']
export const STEP_NAME: Record<StepKind, string> = { tests: 'Tests', criteria: 'Tests for its criteria', look: 'Opening the app', read: 'Reader of its changes',
  ui: 'UI tester' }
/** What the button's tooltip and the results say HQ is doing now. */
export const STEP_DOING: Record<StepKind, string> = { tests: 'running the tests', criteria: 'checking the tests for its criteria', look: 'opening the app',
  read: 'a reader has its changes', ui: 'trying it in a browser' }
/** One line under a step: good, bad, or plain. */
export type StepLine = { text: string; tone: 'ok' | 'bad' | 'plain' }
/** How one check went. `words`: one line. `lines`: the details (each criterion, each problem, each scenario). `output`: what the tests printed, when they failed.
 *  `trouble`: skipped because something went wrong (the UI tester or the reader couldn't be asked, the app wouldn't start), not because of how the project is
 *  set up (no start steps, turned off): the check can't say everything passed then, and ends amber. */
export type CheckStep = { kind: StepKind; state: 'pass' | 'fail' | 'skipped'; words: string; lines?: StepLine[]; output?: string; trouble?: boolean }
/** What Send to engineer sends: its conflicts (Fix conflicts), or a report of what failed, as auto mode sends one (tickets.ts fixTests; testrun.ts Failed). */
export type SendBack = { kind: 'conflicts' } | { kind: 'fix'; test: string; output: string; earlier: string; hung?: boolean; unproven?: boolean; missing?: number
  outside?: number; look?: boolean; review?: boolean; tester?: boolean }
/** Bug 373: what the ticket's engineer did with a check the user sent it, kept on that check once the engineer finishes the ticket again (mergewatch.ts
 *  finishTicket): when, the commit it handed over, the files it changed since the commit HQ tested (`more`: how many more the list leaves out) and what it wrote
 *  in its handoff log meanwhile ('' when nothing). What it found used to stay in its terminal. */
export type CheckBack = { at: number; sha: string | null; files: string[]; more?: number; note: string }
/** The passing tests, for the merge's record when the user merges the very commit HQ tested (mergewatch.ts mergeTicket; records.ts MergeTest). */
export type CheckTested = { test: string; counts: Counts | null; ms: number; output: string; look?: Look }
/** One check of a ticket. `sha`: the ticket's commit HQ tested; `base_sha`: main's; `base`: main in words. `finished_sha`: the commit its last open_pr named as
 *  the check began (records.ts Ticket): a later open_pr makes the results out of date. `state`: going, all passed, something failed, or HQ couldn't finish
 *  (`why`: an error, nothing it could test, main already failing) or it was stopped (`why`: by whom or what). `now`: the step under way. `cost_usd`: what the
 *  UI tester cost; `read_tokens`: the reader's tokens. `sent_at`: when the user sent the failure to its engineer; `back`: what that engineer did with it. */
export type HqCheck = { id: string; state: 'running' | 'pass' | 'fail' | 'error' | 'stopped'; sha: string; base: string; base_sha: string; finished_sha: string | null
  started_at: number; ended_at?: number; why?: string; now?: StepKind; steps: CheckStep[]; cost_usd?: number; read_tokens?: number; send?: SendBack; sent_at?: number
  back?: CheckBack; tested?: CheckTested; prep?: string } // prep (Bug 411): what HQ waits for before its first step (a helper working out the project's test steps)

/** The ticket's check, or null: never tested, or a record HQ can't read. */
export function checkOf(t: { hq_check?: string | null }): HqCheck | null {
  try { const c = t.hq_check ? JSON.parse(t.hq_check) as HqCheck : null; return c && typeof c.state === 'string' && Array.isArray(c.steps) ? c : null } catch { return null }
}
const readable = (c: unknown): c is HqCheck => !!c && typeof (c as HqCheck).state === 'string' && Array.isArray((c as HqCheck).steps)
/** Bug 373: the ticket's checks from before its latest one, oldest first (tickets.hq_checks): Test again used to wipe the results the user had sent to its
 *  engineer. [] for none, or a record HQ can't read. */
export function pastChecks(t: { hq_checks?: string | null }): HqCheck[] {
  try { const l = t.hq_checks ? JSON.parse(t.hq_checks) as unknown : []; return Array.isArray(l) ? l.filter(readable) : [] } catch { return [] }
}
/** Every check HQ has of the ticket, newest first: the latest, then the earlier ones. */
export function checksOf(t: { hq_check?: string | null; hq_checks?: string | null }): HqCheck[] {
  const c = checkOf(t); return [...(c ? [c] : []), ...pastChecks(t).reverse()]
}
/** How many earlier checks a ticket keeps besides its latest. */
export const PAST_CHECKS = 5
/** The earlier checks once `prev`, the latest until now, gives way to a new one. One that says nothing (stopped before any check ran) isn't kept, and a
 *  passing run's output isn't either: only the latest check can be a merge's test (testedFor). Over the limit the oldest goes, but the last one the user sent to
 *  its engineer stays while another can go: it is the one they come back for. */
export function pastWith(past: HqCheck[], prev: HqCheck | null, max = PAST_CHECKS): HqCheck[] {
  const all = [...past]
  if (prev && prev.state !== 'running' && (prev.steps.length > 0 || prev.sent_at)) { const { tested: _, ...kept } = prev; all.push(kept) }
  while (all.length > max) {
    let sent = -1; all.forEach((c, i) => { if (c.sent_at) sent = i })
    all.splice(sent === 0 && all.length > 1 ? 1 : 0, 1)
  }
  return all
}
export const FINISHED = ['pr_ready', 'pr_open']
/** Bug 373: the tests passed and no test failed; the check didn't pass only because HQ didn't see every test named for the ticket's criteria run. That isn't
 *  a failed test and never looks like one: amber, in its own words. Read from what the check would send, so a check kept before this says it too. */
export const unseenOnly = (c: HqCheck): boolean => c.state === 'fail' && c.send?.kind === 'fix' && !!c.send.unproven
/** How many named tests that is: as kept, or counted from the step's lines on a check from before HQ kept the number. 0 when it isn't that kind of check. */
export function unseenCount(c: HqCheck): number {
  if (!unseenOnly(c) || c.send?.kind !== 'fix') return 0
  return c.send.missing ?? c.steps.find((s) => s.kind === 'criteria')?.lines?.filter((l) => l.tone === 'bad').length ?? 0
}
/** "8 tests named for its criteria weren't seen running": what HQ knows. It didn't see them by name; whether they ran is for the engineer to find out. */
export const unseenWords = (n: number): string => n === 1 ? "1 test named for its criteria wasn't seen running"
  : `${n > 0 ? n : 'some'} tests named for its criteria weren't seen running`
/** "changed 1 file: a.json", "changed 3 files: a, b, c", "changed 12 files: a, b, c and 9 more", "changed no files". */
export function changedWords(files: string[], more = 0): string {
  const n = files.length + more
  return n ? `changed ${n === 1 ? '1 file' : `${n} files`}: ${files.join(', ')}${more ? ` and ${more} more` : ''}` : 'changed no files'
}
/** The engineer finished it again (a new open_pr) after HQ's check began: those results are about older code. A ticket finished before HQ kept the commit
 *  (finished_sha null on both) can't tell, and isn't. */
export const outOfDate = (t: { finished_sha?: string | null }, c: HqCheck): boolean => c.state !== 'running' && (t.finished_sha ?? null) !== c.finished_sha

export type Tone = 'plain' | 'green' | 'red' | 'amber' | 'grey'
/** A check's colour by how it ended: green all passed, red something failed, amber HQ couldn't finish or (Bug 373) the tests passed with named ones unseen. */
export const checkTone = (c: HqCheck): Tone => c.state === 'running' ? 'plain' : c.state === 'pass' ? 'green' : c.state === 'fail' && !unseenOnly(c) ? 'red' : 'amber'
/** The ticket's button: what it says, its colour, and its tooltip. `start`: a click starts a check (otherwise it opens the results). Null: no button: the ticket
 *  isn't finished and unmerged, or the user doesn't move it on (auto mode does, or the project is being cleared: board.ts nextMover). */
export function checkButton(t: { key: string; status: string; finished_sha?: string | null; hq_check?: string | null }, userMoves: boolean):
  { label: string; tone: Tone; start: boolean; tip: string } | null {
  if (!userMoves || !FINISHED.includes(t.status)) return null
  const c = checkOf(t)
  const fresh = { label: 'Have HQ test this', tone: 'plain' as const, start: true, tip: `HQ runs the checks auto mode runs before a merge on ${t.key}: its tests with it merged into `
    + 'main, the tests for its criteria, the app, a reader of its changes (bigger tickets) and the UI tester. It only reports: nothing is merged or sent back unless '
    + 'you say so. The tests and the app are free; the reader and the UI tester use Claude, usually under $1.' }
  if (!c) return fresh
  if (c.state === 'running') return { label: 'Testing…', tone: 'plain', start: false,
    tip: `HQ is testing ${t.key}: ${c.prep ?? (c.now ? STEP_DOING[c.now] : 'starting')}. Click to watch it or stop it.` }
  if (outOfDate(t, c)) return { label: 'Results out of date', tone: 'grey', start: false,
    tip: `${t.key}'s engineer finished it again after HQ's test, so the results are about older code. Click to read them or test again.` }
  if (c.state === 'pass') return { label: 'View results ✓', tone: 'green', start: false, tip: `Everything HQ tested on ${t.key} passed. Click for the results.` }
  if (commandGap(c)) return { label: 'View results ⚠', tone: 'amber', start: false, tip: `The tests passed when HQ tested ${t.key}, and none failed, but ${gapWords(c)}. `
    + 'Click for which. Its engineer can\'t change the test command: set one that runs them (Auto box), then test again.' } // Bug 411
  if (unseenOnly(c)) return { label: 'View results ⚠', tone: 'amber', start: false, tip: `The tests passed when HQ tested ${t.key}, and none failed, but `
    + `${unseenWords(unseenCount(c))}. Click for which, and to send it to its engineer.` }
  if (c.state === 'fail') return { label: 'View results ✗', tone: 'red', start: false, tip: `Something failed when HQ tested ${t.key}. Click for what, and to send it to its engineer.` }
  return { label: "Couldn't finish", tone: 'amber', start: false, tip: `HQ couldn't finish testing ${t.key}: ${c.why ?? 'it stopped'}. Click for more.` }
}

/** The results' heading line. */
export function checkHeadline(c: HqCheck): string {
  if (c.state === 'running') return `Testing… ${c.prep ?? (c.now ? STEP_DOING[c.now] : 'starting')}`
  if (c.state === 'pass') return 'Everything HQ tested passed'
  if (commandGap(c)) return `The tests passed, but ${gapWords(c)}`
  if (unseenOnly(c)) return `The tests passed, but ${unseenWords(unseenCount(c))}`
  if (c.state === 'fail') { const f = c.steps.find((s) => s.state === 'fail'); return `${f ? STEP_NAME[f.kind] : 'A check'} failed` }
  if (c.state === 'stopped') return `Stopped: ${c.why ?? 'before it finished'}`
  return `Couldn't finish: ${c.why ?? 'HQ hit an error'}`
}
/** Every step, in order, with the ones HQ never got to: why not (an earlier one failed, it was stopped) or that it's still to come. */
export function allSteps(c: HqCheck): (CheckStep | { kind: StepKind; state: 'waiting' | 'running' | 'not_run'; words: string })[] {
  const failed = c.steps.some((s) => s.state === 'fail')
  return STEPS.map((k) => c.steps.find((s) => s.kind === k) ?? (c.state === 'running'
    ? (c.now === k ? { kind: k, state: 'running' as const, words: `${STEP_DOING[k][0]!.toUpperCase()}${STEP_DOING[k].slice(1)}…` } : { kind: k, state: 'waiting' as const, words: 'still to come' })
    : { kind: k, state: 'not_run' as const, words: failed ? (unseenOnly(c) ? "not run: an earlier check didn't pass" : 'not run: an earlier check failed')
      : c.state === 'stopped' ? 'not run: stopped' : 'not run' }))
}
/** What it tested, how long it took, and what it cost, for under the heading. A check under way has its clock on the page instead. */
export function checkFacts(c: HqCheck): string {
  const s = Math.round(((c.ended_at ?? c.started_at) - c.started_at) / 1000), took = s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
  const cost = c.cost_usd ? ` · UI tester $${c.cost_usd.toFixed(2)}` : '', read = c.read_tokens ? ` · reader ${Math.round(c.read_tokens / 1000)}k tokens` : ''
  return `${c.sha.slice(0, 7)} merged into ${c.base} (${c.base_sha.slice(0, 7)})${c.state === 'running' ? '' : ` · took ${took}`}${cost}${read}`
}
/** Send to engineer is offered: something failed that its engineer can fix, and it hasn't gone to them yet. */
/** Bug 411: every named test HQ didn't see run is in a folder its test command runs nothing in. The command is what's missing, so there is nothing to send
 *  the ticket's engineer: the user sets a command that runs those tests, and tests again. */
/** "HQ's test command doesn't run the folder the tests named for its criteria are in" (or "a test … is in"). */
export const gapWords = (c: HqCheck): string => `HQ's test command doesn't run the folder ${unseenCount(c) === 1 ? 'a test named for its criteria is' : 'the tests named for its criteria are'} in`
export const commandGap = (c: HqCheck): boolean => unseenOnly(c) && c.send?.kind === 'fix' && !!c.send.outside && c.send.outside >= (c.send.missing ?? c.send.outside)
export const canSend = (t: { finished_sha?: string | null }, c: HqCheck): boolean => c.state === 'fail' && !!c.send && !c.sent_at && !outOfDate(t, c) && !commandGap(c)
/** What the merge records when the user merges a ticket HQ's check passed: only for the very commits it tested, the ticket's and main's. */
export function testedFor(c: HqCheck | null, head: string, baseSha: string): (CheckTested & { on: string; at: number }) | null {
  if (!c || c.state !== 'pass' || !c.tested || c.sha !== head || c.base_sha !== baseSha) return null
  return { ...c.tested, on: c.base, at: c.ended_at ?? c.started_at }
}
