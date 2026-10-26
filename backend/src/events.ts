// Append-only event log + in-process bus. Every inbound record (hook, mod, status line, system)
// goes through here, then reducers update state and the WS layer broadcasts patches.
import { EventEmitter } from 'node:events'
import { run, now } from './db.ts'

export type HqEvent = { agentId: string | null; sessionId?: string | null; source: 'hook' | 'mod' | 'statusline' | 'system' | 'mcp' | 'ui'; kind: string; payload: Record<string, unknown>; at: number }
export const bus = new EventEmitter()
bus.setMaxListeners(100)

export function emit(ev: Omit<HqEvent, 'at'> & { at?: number }): HqEvent {
  const full: HqEvent = { ...ev, at: ev.at ?? now() }
  run('INSERT INTO events(agent_id, session_id, source, kind, payload, created_at) VALUES (?,?,?,?,?,?)', full.agentId, full.sessionId ?? null, full.source, full.kind, JSON.stringify(full.payload), full.at)
  bus.emit('event', full)
  bus.emit(`event:${full.kind}`, full)
  return full
}

// Entity patches for the UI: { entity, id, patch } — emitted by reducers, consumed by ws.ts
export type Patch = { entity: string; id: string; patch: Record<string, unknown> | null }
export function patch(entity: string, id: string, p: Record<string, unknown> | null): void { bus.emit('patch', { entity, id, patch: p } satisfies Patch) }
