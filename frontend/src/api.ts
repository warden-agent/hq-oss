export type Agent = Record<string, any> & { id: string; role: string; status: string }
export type State = { autoRuns?: any[]; repos: any[]; features: any[]; tickets: any[]; agents: Agent[]; messages: any[]; reviews: any[]; attention: any[]; asks: any[];
  settings: Record<string, any>; defaults: Record<string, any>; held: number; ports: Record<string, number>; previews: any[]
  /** The frontend build HQ serves now (Bug 48): a tab running another one is out of date. */
  build?: string | null
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
  return { count, held: false, why: a.status === 'working' ? 'waits for its current turn to end' : 'delivering…' }
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
