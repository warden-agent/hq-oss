// Bug 106: HQ's own test runs on screen. While HQ tests a finished ticket on main every agent can be idle or gone, for minutes, and the board used to say the same
// words before, during and after. The backend sends each run under way (testrun.ts TestRunView); this is what the ticket's box and the top bar say about it.
// Pure and self-contained, so the backend's test runner unit-tests it (src/testruns.test.ts).

/** `what`: a ticket merged into main; main alone (as an auto run starts, with no ticket, or after a ticket failed: was main already broken?); a repair's try of a
 *  test command. `state`: in line for its turn (builds and test runs take turns, Bug 76) or running. `since`: when that began. */
export type TestRun = { id: string; repo_id: string; ticket_id: string | null; what: 'ticket' | 'main' | 'command'; state: 'waiting' | 'running'; since: number }

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
  if (r.what === 'ticket') return go ? { box: `HQ is testing it on ${base}`, bar: `HQ is testing ${key ?? 'a ticket'} on ${base}` }
    : { box: `HQ's test ${turn}`, bar: `HQ's test of ${key ?? 'a ticket'} ${turn}` }
  const alone = key ? `${base} without ${key}` : base
  return go ? { box: `its tests failed · HQ is testing ${base} without it`, bar: `HQ is testing ${alone}` }
    : { box: `its tests failed · HQ's test of ${base} without it ${turn}`, bar: `HQ's test of ${alone} ${turn}` }
}
