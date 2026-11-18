// Bug 142: what a repair of main's tests left out, for the run's summary. A repair can keep the test command and change what it runs (the npm script behind
// it, a file that script calls, a test removed). That lands like any other code, so the summary named nothing. Now HQ keeps the engineer's own words from
// two places: a proposal of the command HQ already runs (answered "that's already it", so nothing else keeps them), and the "## Tests left out" section a
// repair's open_pr must have. Both are kept on the ticket in `docs`, so they outlive the event and a restart; the summary lists a merged repair's words.
import { one, run, now } from './db.ts'
import { j } from './util.ts'

export const LEFT_OUT_HEADING = '## Tests left out'
/** What every repair is asked for at open_pr, in its spec and in the refusal: one line, so the two say the same. */
export const LEFT_OUT_ASK = `put a "${LEFT_OUT_HEADING}" section in its body: exactly which tests no longer run once your branch is in (removed, skipped, `
  + 'or no longer in what a script runs) and why, or "Nothing". The user reads it in the run\'s summary.'
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
/** "Nothing", the word the spec asks for when every test still runs, and its usual spellings. Anything longer is the engineer's words and is shown. */
export const saysNothing = (s: string): boolean => /^(nothing|none|n\/a|nothing left out|no tests? left out)[.!]?$/i.test(squash(s))

/** The words under the body's "## Tests left out" heading, up to the next heading; null when there's no such section or it's empty. */
export function leftOutSection(body: string): string | null {
  const lines = body.split('\n'), at = lines.findIndex((l) => /^##\s+tests left out\s*:?\s*$/i.test(l.trim()))
  if (at < 0) return null
  const end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l))
  const text = lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim()
  return text || null
}

type Proposed = { cmd: string; left_out: string; at: number }
/** A proposal of the command HQ already runs: kept on the ticket (the newest one), as the summary's source when the command stays the same. */
export function keepProposed(ticketId: string, cmd: string, leftOut: string): void {
  const text = JSON.stringify({ cmd: squash(cmd), left_out: leftOut.trim(), at: now() } satisfies Proposed)
  run("INSERT INTO docs(scope, key, text, updated_at) VALUES (?, 'left_out', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
    `ticket:${ticketId}`, text, now())
}
const doc = (ticketId: string, key: string): string | null =>
  one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', `ticket:${ticketId}`, key)?.text ?? null

const MAX = 1500
/** The engineer's words in a list item: one line goes after the colon (a list mark of its own dropped), more go under it, indented, so a heading or a list in
 *  them stays inside the item. Long words are cut, saying where the rest is. */
function words(s: string, rest: string): string {
  const t = s.replace(/\n\s*\n+/g, '\n').trim(), cut = t.length > MAX ? `${t.slice(0, MAX).trimEnd()}… (the rest is in ${rest})` : t, lines = cut.split('\n').map((l) => l.trim())
  return lines.length === 1 ? ` ${lines[0]!.replace(/^[-*]\s+/, '')}` : `\n${lines.map((l) => `  ${l}`).join('\n')}`
}
/** The summary's lines for the repairs that merged in a run: what each one's engineer said it left out, in a proposal HQ answered and in its PR.
 *  "Nothing" isn't listed, nor the same words twice. A repair finished before this existed has neither and isn't listed. */
export function leftOutLines(repairs: { id: string; key: string }[]): string[] {
  return repairs.flatMap((t) => {
    const p = j<Proposed | null>(doc(t.id, 'left_out'), null), pr = leftOutSection(doc(t.id, 'pr') ?? '')
    const said = [p && !saysNothing(p.left_out) ? { how: `when it proposed \`${p.cmd}\``, text: p.left_out, rest: 'its proposal' } : null,
      pr && !saysNothing(pr) ? { how: 'in its PR', text: pr, rest: 'its PR' } : null].filter((x) => x !== null)
    return said.filter((x, i) => !said.slice(0, i).some((y) => squash(y.text) === squash(x.text))).map((x) => `- ${t.key}, ${x.how}:${words(x.text, x.rest)}`)
  })
}
