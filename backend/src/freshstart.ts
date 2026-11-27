// Fresh start: an agent stops, leaves a handoff note, and its session ends; a new session takes over from the note, at once or
// when the user presses Resume. Asked by a click (interrupts at once), at the context limit (after the current step), for every
// agent of a repo the user switches away from ('switch': parked until they come back), or when the user clears the repo (clear.ts: an
// engineer's note goes to the archive and nobody takes over; the project's TPM comes back after the clear, Bug 52). Bug 308: the
// request, the Events lines (eventtext.ts) and the box (api.ts noteLine) say which of these it is: only some are a fresh start.
import { CHOICES, DEFAULTS, ENGINEER_LIMIT, NOTE_CAP } from './config.ts'
import { getSetting, now, one, q, run } from './db.ts'
import { emit, patch } from './events.ts'
import { attention, resolveKind } from './attention.ts'
import { getAgent, liveAgents, onDialog, stopAgent, update, type Agent } from './agents.ts'
import { interruptAndType, sendMessage, type Message } from './delivery.ts'
import { autoOn, features, getFeature, getRepo, getTicket, repoOfAgent, setTicket, tickets } from './records.ts'
import { planWaitsWhy } from './checks.ts'
import { agentNote, HQ_NOTE_HEAD, noteScope, readNote, saveNote } from './notes.ts'
import { resumeEngineer } from './tickets.ts'
import { restartTpm } from './tpm.ts'
import { maybeFinishClear } from './clear.ts'

export type Then = 'continue' | 'park' | 'switch' | 'clear'
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
  // HQ types the request after Escape: on a dialog or menu, Enter would pick whatever option is highlighted. After an API error it sits at its prompt (Bug 72).
  if (onDialog(a)) return `${name(a)} is waiting on a dialog in its terminal. Answer it first.`
  if (a.role === 'tpm') return null
  const t = a.ticket_id ? getTicket(a.ticket_id) : undefined
  if (!t) return `${name(a)} has no ticket.`
  if (t.status === 'plan_review') return planWaitsWhy(t.key, autoOn(getFeature(t.feature_id)?.repo_id)) // on auto HQ's plan check answers it (Bug 220)
  if (!RESUMABLE.includes(t.status)) return `${t.key} is ${t.status}; there's nothing to hand over.`
  return null
}

/** Bug 308: why this session ends and what follows its note, in the request's first words. Only 'continue' and 'park' are a fresh start: a
 *  switch of projects waits for the user to come back, and a Clear ends an engineer's work with nobody taking over. */
function whyEnding(a: Agent, then: Then): string {
  if (then === 'clear') return a.role === 'tpm' ? 'The user is clearing this project\'s board from HQ: every ticket goes, and this session is ending. '
    + 'A new TPM session starts after the clear with your note and what has been built, so it keeps the project\'s memory but not the old tickets.'
    : 'The user is clearing this project from HQ: this session is ending, and no new session takes over now. '
    + 'Your note is archived for whoever picks the work up later, so make it stand on its own.'
  if (then === 'switch') return 'The user switched to another project in HQ: this session is ending, and a new one takes over from your note '
    + 'when they come back to this one.'
  return `Fresh start: this session is ending so that a new one can take over with a clean context${then === 'park' ? ' when the user presses Resume' : ''}.`
}
function requestText(a: Agent, interrupted: boolean, then: Then): string {
  const cap = NOTE_CAP[a.role as 'tpm' | 'engineer'].toLocaleString('en-US')
  const reader = then === 'clear' && a.role !== 'tpm' ? 'whoever picks the work up later' : `the ${a.role === 'tpm' ? 'TPM' : 'engineer'} who takes over`
  const head = `${whyEnding(a, then)} Stop what you are doing now. Don't finish the step, run more commands, edit files or commit. `
    + `Call write_handoff_note once with a note of at most ${cap} characters for ${reader}, under these headings:\n`
  const body = a.role === 'tpm' && then === 'clear'
    ? ['## What the user wants from this project (in their words)', '## Decisions so far', '## Watch out (things the next TPM would get wrong)',
      "Don't list tickets or what's in flight: the user is clearing the board. HQ gives the next TPM what has been built."].join('\n')
    : a.role === 'tpm'
    ? ['## What the user wants (in their words)', '## Decisions so far', '## In flight', '## Next', '## Watch out (things the next TPM would get wrong)',
      "Don't list tickets or their statuses: HQ gives the next TPM those."].join('\n')
    : ['## Where I stopped (what you were in the middle of; any half-edited file; are the tests passing or failing)', '## Done', '## Left to do',
      '## Watch out (quirks of this code, approaches that failed, design intent)', "Don't list changed files: HQ gives the next engineer the git status."].join('\n')
  const why = interrupted ? INTERRUPTED : ''
  return `${why}${head}${body}\nShort bullets. After it is saved, do nothing else: HQ ends this session.`
}
const INTERRUPTED = 'HQ interrupted your last step for this; nobody rejected it, so don\'t note it as rejected.\n'
/** The first words of a request that replaces one already in the agent's terminal (Bug 338). */
const REPLACES = 'This replaces HQ\'s earlier request for your handoff note: what happens after it has changed.\n'

