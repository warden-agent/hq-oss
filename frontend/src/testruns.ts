// Bug 106: HQ's own test runs on screen. While HQ tests a finished ticket on main every agent can be idle or gone, for minutes, and the board used to say the same
// words before, during and after. The backend sends each run under way (testrun.ts TestRunView); this is what the ticket's box and the top bar say about it.
// Pure and self-contained, so the backend's test runner unit-tests it (src/testruns.test.ts).

/** `what`: a ticket merged into main; main alone (as an auto run starts, with no ticket, or after a ticket failed: was main already broken?); a repair's try of a
 *  test command; `look`: the tests passed and HQ is opening the app with the ticket merged in (the same run, a step on); `look_main`: that look showed something
 *  wrong, and HQ is opening the app on main alone to see whether it was already like that; `review`: everything else passed and a fresh reader (one
 *  headless call, diffcheck.ts) has the ticket's changes before it merges; `tester`: the run's tickets are merged and an agent is trying what they built in
 *  a browser (tester.ts), with no ticket of its own; `map`: a one-time session clicks through the app to write its first feature map (firstmap.ts);
 *  `scenario`: HQ runs a scripted scenario against the app (scenario.ts); `setup_check`: HQ tries a test setup for real (testsetup.ts).
 *  `checker`: a fresh reader (backendcheck.ts) has the tester's recordings and judges them against the backend criteria; `replay`: HQ replays the
 *  steps of a finding whose fix merged (replay.ts).
 *  `state`: in line for its turn (builds and test runs take turns, Bug 76) or running. `since`: when that began. */
export type TestRun = { id: string; repo_id: string; ticket_id: string | null; what: 'ticket' | 'main' | 'command' | 'look' | 'look_main' | 'review' | 'tester' | 'map'
  | 'scenario' | 'setup_check' | 'checker' | 'replay'; state: 'waiting' | 'running'; since: number }

/** How long something has been going: 0:42, 12:05, 1:02:03. A clock that is a little behind HQ's reads 0:00, never a minus. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}
/** A run in words. `box`: on its ticket's own box, so the ticket is "it". `bar`: in the top bar, which names the ticket (`key`; null when the run has none,
 *  or its ticket is gone). `base`: the branch tickets merge into. */
