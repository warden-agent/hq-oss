// The UI tester's rules (uitester.ts): as an auto run ends, a code-blind tester uses the whole app in a real browser, the way a person would, and reports where
// a person would get stuck or confused. These are the shapes HQ keeps, what the tester is told, what of its answers HQ keeps, how a step it took becomes a
// step a script can replay, and the words for the run's summary. Pure: no DB, no processes.
import type { Criterion } from './criteria.ts'
import { cssWords, ordinal, within } from './findingrules.ts'
import { movedWords, type MovedPort } from './smokerules.ts'

export type ScenarioKind = 'basic' | 'weird' | 'complex' | 'retry'
/** One thing to try, written by the tester's planning call from the feature map and what's new (or, for `retry`, by HQ from a finding a replay couldn't
 *  reproduce by script: Part 5). `criteria`: the screen criteria it is about ("T-03 A2"). */
export type Scenario = { id: string; kind: ScenarioKind; title: string; goal: string; criteria?: string[] }
/** One step the tester took, as a script can replay it with no AI: built by HQ from the Playwright code the browser tools ran, never from the model's words.
 *  `code`: that line of code, for a replay that can't use the fields. `css`: the selector of an element the browser named by `locator('…')`, not by role or text
 *  (Bug 173), with `nth` the one of its matches it took (0 the first, -1 the last). */
export type Step = { action: 'navigate' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'hover' | 'back'; role?: string; name?: string; text?: string;
  label?: string; css?: string; nth?: number; value?: string; url?: string; code: string }
/** What the tester expected to see at a finding, checked by HQ in the page text it last read: is that element there? */
export type Expect = { role?: string; name?: string; text?: string; visible: boolean }
export const FINDING_KINDS = ['stuck', 'confusing', 'unclear_label', 'no_feedback', 'broken', 'missing'] as const
export type FindingKind = typeof FINDING_KINDS[number]
/** A place a person would get stuck or confused, with the steps that lead there (the scenario's steps up to the moment it happened). */
export type UiFinding = { id: string; scenario: string; kind: FindingKind; what: string; expected: string; steps: Step[]; criterion?: string; expect?: Expect[] }
/** One step of the tester's log as HQ recorded it: when it began (HQ's clock), the browser tool, the step it ran (none for a look), whether it worked. */
export type LogEntry = { at: number; ms: number; tool: string; step?: Step[]; ok: boolean; note?: string }
/** How a scenario went. `ok`: it did what the map and criteria say, with nothing worth a finding. `problem`: one finding or more. `unspecified`: neither the
 *  map nor the criteria say what should happen, so there is no verdict. `couldnt_test`: it needs something no one can do from a browser (change the clock,
 *  wait hours, get an email), so there is no verdict either, and nothing to fix (Bug 223); `why` says what (on `ok` too: a part it couldn't check, Bug 260).
 *  `not_run`: the session ended before it began, or before it finished. */
export type Outcome = 'ok' | 'problem' | 'unspecified' | 'couldnt_test' | 'not_run'
export type ScenarioResult = { scenario: Scenario; outcome: Outcome; why?: string; steps: Step[]; log: LogEntry[]; findings: UiFinding[]; notes: string[];
  recording: string | null }
/** What the run's tester did, kept with the run (auto_runs.ui_test). `skipped`: HQ couldn't have it tried, and why (`quiet`: it's how the project is set up).
 *  `unrecorded`: why HQ's recorder wasn't on while it ran, so the backend checker has nothing of this run to read. */
export type UiTest = { at: number } & ({ state: 'done'
  scenarios: { id: string; kind: ScenarioKind; title: string; outcome: Outcome; actions: number; why?: string; criteria?: string[] }[]
  findings: UiFinding[]; ms: number; tokens: number; cost_usd: number; model: string; sessions: number; unrecorded?: string
  /** Bug 374: ports the project hard-wires that were in use, so the tester's copy of the app ran on others. */
  moved?: MovedPort[] }
  /** `tokens`, `cost_usd`: what its plan of scenarios cost, when that was paid for before the step ended untried (Bug 380: the app didn't start). */
  | { state: 'skipped'; why: string; quiet?: boolean; tokens?: number; cost_usd?: number })

/** How many scenarios the tester writes, how many it gets per session, and what one scenario may take: browser actions (a click, typing, opening a page), looks
 *  at the page as text, and screenshots (for layout only). The tester's browser refuses a step past these (HQ's hook, uitesthost.mjs), not its prompt. */
export const SCENARIOS = Number(process.env.HQ_UITEST_SCENARIOS) || 30
export const PER_SESSION = Number(process.env.HQ_UITEST_BATCH) || 5
export const BUDGET = { actions: 12, looks: 16, screenshots: 2 }
export const MAX_FINDINGS = 3 // a scenario's

