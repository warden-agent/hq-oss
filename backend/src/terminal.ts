// Terminal bridge: a node-pty client attached to an agent's (or the live preview's) tmux session, streamed over WebSocket.
import pty, { type IPty } from 'node-pty'
import { getSetting } from './db.ts'
import { DEFAULTS } from './config.ts'
import { getAgent, update } from './agents.ts'
import { emit } from './events.ts'

export type Term = { write: (data: string, typed: boolean) => void; resize: (cols: number, rows: number) => void; kill: () => void }
// tmux client pids of HQ's own terminal views. Their attach isn't a take-over; only someone in a real terminal is.
const bridgePids = new Set<number>()
export const isBridgePid = (pid: number): boolean => bridgePids.has(pid)
/** A tmux client for one session, streamed to the UI. `readOnly` (`attach -r`): tmux ignores its keys but still answers the
 *  terminal's own queries. */
function attach(session: string, cols: number, rows: number, onData: (d: string) => void, onExit: () => void, readOnly = false): IPty {
  const p = pty.spawn('tmux', ['attach-session', ...(readOnly ? ['-r'] : []), '-t', session], { name: 'xterm-256color', cols: Math.max(20, cols), rows: Math.max(5, rows), cwd: process.env.HOME, env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string> })
  bridgePids.add(p.pid)
  p.onData(onData); p.onExit(() => { bridgePids.delete(p.pid); onExit() })
  return p
}
const term = (p: IPty, write: Term['write']): Term => ({ write, resize: (c, r) => { try { p.resize(Math.max(20, c), Math.max(5, r)) } catch {} }, kill: () => { try { p.kill() } catch {} } })
/** The live preview's server output (read-only: Restart and Stop are buttons, not keystrokes). */
export function openPreviewTerminal(session: string, cols: number, rows: number, onData: (d: string) => void, onExit: () => void): Term {
  const p = attach(session, cols, rows, onData, onExit, true)
  return term(p, (data) => p.write(data))
}
export function openTerminal(agentId: string, cols: number, rows: number, onData: (d: string) => void, onExit: () => void): Term | null {
  const a = getAgent(agentId); if (!a) return null
  const p = attach(a.tmux_session, cols, rows, onData, onExit)
  const lockMs = () => getSetting('takeover_lock_s', DEFAULTS.takeover_lock_s) * 1000
  let lastLock = 0
  // Only real keystrokes/paste hold delivery; terminal auto-replies (tmux queries, focus, mouse) pass through without a hold.
  return term(p, (data, typed) => { p.write(data); if (!typed) return; const t = Date.now(); if (t - lastLock > 5000) { lastLock = t; update(agentId, { takeover_locked_until: t + lockMs() }); emit({ agentId, source: 'ui', kind: 'takeover.input', payload: {} }) } })
}
