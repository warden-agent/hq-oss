// The UI tester's rules (uitester.ts): as an auto run ends, a code-blind tester uses the whole app in a real browser, the way a person would, and reports where
// a person would get stuck or confused. These are the shapes HQ keeps, what the tester is told, what of its answers HQ keeps, how a step it took becomes a
// step a script can replay, and the words for the run's summary. Pure: no DB, no processes.
import type { Criterion } from './criteria.ts'

export type ScenarioKind = 'basic' | 'weird' | 'complex' | 'retry'
/** One thing to try, written by the tester's planning call from the feature map and what's new (or, for `retry`, by HQ from a finding a replay couldn't
 *  reproduce by script: Part 5). `criteria`: the screen criteria it is about ("T-03 A2"). */
export type Scenario = { id: string; kind: ScenarioKind; title: string; goal: string; criteria?: string[] }
/** One step the tester took, as a script can replay it with no AI: built by HQ from the Playwright code the browser tools ran, never from the model's words.
 *  `code`: that line of code, for a replay that can't use the fields. */
export type Step = { action: 'navigate' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'hover' | 'back'; role?: string; name?: string; text?: string;
  label?: string; value?: string; url?: string; code: string }
/** What the tester expected to see at a finding, checked by HQ in the page text it last read: is that element there? */
export type Expect = { role?: string; name?: string; text?: string; visible: boolean }
export const FINDING_KINDS = ['stuck', 'confusing', 'unclear_label', 'no_feedback', 'broken', 'missing'] as const
export type FindingKind = typeof FINDING_KINDS[number]
/** A place a person would get stuck or confused, with the steps that lead there (the scenario's steps up to the moment it happened). */
export type UiFinding = { id: string; scenario: string; kind: FindingKind; what: string; expected: string; steps: Step[]; criterion?: string; expect?: Expect[] }
/** One step of the tester's log as HQ recorded it: when it began (HQ's clock), the browser tool, the step it ran (none for a look), whether it worked. */
export type LogEntry = { at: number; ms: number; tool: string; step?: Step[]; ok: boolean; note?: string }
/** How a scenario went. `ok`: it did what the map and criteria say, with nothing worth a finding. `problem`: one finding or more. `unspecified`: neither the
 *  map nor the criteria say what should happen, so there is no verdict. `not_run`: the session ended before it began, or before it finished. */
export type Outcome = 'ok' | 'problem' | 'unspecified' | 'not_run'
export type ScenarioResult = { scenario: Scenario; outcome: Outcome; why?: string; steps: Step[]; log: LogEntry[]; findings: UiFinding[]; notes: string[];
  recording: string | null }