/** Asks `agentId` for its handoff note. `now` interrupts what it is doing; `after_turn` waits for the current step to end.
 *  `then`: a new session takes over as soon as the note is in (continue), the work waits for Resume (park) or for the user to come back to the
 *  project (switch), or the project is being cleared (clear). */
export async function freshStart(agentId: string, o: { how: 'now' | 'after_turn'; then: Then }): Promise<void> {
  const a = getAgent(agentId); if (!a) throw new Error('unknown agent')
  const why = freshStartBlocker(a); if (why) throw new Error(why)
  update(a.id, { fresh_start_at: now(), fresh_start_then: o.then }) // first, so only this request is delivered to it from now on
  const m = sendMessage({ repoId: a.repo_id, featureId: a.feature_id, channel: 'dm', from: 'hq', to: a.id, reason: 'fresh_start', body: requestText(a, o.how === 'now', o.then) })
  update(a.id, { fresh_start_msg: m.id })
  // Bug 368: its Events line before the typing, which a restart can cut (the new backend types the rest, typeCutShort, and writes no line)
  emit({ agentId: a.id, source: 'system', kind: 'fresh_start.requested', payload: { how: o.how, then: o.then, role: a.role } }) // role: Bug 308's words
  if (o.how === 'now') { update(a.id, { takeover_locked_until: 0 }); await interruptAndType(a, m) } // after_turn: the mod delivers it
}

/** Bug 338: an open fresh start now ends another way (the user clears the project while it writes its note): its `then` changes, and so
 *  do the request's words (a TPM's note for a Clear has its own headings). A request not handed out yet is rewritten. One already in its
 *  terminal is replaced by a new one, typed the same way (Escape, then the line), unless the note is in or its session has ended. On a
 *  dialog nothing is typed: the new request waits for the mod, like an `after_turn` one. Only the current request is ever handed out. */
export async function retarget(agentId: string, then: Then): Promise<void> {
  const a = getAgent(agentId); if (!a?.fresh_start_at || a.fresh_start_then === then) return
  update(a.id, { fresh_start_then: then }); await retell(a.id)
}
/** Gives an agent writing its note the request for the `fresh_start_then` it has now (retarget, or parkRepo, which marks first and types after). */
async function retell(agentId: string): Promise<void> {
  const a = getAgent(agentId); if (!a?.fresh_start_at) return
  const then = thenOf(a)
  const old = a.fresh_start_msg ? one<Message>('SELECT * FROM messages WHERE id = ?', a.fresh_start_msg) : undefined
  const told = { then, role: a.role, again: true } // Events: "Asked again for its handoff note: …"
  if (old && !old.delivered_at) { // its first words stay: whether it replaces one in its terminal, whether HQ interrupted it
    const lead = old.body.startsWith(REPLACES) ? REPLACES : '', body = `${lead}${requestText(a, old.body.startsWith(INTERRUPTED, lead.length), then)}`
    run('UPDATE messages SET body = ? WHERE id = ? AND delivered_at IS NULL', body, old.id); patch('message', old.id, { body })
    emit({ agentId: a.id, source: 'system', kind: 'fresh_start.requested', payload: { how: 'after_turn', ...told } }); return
  }
  if (a.status === 'exited' || noteIn(a)) return // the sweep writes HQ's note / completeFreshStart ends it: nothing more to ask
  const m = sendMessage({ repoId: a.repo_id, featureId: a.feature_id, channel: 'dm', from: 'hq', to: a.id, reason: 'fresh_start',
    body: `${REPLACES}${requestText(a, true, then)}` })
  update(a.id, { fresh_start_msg: m.id }) // the sweep's time limit counts from this one; the old one is never handed out again (delivery.ts)
  const typed = !onDialog(a) // Enter on a dialog would pick its highlighted option (freshStartBlocker)
  emit({ agentId: a.id, source: 'system', kind: 'fresh_start.requested', payload: { how: typed ? 'now' : 'after_turn', ...told } }) // before the typing (Bug 368)
  if (!typed) return
  update(a.id, { takeover_locked_until: 0 })
  // its terminal gone: no throw into the Clear that asked; the agent ends, and the sweep writes HQ's note
  await interruptAndType(a, m).catch((e) => emit({ agentId: a.id, source: 'system', kind: 'backend.error', payload: { server: 'typing', error: String(e) } }))
}
/** Whether the agent's note is in since its fresh start was asked for. */
function noteIn(a: Agent): boolean {
  const scope = noteScope(a); if (!scope || !a.fresh_start_at) return false
  return (one<{ updated_at: number }>("SELECT updated_at FROM docs WHERE scope = ? AND key = 'note'", scope)?.updated_at ?? 0) >= a.fresh_start_at
}

