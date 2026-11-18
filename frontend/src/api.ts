import type { TestRun } from './testruns.ts'
import type { Question } from './needs.ts'
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
/** Messages HQ hasn't handed to this agent yet (same rule as the backend's pendingFor), and why they're waiting. */
export function waitingFor(a: Agent, s: State, now = Date.now()): { count: number; held: boolean; why: string } | null {
  if (a.status === 'exited') return null
  const count = s.messages.filter((m) => !m.delivered_at && (m.to_id === a.id || (m.channel === 'team' && m.feature_id === a.feature_id && m.from_id !== a.id))).length
  if (!count) return null
  const lock = a.takeover_locked_until ?? 0
  const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (lock > now + 86_400_000) return { count, held: true, why: 'held · open in another terminal' }
  if (lock > now) return { count, held: true, why: `held · you typed in its terminal · until ${hhmm(lock)}` }
  if (a.status === 'paused' || (s.settings.paused_roles ?? []).includes(a.role)) return { count, held: true, why: 'held · paused' }
  // Bug 110: its turn was interrupted (Escape), so HQ types its messages into its terminal, and something there is in the way: a question, or a menu
  // such as Claude Code's Rewind (Escape twice). HQ never types into those: Enter would pick an option.
  if (a.interrupted_at && (a.type_waits === 'dialog' || a.type_waits === 'screen')) return { count, held: true, why: 'held · its terminal shows a menu or a question · answer or close it there' }
  return { count, held: false, why: a.status === 'working' ? 'waits for its current turn to end' : 'delivering…' }
}
/** Bug 122: what the Agents menu says under an agent that has ended, in place of its last activity line: why it ended (its `ended_why`, from the backend) and
 *  when. A fresh start reads "replaced" once a newer agent has its place (same ticket; a TPM, the same project). Old rows with nothing recorded say only when. */
export function endedLine(a: Agent, s: Pick<State, 'agents'>, now = Date.now()): string | null {
  if (a.status !== 'exited') return null
  const why = String(a.ended_why ?? '')
  const newer = s.agents.some((x) => x.id !== a.id && x.role === a.role && (x.started_at ?? 0) > (a.started_at ?? 0) && (a.ticket_id ? x.ticket_id === a.ticket_id : x.repo_id === a.repo_id))
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
