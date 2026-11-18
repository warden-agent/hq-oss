// The findings loop's rules (Part 5). At the end of an auto run the UI tester (Part 4) and the backend checker (backendcheck.ts) report what they found; HQ keeps
// each finding across runs, the user decides what happens to it, the TPM turns the ones sent into fix tickets, and the next run replays each one to see if
// it's fixed. Nothing is fixed without the user, and HQ's code (not a model) decides what counts as the same finding, fixed, or broken twice.
// Pure: no DB, no processes. The page imports it too, for the words.
import type { Expect, Flag, Step } from './loopinputs.ts'

/** Where a finding was seen: on the screen (the UI tester), behind it (the backend checker against a backend criterion), or somewhere no criterion covers. */
export type Source = 'ui' | 'backend' | 'unspecified'
/** What the user said. fix: make a ticket for it. ignore: never report it again. rule (unspecified only): it should be a rule, in the user's words, and a
 *  ticket makes the app follow it. fine: it's fine as it is (also never reported again). */
export type Decision = 'fix' | 'ignore' | 'rule' | 'fine'
/** Where a finding is. new: waiting for the user. sent: the user sent it; the TPM is to make its ticket. fixing: its ticket is made. fixed: the replay
 *  showed it gone. closed: ignored or fine. flagged: broken after two fix tickets; HQ won't make a third (the user decides). */
export type State = 'new' | 'sent' | 'fixing' | 'fixed' | 'closed' | 'flagged'
/** One look at whether a sent finding was fixed, made in the run its ticket merged in. `how`: replayed as a script, retried by the tester because the script
 *  couldn't run, or judged by the checker from the replay's recording. `result: unknown`: nothing could tell (no test setup, the app wouldn't start). */
export type Check = { run: string; at: number; result: 'fixed' | 'broken' | 'unknown'; how: 'replay' | 'retry' | 'checker'; why: string }
/** `goal`: the scenario's goal in the UI tester's own words, the only thing about a backend finding a retry may tell the tester (the rest is the checker's). */
export type Evidence = { scenario: string; goal?: string; recording?: string; rows: string[]; flags: Flag[] }
export type Kept = {
  id: string; repo_id: string; first_run: string; runs: string[]; source: Source
  /** Who wrote it: the code-blind UI tester, or the checker, who read the code. Only the tester's own words may go back to the tester. */
  by: 'tester' | 'checker'
  /** Why it's back with the user when that isn't a replay: its fix ticket was cancelled, or a fixed one was seen again. */
  back?: string
  /** What's wrong, what should happen instead, as the tester or checker said it; `wording`: the user's edit, used from then on. */
  what: string; expected: string; wording?: string
  /** The criterion it breaks ("T-03 A2"), or none (unspecified). */
  criterion?: string
  steps: Step[]; expect?: Expect[]; evidence: Evidence; key: string
  decision?: Decision; rule?: string; decided_at?: number; sent_at?: number
  /** Tickets made for it, oldest first. Each ticket that didn't fix it is a strike: two, and HQ stops making tickets for it. */
  tickets: string[]; strikes: number; checks: Check[]; state: State
}
/** What a run's tester or checker found, before HQ keeps it. */
export type Fresh = Omit<Kept, 'id' | 'repo_id' | 'first_run' | 'runs' | 'key' | 'tickets' | 'strikes' | 'checks' | 'state' | 'wording' | 'decision' | 'rule' | 'decided_at'
  | 'sent_at' | 'back'>

export const MAX_STRIKES = 2
export const MAX_PER_RUN = 30
const squash = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 :/_-]/g, '').trim()
/** A step in a few words of code: what it acts on, not what it typed (a value typed differently is the same place in the app). */
export const target = (s: Step): string => s.action === 'navigate' ? `go:${squash(s.url).replace(/\?.*$/, '')}` : s.action === 'back' ? 'back'
  : s.css && !s.role && !(s.name ?? s.text) ? `${s.action}:css:${squash(s.css)}:${s.nth ?? 0}` : `${s.action}:${squash(s.role)}:${squash(s.name ?? s.text)}`
/** What makes two findings the same one, whatever words the model used: computed from the steps, the flag and the criterion, never from the text.
 *  A flag-led backend finding is its flag on its endpoint. Anything else is its source, its criterion and the last two places its steps acted on. */