/** What the run's tester did, kept with the run (auto_runs.ui_test). `skipped`: HQ couldn't have it tried, and why (`quiet`: it's how the project is set up). */
export type UiTest = { at: number } & ({ state: 'done'; scenarios: { id: string; kind: ScenarioKind; title: string; outcome: Outcome; actions: number; why?: string }[];
  findings: UiFinding[]; ms: number; tokens: number; cost_usd: number; model: string; sessions: number } | { state: 'skipped'; why: string; quiet?: boolean })

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
A goal says what the person wants and how they'd know it worked, never how the app is built. Name the what's-new items a scenario is about by their [id].`
export const PLAN_SCHEMA = JSON.stringify({ type: 'object', required: ['scenarios'], properties: { scenarios: { type: 'array', items: { type: 'object',
  required: ['kind', 'title', 'goal'], properties: { kind: { enum: ['basic', 'weird', 'complex'] }, title: { type: 'string' }, goal: { type: 'string' },
  criteria: { type: 'array', items: { type: 'string' } } } } } } })
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
    const crit = [...new Set((Array.isArray(s.criteria) ? s.criteria : []).map((c) => knownCriterion(c, ids)).filter((c): c is string => !!c))]
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
- A finding is something a person would trip over: stuck (couldn't go on), confusing (wrong click or backtrack), unclear_label (the label didn't match what
  happened), no_feedback (nothing showed that it worked or failed), broken (an error, or the wrong result), missing (the map says it's there and it isn't).
  Give the action it happened at (count your page opens, clicks, typing and key presses in this scenario from 1; looks don't count), what you saw, what you expected, and the what's-new [id] if it is
  about one. If you were looking for an element, name it in looked_for (its role and name as the page text shows them).
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
/** The element a locator names: `getByRole('button', { name: 'Add' })`, `getByText('…')`, `getByLabel('…')`, `getByPlaceholder('…')`. */
function target(loc: string): Pick<Step, 'role' | 'name' | 'text' | 'label'> | null {
  const m = /^\.?getBy(Role|Text|Label|Placeholder|Title|AltText|TestId)\((.*)$/.exec(loc.trim()); if (!m) return null
  const a = literal(m[2]!.trim()); if (!a) return null
  if (m[1] === 'Role') {
    const name = /name:\s*(['"`])/.exec(a[1]); const n = name ? literal(a[1].slice(name.index + name[0].length - 1)) : null
    return { role: a[0], ...(n ? { name: n[0] } : {}) }
  }
  return m[1] === 'Label' || m[1] === 'Placeholder' ? { label: a[0] } : { text: a[0] }
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
  const loc = m[1]!.split(/\.(?=getBy|locator|first\(|nth\(|filter\()/).map((x) => target(x)).find(Boolean)
  const arg = m[3]!.trim(), lit = literal(arg), arr = arg.startsWith('[') ? literal(arg.slice(1).trim()) : null
  const value = lit?.[0] ?? arr?.[0]
  return { action: ACTIONS[m[2]!]!, ...(loc ?? {}), ...(value !== undefined ? { value } : {}), code: c }
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
type Said = { outcome?: unknown; notes?: unknown; findings?: unknown }
/** What HQ keeps of a scenario's report: an outcome it can give, at most three findings with a known kind and something to say, each with the steps up to
 *  the one it names (HQ's own record of what ran, not the tester's words) and, when it named an element it looked for, whether that element was in the last
 *  page it read there. `steps`: what each action of the scenario ran, in order, as the tester counts them for `at_step` (spike: it counts actions, not
 *  looks). `pages`: the page text of each look, by the number of actions before it. */
export function keepReport(raw: unknown, s: Scenario, steps: Step[][], pages: { after: number; text: string }[], ids: string[]): Pick<ScenarioResult,
  'outcome' | 'why' | 'findings' | 'notes'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Said
  const notes = (Array.isArray(r.notes) ? r.notes : []).map((n) => line(n, 200)).filter(Boolean).slice(0, 8)
  const findings: UiFinding[] = []
  for (const f of Array.isArray(r.findings) ? r.findings as Record<string, unknown>[] : []) {
    const kind = String(f?.kind ?? '') as FindingKind, what = line(f?.what, 400), expected = line(f?.expected, 300)
    if (!FINDING_KINDS.includes(kind) || what.length < 10 || findings.length >= MAX_FINDINGS) continue
    const at = Math.min(Math.max(Math.round(Number(f.at_step) || steps.length), 1), Math.max(steps.length, 1))
    const criterion = knownCriterion(f.criterion, ids), lf = (f.looked_for && typeof f.looked_for === 'object' ? f.looked_for : null) as Record<string, unknown> | null
    const el = lf ? { ...(lf.role ? { role: line(lf.role, 40) } : {}), ...(lf.name ? { name: line(lf.name, 120) } : {}), ...(lf.text ? { text: line(lf.text, 120) } : {}) } : null
    const page = pages.filter((p) => p.after <= at).at(-1)
    const expect = el && (el.role || el.text) && page ? [{ ...el, visible: onPage(page.text, el) }] : undefined
    findings.push({ id: '', scenario: s.id, kind, what, expected, steps: steps.slice(0, at).flat(), ...(criterion ? { criterion } : {}), ...(expect ? { expect } : {}) })
  }
  const said = String(r.outcome ?? '')
  if (!findings.length && said === 'problem') return { outcome: 'unspecified', why: 'the tester saw a problem but reported no finding HQ could keep', findings, notes }
  return { outcome: findings.length ? 'problem' : said === 'unspecified' ? 'unspecified' : 'ok', findings, notes }
}
/** Numbers every finding of the run in order (U1, U2…). */
export const numbered = (all: UiFinding[]): UiFinding[] => all.map((f, i) => ({ ...f, id: `U${i + 1}` }))

// --- Words --------------------------------------------------------------------------------------------------------------------------------------------------
const KIND_WORDS: Record<FindingKind, string> = { stuck: 'stuck', confusing: 'confusing', unclear_label: 'label', no_feedback: 'no feedback', broken: 'broken',
  missing: 'missing' }
const cut = (v: string): string => v.length > 40 ? `${v.slice(0, 37)}…` : v
/** A step in a few words, for a person reading the summary. */
export function stepWords(s: Step): string {
  const el = s.role ? `${s.role}${s.name ? ` "${s.name}"` : ''}` : s.label ? `"${s.label}"` : s.text ? `"${s.text}"` : ''
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
/** The run summary's lines for the tester: what it covered, each finding with its steps, then one line per scenario that went fine or had no verdict. */
export function uiTestLines(u: UiTest | null): string[] {
  if (!u) return []
  if (u.state === 'skipped') return u.quiet ? [] : [`- Not tried: ${u.why}`]
  const by = (o: Outcome) => u.scenarios.filter((s) => s.outcome === o)
  const head = `- ${things(u.scenarios.length, 'scenario')}: ${by('ok').length} fine, ${things(u.findings.length, 'finding')}, ${by('unspecified').length} unspecified`
    + `${by('not_run').length ? `, ${by('not_run').length} not run` : ''}`
  const title = (id: string) => u.scenarios.find((s) => s.id === id)?.title ?? id
  return [head,
    ...u.findings.map((f) => `- ${f.id} (${KIND_WORDS[f.kind]}, ${f.scenario} ${title(f.scenario)}${f.criterion ? `, ${f.criterion}` : ''}): ${f.what}`
      + `${f.expected ? ` Expected: ${f.expected}` : ''}${f.steps.length ? ` Steps: ${chain(f.steps)}` : ''}`),
    ...u.scenarios.filter((s) => s.outcome !== 'problem').map((s) => `- ${s.id} ${s.title}: ${s.outcome === 'ok' ? 'fine' : s.outcome === 'unspecified'
      ? `no verdict (${s.why ?? 'the map and criteria don\'t say what should happen'})` : `not run${s.why ? ` (${s.why})` : ''}`}`)]
}
export const uiTestOf = (json: string | null | undefined): UiTest | null => { try { return json ? JSON.parse(json) as UiTest : null } catch { return null } }