/** The browser tools (Playwright MCP) the tester gets: what a person does with a page, a look at it as text, and a screenshot. Not running JavaScript, not
 *  uploading files, not reading the network or the console (HQ records those itself), not other tabs. roles.ts gives Claude Code these and nothing else. */
export const BROWSER_TOOLS = ['navigate', 'navigate_back', 'click', 'type', 'fill_form', 'press_key', 'select_option', 'hover', 'handle_dialog', 'wait_for',
  'snapshot', 'take_screenshot'] as const
export const LOOK_TOOLS: readonly string[] = ['snapshot', 'wait_for']
/** The tools that name an element by a ref from the last look: refused until the tester has looked at the page it is on (uitesthost.mjs). */
export const ON_ELEMENT: readonly string[] = ['click', 'type', 'fill_form', 'select_option', 'hover']
/** What a tool counts against: a look, a screenshot, or an action. */
export const costOf = (tool: string): keyof typeof BUDGET => tool === 'take_screenshot' ? 'screenshots' : LOOK_TOOLS.includes(tool) ? 'looks' : 'actions'

/** The run's screen criteria as a plain "what's new" list for the tester: no ticket text, no backend criteria, only what a person should see. */
export function whatsNew(tickets: { key: string; title: string; criteria: Criterion[] }[]): { lines: string[]; ids: string[] } {
  const lines: string[] = [], ids: string[] = []
  for (const t of tickets) {
    for (const c of t.criteria) if (c.kind === 'ui') { const id = `${t.key} ${c.id}`; ids.push(id); lines.push(`- [${id}] ${c.text}`) }
  }
  return { lines, ids }
}

const BLIND = `You never see the app's code, and you don't guess at it. All you know is the feature map (what a person sees on each screen and what each control
does), the list of what's new, and the page in front of you.`

export const PLAN_SYSTEM = `You plan how to test a web app the way people really use it. ${BLIND}

Write scenarios: each one thing a person wants to get done, in their words. Mix three kinds:
- basic: the everyday tasks, one per screen or control the map names, and one for each item in what's new.
- weird: what people really do: empty input, the same thing twice, double clicks, very long text, the back button, changing their mind halfway.
- complex: a few steps across screens that depend on each other.
A goal says what the person wants and how they'd know it worked, never how the app is built. Put the ids of the what's-new items a scenario is about in
its "about" list, as written between the brackets (for example "T-03 A2"), and nothing else there.`
// Bug 257: the list was called `criteria` with no description, and Haiku filled it with pass checks of its own and put the [id]s in the goal instead
export const PLAN_SCHEMA = JSON.stringify({ type: 'object', required: ['scenarios'], properties: { scenarios: { type: 'array', items: { type: 'object',
  required: ['kind', 'title', 'goal', 'about'], properties: { kind: { enum: ['basic', 'weird', 'complex'] }, title: { type: 'string' }, goal: { type: 'string' },
  about: { type: 'array', items: { type: 'string' }, description: 'The ids of the what\'s-new items this scenario is about (for example "T-03 A2"); empty if none.' },
} } } } })
export function planPrompt(map: string, news: string[], n: number): string {
  return `## Feature map\n${map.trim() || '(There is no map yet: plan from what\'s new, and include scenarios that find their way around the app from its start page.)'}\n\n`
    + `## What's new\n${news.join('\n') || '(Nothing listed: test the app as a whole.)'}\n\nWrite about ${n} scenarios: about half basic, a third weird, the rest complex.\n`
}

