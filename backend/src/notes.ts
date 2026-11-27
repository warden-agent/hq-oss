// Handoff notes: what an agent leaves for the session that takes over after a fresh start. One per project TPM (Bug 52) and one
// per ticket, replaced each time, capped by code (a longer note is refused, never cut), also written to an md file under ~/.hq.
import fs from 'node:fs'
import path from 'node:path'
import { NOTE_CAP, PATHS } from './config.ts'
import { one, run, now } from './db.ts'
import { git } from './reposync.ts'
import { getFeature, getTicket } from './records.ts'
import type { Agent } from './agents.ts'
import type { GitFacts } from './handover.ts'
import { tpmWorkspace } from './projectmd.ts'

type Who = Pick<Agent, 'role' | 'repo_id' | 'feature_id' | 'ticket_id'>
/** The docs scope of a note: `resume:repo:<id>` for the project's TPM, `resume:ticket:<id>` for an engineer. */
export const noteScope = (a: Who): string | null =>
  a.role === 'tpm' && a.repo_id ? `resume:repo:${a.repo_id}` : a.role === 'engineer' && a.ticket_id ? `resume:ticket:${a.ticket_id}` : null
export function readNote(scope: string): string | null { return one<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'note'", scope)?.text ?? null }
/** Bug 442: the note for the session that takes over from `prev` (the one that ran last), when it was left, and whether it is prev's own: left in
 *  prev's session (by it, or HQ's for it as it ended). If not, an earlier session wrote it, prev took over from it and ended without one (a plain
 *  Stop, a crash), so it says where things stood before prev's work. No `prev`: the note counts as the last session's, as before. */
export function lastNote(scope: string, prev: Pick<Agent, 'started_at'> | undefined): { text: string; at: number; own: boolean } | null {
  const row = one<{ text: string; updated_at: number }>("SELECT text, updated_at FROM docs WHERE scope = ? AND key = 'note'", scope)
  return row ? { text: row.text, at: row.updated_at, own: !prev || row.updated_at >= prev.started_at } : null
}
/** Bug 442: `a` started from the note and HQ stopped it at once, before it could leave one (a switch away while it started, Bug 339): the note is
 *  counted as left in its session, so the session after it gets it (lastNote). */
export function noteStays(a: Who): void { const scope = noteScope(a); if (scope) run("UPDATE docs SET updated_at = ? WHERE scope = ? AND key = 'note'", now(), scope) }
/** How HQ's own note starts when the agent left none (freshstart.ts fallbackNote). Notes saved before Bug 196 carry it too. */
export const HQ_NOTE_HEAD = '(Written by HQ'
/** The note the agent itself wrote, or null. HQ's stand-in from an earlier fresh start or Clear never counts as one (Bug 196). */
export function agentNote(scope: string): string | null { const t = readNote(scope); return t && !t.startsWith(HQ_NOTE_HEAD) ? t : null }

/** Why `text` can't be a note for `role` (empty, or over the cap with both numbers), or null. */
export function noteProblem(role: 'tpm' | 'engineer', text: string): string | null {
  const cap = NOTE_CAP[role]
  if (!text.trim()) return 'The note is empty. Write it and call write_handoff_note again.'
  if (text.length > cap) return `This is ${text.length.toLocaleString('en-US')} characters; the limit is ${cap.toLocaleString('en-US')}. Shorten it and call write_handoff_note again.`
  return null
}
/** Stores the note (replacing the last one) and writes it to HANDOFF.md in the TPM's workspace, or HQ's folder for the ticket. */
export function saveNote(a: Who, text: string): string | null {
  const scope = noteScope(a); if (!scope) return null
  run("INSERT INTO docs(scope, key, text, updated_at) VALUES (?, 'note', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at", scope, text, now())
  const file = noteFile(a); if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`) }
  return file
}
function noteFile(a: Who): string | null {
  if (a.role === 'tpm') return a.repo_id ? path.join(tpmWorkspace(a.repo_id), 'HANDOFF.md') : null
  if (!a.feature_id || !getFeature(a.feature_id)) return null
  const t = a.ticket_id ? getTicket(a.ticket_id) : undefined
  return t ? path.join(PATHS.workspaces, a.feature_id, 'tickets', t.key, 'HANDOFF.md') : null
}

const cut = (s: string, max: number): string => s.length > max ? `${s.slice(0, max)}\n…(${s.length - max} more characters)` : s
/** What git shows about a worktree's branch against `baseRef`: uncommitted changes, its commits, and the files it changed. */
export async function gitFacts(worktree: string, baseRef: string): Promise<GitFacts> {
  const g = (...args: string[]) => git(worktree, args).then((o) => o.replace(/\s+$/, ''), () => '') // keep the first line's leading space (' M file')
  const [status, log, diffStat] = await Promise.all([g('status', '--porcelain'), g('log', '--oneline', `${baseRef}..HEAD`), g('diff', '--stat', `${baseRef}...HEAD`)])
  return { status: cut(status, 1500), log: cut(log, 1200), diffStat: cut(diffStat, 1500) }
}
