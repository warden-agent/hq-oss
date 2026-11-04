// Fresh start: an agent stops, leaves a handoff note, and its session ends; a new session takes over from the note, at once or
// when the user presses Resume. Asked by a click (interrupts at once), at the context limit (after the current step), for every
// agent of a repo the user switches away from (parked until they come back), or when the user clears the repo (clear.ts: an
// engineer's note goes to the archive and nobody takes over; the project's TPM comes back after the clear, Bug 52).
import { CHOICES, DEFAULTS, ENGINEER_LIMIT, NOTE_CAP } from './config.ts'
import { getSetting, now, one, q, run } from './db.ts'
import { emit, patch } from './events.ts'
import { attention, resolveKind } from './attention.ts'
import { getAgent, liveAgents, stopAgent, update, type Agent } from './agents.ts'
import { interruptAndType, sendMessage } from './delivery.ts'
import { autoOn, features, getRepo, getTicket, repoOfAgent, setTicket, tickets } from './records.ts'
import { noteScope, readNote, saveNote } from './notes.ts'
import { resumeEngineer } from './tickets.ts'
import { restartTpm } from './tpm.ts'
import { maybeFinishClear } from './clear.ts'

export type Then = 'continue' | 'park' | 'clear'
const RESUMABLE = ['planning', 'implementing', 'awaiting_answer', 'resolving']
const TIMEOUT_MS = Number(process.env.HQ_FRESH_START_TIMEOUT_S ?? 180) * 1000 // after the request reached the agent
const NEVER_MS = Number(process.env.HQ_FRESH_START_NEVER_S ?? 900) * 1000 // the request never reached it
const name = (a: Agent): string => a.display_name ?? a.id
const k = (n: number): string => `${Math.round(n / 1000)}k`

/** The context size at which HQ warns about an agent: the TPM's is the user's pick, an engineer's follows from it. */
export function limitFor(role: string): number | null {
  const tpm = Number(getSetting('context_limit', DEFAULTS.context_limit))
  const pick = CHOICES.context_limit!.includes(tpm) ? tpm : DEFAULTS.context_limit
  return role === 'tpm' ? pick : role === 'engineer' ? ENGINEER_LIMIT[pick]! : null
}
/** Why `a` can't have a fresh start now, or null. */
export function freshStartBlocker(a: Agent): string | null {
  if (a.role !== 'tpm' && a.role !== 'engineer') return 'Only TPMs and engineers have fresh starts (an architect is new for every review).'
  if (a.status === 'exited') return `${name(a)} isn't running.`
  if (a.fresh_start_at) return `${name(a)} is already writing its handoff note.`
  // HQ types the request after Escape: on a dialog or menu, Enter would pick whatever option is highlighted.
  if (a.status === 'blocked' || a.status === 'paused') return `${name(a)} is waiting on a dialog in its terminal. Answer it first.`
  if (a.role === 'tpm') return null
  const t = a.ticket_id ? getTicket(a.ticket_id) : undefined
  if (!t) return `${name(a)} has no ticket.`
  if (t.status === 'plan_review') return `${t.key}'s plan is waiting for your review. Answer it first.`
  if (!RESUMABLE.includes(t.status)) return `${t.key} is ${t.status}; there's nothing to hand over.`
  return null
}

