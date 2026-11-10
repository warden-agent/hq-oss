// What Claude Code says about its own session (Bug 62): it keeps ~/.claude/sessions/<pid>.json with `status` (busy, idle, or waiting while a dialog is open) and when that last
// changed. HQ hears when a dialog opens (the Notification hook) but nothing when it closes, and a denied or Escaped dialog fires no hook at all, so this file is how HQ tells a
// dialog is really gone. It's Claude Code's file, not an API: rerun hq-notes/test-tools/dialogspike.mjs at every version bump (spike S1 checked 2.1.300).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Agent } from './agents.ts'
import { paneShowsDialog } from './screen.ts'
import * as tmux from './tmux.ts'

export type Presence = { status: string; waitingFor?: string; statusUpdatedAt: number }
/** The session's status file, found by its session id, or null when there isn't a readable one. */
export function presenceOf(sessionId: string | null, dir = path.join(os.homedir(), '.claude', 'sessions')): Presence | null {
  if (!sessionId) return null
  let files: string[] = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return null }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>
      if (j.sessionId === sessionId) return typeof j.status === 'string' && typeof j.statusUpdatedAt === 'number' ? j as unknown as Presence : null
    } catch { /* being written: the next look reads it */ }
  }
  return null
}
/** Positive evidence that the agent's dialog is gone: its status file says it isn't waiting, it changed after the alert was raised (`since`), and no menu is on its screen.
 *  Anything unknown, a file that's missing, unreadable or older than the alert, says no: doubt never clears an alert, because auto mode stops on it. */
export async function dialogGone(a: Pick<Agent, 'claude_session_id' | 'tmux_session'>, since: number): Promise<boolean> {
  const p = presenceOf(a.claude_session_id)
  if (!p || p.status === 'waiting' || p.statusUpdatedAt < since) return false
  return !paneShowsDialog(await tmux.visiblePane(a.tmux_session)) // a menu on screen outranks the file
}
