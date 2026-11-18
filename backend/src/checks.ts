// What auto mode's two readers found (checker.ts): the records HQ keeps of a plan check (plancheck.ts) and of a diff check (diffcheck.ts), and the words for
// them on the page and in a run's summary. Pure: no DB, no processes. The page imports it.

/** One thing a reader found. `about`: the criterion it is about (A2), or the check's own word for something no criterion covers ("extra" in a plan, "bug"
 *  in a diff). `problem`: what is wrong and what to do instead, in a sentence or two. */
export type Finding = { about: string; problem: string }
type Cost = { at: number; ms: number; tokens: number; model: string }
/** How a plan's check went, kept with the plan (plan_revisions.check_result) and sent to the page with its review. `checking`: the reader has it now.
 *  `ok`: nothing found. `sent_back`: these findings went to the engineer. `unchecked`: HQ approved it without a reader, and why. */
export type PlanCheck = { state: 'checking'; since: number } | ({ state: 'ok' } & Cost) | ({ state: 'sent_back'; findings: Finding[] } & Cost) | { state: 'unchecked'; at: number; why: string }
/** How the check of a finished ticket's changes went, kept with the ticket (tickets.diff_check). `why`: what made HQ ask for a reader (its size, what git
 *  flagged). `ok`: nothing found. `sent_back`: these findings went to the engineer, once; the ticket merges on its next pass without another read.
 *  `unchecked`: the reader couldn't be asked, and why; the ticket merged on its tests. */
export type DiffCheck = ({ state: 'ok'; why: string[] } & Cost) | ({ state: 'sent_back'; why: string[]; findings: Finding[] } & Cost) | { state: 'unchecked'; at: number; why: string[]; error: string }

const parse = <T>(json: unknown): T | null => { try { return typeof json === 'string' && json ? JSON.parse(json) as T : null } catch { return null } }
export const planCheckOf = (json: unknown): PlanCheck | null => { const c = parse<PlanCheck>(json); return c && typeof c.state === 'string' ? c : null }
export const diffCheckOf = (t: { diff_check?: string | null }): DiffCheck | null => { const c = parse<DiffCheck>(t.diff_check); return c && typeof c.state === 'string' ? c : null }
/** "- A3: No step builds the label." */
export const findingLines = (fs0: Finding[]): string => fs0.map((f) => `- ${f.about}: ${f.problem}`).join('\n')
const inLine = (fs0: Finding[]): string => fs0.map((f) => `${f.about}: ${f.problem}`).join(' ')

/** One line for a run's summary when a ticket's plan check is worth knowing about: it sent the plan back (and what it found), or the plan was never read.
 *  `all`: the ticket's plan checks, newest plan first. A clean check says nothing. */
export function planCheckLine(all: PlanCheck[]): string | null {
  const back = all.find((c) => c.state === 'sent_back'), un = all.find((c) => c.state === 'unchecked')
  if (back?.state === 'sent_back') return `its plan was sent back once (${inLine(back.findings)})`
  return un?.state === 'unchecked' ? `its plan wasn't checked: ${un.why}` : null
}
/** The same for its diff check: it sent the ticket back, or couldn't run. */
export function diffCheckLine(c: DiffCheck | null): string | null {
  if (c?.state === 'sent_back') return `HQ's read of its changes sent it back once (${inLine(c.findings)})`
  return c?.state === 'unchecked' ? `its changes weren't read before it merged: ${c.error}` : null
}
type Words = { text: string; tone: 'ok' | 'look' | 'none'; findings: Finding[] }
/** A plan check in words, for the Ticket tab. */
export function planCheckWords(c: PlanCheck | null): Words | null {
  if (!c) return null
  if (c.state === 'checking') return { text: 'A fresh reader is checking its plan against the criteria now.', tone: 'none', findings: [] }
  if (c.state === 'ok') return { text: 'A fresh reader checked its plan against the criteria and found nothing missing and nothing extra.', tone: 'ok', findings: [] }
  if (c.state === 'sent_back') return { text: 'A fresh reader checked its plan against the criteria and sent it back once:', tone: 'look', findings: c.findings }
  return { text: `Its plan was approved without a check: ${c.why}.`, tone: 'look', findings: [] }
}
/** A diff check in words, for the Ticket tab. */
export function diffCheckWords(c: DiffCheck | null): Words | null {
  if (!c) return null
  const why = c.why.length ? ` (${c.why.join('; ')})` : ''
  if (c.state === 'ok') return { text: `A fresh reader read its changes before it merged${why} and found nothing wrong.`, tone: 'ok', findings: [] }
  if (c.state === 'sent_back') return { text: `A fresh reader read its changes${why} and sent it back once:`, tone: 'look', findings: c.findings }
  return { text: `Nobody read its changes before it merged${why}: ${c.error}.`, tone: 'look', findings: [] }
}