function requestText(a: Agent, interrupted: boolean, then: Then): string {
  const cap = NOTE_CAP[a.role as 'tpm' | 'engineer'].toLocaleString('en-US')
  const head = 'Fresh start: this session is ending so that a new one can take over with a clean context. Stop what you are doing now. '
    + "Don't finish the step, run more commands, edit files or commit. "
    + `Call write_handoff_note once with a note of at most ${cap} characters for the ${a.role === 'tpm' ? 'TPM' : 'engineer'} who takes over, under these headings:\n`
  const body = a.role === 'tpm' && then === 'clear'
    ? ['## What the user wants from this project (in their words)', '## Decisions so far', '## Watch out (things the next TPM would get wrong)',
      "Don't list tickets or what's in flight: the user is clearing the board. HQ gives the next TPM what has been built."].join('\n')
    : a.role === 'tpm'
    ? ['## What the user wants (in their words)', '## Decisions so far', '## In flight', '## Next', '## Watch out (things the next TPM would get wrong)',
      "Don't list tickets or their statuses: HQ gives the next TPM those."].join('\n')
    : ['## Where I stopped (what you were in the middle of; any half-edited file; are the tests passing or failing)', '## Done', '## Left to do',
      '## Watch out (quirks of this code, approaches that failed, design intent)', "Don't list changed files: HQ gives the next engineer the git status."].join('\n')
  const why = interrupted ? 'HQ interrupted your last step for this; nobody rejected it, so don\'t note it as rejected.\n' : ''
  const cleared = then !== 'clear' ? '' : a.role === 'tpm' ? 'The user is clearing this project\'s board from HQ: every ticket goes. A new TPM session '
    + 'starts after the clear with your note and what has been built, so it keeps the project\'s memory but not the old tickets.\n'
    : 'The user is clearing this project from HQ: no new session takes over now. Your note is archived for whoever picks the work up later, so make it stand on its own.\n'
  return `${why}${cleared}${head}${body}\nShort bullets. After it is saved, do nothing else: HQ ends this session.`
}

/** Asks `agentId` for its handoff note. `now` interrupts what it is doing; `after_turn` waits for the current step to end.
 *  `then`: a new session takes over as soon as the note is in (continue), or the work waits for Resume (park). */
export async function freshStart(agentId: string, o: { how: 'now' | 'after_turn'; then: Then }): Promise<void> {
  const a = getAgent(agentId); if (!a) throw new Error('unknown agent')
  const why = freshStartBlocker(a); if (why) throw new Error(why)
  update(a.id, { fresh_start_at: now(), fresh_start_then: o.then }) // first, so only this request is delivered to it from now on
  const m = sendMessage({ repoId: a.repo_id, featureId: a.feature_id, channel: 'dm', from: 'hq', to: a.id, reason: 'fresh_start', body: requestText(a, o.how === 'now', o.then) })
  update(a.id, { fresh_start_msg: m.id })
  if (o.how === 'now') { update(a.id, { takeover_locked_until: 0 }); await interruptAndType(a, m) } // after_turn: the mod delivers it
  emit({ agentId: a.id, source: 'system', kind: 'fresh_start.requested', payload: { how: o.how, then: o.then } })
}

