// M1: capacity/pause checks. Dependencies are enforced in launchEngineer; overlap prediction arrives in M2.
import { getSetting, one } from './db.ts'
import { DEFAULTS } from './config.ts'
import { FINISHED } from './readiness.ts'
/** Tickets whose engineer is being started right now (launchEngineer adds and removes them). */
export const starting = new Set<string>()
/** Whether another engineer may start. The parallel limit counts engineers still working a ticket, not finished ones
 *  (pushed / PR open / merged) that sit idle until their PR merges, plus launches still under way. */
export function canLaunch(): { ok: boolean; why?: string; free: number } {
  const cap = getSetting('concurrency_cap', DEFAULTS.concurrency_cap)
  const running = one<{ c: number }>(`SELECT COUNT(*) AS c FROM agents a LEFT JOIN tickets t ON t.id = a.ticket_id WHERE a.role = 'engineer' AND a.status != 'exited' AND (t.status IS NULL OR t.status NOT IN (${FINISHED.map(() => '?').join(',')}))`, ...FINISHED)!.c + starting.size
  const free = Math.max(0, cap - running)
  if (!free) return { ok: false, why: `Parallel limit reached (${running}/${cap})`, free }
  const paused = getSetting<string[]>('paused_roles', []); if (paused.includes('engineer')) return { ok: false, why: 'Engineer role is paused (model fallback or usage limit)', free: 0 }
  const u = one<{ fh: number | null; sd: number | null }>('SELECT MAX(five_hour_pct) fh, MAX(seven_day_pct) sd FROM usage_samples WHERE at > ?', Date.now() - 600_000)
  if ((u?.fh ?? 0) >= getSetting('pause_five_hour_pct', DEFAULTS.pause_five_hour_pct)) return { ok: false, why: `Five-hour usage at ${u?.fh}%`, free: 0 }
  if ((u?.sd ?? 0) >= getSetting('pause_seven_day_pct', DEFAULTS.pause_seven_day_pct)) return { ok: false, why: `Seven-day usage at ${u?.sd}%`, free: 0 }
  return { ok: true, free }
}
