import type { TestRun } from './testruns.ts'
import { hqAnswersPlan, type Question } from './needs.ts'
import { planCheckOf } from '../../backend/src/checks.ts'
export type Agent = Record<string, any> & { id: string; role: string; status: string }
/** A project's feature map as the page gets it (backend mapstore.ts MapView). */
export type MapView = { id: string; text: string; by: { at: number; by: string } | null; pending: { ticket: string; key: string; screens: string; unchanged: boolean }[]
  first: { running: true; since: number } | { running: false; at: number; ok: boolean; why: string | null } | null }
export type State = { autoRuns?: any[]; findings?: any[];
  repos: any[]; features: any[]; tickets: any[]; agents: Agent[]; messages: any[]; reviews: any[]; attention: any[]; asks: any[]; questions?: Question[];
  settings: Record<string, any>; defaults: Record<string, any>; held: number; ports: Record<string, number>; previews: any[]
  /** The frontend build HQ serves now (Bug 48): a tab running another one is out of date. */
  build?: string | null
  /** Bug 97: the Claude Code version HQ was checked on, the one its agents run, and the one installed on this computer (null: unknown, or none). */
  claude?: { checked: string; runs: string | null; installed: string | null }
  /** Bug 106: HQ's own test runs under way now (forRepo keeps the picked repo's). */
  testRuns?: TestRun[]
  /** Each project's feature map (FeatureMap.tsx). */
  maps?: MapView[]
  /** Bug 224: HQ's archive folder, home shown as ~ (Clear and Remove name it). */
  archive?: string
  /** Engineers working in every repo (forRepo sets it: the parallel limit counts them all). */
  working?: number }
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
/** A box's first question to HQ, which may be restarting as the box opens (Bug 51, Bug 64): asks again while nothing answers (a TypeError), and stops at any answer,
 *  because a refusal won't change by asking again. `away` says whether HQ is out of reach right now. Returns a stop function, so it can be an effect's whole body. */
export function askUntilAnswered<T = any>(path: string, on: { away: (is: boolean) => void; answer: (r: T) => void; refused: (e: Error) => void }, everyMs = 1500): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined, gone = false
  const ask = () => api<T>(path, {}).then((r) => { if (!gone) { on.away(false); on.answer(r) } }, (e: Error) => { // two arguments: a bug in answer isn't HQ being away
    if (gone) return
    if (e instanceof TypeError) { on.away(true); timer = setTimeout(ask, everyMs) } else { on.away(false); on.refused(e) }
  })
  void ask()
  return () => { gone = true; clearTimeout(timer) }
}
/** A hold on everything HQ sends the agent, from its terminal: somebody typed there (`takeover_lock_s`, set again at each keystroke), or it's open in
 *  another terminal (a lock a year long, ended when that terminal detaches). Null: none now. */
const LONG_HOLD_MS = 86_400_000
function holdWhy(a: Agent, now: number): string | null {
  const lock = a.takeover_locked_until ?? 0
  const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return lock > now + LONG_HOLD_MS ? 'held · open in another terminal' : lock > now ? `held · you typed in its terminal · until ${hhmm(lock)}` : null
}
/** Bug 228: when the next timed hold ends (the page looks again then: nothing from HQ says so), null with none. */
export const nextHoldEnd = (agents: Agent[], now = Date.now()): number | null => agents.reduce<number | null>((t, a) => {
  const lock = a.status === 'exited' ? 0 : a.takeover_locked_until ?? 0
  return lock > now && lock <= now + LONG_HOLD_MS && (t === null || lock < t) ? lock : t
}, null)
/** Messages HQ hasn't handed to this agent yet (same rule as the backend's pendingFor), and why they're waiting. Bug 228: the project's TPM hears every
 *  team message in its project, whatever the feature; counted only by feature, those held for it didn't show. */
export function waitingFor(a: Agent, s: State, now = Date.now()): { count: number; held: boolean; why: string } | null {
  if (a.status === 'exited') return null
  const team = (m: any) => m.channel === 'team' && m.from_id !== a.id && m.repo_id === a.repo_id && (a.role === 'tpm' || !m.feature_id || m.feature_id === a.feature_id)
  const count = s.messages.filter((m) => !m.delivered_at && (m.to_id === a.id || team(m))).length
  if (!count) return null
  const hold = holdWhy(a, now); if (hold) return { count, held: true, why: hold }
  if (a.status === 'paused' || (s.settings.paused_roles ?? []).includes(a.role)) return { count, held: true, why: 'held · paused' }
  // Bug 110: its turn was interrupted (Escape), so HQ types its messages into its terminal, and something there is in the way: a question, or a menu
  // such as Claude Code's Rewind (Escape twice). HQ never types into those: Enter would pick an option.
  if (a.interrupted_at && (a.type_waits === 'dialog' || a.type_waits === 'screen')) return { count, held: true, why: 'held · its terminal shows a menu or a question · answer or close it there' }
  // Bug 149: a line somebody typed into its prompt box and didn't send. HQ's text would go in after it, and Enter would send both as one message.
  if (a.interrupted_at && a.type_waits === 'draft') return { count, held: true, why: 'held · a half-written line is in its terminal · send or clear it there' }
  return { count, held: false, why: a.status === 'working' ? 'waits for its current turn to end' : 'delivering…' }
}
/** Bug 228: the line a box and the Agents menu show about the agent's messages: those waiting, and why; or, with none waiting, a hold from its terminal
 *  that keeps back whatever HQ sends it next, and until when (a notice sent meanwhile came minutes late with nothing on the board saying why). */