const finishing = new Set<string>()
/** The note is in (or HQ wrote one): the session ends, and a new one takes over or the work is parked. */
export async function completeFreshStart(agentId: string, by: 'note' | 'fallback', why = ''): Promise<void> {
  const a = getAgent(agentId); if (!a?.fresh_start_at || finishing.has(agentId)) return
  finishing.add(agentId)
  const then: Then = a.fresh_start_then === 'park' || a.fresh_start_then === 'clear' ? a.fresh_start_then : 'continue'
  try {
    if (by === 'fallback') saveNote(a, fallbackNote(a, why))
    if (a.status !== 'exited') await stopAgent(a.id, 'fresh_start')
    update(a.id, { fresh_start_at: null, fresh_start_then: null, fresh_start_msg: null })
    for (const kind of ['context_high', 'stuck', 'agent_exited', 'engineer_exited']) resolveKind(kind, a.id)
    emit({ agentId: a.id, source: 'system', kind: 'fresh_start.done', payload: { by, then, why } })
    if (then === 'clear') { const repoId = repoOfAgent(a); if (repoId) void maybeFinishClear(repoId).catch(() => {}); return }
    if (then === 'park') return park(a)
    try { if (a.role === 'tpm') await restartTpm(a.repo_id!, { why: 'fresh_start' }); else await resumeEngineer(a.ticket_id!, { replace: true }) } catch (e) {
      park(a)
      attention('fresh_start_failed', `${name(a)} saved its note, but the new session didn't start: ${(e as Error).message} Press Resume to try again.`,
        { agentId: a.id, ticketId: a.ticket_id })
    }
  } finally { finishing.delete(agentId) }
}
function park(a: Agent): void {
  if (a.role === 'engineer' && a.ticket_id) setTicket(a.ticket_id, { parked_at: now() })
  else if (a.role === 'tpm' && a.repo_id) { const t = now(); run('UPDATE repos SET tpm_parked_at = ? WHERE id = ?', t, a.repo_id); patch('repo', a.repo_id, { tpm_parked_at: t }) }
}
/** The note HQ writes when the agent couldn't: where things stood, from HQ's records. Git facts reach the next engineer anyway. */
export function fallbackNote(a: Agent, why: string): string {
  const head = `(Written by HQ: the ${a.role === 'tpm' ? 'TPM' : 'engineer'} didn't leave a note${why ? `: ${why}` : ''}.)`
  if (a.role === 'tpm') return `${head}\nRely on PROJECT.md, the ticket list and the recent messages with the user.`
  const t = a.ticket_id ? getTicket(a.ticket_id) : undefined
  const steps = q<{ payload: string }>("SELECT payload FROM events WHERE agent_id = ? AND kind = 'hook.PreToolUse' ORDER BY id DESC LIMIT 6", a.id).reverse()
    .map((e) => {
      try { const p = JSON.parse(e.payload) as { tool?: string; input?: unknown }; return `- ${p.tool ?? '?'} ${JSON.stringify(p.input ?? '').slice(0, 140)}` } catch { return '' }
    }).filter(Boolean)
  return `${head}\n## Where it stopped\n${t ? `${t.key} was ${t.status}.` : ''} Its last actions, oldest first:\n${steps.join('\n') || '- (none recorded)'}\n`
    + '## Watch out\nIt may have stopped mid-edit: check the uncommitted changes and run the tests before carrying on.'
}

/** Called with each context measurement: past the agent's limit, one notice; with 'auto', a fresh start after the current step. */
export function checkContext(a: Agent, tokens: number | null | undefined): void {
  const limit = limitFor(a.role); if (!limit || !tokens || tokens < limit || a.status === 'exited') return
  const auto = getSetting('context_action', DEFAULTS.context_action) === 'auto' || autoOn(repoOfAgent(a)) // on auto nobody reads the warning
  const then = auto ? 'HQ fresh-starts it when its current step ends.' : 'A fresh start keeps it sharp.'
  attention('context_high', `${name(a)} is at ${k(tokens)} of context (limit ${k(limit)}). ${then}`, { agentId: a.id, ticketId: a.ticket_id, keep: true }) // one notice: the count grows every sample
  if (auto && !freshStartBlocker(a)) void freshStart(a.id, { how: 'after_turn', then: 'continue' }).catch(() => {})
}

/** Every 10 s: finish fresh starts whose note is in (a restart may have lost the moment), and write the note for agents that
 *  died, never answered within the timeout after the request reached them, or never got the request at all. */
export function sweepFreshStarts(): void {
  for (const a of q<Agent>('SELECT * FROM agents WHERE fresh_start_at IS NOT NULL')) {
    const scope = noteScope(a)
    const noted = scope ? one<{ updated_at: number }>("SELECT updated_at FROM docs WHERE scope = ? AND key = 'note'", scope)?.updated_at ?? 0 : 0
    if (noted >= a.fresh_start_at!) { void completeFreshStart(a.id, 'note'); continue }
    if (a.status === 'exited') { void completeFreshStart(a.id, 'fallback', 'its session ended first'); continue }
    const acked = a.fresh_start_msg ? one<{ ack_at: number | null }>('SELECT ack_at FROM messages WHERE id = ?', a.fresh_start_msg)?.ack_at ?? null : null
    if (acked && now() - acked > TIMEOUT_MS) void completeFreshStart(a.id, 'fallback', `none came within ${Math.round(TIMEOUT_MS / 60000)} minutes`)
    else if (!acked && now() - a.fresh_start_at! > NEVER_MS) void completeFreshStart(a.id, 'fallback', 'the request never reached it')
  }
  // A clear whose last note came in while HQ was down, or whose agents died: its board is archived and deleted once nobody runs.
  for (const r of q<{ id: string }>('SELECT id FROM repos WHERE clearing_at IS NOT NULL')) void maybeFinishClear(r.id).catch(() => {})
}
let timer: NodeJS.Timeout | null = null
export function startFreshStartLoop(): void {
  if (!timer) { sweepFreshStarts(); timer = setInterval(() => { try { sweepFreshStarts() } catch {} }, 10_000) }
}