const line = (s: unknown, max: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
/** The criterion a name means: its full name ("T-03 A2"), or its id alone when only one ticket has that id. */
export function knownCriterion(c: unknown, ids: string[]): string | null {
  const k = squash(String(c ?? '')); if (!k) return null
  const full = ids.find((id) => squash(id) === k); if (full) return full
  const same = ids.filter((id) => squash(id.split(' ').at(-1) ?? '') === k); return same.length === 1 ? same[0]! : null
}
/** What a planned scenario names as its criteria: its `about` list (`criteria` too, as older answers called it), and any [id] in its title, goal or those
 *  lists, where a model also writes them (Bug 257). Only names knownCriterion knows are kept, so a pass check written in place of an id is dropped. */
function namedIn(s: Record<string, unknown>): unknown[] {
  const listed = [s.about, s.criteria].flatMap((l) => Array.isArray(l) ? l : [])
  const tags = [s.title, s.goal, ...listed].flatMap((t) => [...String(t ?? '').matchAll(/\[([^[\]]{1,80})\]/g)].map((m) => m[1]!))
  return [...listed, ...tags].flatMap((c) => String(c ?? '').split(/[,;]/)) // "T-03 A1, T-03 A2" names two
}
/** The scenarios HQ keeps of a planning answer: at most `n`, each with a kind, a title and a goal, none the same as another; then numbered. `retry` scenarios
 *  (from findings to try again) go first, as HQ wrote them. */
export function keepPlan(raw: unknown, n: number, ids: string[], retry: Omit<Scenario, 'id' | 'kind'>[] = []): Scenario[] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { scenarios?: unknown }, seen = new Set<string>(), out: Omit<Scenario, 'id'>[] = []
  for (const x of retry) out.push({ kind: 'retry', title: line(x.title, 120), goal: x.goal, ...(x.criteria?.length ? { criteria: x.criteria } : {}) }) // verbatim
  for (const s of Array.isArray(r.scenarios) ? r.scenarios as Record<string, unknown>[] : []) {
    const kind = String(s?.kind ?? ''), title = line(s?.title, 120), goal = line(s?.goal, 600)
    if (!['basic', 'weird', 'complex'].includes(kind) || title.length < 3 || goal.length < 10 || seen.has(squash(goal))) continue
    if (out.length >= n + retry.length) break
    seen.add(squash(goal))
    const crit = [...new Set(namedIn(s).map((c) => knownCriterion(c, ids)).filter((c): c is string => !!c))]
    out.push({ kind: kind as ScenarioKind, title, goal, ...(crit.length ? { criteria: crit } : {}) })
  }
  return out.map((s, i) => ({ id: `s-${String(i + 1).padStart(2, '0')}`, ...s }))
}

export const TESTER_SYSTEM = `You are testing a web app as a person using it for the first time. ${BLIND}

For each scenario you are given, in order:
1. Call start_scenario with its id. HQ resets the app to a clean start and tells you its address. Open it with browser_navigate, then look at it
   (browser_snapshot): element refs from before the reset name nothing.
2. Work toward the goal as that person would, one step at a time: look (browser_snapshot: the page as text), act (click, type, press a key, go back), then
   check what changed (browser_snapshot again). Take a screenshot only to judge layout (something hidden, overlapping or out of place), never to read text.
3. At every step ask yourself: did I know what to do next? Was the control I needed obvious? Did its label say what it did? Did the app show me that something
   happened (or went wrong)? Note every hesitation, wrong click and backtrack, even when the task succeeds in the end.
4. Call finish_scenario with what happened, always, even when the scenario went badly or its budget ran out. Then go on to the next scenario.

Rules:
- Each scenario has a fixed budget of actions, looks and screenshots. When the browser refuses a step because the budget is spent, finish the scenario.
- outcome "ok": it worked and nothing was confusing. "problem": you have at least one finding. "unspecified": the map and what's new don't say what should
  happen here (for example what an empty name should do), so you can't say whether it's right; say what the app did in notes, without a verdict.
  "couldnt_test": the scenario needs something a person can't do from this browser (change the computer's clock or date, wait hours, get an email or a text,
  use a second device or account), so you couldn't check it; say what in couldnt_test, with no findings. If you also saw a real problem on the way, the
  outcome is "problem" with that finding, and what you couldn't check still goes in couldnt_test.
- A finding is something a person would trip over: stuck (couldn't go on), confusing (wrong click or backtrack), unclear_label (the label didn't match what
  happened), no_feedback (nothing showed that it worked or failed), broken (an error, or the wrong result), missing (the map says it's there and it isn't).
  Give the action it happened at (count your page opens, clicks, typing and key presses in this scenario from 1; looks don't count), what you saw, what you expected, and the what's-new [id] if it is
  about one. If you were looking for an element, name it in looked_for (its role and name as the page text shows them).
- That you couldn't try something is never a finding: a finding is about what the app did. "I couldn't change the clock to see the morning greeting" goes
  in couldnt_test.
- Report only what you saw on the page. Nothing about how it is built or how you would build it.`

export function testerPrompt(o: { map: string; news: string[]; scenarios: Scenario[]; budget: typeof BUDGET }): string {
  const one = (s: Scenario) => `### ${s.id} (${s.kind}): ${s.title}\n${s.goal}${s.criteria?.length ? `\nAbout: ${s.criteria.join(', ')}` : ''}`
  return `## Feature map\n${o.map.trim() || '(There is no map yet: find your way from the start page.)'}\n\n## What's new\n${o.news.join('\n') || '(Nothing listed.)'}\n\n`
    + `## Your scenarios\n${o.scenarios.map(one).join('\n\n')}\n\nEach scenario's budget: ${o.budget.actions} actions, ${o.budget.looks} looks, `
    + `${o.budget.screenshots} screenshots.\n`
}

