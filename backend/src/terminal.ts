// Terminal bridge: a node-pty client attached to an agent's (or the live preview's) tmux session, streamed over WebSocket.
import pty, { type IPty } from 'node-pty'
import { getSetting } from './db.ts'
import { DEFAULTS } from './config.ts'
import { getAgent, update } from './agents.ts'
import { emit } from './events.ts'
import { paneDeadStatus, paneOutput, socket } from './tmux.ts'

export type Term = { write: (data: string, typed: boolean) => void; resize: (cols: number, rows: number) => void; kill: () => void }
// tmux client pids of HQ's own terminal views. Their attach isn't a take-over; only someone in a real terminal is.
const bridgePids = new Set<number>()
export const isBridgePid = (pid: number): boolean => bridgePids.has(pid)
/** Bug 342: the env of a view's tmux client, without `$TMUX`/`$TMUX_PANE` (set when HQ runs inside tmux, as the live HQ does). With
 *  them, tmux refuses the attach ("sessions should be nested with care") whenever the client's new tty has the name of a pane on
 *  that server, and a pane that ended (a crashed app, an exited agent) keeps the name of a tty the system hands out again. `-S`
 *  already names the server, so the client needs neither. */
export function attachEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = env
  return { ...rest, TERM: 'xterm-256color' } as Record<string, string>
}
/** A tmux client for one session, streamed to the UI. `readOnly` (`attach -r`): tmux ignores its keys but still answers the
 *  terminal's own queries. */
function attach(session: string, cols: number, rows: number, onData: (d: string) => void, onExit: () => void, readOnly = false): IPty {
  const p = pty.spawn('tmux', ['-S', socket(), 'attach-session', ...(readOnly ? ['-r'] : []), '-t', session],
    { name: 'xterm-256color', cols: Math.max(20, cols), rows: Math.max(5, rows), cwd: process.env.HOME, env: attachEnv() })
  bridgePids.add(p.pid)
  p.onData(onData); p.onExit(() => { bridgePids.delete(p.pid); onExit() })
  return p
}
const term = (p: IPty, write: Term['write']): Term => ({ write, resize: (c, r) => { try { p.resize(Math.max(20, c), Math.max(5, r)) } catch {} }, kill: () => { try { p.kill() } catch {} } })
/** The live preview's server output (read-only: Restart and Stop are buttons, not keystrokes). Bug 302: an app that has ended is shown
 *  as its pane's text, not attached to. tmux keeps its cursor on the "Pane is dead" line at the bottom, and a client's attach shrinks
 *  the window: what was above the new top went to the pane's history, which a client never draws, and the tab showed only that line. */
export function openPreviewTerminal(session: string, cols: number, rows: number, onData: (d: string) => void, onExit: () => void): Term {
  let p: IPty | null = null, closed = false
  void (async () => {
    if ((await paneDeadStatus(session)) !== null) {
      const text = await paneOutput(session, DEAD_LINES, true)
      if (!closed) onData(`${text.split('\n').join('\r\n')}\x1b[0m\r\n`)
      return
    }
    if (!closed) p = attach(session, cols, rows, onData, onExit, true)
  })().catch((e) => { if (!closed) onData(`\r\n\x1b[31mHQ couldn't open this terminal: ${(e as Error).message}\x1b[0m\r\n`) })
  return { write: (data) => p?.write(data), resize: (c, r) => { cols = c; rows = r; try { p?.resize(Math.max(20, c), Math.max(5, r)) } catch {} },
    kill: () => { closed = true; try { p?.kill() } catch {} } }
}
/** As far back as tmux keeps (its history-limit's default). */
const DEAD_LINES = 2000
export function openTerminal(agentId: string, cols: number, rows: number, onData: (d: string) => void, onExit: () => void): Term | null {
  const a = getAgent(agentId); if (!a) return null
  const p = attach(a.tmux_session, cols, rows, onData, onExit)
  const lockMs = () => getSetting('takeover_lock_s', DEFAULTS.takeover_lock_s) * 1000
  let lastLock = 0
  // Only real keystrokes/paste hold delivery; terminal auto-replies (tmux queries, focus, mouse) pass through without a hold.
  return term(p, (data, typed) => { p.write(data); if (!typed) return; const t = Date.now(); if (t - lastLock > 5000) { lastLock = t; update(agentId, { takeover_locked_until: t + lockMs() }); emit({ agentId, source: 'ui', kind: 'takeover.input', payload: {} }) } })
}
