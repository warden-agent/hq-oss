// Bug 97: HQ knows which Claude Code its agents run, and says so when it isn't the version HQ was checked on (claudeversion.ts has the rules).
// At start HQ makes sure its own copy is there. Then it looks again whenever an agent launches and every few minutes (a look is two file stats;
// `--version` is only asked of a file that changed), so an update can't go by unnoticed: not of the binary agents run, and not of the user's own Claude Code.
import fs from 'node:fs'
import { CLAUDE_BIN, CLAUDE_BIN_GIVEN, PINNED_VERSION } from './config.ts'
import { getSetting, setSetting } from './db.ts'
import { bus, emit } from './events.ts'
import { attention, resolveKind } from './attention.ts'
import { CHECKED_VERSION, installedBin, notices, ownCopy, sources, versionOf, type ClaudeInfo, type Told } from './claudeversion.ts'

let info: ClaudeInfo = { checked: CHECKED_VERSION, runs: null, installed: null }
/** What the last look found: the version HQ was checked on, the one its agents run, and the one the user has installed (null: unknown, or none). */
export const claudeInfo = (): ClaudeInfo => info

/** At start: HQ's own copy of Claude Code is there, taken from this computer's install if need be. Throws, with what to do, when it can't be. */
export async function ensureClaude(): Promise<void> {
  if (CLAUDE_BIN_GIVEN) { if (fs.existsSync(CLAUDE_BIN)) return; throw new Error(`HQ_CLAUDE_BIN names a Claude Code binary that isn't there: ${CLAUDE_BIN}`) }
  const from = await ownCopy(CLAUDE_BIN, PINNED_VERSION)
  if (from) emit({ agentId: null, source: 'system', kind: 'claude.copied', payload: { version: PINNED_VERSION, from, to: CLAUDE_BIN } })
  if (from !== null) return
  throw new Error(`HQ runs its own copy of Claude Code ${PINNED_VERSION}, and this computer doesn't have that version (looked in ${sources(PINNED_VERSION).join(' and ') || 'no place'}).\n`
    + `Put that version's binary at ${CLAUDE_BIN}, or start HQ with HQ_CLAUDE_BIN=<path to a claude binary> to run another version: HQ then says it hasn't been checked on it.`)
}

let looking: Promise<ClaudeInfo> | null = null
/** Looks at both versions and tells the user what changed. One look at a time: a launch and the timer may ask together. */
export function checkClaude(): Promise<ClaudeInfo> {
  return looking ??= look().finally(() => { looking = null })
}
let looked = false
const missed = { runs: 0, installed: 0 }
/** A version that couldn't be read just now (a busy machine, a file being replaced) stays what it was, until a second look in a row can't read it either:
 *  one bad read must not raise a notice, or bring back one the user ticked away. */
function steady(which: 'runs' | 'installed', now: string | null): string | null {
  if (now !== null || info[which] === null || ++missed[which] >= 2) { missed[which] = 0; return now }
  return info[which]
}
async function look(): Promise<ClaudeInfo> {
  const user = installedBin()
  const next: ClaudeInfo = { checked: CHECKED_VERSION, runs: steady('runs', await versionOf(CLAUDE_BIN)), installed: user ? steady('installed', await versionOf(user)) : null }
  const before = getSetting<Told>('claude_told', {}), { say, told } = notices(next, before, CLAUDE_BIN)
  for (const [kind, text] of Object.entries(say)) { if (text === null) resolveKind(kind, null); else if (text) attention(kind, text) }
  if (JSON.stringify(told) !== JSON.stringify(before)) setSetting('claude_told', told)
  const changed = next.runs !== info.runs || next.installed !== info.installed
  info = next
  if (changed || !looked) emit({ agentId: null, source: 'system', kind: 'claude.version', payload: { ...next } })
  if (changed && looked) bus.emit('resnapshot') // open pages show which version runs
  looked = true
  return info
}
export function startClaudeCheck(): NodeJS.Timeout {
  const every = (Number(process.env.HQ_CLAUDE_CHECK_S) || 300) * 1000
  return setInterval(() => { checkClaude().catch((e) => emit({ agentId: null, source: 'system', kind: 'claude.check_error', payload: { error: String(e) } })) }, every).unref()
}
