// Thin tmux wrapper. One tmux session per agent, named hq-<agentId>.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Bug 242: the tmux server HQ's sessions live on, named with `-S` in every call. A bare `tmux` takes `$TMUX` first, then `$TMUX_TMPDIR`, and
 *  when that folder is gone it falls back to /tmp: the user's own default server (Bug 74). This is the same choice without that fallback.
 *  Inside tmux (live HQ runs in hq-backend): the server it runs on, the one a bare call reached before, so a restart still finds its sessions. */
export function socketPath(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): string {
  const inside = (env.TMUX ?? '').split(',')[0]
  return inside || path.join(env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, 'default')
}
let chosen: string | null = null
/** The socket this backend uses, chosen once: its server never changes while it runs. */
export const socket = (): string => (chosen ??= socketPath())
/** At start-up: the socket's folder, as tmux would make it (only its own default path gets one). A `TMUX_TMPDIR` that doesn't exist stops HQ
 *  here: a bare tmux would have gone to the default server instead, and HQ never runs half-started. */
export function prepareSocket(sock = socket()): string {
  const dir = path.dirname(sock)
  if (fs.existsSync(dir)) return sock
  if (!fs.existsSync(path.dirname(dir))) throw new Error(`HQ can't start: its tmux folder ${path.dirname(dir)} (TMUX_TMPDIR) doesn't exist. Create it or unset TMUX_TMPDIR.`)
  fs.mkdirSync(dir, { mode: 0o700 }); return sock
}

export function tmux(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-S', socket(), ...args], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`tmux ${args[0]}: ${stderr || err.message}`)); else resolve(stdout)
    })
  })
}
export async function hasSession(name: string): Promise<boolean> { try { await tmux('has-session', '-t', name); return true } catch { return false } }
export async function newSession(name: string, command: string, opts: { cwd: string; cols?: number; rows?: number }): Promise<void> {
  // remain-on-exit in the same call: set a moment later, a command that dies at once takes its output with it
  await tmux('new-session', '-d', '-s', name, '-x', String(opts.cols ?? 220), '-y', String(opts.rows ?? 50), '-c', opts.cwd, command, ';', 'set-option', '-t', name, 'remain-on-exit', 'on')
  await tmux('set-option', '-t', name, 'window-size', 'latest').catch(() => {})
}
export async function killSession(name: string): Promise<void> { await tmux('kill-session', '-t', name).catch(() => {}) }
/** `styled`: with its styles (`-e`), as visiblePaneStyled below. */
export async function capturePane(name: string, lines = 60, styled = false): Promise<string> {
  return tmux('capture-pane', ...(styled ? ['-e'] : []), '-p', '-t', name, '-S', `-${lines}`).catch(() => '')
}
/** Bug 302: tmux writes a dead pane's "Pane is dead (status N, …)" on its bottom row, so an app that printed a few lines and ended has
 *  a screenful of blank lines between its output and that line (and "the last 40 lines" were all blank). The pane's text, `lines`
 *  back, with those blank lines gone: the output, then tmux's line right under it. A live pane's text just loses its blank end. */