export function findingKey(f: Pick<Kept, 'source' | 'criterion' | 'steps' | 'evidence'>): string {
  const flag = f.source !== 'ui' ? f.evidence.flags[0] : undefined
  if (flag?.path) return [f.source, flag.kind, `${flag.method ?? ''} ${flag.path}`.trim()].join('|')
  const where = f.steps.filter((s) => s.action !== 'fill' || s.role || s.name).slice(-2).map(target).join('>')
  return [f.source, squash(f.criterion) || '-', where || '-'].join('|')
}

/** Keeps what a run found: new findings get ids, and a finding HQ already has (the same key) gets this run added, not a second entry. One the user ignored or
 *  called fine is dropped: it's never reported again. One whose ticket is on its way is dropped too: the replay will tell. `next`: the next id number. */
export function take(have: Kept[], found: Fresh[], o: { repoId: string; runId: string; next: number }): { add: Kept[]; seen: Kept[]; dropped: number } {
  const add: Kept[] = [], seen: Kept[] = []; let dropped = 0, n = o.next
  for (const f of found) {
    const key = findingKey(f), same = [...have, ...add].find((k) => k.key === key)
    if (same) {
      if (same.state === 'new' && !same.runs.includes(o.runId)) seen.push({ ...same, runs: [...same.runs, o.runId] })
      else if (same.state === 'fixed') { // it came back after its fix held: as good as a replay that failed (a strike, two flag it)
        const back = afterCheck(same, { run: o.runId, at: Date.now(), result: 'broken', how: 'replay', why: 'a fresh pass found it again after it was fixed' })
        seen.push({ ...back, runs: [...same.runs, o.runId], back: `it was fixed, and a fresh pass in a later run found it again` })
      } else dropped++
      continue
    }
    if (add.length >= MAX_PER_RUN) { dropped++; continue }
    add.push({ ...f, id: `P-${n++}`, repo_id: o.repoId, first_run: o.runId, runs: [o.runId], key, tickets: [], strikes: 0, checks: [], state: 'new' })
  }
  return { add, seen, dropped }
}

/** The user's decision on a finding, or why it can't be taken. Wording and the rule are the user's own words; a rule is checked like a criterion by `ruleProblem`. */
export function decide(k: Kept, d: Decision | null, o: { wording?: string; rule?: string }, ruleProblem: (text: string) => string | null): Kept | { error: string } {
  if (k.state === 'flagged' && d !== 'ignore' && d !== null) {
    return { error: `${k.id} was still broken after ${MAX_STRIKES} fix tickets, so HQ won't make another: ignore it, or tell the TPM what to do.` }
  }
  if (k.state !== 'new' && k.state !== 'flagged') return { error: `${k.id} isn't waiting for you (it's ${STATE_WORDS[k.state]}).` }
  if (d === 'rule' && k.source !== 'unspecified') return { error: `${k.id} already breaks a criterion (${k.criterion}): Fix it, or ignore it.` }
  const wording = o.wording?.replace(/\s+/g, ' ').trim()
  if (wording !== undefined && wording.length < 10) return { error: 'Say what is wrong in a sentence (at least 10 characters), or leave the wording as it was.' }
  if (wording && wording.length > 600) return { error: 'Keep the wording under 600 characters.' }
  let rule: string | undefined
  if (d === 'rule') {
    rule = (o.rule ?? k.rule ?? '').replace(/\s+/g, ' ').trim()
    if (!rule) return { error: 'Write the rule: what should be true, checkable from outside ("when X happens, Y is true").' }
    const bad = ruleProblem(rule); if (bad) return { error: bad }
  }
  const { decision: _d, rule: _r, decided_at: _a, ...rest } = k
  return { ...rest, ...(wording !== undefined ? { wording } : {}), ...(d ? { decision: d, decided_at: Date.now() } : {}), ...(rule ? { rule } : {}) }
}
/** The findings Send sends: decided Fix or rule, waiting for the user. Ignore and fine close at once on Send too (a flagged one can only be ignored). */
export function toSend(all: Kept[]): { send: Kept[]; close: Kept[] } {
  const waiting = all.filter((k) => (k.state === 'new' || k.state === 'flagged') && k.decision)
  return { send: waiting.filter((k) => k.decision === 'fix' || k.decision === 'rule'), close: waiting.filter((k) => k.decision === 'ignore' || k.decision === 'fine') }
}

/** What a look at a fixed finding means for it. Fixed: done. Broken: a strike for its ticket; with two, it's flagged for the user and no third ticket is
 *  made, else it waits for the user again ("still broken"). Unknown: nothing changes; the next run looks again. */