export function runWords(r: Pick<TestRun, 'what' | 'state'>, key: string | null, base: string): { box: string; bar: string } {
  const go = r.state === 'running', turn = 'is waiting its turn'
  if (r.what === 'command') { const tryIt = go ? 'HQ is trying' : 'HQ is waiting its turn to try'
    return { box: `${tryIt} its new test command`, bar: `${tryIt} ${key ? `${key}'s` : 'a'} new test command` } }
  // short enough for one row of the narrowest box, like the line they take the place of: the box keeps its height as a run waits, starts and ends
  if (r.what === 'tester') return go ? { box: 'HQ\'s tester is using the app', bar: 'HQ\'s tester is using the app in a browser, as a person would' }
    : { box: `HQ's tester ${turn}`, bar: `HQ's tester ${turn}` }
  if (r.what === 'map') return go ? { box: 'HQ is writing the first feature map', bar: 'HQ is clicking through the app to write its first feature map' }
    : { box: `HQ's first-map session ${turn}`, bar: `HQ's first-map session ${turn}` }
  if (r.what === 'scenario') return go ? { box: 'HQ is running a scenario on the app', bar: 'HQ is running a scenario on the app' } : { box: `HQ's scenario ${turn}`, bar: `HQ's scenario ${turn}` }
  if (r.what === 'setup_check') return go ? { box: 'HQ is checking its test setup', bar: 'HQ is trying its test setup for real: seed, start, reset' }
    : { box: `HQ's check of its test setup ${turn}`, bar: `HQ's check of its test setup ${turn}` }
  if (r.what === 'checker') return go ? { box: 'HQ\'s checker is reading what the tester did', bar: 'HQ\'s checker is reading what the tester did, against the criteria' }
    : { box: `HQ's checker ${turn}`, bar: `HQ's checker ${turn}` }
  if (r.what === 'replay') return go ? { box: 'HQ is replaying a fixed finding', bar: 'HQ is replaying the findings whose fixes merged' }
    : { box: `HQ's replay ${turn}`, bar: `HQ's replay of fixed findings ${turn}` }
  if (r.what === 'review') return { box: 'tests passed · a fresh reader has its changes', bar: `A fresh reader has ${key ? `${key}'s` : "a ticket's"} changes` }
  if (r.what === 'look') return go ? { box: 'tests passed · HQ is opening the app', bar: `HQ is opening the app with ${key ?? 'a ticket'} merged in` }
    : { box: `HQ's look at the app ${turn}`, bar: `HQ's look at the app with ${key ?? 'a ticket'} ${turn}` }
  if (r.what === 'look_main') return go ? { box: `HQ is opening the app on ${base} without it`, bar: `HQ is opening the app on ${key ? `${base} without ${key}` : base}` }
    : { box: `HQ's look at ${base} without it ${turn}`, bar: `HQ's look at ${key ? `${base} without ${key}` : base} ${turn}` }
  if (r.what === 'ticket') return go ? { box: `HQ is testing it on ${base}`, bar: `HQ is testing ${key ?? 'a ticket'} on ${base}` }
    : { box: `HQ's test ${turn}`, bar: `HQ's test of ${key ?? 'a ticket'} ${turn}` }
  const alone = key ? `${base} without ${key}` : base
  return go ? { box: `its tests failed · HQ is testing ${base} without it`, bar: `HQ is testing ${alone}` }
    : { box: `its tests failed · HQ's test of ${base} without it ${turn}`, bar: `HQ's test of ${alone} ${turn}` }
}

import type { Look } from '../../backend/src/smokerules.ts'
// Bug 126: what HQ ran on a ticket before it merged, once it has. Nothing on the board showed it, and a TPM told the user "HQ ran the tests before each merge"
// after six merges HQ never tested. The backend saves it on the ticket as it merges (records.ts MergeTest, the same type).
export type Counts = { passed: number; failed: number; skipped: number }
export type MergeTest = { ran: 'pass'; test: string; counts: Counts | null; ms: number; on: string; at: number; look?: Look } | { ran: 'none'; by: 'user' | 'outside'; at: number }
/** The ticket's `merge_test`, or null: merged before HQ kept a record, or not merged. Bad JSON is no record. */
export function mergeTestOf(t: { merge_test?: string | null }): MergeTest | null {
  try { const m = t.merge_test ? JSON.parse(t.merge_test) as MergeTest : null; return m && (m.ran === 'pass' || m.ran === 'none') ? m : null } catch { return null }
}
/** "under 1 s", "8 s", "2 min 5 s" */
export const took = (ms: number): string => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return !s ? 'under 1 s' : m ? `${m} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s` }
/** "412 passed, 6 skipped": skipped and failed only when there are some. */
export const countWords = (c: Counts): string =>
  [`${c.passed} passed`, c.failed ? `${c.failed} failed` : '', c.skipped ? `${c.skipped} skipped` : ''].filter(Boolean).join(', ')
/** A merge's tests in words. `box`: a few words for the merged box's one row. `long`: the whole of it, for its tooltip and the Ticket tab. `passed`: tested and passed.
 *  `none`: null, the ticket merged before HQ kept a record (its box says nothing rather than "no tests", which may be untrue). */
export function mergeTestWords(m: MergeTest | null): { box: string; long: string; passed: boolean } | null {
  if (!m) return null
  if (m.ran === 'none') return { box: 'no HQ test', passed: false,
    long: m.by === 'user'
      ? 'You merged it with Merge, which runs no tests: HQ did not test it as it merged (only auto mode tests before it merges).' : 'It was merged outside HQ, so HQ did not test it as it merged.' }
  return { box: 'tests passed', passed: true, long: `HQ's tests passed on ${m.on} with it merged in, before it merged · ${m.counts ? `${countWords(m.counts)} · ` : ''}${took(m.ms)}` }
}
/** A finished feature folds its tickets away (one "✓ done" box), so it says what HQ ran on them right before they merged (Bug 126: after F-4's six merges, none of them
 *  tested, the board showed only "✓ done · all 6 merged"). `tip`: each ticket's own line. Null when HQ has a record of none of them. */
export function featureTestsLine(ts: { key: string; merge_test?: string | null }[]): { text: string; tip: string; passed: boolean } | null {
  const all = [...ts].sort((x, y) => x.key.localeCompare(y.key, undefined, { numeric: true })).map((t) => ({ key: t.key, m: mergeTestOf(t) }))
  const known = all.filter((x) => x.m), tested = known.filter((x) => x.m!.ran === 'pass').length
  if (!known.length) return null
  const none = all.length - known.length, unknown = none ? ` · ${none} with no record` : ''
  const text = tested === known.length ? `HQ tested ${known.length === 1 ? 'it' : `all ${known.length}`} right before ${known.length === 1 ? 'it' : 'they'} merged${unknown}`
    : tested ? `HQ tested ${tested} of ${known.length} right before they merged${unknown}` : `none tested by HQ as they merged${unknown}`
  const tip = all.map(({ key, m }) => {
    const w = mergeTestWords(m); return `${key}: ${!w ? 'no record (merged before HQ kept one)' : w.passed ? w.long.replace("HQ's tests passed", 'tests passed') : w.long}`
  })
  return { text, tip: tip.join('\n'), passed: tested === all.length }
}