// --- Steps, from the Playwright code the browser tools ran -----------------------------------------------------------------------------------------------
/** A JavaScript string literal at the start of `s` ('…', "…" or `…`) and what's after it. */
function literal(s: string): [string, string] | null {
  const q = s[0]; if (q !== '\'' && q !== '"' && q !== '`') return null
  let out = ''
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!
    if (c === '\\') { const n = s[++i] ?? ''; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; continue }
    if (c === q) return [out, s.slice(i + 1)]
    out += c
  }
  return null
}
/** A regular expression literal at the start of `s` (`/^Dune$/i`), as written, and what's after it. */
function regex(s: string): [string, string] | null {
  if (s[0] !== '/') return null
  let cls = false
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!
    if (c === '\\') { i++; continue }
    if (c === '[') cls = true; else if (c === ']') cls = false
    else if (c === '/' && !cls) { const f = /^[a-z]*/.exec(s.slice(i + 1))![0]; return i > 1 ? [s.slice(0, i + 1 + f.length), s.slice(i + 1 + f.length)] : null }
  }
  return null
}
type Val = string | { re: string } | boolean | number
/** A plain value at the start of `s` (a string, a regex, true, false, a number) and what's after it; null for anything else (a variable, a call). */
function value(s: string): [Val, string] | null {
  const l = literal(s); if (l) return l
  const r = regex(s); if (r) return [{ re: r[0] }, r[1]]
  const w = /^(true|false|-?\d+(?:\.\d+)?)(?![\w$])/.exec(s); if (!w) return null
  return [w[1] === 'true' ? true : w[1] === 'false' ? false : Number(w[1]), s.slice(w[0].length)]
}
/** A call's arguments: its first value and, after it, an options object of plain values (`'button', { name: 'Add', exact: true }`). */
function argsOf(args: string): { first?: Val; opts: Record<string, Val> } | null {
  let s = args.trim(), first: Val | undefined
  if (s && s[0] !== '{') { const v = value(s); if (!v) return null; first = v[0]; s = v[1].trim().replace(/^,\s*/, '') }
  const opts: Record<string, Val> = {}
  if (!s) return { first, opts }
  if (s[0] !== '{') return null
  for (s = s.slice(1).trim(); s[0] !== '}'; s = s.trim()) {
    const k = /^([A-Za-z_$][\w$]*)\s*:\s*/.exec(s); if (!k) return null
    const v = value(s.slice(k[0].length)); if (!v) return null
    opts[k[1]!] = v[0]; s = v[1].trim(); if (s[0] === ',') s = s.slice(1)
  }
  return s.slice(1).trim() ? null : { first, opts }
}
/** A text in a selector the way Playwright writes it for the getBy… call (its own `internal:` selectors): quoted with `i`, or `s` when exact. */
const quoted = (v: Val, exact: unknown, attr = false): string | null => typeof v === 'object'
  ? v.re.replace(/(^|[^\\])(\\\\)*(["'`])/g, '$1$2\\$3').replace(/>>/g, '\\>\\>')
  : typeof v !== 'string' ? null : `${attr ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : JSON.stringify(v)}${exact === true ? 's' : 'i'}`
const ROLE_OPTS: [string, string][] = [['checked', 'checked'], ['disabled', 'disabled'], ['selected', 'selected'], ['expanded', 'expanded'],
  ['includeHidden', 'include-hidden'], ['level', 'level'], ['name', 'name'], ['description', 'description'], ['pressed', 'pressed']]
const ATTRS: Record<string, string> = { getByPlaceholder: 'placeholder', getByTitle: 'title', getByAltText: 'alt' }
type Call = { name: string; args: string }
/** One call of a locator chain as the Playwright selector it stands for (what `page.getByRole(…)` itself builds), or null when a selector can't say it
 *  (filter({ has }), a frame, an option it doesn't know). */
function selectorOf(c: Call): string | null {
  const a = argsOf(c.args); if (!a) return null
  const known = (...k: string[]) => Object.keys(a.opts).every((x) => k.includes(x))
  if (c.name === 'getByRole') {
    if (typeof a.first !== 'string' || !/^[a-z]+$/.test(a.first) || !known('exact', ...ROLE_OPTS.map(([k]) => k))) return null
    let out = `internal:role=${a.first}`
    for (const [k, n] of ROLE_OPTS) {
      const v = a.opts[k]; if (v === undefined) continue
      const w = k === 'name' || k === 'description' ? quoted(v, a.opts.exact, true) : typeof v === 'object' ? null : String(v); if (!w) return null
      out += `[${n}=${w}]`
    }
    return out
  }
  const t = a.first !== undefined && known('exact') ? quoted(a.first, a.opts.exact, c.name in ATTRS) : null
  if (c.name === 'getByText' || c.name === 'getByLabel') return t && `internal:${c.name === 'getByText' ? 'text' : 'label'}=${t}`
  if (c.name in ATTRS) return t && `internal:attr=[${ATTRS[c.name]}=${t}]`
  if (c.name === 'getByTestId') { const v = typeof a.first === 'string' && known() ? quoted(a.first, true, true) : null; return v && `internal:testid=[data-testid=${v}]` }
  if (c.name === 'filter') { // a filter on text: what the code generator writes to pick one row of a list
    const [k, v] = Object.entries(a.opts)[0] ?? []; if (a.first !== undefined || Object.keys(a.opts).length !== 1 || v === undefined) return null
    if (k === 'hasText' || k === 'hasNotText') { const w = quoted(v, false); return w && `internal:${k === 'hasText' ? 'has-text' : 'has-not-text'}=${w}` }
    return k === 'visible' && typeof v === 'boolean' ? `visible=${v}` : null
  }
  if (c.name !== 'locator' || typeof a.first !== 'string' || !a.first.trim()) return null // a plain selector, maybe with a plain hasText (Bug 173)
  const has = a.opts.hasText; if (!known('hasText') || (has !== undefined && typeof has !== 'string')) return null
  return has !== undefined ? `${a.first}:has-text(${JSON.stringify(has)})` : a.first
}
/** The element a getBy… call names by its own words: `getByRole('button', { name: 'Add' })`, `getByText('…')`, `getByLabel('…')`, `getByPlaceholder('…')`. */
function target(c: Call): Pick<Step, 'role' | 'name' | 'text' | 'label'> | null {
  const m = /^getBy(Role|Text|Label|Placeholder|Title|AltText|TestId)$/.exec(c.name), a = m ? argsOf(c.args) : null
  if (!m || !a || typeof a.first !== 'string') return null
  if (m[1] === 'Role') return { role: a.first, ...(typeof a.opts.name === 'string' ? { name: a.opts.name } : {}) }
  return m[1] === 'Label' || m[1] === 'Placeholder' ? { label: a.first } : { text: a.first }
}
/** A locator chain (`locator('li').first()`) as its calls, each with its arguments' text; null when it isn't a plain chain of calls. */
function calls(chain: string): Call[] | null {
  const out: Call[] = []
  for (let s = chain.trim(); s; s = s.trim()) {
    const m = /^\.?([A-Za-z_$][\w$]*)\(/.exec(s); if (!m) return null
    let i = m[0].length, depth = 1
    while (i < s.length && depth) {
      const c = s[i]!
      if (c === '\'' || c === '"' || c === '`') { const l = literal(s.slice(i)); if (!l) return null; i = s.length - l[1].length; continue }
      if (c === '/' && /[(,:]\s*$/.test(s.slice(0, i))) { const r = regex(s.slice(i)); if (r) { i = s.length - r[1].length; continue } }
      if (c === '(') depth++; else if (c === ')') depth--
      i++
    }
    if (depth) return null
    out.push({ name: m[1]!, args: s.slice(m[0].length, i - 1).trim() }); s = s.slice(i)
  }
  return out
}
/** Which match a call takes: first() 0, last() -1, nth(n) n; undefined for any other call. */
const pick = (c: Call): number | undefined => c.name === 'first' && !c.args ? 0 : c.name === 'last' && !c.args ? -1
  : c.name === 'nth' && /^-?\d+$/.test(c.args) ? Number(c.args) : undefined
/** The element a locator chain names, as a script can find it again. One plain getByRole, getByText, getByLabel or getByPlaceholder (texts only, no option
 *  but a role's name): that element by its own words, and which of its matches it took when that's not the first (Bug 198: Playwright MCP writes `getByRole('button', { name: 'Edit' }).nth(1)`
 *  for the second row's Edit). Any other chain (`exact: true` or a regex, which the words can't keep; Bug 173: `locator('button:has-text("Remove")')`;
 *  Bug 198: `getByRole('row', { name: 'Dune' }).getByRole('button')`): the whole chain as one
 *  Playwright selector, each later call inside the earlier ones joined by ` >> ` as Playwright itself does, with the match the chain ends on, and the last
 *  element's own words when a getBy… call names it (never the first one's: that's only what it sits in). Null for anything a selector can't say: never a
 *  wrong element. */
function elementOf(chain: string): Pick<Step, 'role' | 'name' | 'text' | 'label' | 'css' | 'nth'> | null {
  const cs = calls(chain); if (!cs?.length) return null
  const a = argsOf(cs[0]!.args), plain = /^getBy(Role|Text|Label|Placeholder)$/.test(cs[0]!.name) && typeof a?.first === 'string'
    && Object.entries(a.opts).every(([k, v]) => k === 'name' && typeof v === 'string' && cs[0]!.name === 'getByRole')
  const one = plain && (cs.length === 1 || (cs.length === 2 && pick(cs[1]!) !== undefined)) ? target(cs[0]!) : null, n = cs.length === 2 ? pick(cs[1]!) : undefined
  if (one) return { ...one, ...(n ? { nth: n } : {}) }
  const parts: string[] = []; let nth: number | undefined, el: Pick<Step, 'role' | 'name' | 'text' | 'label'> = {}
  for (const c of cs) {
    if (nth !== undefined) { parts.push(`nth=${nth}`); nth = undefined }
    const p = pick(c); if (p !== undefined) { nth = p; continue }
    const sel = selectorOf(c); if (!sel) return null
    parts.push(sel); if (c.name !== 'filter') el = target(c) ?? {}
  }
  return parts.length ? { ...el, css: parts.join(' >> '), ...(nth !== undefined ? { nth } : {}) } : null
}
const ACTIONS: Record<string, Step['action']> = { click: 'click', dblclick: 'click', fill: 'fill', press: 'press', pressSequentially: 'fill', selectOption: 'select',
  check: 'check', uncheck: 'uncheck', hover: 'hover', setChecked: 'check' }
/** One line of Playwright code as a step, or null when it isn't one (a screenshot, a wait, a comment). `origin`: the app's address, which a replay's will differ
 *  from, so `url` is the path. */
export function stepOf(code: string, origin: string): Step | null {
  const c = code.trim().replace(/;$/, '')
  const go = /^await page\.goto\((.*)\)$/.exec(c)
  if (go) { const u = literal(go[1]!.trim()); if (!u) return null; return { action: 'navigate', url: u[0].startsWith(origin) ? u[0].slice(origin.length) || '/' : u[0], code: c } }
  if (/^await page\.goBack\(/.test(c)) return { action: 'back', code: c }
  const key = /^await page\.keyboard\.press\((.*)\)$/.exec(c)
  if (key) { const k = literal(key[1]!.trim()); return k ? { action: 'press', value: k[0], code: c } : null }
  const m = /^await page\.(.+)\.(click|dblclick|fill|press|pressSequentially|selectOption|check|uncheck|hover|setChecked)\((.*)\)$/.exec(c); if (!m) return null
  const loc = elementOf(m[1]!)
  const arg = m[3]!.trim(), lit = literal(arg), arr = arg.startsWith('[') ? literal(arg.slice(1).trim()) : null
  const value = lit?.[0] ?? arr?.[0]
  return { action: ACTIONS[m[2]!]!, ...loc, ...(value !== undefined ? { value } : {}), code: c }
}
/** The steps a browser tool's answer says it ran: the lines of its "Ran Playwright code" block. */
export function stepsOf(answer: string, origin: string): Step[] {
  const block = /### Ran Playwright code\s*```[a-z]*\n([\s\S]*?)```/.exec(answer)?.[1] ?? ''
  return block.split('\n').map((l) => stepOf(l, origin)).filter((s): s is Step => !!s)
}
/** Is an element with this role and name (or this text) in a page as the tester read it? From the page text (an accessibility snapshot). */
export function onPage(page: string, el: { role?: string; name?: string; text?: string }): boolean {
  const lines = page.split('\n').map((l) => l.trim().replace(/^- /, ''))
  if (el.role) return lines.some((l) => l.startsWith(`${el.role}`) && (!el.name || l.slice(el.role!.length).includes(`"${el.name}"`)))
  return !!el.text && page.includes(el.text)
}

// --- What the tester reports ------------------------------------------------------------------------------------------------------------------------------
type Said = { outcome?: unknown; notes?: unknown; findings?: unknown; couldnt_test?: unknown }
/** A finding that is really the tester saying it couldn't try something from the browser, not what the app did (Bug 223: "I couldn't change the clock to
 *  check the morning greeting", kept as a finding that broke the greeting's criteria): the machine's clock, date or time zone, which no page lets a person
 *  change. Narrow on purpose: "couldn't set the time on the reminder", "couldn't change the alarm clock" or "the clock format" are about the app, and stay
 *  findings. The prompt asks for `couldnt_test` instead; this catches the tester that still writes it as a finding. */
const CANT_TRY = new RegExp(String.raw`\b(?:couldn'?t|could not|can'?t|cannot|unable to|no way to)\s+(?:change|set|move|control|fake|mock|simulate|adjust|alter|override|advance)`
  + String.raw`\s+(?:the\s+|my\s+|its\s+|this\s+)?(?:(?:system|device|computer|machine|browser|real|current|actual)(?:'s)?\s+(?:clock|time|date|time ?zone)\b`
  + String.raw`|(?:clock|time of day)\b(?!\s+(?:format|style|setting|display|widget|face|picker|field|box)))`, 'i')
export const cantTry = (words: string): boolean => CANT_TRY.test(words.replace(/[’‘]/g, "'"))
/** What HQ keeps of a scenario's report: an outcome it can give, at most three findings with a known kind and something to say, each with the steps up to
 *  the one it names (HQ's own record of what ran, not the tester's words) and, when it named an element it looked for, whether that element was in the last
 *  page it read there. `steps`: what each action of the scenario ran, in order, as the tester counts them for `at_step` (spike: it counts actions, not
 *  looks). `pages`: the page text of each look, by the number of actions before it. */
export function keepReport(raw: unknown, s: Scenario, steps: Step[][], pages: { after: number; text: string }[], ids: string[]): Pick<ScenarioResult,
  'outcome' | 'why' | 'findings' | 'notes'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Said
  const notes = (Array.isArray(r.notes) ? r.notes : []).map((n) => line(n, 200)).filter(Boolean).slice(0, 8)
  const findings: UiFinding[] = [], cant: string[] = [] // what the tester couldn't try, in its words (Bug 223)
  const said = String(r.outcome ?? ''), untested = said === 'couldnt_test', told = filled(line(r.couldnt_test, 300))
  for (const f of Array.isArray(r.findings) ? r.findings as Record<string, unknown>[] : []) {
    const kind = String(f?.kind ?? '') as FindingKind, what = line(f?.what, 400), expected = line(f?.expected, 300)
    // No verdict, so nothing to fix: what it wrote as a finding anyway is kept as a note
    if (what.length >= 10 && (untested || cantTry(what))) { cant.push(what); continue }
    if (!FINDING_KINDS.includes(kind) || what.length < 10 || findings.length >= MAX_FINDINGS) continue
    const at = Math.min(Math.max(Math.round(Number(f.at_step) || steps.length), 1), Math.max(steps.length, 1))
    const criterion = knownCriterion(f.criterion, ids), lf = (f.looked_for && typeof f.looked_for === 'object' ? f.looked_for : null) as Record<string, unknown> | null
    const el = lf ? { ...(lf.role ? { role: line(lf.role, 40) } : {}), ...(lf.name ? { name: line(lf.name, 120) } : {}), ...(lf.text ? { text: line(lf.text, 120) } : {}) } : null
    const page = pages.filter((p) => p.after <= at).at(-1)
    const expect = el && (el.role || el.text) && page ? [{ ...el, visible: onPage(page.text, el) }] : undefined
    findings.push({ id: '', scenario: s.id, kind, what, expected, steps: steps.slice(0, at).flat(), ...(criterion ? { criterion } : {}), ...(expect ? { expect } : {}) })
  }
  const why = told || cant[0] || ''
  // Bug 260: a "problem" with no finding HQ keeps but its couldnt_test filled in ("I could not change the clock…") is that: it couldn't test it
  if (!findings.length && (untested || cant.length || (told && said === 'problem'))) {
    return { outcome: 'couldnt_test', why: why || 'the tester couldn\'t try it from the browser', findings, notes: [...notes, ...cant.filter((c) => c !== why)].slice(0, 8) }
  }
  if (why) notes.push(`Couldn't check: ${why}`) // a real finding, and something it couldn't try: the finding is the verdict
  if (!findings.length && said === 'problem') return { outcome: 'unspecified', why: 'the tester saw a problem but reported no finding HQ could keep', findings, notes }
  // "ok" with something it couldn't check: still fine, and the summary's line says what wasn't checked (Bug 260)
  if (!findings.length && said !== 'unspecified' && why) return { outcome: 'ok', why, findings, notes }
  return { outcome: findings.length ? 'problem' : said === 'unspecified' ? 'unspecified' : 'ok', findings, notes }
}
/** A couldnt_test that says nothing ("none", "N/A", "-"): as if left out, so a "problem" with it is still one HQ couldn't keep. */
const filled = (s: string): string => /^(?:n\/?a|none|nothing|no|null|nil|-+|—|–)\.?$/i.test(s) ? '' : s
/** Numbers every finding of the run in order (U1, U2…). */
export const numbered = (all: UiFinding[]): UiFinding[] => all.map((f, i) => ({ ...f, id: `U${i + 1}` }))

// --- Words --------------------------------------------------------------------------------------------------------------------------------------------------
const KIND_WORDS: Record<FindingKind, string> = { stuck: 'stuck', confusing: 'confusing', unclear_label: 'label', no_feedback: 'no feedback', broken: 'broken',
  missing: 'missing' }
const cut = (v: string): string => v.length > 40 ? `${v.slice(0, 37)}…` : v
/** A step in a few words, for a person reading the summary. */
export function stepWords(s: Step): string {
  const el = s.role || s.label || s.text ? `${ordinal(s.nth)}${s.role ? `${s.role}${s.name ? ` "${s.name}"` : ''}` : `"${s.label ?? s.text}"`}${within(s.css)}`
    : s.css ? cssWords(s.css, s.nth) : ''
  switch (s.action) {
    case 'navigate': return `open ${s.url}`
    case 'back': return 'go back'
    case 'fill': return `type "${cut(s.value ?? '')}" in ${el || 'a field'}`
    case 'press': return `press ${s.value ?? ''}${el ? ` in ${el}` : ''}`
    case 'select': return `pick "${s.value ?? ''}" in ${el || 'a list'}`
    default: return `${s.action} ${el}`.trim()
  }
}
const things = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
/** A finding's steps in words: the last seven of a long chain (all of them are in the scenario's file). */
const chain = (steps: Step[]): string => (steps.length > 8 ? [`(${steps.length - 7} steps before)`, ...steps.slice(-7).map(stepWords)] : steps.map(stepWords)).join(' → ')
/** The run summary's lines for the tester: what it covered, each finding with its steps, then one line per scenario that went fine or had no verdict. When
 *  none ran, all for one reason, that reason once (Bug 170: thirty lines of the same words hid it). */
export function uiTestLines(u: UiTest | null): string[] {
  if (!u) return []
  if (u.state === 'skipped') return u.quiet ? [] : [`- Not tried: ${u.why}${u.cost_usd ? ` (its plan of scenarios had cost $${u.cost_usd.toFixed(2)})` : ''}`]
  const by = (o: Outcome) => u.scenarios.filter((s) => s.outcome === o)
  const whys = new Set(u.scenarios.map((s) => s.why))
  if (u.scenarios.length > 1 && by('not_run').length === u.scenarios.length && whys.size === 1) {
    const why = [...whys][0]; return [`- ${things(u.scenarios.length, 'scenario')}, none run${why ? ` (${why})` : ''}`]
  }
  const head = `- ${things(u.scenarios.length, 'scenario')}: ${by('ok').length} fine, ${things(u.findings.length, 'finding')}, ${by('unspecified').length} unspecified`
    + `${by('couldnt_test').length ? `, ${by('couldnt_test').length} couldn't test` : ''}${by('not_run').length ? `, ${by('not_run').length} not run` : ''}`
  const title = (id: string) => u.scenarios.find((s) => s.id === id)?.title ?? id
  const verdict = (s: typeof u.scenarios[number]): string => s.outcome === 'ok' ? `fine${s.why ? `, but it couldn't check from a browser: ${s.why}` : ''}`
    : s.outcome === 'unspecified' ? `no verdict (${s.why ?? 'the map and criteria don\'t say what should happen'})`
    // Not a finding (Bug 223): no verdict on what it's about, and nothing to fix
    : s.outcome === 'couldnt_test' ? `couldn't test it from a browser, so ${s.criteria?.length ? `${s.criteria.join(', ')} ${s.criteria.length === 1 ? 'has' : 'have'}`
      : 'it has'} no verdict here (${s.why ?? 'no reason given'})`
    : `not run${s.why ? ` (${s.why})` : ''}`
  return [head, ...(u.moved?.length ? [`- HQ ran its own copy of the app on ${movedWords(u.moved)}`] : []),
    ...u.findings.map((f) => `- ${f.id} (${KIND_WORDS[f.kind]}, ${f.scenario} ${title(f.scenario)}${f.criterion ? `, ${f.criterion}` : ''}): ${f.what}`
      + `${f.expected ? ` Expected: ${f.expected}` : ''}${f.steps.length ? ` Steps: ${chain(f.steps)}` : ''}`),
    ...u.scenarios.filter((s) => s.outcome !== 'problem').map((s) => `- ${s.id} ${s.title}: ${verdict(s)}`)]
}
export const uiTestOf = (json: string | null | undefined): UiTest | null => { try { return json ? JSON.parse(json) as UiTest : null } catch { return null } }
