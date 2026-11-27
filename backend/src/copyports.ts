// Bug 410: who this HQ gave which port while nothing may listen there yet. A port's owner isn't always listening: an app still installing or slow to start,
// and HQ's own test copy of an app (the look, the UI tester, the first map, the tester, a scenario: smoke.ts prepareApp in a throwaway checkout) between
// the moment HQ settles its ports and the moment its server is up. A port that looks free then was given twice: another project's preview with the same
// fixed port started, and read "running" off the copy's page. So every choice of a port is made here one at a time (the previews' and the copies'),
// and what each was given counts as taken for the others until it ends. In memory: a backend that stops kills its test runs and their copies
// (testrun.ts), and previews keep their own ports in their rows (preview.ts givenElsewhere).
import path from 'node:path'
import fs from 'node:fs'

let choosing: Promise<unknown> = Promise.resolve()
/** Bug 354: one port choice at a time across this HQ (each repo's own preview queue lets two repos' starts overlap): reading what the others were given,
 *  the busy checks and keeping the choice happen in one go, so two choices a moment apart can't both take the same free port. */
export function oneChoice<T>(job: () => Promise<T>): Promise<T> {
  const p = choosing.then(job, job); choosing = p.catch(() => {}); return p
}

/** Bug 354: the ports chosen for a preview's start still on its way (its row not yet saved "starting"), by repo; preview.ts drops them when that start ends. */
export const handing = new Map<string, number[]>()

type Copy = { repoId: string | null; ports: number[] }
const copies = new Map<string, Copy>()
const key = (wt: string): string => path.resolve(wt)
/** Bug 410: HQ's test copy in the throwaway checkout `wt` will run its app on these fixed ports (testports.ts placePorts, after any move). Kept until the
 *  checkout goes (releaseCopy); a second call for the same checkout adds to it. `repoId`: whose app it is, for the words. */
export function claimCopy(wt: string, repoId: string | null, ports: number[]): void {
  if (!ports.length) return
  const had = copies.get(key(wt)), all = [...new Set([...(had?.ports ?? []), ...ports])]
  copies.set(key(wt), { repoId: had?.repoId ?? repoId, ports: all })
}
/** The copy in `wt` is over: its checkout was removed with everything still running in it (testrun.ts dropWorktree), or it never ran (placePorts skipped). */
export function releaseCopy(wt: string): void { copies.delete(key(wt)) }
/** Every port a live test copy of this HQ's was given, with whose app it is (a repo id, or null for a project HQ couldn't name). A claim whose checkout is
 *  gone with no release (a run that ended another way) counts no more. */
export function copyPorts(): Map<number, string | null> {
  const to = new Map<number, string | null>()
  for (const [wt, c] of copies) { if (!fs.existsSync(wt)) { copies.delete(wt); continue } for (const p of c.ports) to.set(p, c.repoId) }
  return to
}