export function afterCheck(k: Kept, c: Check): Kept {
  const checks = [...k.checks.filter((x) => x.run !== c.run), c]
  if (c.result === 'unknown') return { ...k, checks }
  if (c.result === 'fixed') return { ...k, checks, state: 'fixed' }
  const strikes = k.tickets.length // each merged ticket that didn't fix it is a strike
  const { decision: _d, decided_at: _a, sent_at: _s, ...rest } = k
  return { ...rest, checks, strikes, state: strikes >= MAX_STRIKES ? 'flagged' : 'new' }
}
/** The finding a fix ticket was for, once that ticket is gone (cancelled, removed, or its run undone): back with the user, without the strike a merged fix
 *  that didn't hold would count. Null when the ticket isn't one of its tickets, or the finding is already settled. */
export function ticketGone(k: Kept, key: string, why: string): Kept | null {
  if (!k.tickets.includes(key) || !['sent', 'fixing', 'fixed'].includes(k.state)) return null
  const tickets = k.tickets.filter((t) => t !== key), { decision: _d, decided_at: _a, sent_at: _s, ...rest } = k
  return { ...rest, tickets, strikes: Math.min(k.strikes, tickets.length), state: 'new', back: why }
}
/** Did the UI tester write it (its own words may go back to it on a retry)? Findings kept before `by` existed: the UI ones were the tester's. */
export const fromTester = (k: Pick<Kept, 'by' | 'source'>): boolean => (k.by ?? (k.source === 'ui' ? 'tester' : 'checker')) === 'tester'
/** Findings whose replay is due: their tickets are all merged, and no look has been made since the last one merged. */
export function dueForReplay(all: Kept[], merged: (key: string) => number | null): Kept[] {
  return all.filter((k) => k.state === 'fixing' && k.tickets.length > 0).filter((k) => {
    const at = k.tickets.map(merged); if (at.some((x) => x == null)) return false
    const last = Math.max(...(at as number[])); return !k.checks.some((c) => c.at >= last && c.result !== 'unknown')
  })
}

/** Did the replay's recording still show what the finding was about? In code, where it can be: a flag-led finding is fixed when the replay has no flag of
 *  the same kind on the same endpoint; one with `expect` is fixed when every expect held. null: code can't tell (the checker judges the recording). */
export function judgeInCode(k: Kept, rec: { flags: Flag[]; expect?: { ok: boolean; why?: string }[] }): { result: 'fixed' | 'broken'; why: string } | null {
  const flag = k.evidence.flags[0]
  if (k.source !== 'ui' && flag?.path) {
    const again = rec.flags.find((f) => f.kind === flag.kind && f.path === flag.path && (f.method ?? '') === (flag.method ?? ''))
    if (again) return { result: 'broken', why: `the replay showed it again: ${again.why}` }
    return { result: 'fixed', why: `the replay made the same calls with no ${flag.kind} flag on ${flag.method ?? ''} ${flag.path}`.replace('  ', ' ') }
  }
  if (k.expect?.length && rec.expect?.length === k.expect.length) {
    const bad = rec.expect.findIndex((e) => !e.ok)
    return bad < 0 ? { result: 'fixed', why: 'the replay ended with the page as it should be' } : { result: 'broken', why: `after the same steps, ${expectWords(k.expect[bad]!)} is still not true` }
  }
  return null
}

