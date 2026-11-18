// HQ's look at the built app before an auto merge: passing tests say the code does what the tests say, not that the page loads. HQ starts the app from its
// launch recipe with the ticket merged in and opens its pages in a headless browser (smoke.ts, smokerun.mjs). These are the rules for what that look saw:
// what counts as a problem, what is the ticket's doing and not something main already had, and what HQ says about it. No model, no tokens.
// Pure: no DB, no files, no processes. The page imports it for its words.

/** One page as the browser saw it. `text`: characters of visible text; `things`: images, buttons, fields and the like. `console`: console.error lines;
 *  `errors`: uncaught errors; `failed`: requests to the app itself that got no answer; `bad`: its answers of 400 and up; `outside`: other sites the page asked
 *  for, which HQ's browser can't reach (it has no internet); `load`: why the page itself didn't load. */
export type PageSeen = { path: string; title: string; text: number; things: number; console: string[]; errors: string[]; failed: { url: string; why: string }[]
  bad: { status: number; method: string; url: string }[]; outside: string[]; load?: string }
/** What one run of the app showed. `looked`: it started and HQ opened its pages. `no_start`: it never answered (`output`: what it printed). `skipped`: HQ
 *  couldn't look at all (a port the app always uses is taken, the browser didn't start): nothing about the code. */
export type Seen = { kind: 'looked'; pages: PageSeen[]; ms: number } | { kind: 'no_start'; why: string; output: string } | { kind: 'skipped'; why: string }
export type Problem = { page: string; text: string }
/** How the look ended, kept with the ticket's merge. `pass`: nothing wrong that main didn't already have (`known`: how many problems it shares with main;
 *  `offline`: sites its pages load from that HQ's browser couldn't reach, so what those pages logged wasn't judged). `fail`: the ticket goes back. `skipped`:
 *  HQ couldn't look, and says why; never the ticket's fault (`quiet`: it's how the project is set up, not something that went wrong this time; `dead`: the app
 *  doesn't start on main in HQ's sandbox, with or without the ticket, so there is nothing to compare a ticket with until that changes). */
export type Look = { ran: 'pass'; pages: number; ms: number; known: number; offline: string[] } | { ran: 'fail'; why: string; problems: Problem[]; output?: string }
  | { ran: 'skipped'; why: string; quiet?: boolean; dead?: boolean }

const cut = (s: string, n = 240): string => { const one = s.replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one }
/** What's wrong with one page. A page that loads from another site can't be judged by what it logged or by looking blank: HQ's browser has no internet, so
 *  a library from a CDN never arrives and everything after it fails. Its own server's answers still count. */
export function problemsOf(p: PageSeen): Problem[] {
  const at = (text: string): Problem => ({ page: p.path, text: cut(text) })
  if (p.load) return [at(`didn't load: ${p.load}`)]
  const own = [...p.bad.map((b) => at(`${b.method} ${b.url} answered ${b.status}`)), ...p.failed.map((f) => at(`${f.url} got no answer${f.why ? ` (${f.why})` : ''}`))]
  if (p.outside.length) return own
  return [...own, ...p.errors.map((e) => at(`error on the page: ${e}`)), ...p.console.map((c) => at(`error in the console: ${c}`)),
    ...(!p.text && !p.things ? [at('the page is blank: no text, and nothing to see or press')] : [])]
}
/** A problem's text without what changes from run to run: the port HQ picked, and long numbers (ids, times). */
const same = (x: Problem): string => `${x.page}\n${x.text.replace(/(localhost|127\.0\.0\.1|\[::1\]):\d+/g, 'localhost').replace(/\d{4,}/g, '#')}`
/** The problems main doesn't already have. */
export function newProblems(now: Problem[], before: Problem[]): Problem[] { const had = new Set(before.map(same)); return now.filter((x) => !had.has(same(x))) }
export const allProblems = (s: Seen): Problem[] => s.kind === 'looked' ? s.pages.flatMap(problemsOf) : []
/** Whether the look at main is needed to judge this one: only when something was wrong, so a clean app is opened once. */
export const needsBase = (ticket: Seen): boolean => ticket.kind === 'no_start' || allProblems(ticket).length > 0

/** The verdict on a ticket, from the look at main with it merged in and (when that showed something wrong) the look at main alone. Only what the ticket
 *  changed counts against it. `base`: `main` in words ("main", "origin/main"). */
export function judge(ticket: Seen, main: Seen | null, base: string): Look {
  if (ticket.kind === 'skipped') return { ran: 'skipped', why: ticket.why }
  if (main?.kind === 'skipped') return { ran: 'skipped', why: main.why }
  if (ticket.kind === 'no_start') {
    if (main?.kind === 'no_start') return { ran: 'skipped', why: `the app doesn't start on ${base} either (${main.why})`, dead: true }
    return { ran: 'fail', why: `The app doesn't start with it merged in: ${ticket.why}.`, problems: [], output: ticket.output }
  }
  const all = allProblems(ticket), fresh = main?.kind === 'looked' ? newProblems(all, allProblems(main)) : all
  const offline = [...new Set(ticket.pages.flatMap((p) => p.outside))].sort()
  if (!fresh.length) return { ran: 'pass', pages: ticket.pages.length, ms: ticket.ms, known: all.length, offline }
  return { ran: 'fail', why: `The app has ${fresh.length === 1 ? 'a problem' : `${fresh.length} problems`} with it merged in that ${base} doesn't have.`, problems: fresh }
}

/** The look's report for the engineer the ticket goes back to: what HQ did, and each problem with its page. */
export function lookReport(l: Extract<Look, { ran: 'fail' }>, how: string): string {
  const lines = l.problems.slice(0, 20).map((x) => `- ${x.page}: ${x.text}`), more = l.problems.length - lines.length
  return [`HQ started the app the way its preview does (${how}) and opened its pages in a headless browser.`, l.why, ...lines, more > 0 ? `- and ${more} more` : '',
    l.output ? `\nWhat the app printed:\n${l.output}` : ''].filter(Boolean).join('\n')
}
const pagesWord = (n: number): string => `${n} page${n === 1 ? '' : 's'}`
/** The look in words: a few for the run's summary and the merged box, the whole of it for the Ticket tab. Null: HQ kept no record (merged before it looked). */
export function lookWords(l: Look | null | undefined): { short: string; long: string; tone: 'ok' | 'look' } | null {
  if (!l) return null
  if (l.ran === 'skipped') return { short: `app not opened: ${l.why}`, long: `HQ didn't open the app before it merged: ${l.why}.`, tone: 'look' }
  if (l.ran === 'fail') return { short: 'app has problems', long: l.why, tone: 'look' }
  const known = l.known ? `; ${l.known} problem${l.known === 1 ? '' : 's'} it shares with what was there before` : ''
  const off = l.offline.length ? `; pages that load from ${l.offline.join(', ')} weren't judged by what they logged (HQ's browser has no internet)` : ''
  return { short: `app opened, ${pagesWord(l.pages)}`, long: `HQ opened the app with it merged in: ${pagesWord(l.pages)}, nothing new wrong${known}${off}.`, tone: l.offline.length ? 'look' : 'ok' }
}