/** Every ticket of the feature (at least one, not counting cancelled ones) is merged: its TPM has nothing left to coordinate. */
export const featureDone = (fid: string): boolean => { const all = tickets(fid).filter((t) => t.status !== 'cancelled'); return all.length > 0 && all.every((t) => t.status === 'merged') }
export const inRepo = (repoId: string): Set<string> => new Set(features().filter((f) => f.repo_id === repoId).map((f) => f.id))
/** The repo's live TPM and engineers (the project TPM has no feature: Bug 52). */
const workers = (repoId: string): Agent[] => liveAgents().filter((x) => (x.role === 'tpm' || x.role === 'engineer') && repoOfAgent(x) === repoId)
/** Switching away from a repo: every TPM and engineer in it leaves a note and stops, parked until the user comes back. Engineers
 *  whose plan waits for the user's review stay (they're idle and their context isn't growing). */
export async function parkRepo(repoId: string): Promise<{ parked: string[]; left: string[]; stopped: string[] }> {
  const parked: string[] = [], left: string[] = [], stopped: string[] = []
  if (autoOn(repoId)) return { parked, left, stopped } // a project on auto keeps running while the user looks elsewhere
  for (const a of workers(repoId)) {
    if (a.fresh_start_at) { parked.push(name(a)); continue }
    const why = freshStartBlocker(a); if (why) { left.push(`${name(a)}: ${why}`); continue }
    await freshStart(a.id, { how: 'now', then: 'park' }); parked.push(name(a))
  }
  emit({ agentId: null, source: 'ui', kind: 'repo.parked', payload: { repo: repoId, parked, left, stopped } })
  return { parked, left, stopped }
}
/** "Fresh start all": every TPM and engineer of the repo that can have one now. */
export async function freshStartAll(repoId: string, then: Then): Promise<{ started: string[]; skipped: string[] }> {
  const started: string[] = [], skipped: string[] = []
  for (const a of workers(repoId)) {
    const why = freshStartBlocker(a); if (why) { skipped.push(why); continue }
    try { await freshStart(a.id, { how: 'now', then }); started.push(name(a)) } catch (e) { skipped.push((e as Error).message) }
  }
  return { started, skipped }
}
/** Coming back to a repo: parked TPMs start again from their notes, and parked engineers up to the parallel limit. */
export async function resumeRepo(repoId: string): Promise<{ resumed: string[]; waiting: string[] }> {
  const resumed: string[] = [], waiting: string[] = []
  if (getRepo(repoId)?.clearing_at) return { resumed, waiting } // its work is being archived, not picked up
  if (getRepo(repoId)?.tpm_parked_at) {
    try { await restartTpm(repoId, { why: 'resume' }); resumed.push('TPM') } catch (e) { waiting.push(`TPM: ${(e as Error).message}`) }
  }
  for (const f of features().filter((x) => x.repo_id === repoId && x.status !== 'cancelled')) {
    for (const t of tickets(f.id).filter((x) => x.parked_at && RESUMABLE.includes(x.status))) {
      try { await resumeEngineer(t.id); resumed.push(t.key) } catch (e) { waiting.push(`${t.key}: ${(e as Error).message}`) }
    }
  }
  return { resumed, waiting }
}
export { readNote }