const q = (s?: string): string => s ? `"${s}"` : ''
const TAGS: Record<string, string> = { button: 'button', a: 'link', input: 'box', textarea: 'box', select: 'list', option: 'option', li: 'list item', tr: 'row',
  td: 'cell', img: 'image', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', label: 'label', summary: 'button' }
/** The element itself in a CSS selector: its last compound part (`li:has-text("Rice") button` → `button`), not what it sits in. */
function lastPart(sel: string): string {
  let start = 0, depth = 0, quote = ''
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]!
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue }
    if (c === '"' || c === '\'') quote = c; else if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--
    else if (!depth && /[\s>+~]/.test(c)) start = i + 1
  }
  return sel.slice(start).trim() || sel.trim()
}
/** Which of its matches a step took, as words before the element: nothing for the first, "last ", "2nd "… */
export function ordinal(nth?: number): string {
  if (!nth) return ''
  const n = nth + 1, th = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
  return nth < 0 ? 'last ' : `${n}${th} `
}
// A selector HQ wrote from a locator chain (Bug 198: `internal:role=listitem >> internal:has-text="Rice"i >> internal:role=button[name="Remove"i]`), in words
const FILTERS = /^(internal:has(-not)?-text=|visible=|nth=)/
/** A text in such a selector: "Rice"i → "Rice"; a regex that is only a text (/^Rice$/) → "Rice"; any other regex as written. */
const textOf = (v: string): string => {
  const s = /^"((?:[^"\\]|\\.)*)"[is]?$/.exec(v); if (s) return q(s[1]!.replace(/\\(.)/g, '$1'))
  const r = /^\/\^?((?:[^\\/[\](){}*+?|.$^]|\\[^\w])*)\$?\/[a-z]*$/.exec(v); return r ? q(r[1]!.replace(/\\(.)/g, '$1')) : v
}
/** One part of it: internal:role=row[name="Dune"i] → row "Dune", internal:has-text="Rice"i → with "Rice", a plain selector as cssWords says its element. */
function partWords(p: string): string {
  const role = /^internal:role=([a-z]+)(.*)$/.exec(p), name = role && /\[name=(".*"[is]|\/.*\/[a-z]*)\]/.exec(role[2]!)
  if (role) return `${role[1]}${name ? ` ${textOf(name[1]!)}` : ''}`
  const t = /^internal:(has-text|has-not-text|text|label)=(.*)$/.exec(p)
  if (t) return `${t[1] === 'has-text' ? 'with ' : t[1] === 'has-not-text' ? 'without ' : ''}${textOf(t[2]!)}`
  const a = /^internal:(?:attr|testid)=\[[\w-]+=(.*)\]$/.exec(p); if (a) return textOf(a[1]!)
  if (p === 'visible=true') return '(shown)'
  return cssWords(p).replace(/^the /, '')
}
/** A chain's parts as words, a match taken half-way before the element it picks ("the 3rd row"). */
const partsWords = (ps: string[]): string => ps.reduce((out: string[], p) => {
  const n = /^nth=(-?\d+)$/.exec(p); if (!n) return [...out, partWords(p)]
  const at = Number(n[1]) === 0 ? 'first ' : ordinal(Number(n[1])); return out.length ? [...out.slice(0, -1), `${at}${out.at(-1)}`] : out
}, []).join(' ')
/** What a step's element sits in, from such a selector: " in the listitem with "Rice""; nothing for any other selector. */
export function within(css?: string): string {
  if (!css?.includes('internal:')) return ''
  const ps = css.split(' >> '); let i = ps.length - 1; while (i > 0 && FILTERS.test(ps[i]!)) i--
  return i > 0 ? ` in the ${partsWords(ps.slice(0, i))}` : ''
}
/** An element named by a selector (Bug 173), as a person would say it: `button:has-text("Remove")` → the "Remove" button, `li >> nth=1` → the 2nd
 *  "li"; else the selector itself. `nth`: which of its matches (0 the first, -1 the last); the first of several reads as just the one. One HQ wrote
 *  from a locator chain (Bug 198) reads as its element and what it sits in: the 3rd button in the listitem with "Dune". */
