// Thin tmux wrapper. One tmux session per agent, named hq-<agentId>.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

export function tmux(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
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
/** Types one line into the session's prompt and sends it with Enter. In small pieces: Claude Code takes more than 800 characters that arrive at once
 *  for a paste (the box shows "[Pasted text #1]" and the prompt is wrapped as pasted content), and three pieces read together still stay under that.
 *  `--`: a piece may start with a dash. Checked on 2.1.322 with 8,000 characters. */
export async function typeLine(name: string, text: string): Promise<void> {
  for (const p of pieces(text, 250)) await tmux('send-keys', '-t', name, '-l', '--', p)
  await tmux('send-keys', '-t', name, 'Enter')
}
export async function setHook(name: string, hook: string, shell: string): Promise<void> { await tmux('set-hook', '-t', name, hook, `run-shell ${JSON.stringify(shell)}`).catch(() => {}) }
export async function paneDead(name: string): Promise<boolean> { const out = await tmux('display-message', '-p', '-t', name, '#{pane_dead}').catch(() => '1'); return out.trim() === '1' }
/** Exit code of a dead pane's command (null while it runs or when the session is gone). One a signal ended has no code of its own: 128 plus the signal,
 *  as a shell gives it. Read as "still running", a killed app looked fine for good (Bug 77). */
const SIGNALS: Record<string, number> = { hup: 1, int: 2, quit: 3, abrt: 6, kill: 9, segv: 11, term: 15 }
export async function paneDeadStatus(name: string): Promise<number | null> {
  const out = (await tmux('display-message', '-p', '-t', name, '#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}').catch(() => '')).trim()
  const m = /^1:(\d*):(.*)$/.exec(out); if (!m) return null
  return m[1] ? Number(m[1]) : 128 + (SIGNALS[m[2]!.toLowerCase().replace(/^sig/, '')] ?? 0)
}
/** Pid of the pane's command; it leads the process group its children run in. */
export async function panePid(name: string): Promise<number | null> { const n = Number((await tmux('display-message', '-p', '-t', name, '#{pane_pid}').catch(() => '')).trim()); return n > 0 ? n : null }
