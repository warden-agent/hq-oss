// Which Claude Code is which (Bug 97). HQ leans on things Claude Code doesn't promise: what its hooks carry, how a command that hits its time limit moves to
// the background, what its screen and its session file say. Each was checked on one exact version (README, "Moving HQ to a new Claude Code"), and an update
// can change any of them without a word. So HQ runs a copy of its own of exactly that version, and claudecheck.ts says so when what it runs is anything else.
// Nothing of HQ's own state in here (no db.ts, no config.ts): tests and the e2e harness use it as it is.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** The Claude Code version HQ's checks last passed on. Raise it only with the checks rerun on the new version (README). */
export const CHECKED_VERSION = '2.1.322'

/** "2.1.322 (Claude Code)" → "2.1.322". Null: not a version. */
export const parseVersion = (out: string): string | null => /^\s*(\d+\.\d+\.\d+)(?![\d.])/.exec(out)?.[1] ?? null
/** Is version `a` newer than `b`? By its numbers: 2.1.1000 is newer than 2.1.322. */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 }
  return false
}

/** What `bin --version` says, or null when it can't be run or says something else. Never lets it update itself. */
export function readVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => execFile(bin, ['--version'], { timeout: 15_000, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } },
    (err, out) => resolve(err ? null : parseVersion(String(out)))))
}
const seen = new Map<string, { file: string; version: string | null }>()
/** readVersion, asked again only when the file behind `bin` is another one or has changed: an update moves a link, or writes a new file. */
export async function versionOf(bin: string): Promise<string | null> {
  let file: string
  try { const real = fs.realpathSync(bin), s = fs.statSync(real); file = `${real}:${s.size}:${s.mtimeMs}:${s.ino}` } catch { seen.delete(bin); return null }
  const had = seen.get(bin); if (had?.file === file && had.version) return had.version // one that couldn't be read is tried again
  const version = await readVersion(bin); seen.set(bin, { file, version }); return version
}

/** The Claude Code the user runs themselves: `claude` on PATH. HQ_INSTALLED_CLAUDE names another one; empty, there is none to look at. */
export function installedBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HQ_INSTALLED_CLAUDE !== undefined) return env.HQ_INSTALLED_CLAUDE || null
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, 'claude'); try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p } catch { /* not here */ }
  }
  return null
}
/** Where this computer may have Claude Code `version`: its installer keeps each version as a file of that name, and the user's own `claude` may be it. */
export const sources = (version: string, env: NodeJS.ProcessEnv = process.env): string[] =>
  [path.join(os.homedir(), '.local', 'share', 'claude', 'versions', version), installedBin(env)].filter((p): p is string => !!p)

/** HQ's own copy of Claude Code `version` at `bin`, taken from this computer's install when it isn't there yet. A copy, not a link: Claude Code's updater
 *  deletes the versions it has moved on from. Only a file that itself says it is `version` is taken. Returns where it came from ('' when `bin` was there
 *  already), or null when this computer doesn't have that version. */
export async function ownCopy(bin: string, version: string, from: string[] = sources(version)): Promise<string | null> {
  if (fs.existsSync(bin)) return ''
  for (const src of from) {
    if (await readVersion(src) !== version) continue
    const tmp = `${bin}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(bin), { recursive: true })
      fs.copyFileSync(fs.realpathSync(src), tmp, fs.constants.COPYFILE_FICLONE) // on a Mac's disk the copy shares the original's space
      fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, bin); return src
    } catch { fs.rmSync(tmp, { force: true }) }
  }
  return null
}

export type ClaudeInfo = { checked: string; runs: string | null; installed: string | null }
export type Told = { unchecked?: string; newer?: string }
/** What to tell the user, as notices by kind (null: that notice goes), and what has now been told. Each is told once per version: `told` is what was said
 *  before, so a notice ticked away stays away until the version changes again.
 *  - claude_unchecked: the agents run a version HQ wasn't checked on (HQ_CLAUDE_BIN or HQ_CLAUDE_VERSION names another one, or its file was replaced).
 *  - claude_newer: a newer one is installed here, and HQ's agents stay on the checked one. Information: nothing is wrong. */
export function notices(info: ClaudeInfo, told: Told, bin: string): { say: Record<'claude_unchecked' | 'claude_newer', string | null | undefined>; told: Told } {
  const { checked, runs, installed } = info, next: Told = { ...told }
  const say: Record<'claude_unchecked' | 'claude_newer', string | null | undefined> = { claude_unchecked: undefined, claude_newer: undefined } // undefined: leave it as it is
  const off = runs !== checked, how = '(README: "Moving HQ to a new Claude Code")'
  if (off && told.unchecked !== (runs ?? 'unknown')) {
    next.unchecked = runs ?? 'unknown'
    say.claude_unchecked = runs
      ? `HQ's agents now run Claude Code ${runs}, but HQ has only been checked on ${checked}. Plan review, message delivery and the "stuck" and "dialog" alerts `
        + `lean on how Claude Code behaves, so watch for anything odd. Agents already running keep the version they started with. To be safe, go back to ${checked}, `
        + `or have HQ checked on ${runs} ${how}.`
      : `HQ can't tell which Claude Code its agents run: "${bin} --version" gave no version. HQ has only been checked on ${checked}, so agents may not start, `
        + 'or may misbehave.'
  } else if (!off && told.unchecked) { delete next.unchecked; say.claude_unchecked = null }
  const ahead = !off && !!installed && newer(installed, checked)
  if (ahead && told.newer !== installed) {
    next.newer = installed!
    say.claude_newer = `Claude Code ${installed} is installed on this computer. HQ's agents stay on ${checked}, the version HQ was checked on, so nothing changes `
      + `for them. HQ moves up once it has been checked on a newer version ${how}.`
  } else if (!ahead && told.newer) { delete next.newer; say.claude_newer = null }
  return { say, told: next }
}