export function cssWords(css: string, nth?: number): string {
  if (css.includes('internal:')) {
    const ps = css.split(' >> '); let i = ps.length - 1; while (i > 0 && FILTERS.test(ps[i]!)) i--
    return `the ${ordinal(nth)}${partsWords(ps.slice(i))}${within(css)}`
  }
  const end = css.split(' >> ').filter((p) => !/^nth=-?\d+$/.test(p)).at(-1)?.trim() ?? css, el = /^text=/.test(end) ? end : lastPart(end)
  const said = /:(?:has-text|text-is|text)\((['"])(.*?)\1\)/.exec(el) ?? /\[(?:aria-label|title|placeholder|alt|value)=(['"])(.*?)\1\]/.exec(el)
    ?? /^text=(['"]?)(.+)\1$/.exec(el)
  const tag = TAGS[/^([a-z][a-z0-9]*)/.exec(el)?.[1] ?? ''], at = ordinal(nth)
  return said ? `the ${at}${q(said[2])}${tag ? ` ${tag}` : ''}` : tag && el === css.trim() && el === /^[a-z][a-z0-9]*/.exec(el)?.[0] ? `the ${at}${tag}`
    : `the ${at}${tag ? `${tag} ` : ''}${q(css)}`
}
/** A step as a person would say it: click the "Add" button. */
export function stepWords(s: Step): string {
  const at = ordinal(s.nth), inside = within(s.css), what = s.name ? `the ${at}${q(s.name)}${s.role ? ` ${s.role}` : ''}${inside}`
    : s.css && !s.role ? cssWords(s.css, s.nth) : s.text ? `the ${at}text ${q(s.text)}${inside}` : s.role ? `the ${at}${s.role}${inside}` : 'the page'
  switch (s.action) {
    case 'navigate': return `open ${s.url ?? '/'}`
    case 'back': return 'go back'
    case 'click': return `click ${what}`
    case 'check': return `tick ${what}`
    case 'fill': return `type ${q(s.text) || 'nothing'} into ${s.name ?? s.field ? `the ${q(s.name ?? s.field)} box${inside}` : s.css ? what : 'the box'}`
    case 'press': return `press ${s.text ?? 'Enter'}`
    case 'select': return `pick ${q(s.value)} in ${what}`
    case 'uncheck': return `untick ${what}`
    case 'hover': return `point at ${what}`
    case 'reset': return 'start again from a fresh app'
  }
}
export const expectWords = (e: Expect): string => `${e.name ? `the ${q(e.name)}${e.role ? ` ${e.role}` : ''}` : e.text ? `the text ${q(e.text)}` : e.role ? `the ${e.role}` : 'it'} ${
  e.visible ? 'shows' : 'is gone'}`
export const SOURCE_WORDS: Record<Source, string> = { ui: 'On the screen', backend: 'Behind the screen', unspecified: 'No criterion covers it' }
export const STATE_WORDS: Record<State, string> = { new: 'waiting for you', sent: 'sent to the TPM', fixing: 'being fixed', fixed: 'fixed', closed: 'closed', flagged: 'broken twice' }
export const said = (k: Kept): string => k.wording ?? k.what

/** What a fix ticket carries, under the TPM's spec: the finding, its steps, the criterion it breaks (or the user's new rule) and the evidence. */
export function ticketBlock(k: Kept): string {
  const lines = [`## Finding ${k.id} (${SOURCE_WORDS[k.source].toLowerCase()})`, `What's wrong: ${said(k)}`, `What should happen: ${k.expected}`,
    k.criterion ? `It breaks: ${k.criterion}` : '', k.rule ? `The user's rule: ${k.rule}` : '',
    k.strikes ? `A fix ticket (${k.tickets.join(', ')}) was merged and the replay still showed it: ${k.checks.at(-1)?.why ?? ''}. Find why that fix didn't hold.` : '',
    k.steps.length ? `\nSteps that show it (a fresh app, from its start page):\n${k.steps.map((s, i) => `${i + 1}. ${stepWords(s)}`).join('\n')}` : '',
    k.evidence.rows.length ? `\nWhat HQ recorded:\n${k.evidence.rows.map((r) => `    ${r}`).join('\n')}` : '',
    '\nAfter this merges, HQ replays these steps to check the fix.']
  return lines.filter(Boolean).join('\n')
}
/** The run summary's Findings section: what the replays showed, then what's new. Empty when there's nothing to say. */
export function findingLines(all: Kept[], runId: string): string[] {
  const checked = all.flatMap((k) => k.checks.filter((c) => c.run === runId).map((c) => ({ k, c })))
  const fixed = checked.filter((x) => x.c.result === 'fixed'), broken = checked.filter((x) => x.c.result === 'broken'), unknown = checked.filter((x) => x.c.result === 'unknown')
  const fresh = all.filter((k) => k.first_run === runId && k.state === 'new')
  const again = all.filter((k) => k.first_run !== runId && k.runs.includes(runId) && k.state === 'new' && !broken.some((b) => b.k.id === k.id))
  return [
    ...fixed.map(({ k }) => `- ✓ ${k.id} fixed: ${said(k)}`),
    ...broken.map(({ k, c }) => k.state === 'flagged' ? `- ⚑ ${k.id} still broken after ${k.tickets.length} fix tickets (${k.tickets.join(', ')}). `
      + `HQ won't make a third: it's yours to decide. ${c.why}`
      : `- ✗ ${k.id} still broken after ${k.tickets.at(-1)}: ${said(k)} (${c.why})`),
    ...unknown.map(({ k, c }) => `- ? ${k.id} couldn't be checked: ${c.why}`),
    ...fresh.map((k) => `- New ${k.id} (${SOURCE_WORDS[k.source].toLowerCase()}${k.criterion ? `, ${k.criterion}` : ''}): ${said(k)}`),
    ...again.map((k) => `- Seen again ${k.id}: ${said(k)}`),
  ]
}
