// Bug 128: the Agent tab's header read "5h ?%". Nothing said what 5h was, and the "?" looked like broken data. Claude Code reports how much of the
// plan's usage limits is used (`session.measure` → five_hour_pct / seven_day_pct), but only the windows the account has: on the plan HQ was tested
// on it has never sent a five-hour figure, only the seven-day one. So each figure is named in words, explained on hover, and left out when there's no number.
// Pure and self-contained, so the backend's test runner unit-tests it (src/usage.test.ts, agentheader.test.ts).

export type UsageAgent = { status?: string; five_hour_pct?: number | null; seven_day_pct?: number | null }
export type UsagePart = { key: 'five_hour' | 'seven_day'; text: string; tip: string }
type Settings = Record<string, unknown>

/** The usage (in %) at which HQ stops starting new agents (scheduler.ts), as the user set it or HQ's default. */
export function pauseAt(settings: Settings, defaults: Settings): { five: number; seven: number } {
  const pick = (k: string, d: number) => { const v = Number(settings[k] ?? defaults[k]); return Number.isFinite(v) ? v : d }
  return { five: pick('pause_five_hour_pct', 80), seven: pick('pause_seven_day_pct', 90) }
}

/** Bug 160: the weekly figure came without a 5-hour one. The limits are the account's, so HQ's 5-hour pause can never act there. */
const noFive = (at: number) => ` Claude Code sends no 5-hour figure for this account, so HQ's 5-hour pause (at ${at}%) can't act: only this weekly one stops new agents.`

/** What the header says about usage: one part per figure Claude Code reported, none for an exited agent (its last figure is old). */
export function usageParts(a: UsageAgent, pause: { five: number; seven: number }): UsagePart[] {
  if (a.status === 'exited') return []
  const out: UsagePart[] = []
  const add = (key: UsagePart['key'], pct: number | null | undefined, name: string, limit: string, at: number) => {
    if (pct == null || !Number.isFinite(Number(pct))) return
    out.push({ key, text: `${name} usage ${Math.round(Number(pct))}%`, tip: `How much of your Claude plan's ${limit} is used. `
      + `It's shared by every agent and your own Claude use. HQ stops starting new agents at ${at}%.${key === 'seven_day' && !out.length ? noFive(pause.five) : ''}` })
  }
  add('five_hour', a.five_hour_pct, '5-hour', '5-hour usage limit', pause.five)
  add('seven_day', a.seven_day_pct, 'weekly', 'weekly (7-day) usage limit', pause.seven)
  return out
}

/** A token count in thousands ("61k"). */
export const kTok = (n: number): string => `${Math.round(n / 1000)}k`

export type HeaderAgent = UsageAgent & { role: string; model_live?: string | null; model_alias?: string | null; context_tokens?: number | null }
/** Bug 161: the Agent tab's line under the agent's name, and whether the tab offers Stop. An exited agent has no live state, so no
 *  context figure (it's from its last session) and no Stop (nothing is running to stop); the line says why and when it ended instead
 *  (`ended`: api.ts endedLine). Each "·" stays with the word before it, so a wrapped line never starts with one. */
export function agentHeader(a: HeaderAgent, limit: number | null, ended: string | null): { who: string; stop: boolean } {
  const parts = [a.role, a.model_live ?? a.model_alias].filter(Boolean).map(String)
  if (a.status === 'exited') return { who: [...parts, ended ?? 'ended'].join('\u00a0· '), stop: false }
  if (a.context_tokens) parts.push(`context ${kTok(a.context_tokens)}${limit ? ` / ${kTok(limit)}` : ''}`)
  return { who: parts.join('\u00a0· '), stop: true }
}