export async function paneOutput(name: string, lines: number, styled = false): Promise<string> { return closeUpDead(await capturePane(name, lines, styled)) }
const blank = (row: string): boolean => !row.replace(/\x1b\[[0-9;:]*m/g, '').trim() // styles alone (`-e`) print nothing
export function closeUpDead(text: string): string {
  const rows = text.trimEnd().split('\n'); while (rows.length > 1 && blank(rows.at(-1)!)) rows.pop()
  const last = rows.at(-1)!; if (!/^Pane is dead\b/.test(last.replace(/\x1b\[[0-9;:]*m/g, ''))) return rows.join('\n')
  let end = rows.length - 1; while (end > 0 && blank(rows[end - 1]!)) end--
  return [...rows.slice(0, end), last].join('\n')
}
/** Only what's on the screen now, no scrollback: a menu that scrolled away isn't open any more. */
export async function visiblePane(name: string): Promise<string> { return tmux('capture-pane', '-p', '-t', name).catch(() => '') }
/** The same with its styles (`-e`): only they tell a line somebody typed from Claude Code's grey suggestion (Bug 149, screen.ts paneHasDraft). */
export async function visiblePaneStyled(name: string): Promise<string> { return tmux('capture-pane', '-e', '-p', '-t', name).catch(() => '') }
export async function paneHash(name: string): Promise<string> { return createHash('sha1').update(await capturePane(name, 80)).digest('hex') }
export async function clientPids(name: string): Promise<number[]> { const out = await tmux('list-clients', '-t', name, '-F', '#{client_pid}').catch(() => ''); return out.split('\n').map(Number).filter((n) => n > 0) }
export async function sendKeys(name: string, text: string, enter = true): Promise<void> {
  await tmux('send-keys', '-t', name, '-l', text)
  if (enter) await tmux('send-keys', '-t', name, 'Enter')
}
export async function sendEscape(name: string): Promise<void> { await tmux('send-keys', '-t', name, 'Escape') }
/** `text` in pieces of at most `max` characters, never cut between the two halves of one character (an emoji). */
export function pieces(text: string, max: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + max, text.length); const c = text.charCodeAt(end - 1)
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end += end - 1 > i ? -1 : 1 // the first half of a character: the two stay together
    out.push(text.slice(i, end)); i = end
  }
  return out
}
/** How many characters typeLine sends in one go. Each piece goes in whole (one send-keys), so a line cut short shows whole pieces (Bug 331). */
export const PIECE = 250
/** Types one line into the session's prompt and sends it with Enter. In small pieces: Claude Code takes more than 800 characters that arrive at once
 *  for a paste (the box shows "[Pasted text #1]" and the prompt is wrapped as pasted content), and three pieces read together still stay under that.
 *  `--`: a piece may start with a dash. Checked on 2.1.322 with 8,000 characters. */
export async function typeLine(name: string, text: string): Promise<void> {
  for (const p of pieces(text, PIECE)) await tmux('send-keys', '-t', name, '-l', '--', p)
  await tmux('send-keys', '-t', name, 'Enter')
}
export async function setHook(name: string, hook: string, shell: string): Promise<void> { await tmux('set-hook', '-t', name, hook, `run-shell ${JSON.stringify(shell)}`).catch(() => {}) }
export async function paneDead(name: string): Promise<boolean> { const out = await tmux('display-message', '-p', '-t', name, '#{pane_dead}').catch(() => '1'); return out.trim() === '1' }
/** Exit code of a dead pane's command (null while it runs or when the session is gone). One a signal ended has no code of its own: 128 plus the signal,
 *  as a shell gives it. Read as "still running", a killed app looked fine for good (Bug 77). */
const SIGNALS: Record<string, number> = { hup: 1, int: 2, quit: 3, abrt: 6, kill: 9, segv: 11, term: 15 }
/** The code in tmux's `#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}`. tmux 3.8 names the signal ("1::kill"); tmux 3.6, which Ubuntu ships,
 *  gives its number ("1::9"). Only names were known, so there a killed app read as 128 plus nothing: "stopped with code 128", not 137 (Bug 320). */
export function deadPaneCode(line: string): number | null {
  const m = /^1:(\d*):(.*)$/.exec(line.trim()); if (!m) return null
  if (m[1]) return Number(m[1])
  const signal = m[2]!.toLowerCase().replace(/^sig/, '')
  return 128 + (SIGNALS[signal] ?? (/^\d+$/.test(signal) ? Number(signal) : 0))
}
export async function paneDeadStatus(name: string): Promise<number | null> {
  return deadPaneCode(await tmux('display-message', '-p', '-t', name, '#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}').catch(() => ''))
}
/** Pid of the pane's command; it leads the process group its children run in. */
export async function panePid(name: string): Promise<number | null> { const n = Number((await tmux('display-message', '-p', '-t', name, '#{pane_pid}').catch(() => '')).trim()); return n > 0 ? n : null }
