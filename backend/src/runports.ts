// Ports for HQ's own test runs (Bug 273). An engineer gets a block of 10 ports from this HQ's window (Bug 259, slotports.ts); HQ's own runs of a project's tests
// (a ticket's check before its merge, main's own, a repair's try of a test command) had none, so a test that starts a server on `$PORT || 3000` used 3000 and
// clashed with another HQ's run or the user's own app. Now each run has a block of its own from the same window while it has its turn, and gives it back
// when it ends, however it ends. Kept in memory, like the runs themselves: a backend that stops kills its runs (testrun.ts killTestRuns), so the next one
// starts with every block free; one that died without killing them finds their ports still answering, and skips those blocks.
import { PORTS } from './config.ts'
import { q } from './db.ts'
import { PREVIEW_PORTS, portBusy } from './apprun.ts'
import { freeBase, SLOT_SIZE, slotBases, slotWindow } from './slotports.ts'
import { j } from './util.ts'

/** This HQ's port blocks (Bug 259): from its own window, never a block holding one of HQ's own or preview ports. Worked out on first use, not at import, so a
 *  bad HQ_SLOT_PORTS stops HQ at start-up with its one line (index.ts), not a stack trace. Engineers and HQ's own test runs share them. */
let bases: number[] | null = null
export function slotBasesNow(): number[] {
  if (bases) return bases
  const w = slotWindow(PORTS.ui, process.env.HQ_SLOT_PORTS), got = slotBases(w, [...PREVIEW_PORTS, PORTS.ui, PORTS.hooks, PORTS.mcp])
  if (!got.length) throw new Error(`HQ_SLOT_PORTS ${w[0]}-${w[1]} has no block of ${SLOT_SIZE} ports left for engineers once HQ's own and preview ports are taken out`)
  return (bases = got)
}
/** Engineers' slots taken: by a launch under way (`pending-…`) or an agent that hasn't exited; one still naming an exited or unknown agent is free (its
 *  release was missed). */
export const takenSlots = () => q<{ idx: number; env: string }>(`SELECT s.idx, s.env FROM worker_slots s LEFT JOIN agents a ON a.id = s.agent_id
    WHERE s.agent_id LIKE 'pending-%' OR (a.id IS NOT NULL AND a.status != 'exited')`)
const runBlocks = new Set<number>()
/** The blocks HQ's own test runs hold now. */
export const runBases = (): number[] => [...runBlocks]
/** Every block in use by this HQ: its engineers' and its own test runs'. */
export const heldBases = (): Set<number> => new Set([...takenSlots().map((r) => Number(j<Record<string, string>>(r.env, {}).HQ_PORT_BASE)), ...runBlocks])
/** What a test run's commands are told: PORT (and HQ_PORT_BASE) the first port of its block, as an engineer's are, and a database name no engineer or other
 *  run has. */
export const runEnv = (base: number): Record<string, string> => ({ PORT: String(base), HQ_PORT_BASE: String(base), DB_NAME: `hq_test_${base}` })
/** A block for one of HQ's own test runs: the lowest one no engineer or other run of this HQ holds and nothing on the machine listens on, and what gives it
 *  back (twice does nothing). Null when every block is in use: the run then goes ahead without one, as before Bug 273. */
export async function runPorts(busy: (port: number) => Promise<boolean> = portBusy, all = slotBasesNow()):
  Promise<{ base: number; env: Record<string, string>; done: () => void } | null> {
  return freeBase(all, heldBases, busy, (base) => {
    runBlocks.add(base); let over = false
    return { base, env: runEnv(base), done: () => { if (!over) { over = true; runBlocks.delete(base) } } }
  })
}