export function waitLine(a: Agent, s: State, now = Date.now()): { text: string; held: boolean } | null {
  const w = waitingFor(a, s, now); if (w) return { text: `✉ ${w.count} waiting · ${w.why}`, held: w.held }
  const hold = a.status === 'exited' ? null : holdWhy(a, now)
  return hold ? { text: `✉ messages ${hold}`, held: true } : null
}
/** Bug 72: blocked because its turn ended with an API error. No dialog: it sits at its prompt (the backend's `blocked_why`, agents.ts). */
export const apiErrored = (a: Agent): boolean => a.status === 'blocked' && a.blocked_why === 'api_error'
/** A dialog or menu is on its terminal (or must be assumed): the backend's onDialog. */
export const onDialog = (a: Agent): boolean => a.status === 'paused' || (a.status === 'blocked' && !apiErrored(a))
/** What an agent is doing, in words. */
/** Bug 148: idle because its turn was stopped by Escape in its terminal (no turn has ended normally since): the backend's `interrupted_at`. */
export const interrupted = (a: Agent): boolean => a.status === 'idle' && !!a.interrupted_at
export const agentWord = (a: Agent): string => apiErrored(a) ? 'stopped by an API error' : interrupted(a) ? 'interrupted' : ({ working: 'working', idle: 'idle', plan_review: 'waiting for your review',
  blocked: 'waiting on a dialog', paused: 'paused', launching: 'starting', exited: 'stopped' } as Record<string, string>)[a.status] ?? a.status
/** Bug 179: the hooks' activity line ("Thinking", "Running: …") while it means something. On a dialog, a usage pause or at the plan gate (Bug 216) it is
 *  what the agent did before that came, so it is not shown; it is kept, and comes back once the agent works again (the dialog answered, the next hook). */
export const liveActivity = (a: Agent): string | null => !onDialog(a) && a.status !== 'plan_review' && a.activity ? String(a.activity) : null
type PlanState = Pick<State, 'repos' | 'features' | 'tickets' | 'reviews'>
/** Bug 216: whom a plan held at the gate waits on, in its ticket box's words. On auto HQ's plan check answers it (`hq`; `since`: the check is reading it now).
 *  `review`: the ticket's open review; none (closed while the agent's status hasn't caught up) still says whom. */
export function planWait(s: PlanState, ticketId: string, review: { round: number; plan_check?: unknown } | null): { text: string; hq: boolean; since: number | null } {
  if (!hqAnswersPlan(s, { ticket_id: ticketId })) return { text: review ? `Plan R-${review.round} waiting for you` : 'its plan waits for your review', hq: false, since: null }
  const c = review ? planCheckOf(review.plan_check) : null
  return c?.state === 'checking' ? { text: 'HQ is checking its plan against its criteria', hq: true, since: c.since } : { text: "its plan waits for HQ's check", hq: true, since: null }
}
/** planWait for an agent at the plan gate: its ticket's open review. */
export const agentPlanWait = (a: Agent, s: PlanState) => planWait(s, String(a.ticket_id ?? ''), s.reviews.find((r) => r.ticket_id === a.ticket_id && r.status === 'open') ?? null)
/** Bug 179: the Agents menu's line under a running agent: on a dialog, that it waits on one (as its box says); at the plan gate, whom its plan waits on
 *  (Bug 216); else its activity line. A usage pause says nothing here: its pill says "paused". */
export const menuActivity = (a: Agent, s: PlanState): string | null => a.status === 'blocked' && onDialog(a) ? `${agentWord(a)} in its terminal`
  : a.status === 'plan_review' ? agentPlanWait(a, s).text : liveActivity(a)
/** Bug 216: an agent's status pill, in words (the status itself is the pill's colour): never a raw status word such as `plan_review`. At the plan gate it reads
 *  as its ticket's pill does. */
export const agentPill = (a: Agent, s: PlanState): string => apiErrored(a) ? 'API error' : a.status === 'plan_review' ? (agentPlanWait(a, s).hq ? 'plan check' : 'plan for you')
  : ({ blocked: 'on a dialog', launching: 'starting' } as Record<string, string>)[a.status] ?? a.status
/** A newer agent has its place: the same ticket's engineer, or the same project's TPM. */
const replaced = (a: Agent, s: Pick<State, 'agents'>): boolean => s.agents.some((x) => x.id !== a.id && x.role === a.role && (x.started_at ?? 0) > (a.started_at ?? 0)
  && (a.ticket_id ? x.ticket_id === a.ticket_id : x.repo_id === a.repo_id))
