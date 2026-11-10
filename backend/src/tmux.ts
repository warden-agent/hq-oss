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
export async function capturePane(name: string, lines = 60): Promise<string> { return tmux('capture-pane', '-p', '-t', name, '-S', `-${lines}`).catch(() => '') }
/** Only what's on the screen now, no scrollback: a menu that scrolled away isn't open any more. */
export async function visiblePane(name: string): Promise<string> { return tmux('capture-pane', '-p', '-t', name).catch(() => '') }
export async function paneHash(name: string): Promise<string> { return createHash('sha1').update(await capturePane(name, 80)).digest('hex') }
export async function clientPids(name: string): Promise<number[]> { const out = await tmux('list-clients', '-t', name, '-F', '#{client_pid}').catch(() => ''); return out.split('\n').map(Number).filter((n) => n > 0) }
export async function sendKeys(name: string, text: string, enter = true): Promise<void> {
  await tmux('send-keys', '-t', name, '-l', text)
  if (enter) await tmux('send-keys', '-t', name, 'Enter')
}
export async function sendEscape(name: string): Promise<void> { await tmux('send-keys', '-t', name, 'Escape') }
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