const finishing = new Set<string>()
/** The note is in (or HQ wrote one): the session ends, and a new one takes over or the work is parked. */
export async function completeFreshStart(agentId: string, by: 'note' | 'fallback', why = ''): Promise<void> {
  const a = getAgent(agentId); if (!a?.fresh_start_at || finishing.has(agentId)) return
  finishing.add(agentId)
  let then = thenOf(a)
  try {
    const kept = then === 'clear' && agentNote(noteScope(a) ?? '') // a Clear archives a real note from before rather than HQ's (Bug 73), not HQ's old one (Bug 196)
    if (by === 'fallback' && !kept) saveNote(a, fallbackNote(a, why))
    // what the Agents menu says it ended for (Bug 122), also when its session had already ended; a switch parks its work (Bug 308)
    let endedWhy = why_(then)
    if (a.status !== 'exited') await stopAgent(a.id, endedWhy)
    // Bug 350: the user came back to the project (or left it) while its session ended: a switch's parking and a fresh start's new session
    // swap (resumeRepo, parkRepo). Only those two: a Clear's note was settled above.
    const after = thenOf(getAgent(a.id) ?? a); if (after !== then && SWAPS.includes(then) && SWAPS.includes(after)) { then = after; endedWhy = why_(then) }
    update(a.id, { fresh_start_at: null, fresh_start_then: null, fresh_start_msg: null, ended_why: endedWhy })
    for (const kind of ['context_high', 'stuck', 'agent_exited', 'engineer_exited']) resolveKind(kind, a.id)
    emit({ agentId: a.id, source: 'system', kind: 'fresh_start.done', payload: { by, then, why, role: a.role } })
    if (then === 'clear') { const repoId = repoOfAgent(a); if (repoId) void maybeFinishClear(repoId).catch(() => {}); return }
    if (then === 'park' || then === 'switch') return park(a)
    const repoId = repoOfAgent(a) ?? '', before = moves.get(repoId)?.n // Bug 339: a switch away while the new session starts parks it after all
    try {
      const next = a.role === 'tpm' ? await restartTpm(a.repo_id!, { why: 'fresh_start' }) : await resumeEngineer(a.ticket_id!, { replace: true })
      const m = moves.get(repoId)
      if (m?.away && m.n !== before) {
        await parkStarted(next).catch((e) => emit({ agentId: next.id, source: 'system', kind: 'backend.error', payload: { server: 'park', error: String(e) } }))
      }
    } catch (e) {
      park(a)
      attention('fresh_start_failed', `${name(a)} saved its note, but the new session didn't start: ${(e as Error).message} Press Resume to try again.`,
        { agentId: a.id, ticketId: a.ticket_id })
    }
  } finally { finishing.delete(agentId) }
}
const thenOf = (a: Agent): Then => (['park', 'switch', 'clear'] as const).find((x) => x === a.fresh_start_then) ?? 'continue'
const SWAPS: Then[] = ['switch', 'continue']
const why_ = (then: Then): string => then === 'clear' ? 'cleared' : then === 'switch' ? 'parked' : 'fresh_start'
function park(a: Agent): void {
  if (a.role === 'engineer' && a.ticket_id) setTicket(a.ticket_id, { parked_at: now() })
  else if (a.role === 'tpm' && a.repo_id) { const t = now(); run('UPDATE repos SET tpm_parked_at = ? WHERE id = ?', t, a.repo_id); patch('repo', a.repo_id, { tpm_parked_at: t }) }
}
/** The note HQ writes when the agent couldn't: where things stood, from HQ's records. Git facts reach the next engineer anyway. */
export function fallbackNote(a: Agent, why: string): string {
  const w = why.trim(), stop = /[.!?…]$/.test(w) ? '' : '.' // reasons often end a sentence already (Bug 176: "Answer it first..")
  const head = `${HQ_NOTE_HEAD}: the ${a.role === 'tpm' ? 'TPM' : 'engineer'} didn't leave a note${w ? `: ${w}` : ''}${stop})`
  if (a.role === 'tpm') return `${head}\nRely on PROJECT.md, the ticket list and the recent messages with the user.`
  const t = a.ticket_id ? getTicket(a.ticket_id) : undefined
  // Bug 101: the kind carries the tool ('hook.PreToolUse:Bash'). Helpers' calls (sub) are left out, or a helper's searches push
  // out the engineer's own last edits. hooks.ts stores the input already as a (cut) JSON string: print it as it is.
  const steps = q<{ payload: string }>("SELECT payload FROM events WHERE agent_id = ? AND kind LIKE 'hook.PreToolUse:%' ORDER BY id DESC LIMIT 40", a.id)
    .map((e) => { try { return JSON.parse(e.payload) as { tool?: string; input?: unknown; sub?: boolean } } catch { return null } })
    .filter((p) => p && !p.sub).slice(0, 6).reverse()
    .map((p) => `- ${p!.tool ?? '?'} ${(typeof p!.input === 'string' ? p!.input : JSON.stringify(p!.input ?? '')).slice(0, 140)}`)
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
    if (noteIn(a)) { void completeFreshStart(a.id, 'note'); continue }
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

export const inRepo = (repoId: string): Set<string> => new Set(features().filter((f) => f.repo_id === repoId).map((f) => f.id))
/** The repo's live TPM and engineers (the project TPM has no feature: Bug 52). */
const workers = (repoId: string): Agent[] => liveAgents().filter((x) => (x.role === 'tpm' || x.role === 'engineer') && repoOfAgent(x) === repoId)
/** Switching away from a repo: every TPM and engineer in it leaves a note and stops, parked until the user comes back. Engineers
 *  whose plan waits for the user's review stay (they're idle and their context isn't growing). `again`: a park the last backend began or
 *  had asked for (finishMoves). Bug 369: marked in the DB until every agent is asked; Bug 402: from when it is asked for, not its turn. */
export const parkRepo = (repoId: string, o: { again?: boolean } = {}): Promise<{ parked: string[]; left: string[]; stopped: string[] }> => {
  asked(repoId, 'park', !!o.again); return inTurn(repoId, () => parkNow(repoId, !!o.again))
}
async function parkNow(repoId: string, again: boolean): Promise<{ parked: string[]; left: string[]; stopped: string[] }> {
  const parked: string[] = [], left: string[] = [], stopped: string[] = []
  if (autoOn(repoId)) { over(repoId, 'park'); return { parked, left, stopped } } // a project on auto keeps running while the user looks elsewhere
  try {
    // Already writing a note: a fresh start whose new session would start at once waits for the user to come back instead (Bug 339). Marked
    // for all of them first, with no wait in between: asking the others takes a few seconds each, and a note in meanwhile must find it
    // (its words follow below, retell). A Clear's stays a Clear's, and one waiting for Resume is parked anyway. Bug 369: one marked by
    // the last backend, which went before it typed the switch's words, is told them now.
    const moved = new Set(workers(repoId).filter((a) => a.fresh_start_at && (a.fresh_start_then === 'continue' || (a.fresh_start_then === 'switch' && !toldSwitch(a))))
      .map((a) => a.id))
    for (const id of moved) update(id, { fresh_start_then: 'switch' })
    move(repoId, true)
    for (const { id } of workers(repoId)) {
      const a = getAgent(id); if (!a) continue // read again: the one before can take a while (a note may be in, its session ended and parked)
      if (moved.has(a.id)) { if (a.fresh_start_at && a.fresh_start_then === 'switch') await retell(a.id); parked.push(name(a)); continue }
      if (a.status === 'exited') continue
      if (a.fresh_start_at) { parked.push(name(a)); continue }
      const why = freshStartBlocker(a); if (why) { left.push(`${name(a)}: ${why}`); continue }
      // Bug 397: its terminal can go while HQ types the request, as in retell. The request is recorded before the typing (freshStart), so
      // the sweep writes HQ's note once its session has ended and its work is parked; the park carries on with the others.
      await freshStart(a.id, { how: 'now', then: 'switch' })
        .catch((e) => emit({ agentId: a.id, source: 'system', kind: 'backend.error', payload: { server: 'typing', error: String(e) } }))
      parked.push(name(a))
    }
  } finally { over(repoId, 'park') }
  emit({ agentId: null, source: 'ui', kind: 'repo.parked', payload: { repo: repoId, parked, left, stopped, ...(again ? { again } : {}) } })
  return { parked, left, stopped }
}
type Move = 'park' | 'resume'
const COLUMN = { park: 'parking_at', resume: 'resuming_at' } as const
/** Bugs 369, 389: a switch away (park) or a coming back (resume) asked for at `at` and not over yet, or none (null). Kept in the DB: each asks
 *  or starts one agent after the other, a few seconds each, and a restart in the middle runs it again (finishMoves). */
function mark(repoId: string, kind: Move, at: number | null): void {
  const col = COLUMN[kind]; if ((getRepo(repoId)?.[col] ?? null) === at) return
  run(`UPDATE repos SET ${col} = ? WHERE id = ?`, at, repoId); patch('repo', repoId, { [col]: at })
}
/** Bug 402: each repo's parks and resumes asked for and not over yet, by kind. One waiting for its turn (inTurn) behind the other kind was
 *  only in memory, so a restart lost it: switching straight back to a project whose park was still asking left it parked on screen. */
const pending = new Map<string, Record<Move, number>>()
/** A park or resume asked for: marked now, not when its turn comes, and later than the other kind's mark, so the marks keep the order the
 *  user asked in (finishMoves), even within one millisecond. `again`: run again at start-up, whose mark from the last backend stays. */
function asked(repoId: string, kind: Move, again: boolean): void {
  const n = pending.get(repoId) ?? { park: 0, resume: 0 }; n[kind]++; pending.set(repoId, n)
  if (again) return
  const other = getRepo(repoId)?.[COLUMN[kind === 'park' ? 'resume' : 'park']] ?? 0
  mark(repoId, kind, Math.max(now(), other + 1)) // the newest of its kind: a later one of the same kind replaces it
}
/** One is over: its mark goes once no other of its kind waits. */
function over(repoId: string, kind: Move): void {
  const n = pending.get(repoId); if (n) n[kind] = Math.max(0, n[kind] - 1)
  if (!n?.[kind]) mark(repoId, kind, null)
  if (n && !n.park && !n.resume) pending.delete(repoId)
}
/** Whether the request `a` has now is the switch's, in its words (whyEnding). */
function toldSwitch(a: Agent): boolean {
  const m = a.fresh_start_msg ? one<{ body: string }>('SELECT body FROM messages WHERE id = ?', a.fresh_start_msg) : undefined
  return !!m?.body.includes(whyEnding(a, 'switch'))
}
/** At start-up, each switch away and coming back the last backend went down in the middle of, or had asked for and not begun (Bug 402: one
 *  waiting behind the other), runs again in the order asked: their marks' times (asked). A park (Bug 369): the agents it hadn't asked yet
 *  would keep working in the project the user left; those already writing their note are left to it, the rest are asked now. A resume
 *  (Bug 389): the agents it hadn't started yet would stay parked in the project the user is looking at; it picks up only what is still
 *  parked or still writing the switch's note. Neither for a project being cleared (the Clear asks everyone itself; its work is archived).
 *  No resume when the user has since chosen to press Resume themselves ("Wait until I press Resume"; a project on auto picks up anyway, as
 *  turning auto on does). Called once the servers listen: what it types starts turns, whose hooks need HQ. */
export function finishMoves(): void {
  const wait = getSetting('after_fresh_start', DEFAULTS.after_fresh_start) === 'wait'
  type Row = { id: string; clearing_at: number | null; auto_mode: number; parking_at: number | null; resuming_at: number | null }
  for (const r of q<Row>('SELECT id, clearing_at, auto_mode, parking_at, resuming_at FROM repos WHERE parking_at IS NOT NULL OR resuming_at IS NOT NULL')) {
    const moves = (['park', 'resume'] as const).filter((k) => r[COLUMN[k]] !== null).sort((x, y) => r[COLUMN[x]]! - r[COLUMN[y]]!) // a tie: the park first
    for (const kind of moves) {
      if (r.clearing_at || (kind === 'resume' && wait && !r.auto_mode)) { mark(r.id, kind, null); continue }
      void (kind === 'park' ? parkRepo(r.id, { again: true }) : resumeRepo(r.id, { again: true }))
        .catch((e) => emit({ agentId: null, source: 'system', kind: 'backend.error', payload: { server: kind, error: String(e) } }))
    }
  }
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
/** Bug 350: a repo's park and resume run one after the other, in the order asked. A switch away asks each agent in turn for its note
 *  (a few seconds each), so a switch straight back used to look for the parked work while the park was still asking. */
const turns = new Map<string, Promise<unknown>>()
/** Bug 339: each park and resume of a repo, counted, and whether the last was a park: a fresh start's new session that was still starting
 *  when a switch away came is parked after all (completeFreshStart). In memory: a restart ends every start in flight. */
const moves = new Map<string, { n: number; away: boolean }>()
const move = (repoId: string, away: boolean): void => { moves.set(repoId, { n: (moves.get(repoId)?.n ?? 0) + 1, away }) }
/** The new session `next` of a fresh start began starting before the user switched away from its project: it stops at once and its work is
 *  parked, from the note the session before wrote. Unless the switch has asked it for a note of its own already. */
async function parkStarted(next: Agent): Promise<void> {
  const a = getAgent(next.id); if (!a || a.status === 'exited' || a.fresh_start_at) return
  await stopAgent(a.id, 'parked'); park(a)
}
function inTurn<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const p = (turns.get(repoId) ?? Promise.resolve()).catch(() => {}).then(fn)
  turns.set(repoId, p); void p.catch(() => {}).finally(() => { if (turns.get(repoId) === p) turns.delete(repoId) })
  return p
}
/** Agents of the repo writing the note a switch away asked for (Bug 350), also those whose session has ended since (the sweep writes
 *  HQ's note for them). */
export const switchNotes = (repoId: string): Agent[] => q<Agent>("SELECT * FROM agents WHERE fresh_start_at IS NOT NULL AND fresh_start_then = 'switch'")
  .filter((a) => repoOfAgent(a) === repoId)
/** Coming back to a repo: parked TPMs start again from their notes, and parked engineers up to the parallel limit. An agent still
 *  writing the switch's note (the user came straight back, Bug 350) is told a new session takes over from it as soon as it's in: a
 *  fresh start's "continue", in its terminal too (retarget). Parking it there and then would leave the work parked with nobody to resume it. */
export const resumeRepo = (repoId: string, o: { again?: boolean } = {}): Promise<{ resumed: string[]; waiting: string[] }> => {
  asked(repoId, 'resume', !!o.again); return inTurn(repoId, () => resumeNow(repoId)) // marked as a park is (parkRepo)
}
async function resumeNow(repoId: string): Promise<{ resumed: string[]; waiting: string[] }> {
  const resumed: string[] = [], waiting: string[] = []
  move(repoId, false)
  // the user is back: a park the last backend began is over (it ran before this: inTurn). Not one asked for after this resume (Bug 402).
  if (!pending.get(repoId)?.park) mark(repoId, 'park', null)
  if (getRepo(repoId)?.clearing_at) { over(repoId, 'resume'); return { resumed, waiting } } // its work is being archived, not picked up
  try {
    for (const a of switchNotes(repoId)) { // read again: the one before can take a while, and a Clear's request stays a Clear's
      if (getAgent(a.id)?.fresh_start_then !== 'switch') continue
      await retarget(a.id, 'continue'); resumed.push(`${name(a)} (from its note)`)
    }
    if (getRepo(repoId)?.tpm_parked_at) {
      try { await restartTpm(repoId, { why: 'resume' }); resumed.push('TPM') } catch (e) { waiting.push(`TPM: ${(e as Error).message}`) }
    }
    for (const f of features().filter((x) => x.repo_id === repoId && x.status !== 'cancelled')) {
      for (const t of tickets(f.id).filter((x) => x.parked_at && RESUMABLE.includes(x.status))) {
        try { await resumeEngineer(t.id); resumed.push(t.key) } catch (e) { waiting.push(`${t.key}: ${(e as Error).message}`) }
      }
    }
  } finally { over(repoId, 'resume') }
  return { resumed, waiting }
}
export { readNote }
