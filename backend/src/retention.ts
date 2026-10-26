// Old rows go: events past events_retention_days (pinned ones stay) and usage samples past a week. At start, then daily.
import { getSetting, one, run } from './db.ts'
import { DEFAULTS } from './config.ts'
import { emit } from './events.ts'

const DAY = 86_400_000
export function prune(t = Date.now()): { events: number; usage: number } {
  const days = getSetting('events_retention_days', DEFAULTS.events_retention_days)
  const count = (sql: string, ...p: number[]) => one<{ c: number }>(sql, ...p)!.c
  const events = count('SELECT COUNT(*) c FROM events WHERE pinned = 0 AND created_at < ?', t - days * DAY)
  const usage = count('SELECT COUNT(*) c FROM usage_samples WHERE at < ?', t - 7 * DAY)
  run('DELETE FROM events WHERE pinned = 0 AND created_at < ?', t - days * DAY); run('DELETE FROM usage_samples WHERE at < ?', t - 7 * DAY)
  return { events, usage }
}
export function startRetention(): NodeJS.Timeout {
  const tick = () => { try { const r = prune(); if (r.events || r.usage) emit({ agentId: null, source: 'system', kind: 'retention.pruned', payload: r }) } catch (e) { emit({ agentId: null, source: 'system', kind: 'retention.error', payload: { error: String(e) } }) } }
  tick(); return setInterval(tick, DAY)
}
