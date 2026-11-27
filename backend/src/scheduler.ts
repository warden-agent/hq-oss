// M1: capacity/pause checks. Dependencies are enforced in launchEngineer; overlap prediction arrives in M2.
import { getSetting, one } from './db.ts'
import { DEFAULTS } from './config.ts'
import { FINISHED, LIMIT_REACHED } from './readiness.ts'
/** Tickets whose engineer is being started right now (launchEngineer adds and removes them). */
export const starting = new Set<string>()
/** Whether another engineer may start. The parallel limit counts engineers still working a ticket, not finished ones
 *  (pushed / PR open / merged) that sit idle until their PR merges, plus launches still under way. `ignoreCap`: only the pause
 *  and usage checks (Fix conflicts may go one over the limit; the user asked for it). */
export function canLaunch(o: { ignoreCap?: boolean } = {}): { ok: boolean; why?: string; free: number } {
  const cap = getSetting('concurrency_cap', DEFAULTS.concurrency_cap)
  const running = one<{ c: number }>(`SELECT COUNT(*) AS c FROM agents a LEFT JOIN tickets t ON t.id = a.ticket_id WHERE a.role = 'engineer' AND a.status != 'exited' AND (t.status IS NULL OR t.status NOT IN (${FINISHED.map(() => '?').join(',')}))`, ...FINISHED)!.c + starting.size
  const free = Math.max(0, cap - running)
  if (!free && !o.ignoreCap) return { ok: false, why: `${LIMIT_REACHED} (${running}/${cap})`, free }
  const paused = getSetting<string[]>('paused_roles', [])
  if (paused.includes('engineer')) return { ok: false, why: 'Engineers are paused (one switched models by itself): press Resume on that notice in the ⚠ menu first', free: 0 }
  const u = one<{ fh: number | null; sd: number | null }>('SELECT MAX(five_hour_pct) fh, MAX(seven_day_pct) sd FROM usage_samples WHERE at > ?', Date.now() - 600_000)
  const why = overPause(u?.fh, u?.sd, pauseLevels()); if (why) return { ok: false, why, free: 0 }
  return { ok: true, free }
}

/** The usage (in %) at which HQ stops starting new agents, as the user set it or HQ's default. */
export const pauseLevels = (): { five: number; seven: number } =>
  ({ five: getSetting('pause_five_hour_pct', DEFAULTS.pause_five_hour_pct), seven: getSetting('pause_seven_day_pct', DEFAULTS.pause_seven_day_pct) })
/** Bug 160: which usage figures are at their pause, in words ("Weekly usage at 91%"), or null. Claude Code's usage report
 *  (`session.measure`) has only the limits the account has, and the one HQ runs on has only ever sent the weekly (seven_day) one.
 *  So only figures that came are named, and a missing one never counts as 0% (a pause set to 0 would stop everything "at null%"). */
export function overPause(fh: number | null | undefined, sd: number | null | undefined, at: { five: number; seven: number }): string | null {
  const over: string[] = [], has = (n: number | null | undefined): n is number => n != null && Number.isFinite(n)
  if (has(fh) && fh >= at.five) over.push(`5-hour usage at ${Math.round(fh)}%`)
  if (has(sd) && sd >= at.seven) over.push(`${over.length ? 'weekly' : 'Weekly'} usage at ${Math.round(sd)}%`)
  return over.length ? over.join(' and ') : null
}
/** Bug 160: what setting the 5-hour pause answers (ui.ts) when no 5-hour figure comes. */
export const NO_FIVE_HOUR = 'Claude Code sends no 5-hour usage figure for this account (its latest usage report had only the weekly one), '
  + 'so the 5-hour pause can\'t act: only the weekly pause (pause_seven_day_pct) stops new launches.'
/** Bug 160: whether Claude Code's latest usage report had a weekly figure but no 5-hour one. The limits are the account's, so
 *  then HQ's 5-hour pause can't act: only the weekly one stops new launches. */
export function noFiveHourFigure(): boolean {
  const r = one<{ fh: number | null }>('SELECT five_hour_pct fh FROM usage_samples WHERE five_hour_pct IS NOT NULL OR seven_day_pct IS NOT NULL ORDER BY id DESC LIMIT 1')
  return !!r && r.fh == null
}
