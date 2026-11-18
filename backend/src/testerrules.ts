// The tester (tester.ts): at the end of an auto run, one agent tries what the run built the way a person would, in a real browser, through tools HQ gives it
// (testermcp.mjs). Passing tests and a page that loads don't say the button is there or the flow makes sense. These are its rules: which features it tries,
// what it is told, what of its report HQ keeps, and the words for the run's summary. Pure: no DB, no processes.
import type { Criterion } from './criteria.ts'

/** A feature the run touched and what to try on it: the screen criteria of its tickets that merged in the run, each named by ticket and id ("T-03 A2"). */
export type ToTry = { featureId: string; handle: string; title: string; tickets: string[]; criteria: { id: string; text: string }[] }
export type Problem = { criterion: string; what: string; steps: string[] }
/** How the try of one feature ended, kept with the run. `tried`: what the agent says it tried, the problems it saw, and what it cost. `skipped`: HQ couldn't
 *  have it tried, and why (`quiet`: it's how the project is set up, as for HQ's look: not news for every run's summary).
 *  `tickets`: the merged tickets this covers, so a run that goes on after it doesn't try them twice. */
export type Tried = { feature: string; title: string; tickets: string[] } & (
  { state: 'tried'; tried: string[]; problems: Problem[]; actions: number; ms: number; tokens: number; model: string }
  | { state: 'skipped'; why: string; quiet?: boolean })

export const MAX_FEATURES = 3, MAX_PROBLEMS = 5
type Merged = { id: string; key: string; feature_id: string; criteria: Criterion[] }
/** What to try now: per feature, the screen criteria of merged tickets nobody has tried yet (`covered`: ticket ids of earlier tries in this run). A feature
 *  whose merged tickets have no screen criteria has nothing to try in a browser. Oldest feature first. */
export function toTry(merged: Merged[], features: { id: string; handle: string | null; title: string }[], covered: Set<string>): ToTry[] {
  const out: ToTry[] = []
  for (const f of features) {
    const ts = merged.filter((t) => t.feature_id === f.id && !covered.has(t.id) && t.criteria.some((c) => c.kind === 'ui')); if (!ts.length) continue
    out.push({ featureId: f.id, handle: f.handle ?? f.title, title: f.title, tickets: ts.map((t) => t.id),
      criteria: ts.flatMap((t) => t.criteria.filter((c) => c.kind === 'ui').map((c) => ({ id: `${t.key} ${c.id}`, text: c.text }))) })
  }
  return out
}

export const TESTER_SYSTEM = `You test a web app the way a person would use it, through the browse tools: open a page, click, type. Each tool answers with the page as
text. You are given the acceptance criteria of what was just built. Try each one for real and see whether the app does what it says.

Rules:
- You have a fixed number of actions (each open, click or type is one). Plan them: don't repeat a check, and don't explore what no criterion is about.
- Report only what you saw. A problem names the criterion it is about, says what you saw and what the criterion says should happen, and lists the steps that
  show it. If you couldn't try a criterion (its page or button isn't there, or you ran out of actions), say that as a problem too.
- Nothing about looks you can't see in the page's text, and nothing about how you would have built it.
- When you have tried every criterion, or have no actions left, call done once. Then stop.`
export function testerPrompt(f: ToTry, cap: number, today: string): string {
  return `## What was built: ${f.title}\n${f.criteria.map((c) => `- ${c.id} (screen): ${c.text}`).join('\n')}\n\nThe app's start page is "/". You have ${cap} actions. Today is ${today}.\n`
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const line = (s: unknown, max: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
/** What HQ keeps of the agent's report, whatever it wrote: at most five problems, each about one of the criteria it was given (by its full name, or by
 *  its id alone when only one ticket has that id), each with something to say; steps and what it tried cut to a size that fits a summary. */
export function keepReport(raw: unknown, ids: string[]): { tried: string[]; problems: Problem[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { tried?: unknown; problems?: unknown }
  const known = (c: string): string | null => {
    const k = squash(c), full = ids.find((id) => squash(id) === k); if (full) return full
    const same = ids.filter((id) => squash(id.split(' ').at(-1) ?? '') === k); return same.length === 1 ? same[0]! : null
  }
  const problems: Problem[] = []
  for (const p of Array.isArray(r.problems) ? r.problems as Record<string, unknown>[] : []) {
    const criterion = known(String(p?.criterion ?? '')), what = line(p?.what, 400)
    if (criterion && what.length >= 10 && problems.length < MAX_PROBLEMS) {
      problems.push({ criterion, what, steps: (Array.isArray(p.steps) ? p.steps : []).map((s) => line(s, 120)).filter(Boolean).slice(0, 8) })
    }
  }
  return { tried: (Array.isArray(r.tried) ? r.tried : []).map((s) => line(s, 160)).filter(Boolean).slice(0, 12), problems }
}

const things = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
/** The run summary's lines for what the tester did: one per feature, and under it each problem with its steps. */
export function triedLines(all: Tried[]): string[] {
  return all.flatMap((t) => {
    const name = `${t.feature} ${t.title}`.trim()
    if (t.state === 'skipped') return t.quiet ? [] : [`- ${name}: not tried: ${t.why}`]
    const head = `- ${name}: tried ${things(t.tried.length, 'thing')} in ${things(t.actions, 'action')}, ${t.problems.length ? `found ${things(t.problems.length, 'problem')}` : 'found nothing wrong'}`
    return [head, ...t.problems.map((p) => `  - ${p.criterion}: ${p.what}${p.steps.length ? ` (${p.steps.join(' → ')})` : ''}`)]
  })
}
export const triedOf = (json: string | null | undefined): Tried[] => { try { const v = json ? JSON.parse(json) as unknown : []; return Array.isArray(v) ? v as Tried[] : [] } catch { return [] } }
