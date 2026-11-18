// Replaying a finding whose fix merged (Part 5): HQ runs its reproduction steps again as a plain script, under the recorder (Part 3), from a reset app, and
// judges in code whether the problem is still there (findingrules.ts judgeInCode). Models only where code can't tell:
// - steps that can't run any more (a button moved or was renamed): the UI tester retries it by its goal, knowing only the finding's own words and steps;
// - a UI finding with nothing for code to check on the page: the same;
// - a backend finding no flag shows: the checker reads the replay's recording against the one criterion it broke (backendcheck.ts checkReplay).
import { inputs, type Recorded, type Retry } from './loopinputs.ts'
import { fromTester, judgeInCode, type Check, type Kept } from './findingrules.ts'
import { checkReplay } from './backendcheck.ts'
import { showing } from './testrun.ts'
import { ticketInRepo, type Repo } from './records.ts'
import { criteriaOf } from './criteria.ts'

export type Replayed = { kind: 'checked'; check: Omit<Check, 'run' | 'at'> } | { kind: 'retry'; goal: string }
/** The goal a retry is given: its finding's id leads, so the tester's result can be matched back to it (findings.ts afterUiTest). A UI finding's words are
 *  the tester's own; a backend one's are the checker's, who read the code, so the tester gets only its own scenario's goal back (information flows from the
 *  tester to the checker, never the other way). */
export const retryGoal = (k: Kept): string => `${k.id}: ${fromTester(k) ? k.expected : k.evidence.goal ?? 'do the same thing again, from the start page'}`
/** What a retry tells the tester. */
export const retryOf = (k: Kept): Retry => fromTester(k) ? { goal: retryGoal(k), what: k.wording ?? k.what, expected: k.expected, steps: k.steps }
  : { goal: retryGoal(k), what: 'These steps used to work here. Do the same thing again and report anything that gets in your way.', expected: k.evidence.goal ?? '', steps: k.steps }
/** The criterion a finding broke, as the checker reads it ("T-03 A4"), from the merged ticket it names. */
function namedCriterion(repoId: string, name?: string): { name: string; text: string } | null {
  const [key, cid] = (name ?? '').split(' '); if (!key || !cid) return null
  const t = ticketInRepo(repoId, key), c = t ? criteriaOf(t).find((x) => x.id === cid) : undefined
  return c ? { name: name!, text: c.text } : null
}

export async function replay(repo: Repo, k: Kept, signal: AbortSignal, gen?: number): Promise<Replayed | 'stopped'> {
  const page = showing({ repoId: repo.id, ticketId: ticketInRepo(repo.id, k.tickets.at(-1) ?? '')?.id ?? null, what: 'replay' })
  try {
    // nothing for a script to run, or nothing code could check on the page after it: the tester retries it by its goal, and the script would be a wasted run
    if (!k.steps.length || (fromTester(k) && !k.expect?.length)) return { kind: 'retry', goal: retryGoal(k) }
    const rec = await inputs().runScenario(repo.id, k.steps, { expect: k.expect, gen })
    if (rec === 'stopped' || signal.aborted) return 'stopped'
    if ('why' in rec) return { kind: 'checked', check: { result: 'unknown', how: 'replay', why: `HQ couldn't replay it: ${rec.why}` } }
    const broke = rec.steps.findIndex((s) => !s.ok)
    if (broke >= 0) return { kind: 'retry', goal: retryGoal(k) } // the script no longer fits the app: the tester tries it by its goal
    const coded = judgeInCode(k, rec); if (coded) return { kind: 'checked', check: { ...coded, how: 'replay' } }
    if (fromTester(k)) return { kind: 'retry', goal: retryGoal(k) } // an expect that couldn't be checked
    const c = await checkReplay(repo, { criterion: k.rule ? { name: 'RULE', text: k.rule } : namedCriterion(repo.id, k.criterion), what: k.wording ?? k.what, expected: k.expected,
      rec, steps: k.steps }, signal)
    return c === 'stopped' ? 'stopped' : { kind: 'checked', check: { ...c, how: 'checker' } }
  } finally { page.over() }
}

/** A backend finding whose script broke and the tester retried: judged from the retry's recording, in code where it can be, else by the checker. */
export async function judgeRetry(repo: Repo, k: Kept, rec: Recorded | null, signal: AbortSignal): Promise<Omit<Check, 'run' | 'at'> | 'stopped'> {
  if (!rec) return { result: 'unknown', how: 'retry', why: 'the tester retried it, but there is no recording to judge' }
  const coded = judgeInCode(k, rec); if (coded) return { ...coded, how: 'retry' }
  const c = await checkReplay(repo, { criterion: k.rule ? { name: 'RULE', text: k.rule } : namedCriterion(repo.id, k.criterion), what: k.wording ?? k.what, expected: k.expected,
    rec, steps: k.steps }, signal)
  return c === 'stopped' ? 'stopped' : { ...c, how: 'checker' }
}