/** Bug 122: what the Agents menu says under an agent that has ended, in place of its last activity line: why it ended (its `ended_why`, from the backend) and
 *  when. A fresh start reads "replaced" once a newer agent has its place (same ticket; a TPM, the same project). Old rows with nothing recorded say only when. */
export function endedLine(a: Agent, s: Pick<State, 'agents'>, now = Date.now()): string | null {
  if (a.status !== 'exited') return null
  const why = String(a.ended_why ?? '')
  const newer = replaced(a, s)
  const words: Record<string, string> = { fresh_start: newer ? 'replaced by a fresh start' : 'ended for a fresh start', user: 'stopped by you',
    finished: 'stopped: its ticket is done', merged: 'stopped: its work was merged', cancelled: 'stopped: its ticket was cancelled', parked: 'stopped: its work was parked',
    cleared: 'stopped: the project was cleared', 'removed from HQ': 'stopped: the project was removed from HQ', 'replaced by auto mode': 'replaced by auto mode',
    'launch helper done': 'stopped: its launch work is done', 'stray launch helper': 'stopped: nothing was waiting for it', lost: 'its process ended without HQ stopping it' }
  const text = !why ? 'ended' : why.startsWith('session:') ? 'its session ended' : words[why] ?? 'stopped by HQ'
  if (!a.ended_at) return why ? text : null
  const at = new Date(a.ended_at), day = at.toDateString() === new Date(now).toDateString()
  const when = at.toLocaleString([], { ...(day ? {} : { month: 'short', day: 'numeric' }), hour: 'numeric', minute: '2-digit' })
  return `${text} · ${when}`
}
/** Bugs 153, 165: an alert about an agent that has ended can sit on the box of the one that took its place (the same ticket, the one TPM box),
 *  often under the same name. `tag` (the box's line) and `line` (the alert's own card) say whose it was, so it isn't read as the running one's.
 *  null for a live agent, for no agent, and for a notice that already says its agent ended. */
export function alertFrom(x: { agent_id?: string | null; kind: string }, s: Pick<State, 'agents'>, now = Date.now()): { tag: string; line: string } | null {
  const a = x.agent_id ? s.agents.find((y) => y.id === x.agent_id) : undefined
  if (!a || a.status !== 'exited' || ['agent_exited', 'engineer_exited'].includes(x.kind)) return null
  const role = a.role === 'tpm' ? 'TPM' : a.role === 'launcher' ? 'launch helper' : a.role, name = a.display_name ?? a.id
  const how = endedLine(a, s, now)
  return replaced(a, s) ? { tag: `earlier ${role}`, line: `From an earlier ${name}, which has ended${how ? ` (${how})` : ''}.` }
    : { tag: `${role} ended`, line: `From ${name}, which has ended${how ? ` (${how})` : ''}.` }
}
// The backend's own ticket rules (a pure module), so the two can't drift apart.
export { FINISHED, unmergedDeps } from '../../backend/src/readiness.ts'
/** Puts `key` in a cache that keeps only its newest `max` entries (a Map lists its oldest first), and returns `value`. */
export function keepNewest<K, V>(cache: Map<K, V>, key: K, value: V, max: number): V {
  cache.set(key, value); for (const old of cache.keys()) { if (cache.size <= max) break; cache.delete(old) }
  return value
}
/** A JSON list column (deps, expected_files, merge_order) as strings; anything unreadable is an empty list instead of a blank page. */
export const jsonList = (s: unknown): string[] => { try { const v = JSON.parse(String(s || '[]')); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
/** The backend's error text from a failed api() call (it sends `{ error }` JSON). A TypeError means nothing answered, and browsers word that differently. */
export const errText = (e: Error): string => {
  if (e instanceof TypeError) return "Can't reach HQ. It may be restarting."
  try { return JSON.parse(e.message).error ?? e.message } catch { return e.message }
}
/** The rest of what a refused request sent back, beyond the `error` that errText reads. */
export const errBody = (e: Error): Record<string, any> => { try { return JSON.parse(e.message) } catch { return {} } }
let errorSink: ((msg: string) => void) | null = null
/** Shows an error in the bar under the top bar (ErrorBar in ui.tsx), instead of alert(). */
export function showError(msg: string): void { if (errorSink) errorSink(msg); else console.error(msg) }
export function onError(sink: ((msg: string) => void) | null): void { errorSink = sink }
export type WsMsg = { type: 'snapshot'; data: State } | { type: 'patch'; entity: string; id: string; patch: Record<string, any> | null } | { type: 'event'; event: any } | { type: 'term'; agentId: string; data: string } | { type: 'term.exit'; agentId: string }
export function connectWs(onMsg: (m: WsMsg) => void, onOpen?: (ws: WebSocket) => void): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)
  ws.onmessage = (e) => onMsg(JSON.parse(e.data))
  ws.onopen = () => onOpen?.(ws)
  return ws
}
