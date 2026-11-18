// Engineers' ports (Bug 259). Each running engineer gets a block of 10 ports for its own servers (PORT is the first). They used to be
// 3100+10n on every HQ, so two HQs on one machine (the live one and a test HQ, or two users') both gave their first engineer 3110 and
// their test servers clashed. Now each HQ hands out blocks from a window of its own. No DB access here.

/** Ports in one engineer's block. */
export const SLOT_SIZE = 10
/** Where windows are: 97 windows of 200 ports, 10000–29399, below every OS's own range for ports it hands out (Linux 32768, macOS 49152). */
const POOL_FROM = 10000, WINDOW = 200, WINDOWS = 97

/** This HQ's window, [first, last]: HQ_SLOT_PORTS ("20000-20199") when given, else picked by HQ's UI port, which no other HQ running on
 *  this machine can have. Two UI ports get windows that don't overlap unless they differ by a multiple of 97 (4780 and 4890, 6380 or
 *  any port within 96 of it never share). Stable: the same UI port always gives the same window, across restarts. */
export function slotWindow(uiPort: number, spec?: string): [number, number] {
  if (spec === undefined || spec === '') { const lo = POOL_FROM + (uiPort % WINDOWS) * WINDOW; return [lo, lo + WINDOW - 1] }
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(spec), lo = Number(m?.[1]), hi = Number(m?.[2])
  if (!m || lo < 1024 || hi > 65535 || hi - lo + 1 < SLOT_SIZE || hi - lo >= 1000) {
    throw new Error(`HQ_SLOT_PORTS must look like 20000-20199 (10 to 1000 ports above 1023), not "${spec}"`)
  }
  return [lo, hi]
}

/** The first port of each block of 10 in the window, lowest first, leaving out a block that holds one of `avoid` (HQ's preview ports, its
 *  own UI, hooks and MCP ports). */
export function slotBases(w: [number, number], avoid: number[] = []): number[] {
  const out: number[] = []
  for (let b = w[0]; b + SLOT_SIZE - 1 <= w[1]; b += SLOT_SIZE) if (!avoid.some((p) => p >= b && p < b + SLOT_SIZE)) out.push(b)
  return out
}

/** The block for a new engineer: the lowest base `held` doesn't name (this HQ's engineers that are still running) whose ten ports nothing
 *  listens on now (an engineer of another HQ whose window overlaps, or any other program). `held` is asked again after the wait, since
 *  another launch may have taken that block meanwhile, and `take` claims it in the same step, before anything else can run. Null when
 *  every block is in use. */
export async function freeBase<T>(bases: number[], held: () => Set<number>, busy: (port: number) => Promise<boolean>, take: (base: number) => T):
  Promise<T | null> {
  for (const b of bases) {
    if (held().has(b)) continue
    const ports = Array.from({ length: SLOT_SIZE }, (_, i) => b + i)
    if ((await Promise.all(ports.map(busy))).some(Boolean)) continue
    if (!held().has(b)) return take(b)
  }
  return null
}

/** What an engineer is told about its ports and database name, in its launch prompt. */
export const portsNote = (env: Record<string, string>): string => {
  const b = Number(env.HQ_PORT_BASE)
  return `Your ports for this ticket: ${b}–${b + SLOT_SIZE - 1} ($PORT and $HQ_PORT_BASE are set to ${b}); your database name is $DB_NAME `
    + `(${env.DB_NAME}). Run any server you start (a dev server, a test server) on these ports, never on one you pick yourself: `
    + 'other engineers, and other HQs on this machine, have ports of their own.'
}
