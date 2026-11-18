// What the findings loop (Part 5) takes from the parts built beside it: Part 3's recorded scenarios (timeline rows and their flags, runScenario, the endpoint
// labels) and Part 4's UI tester (its steps, findings and run). The loop imports only this file, and the shapes here are the loop's own, cut to the fields
// it reads. The real parts, and the translation from their shapes to these, are in loopparts.ts; index.ts plugs them in as HQ starts (plugIn), and tests
// plug in stand-ins. Nothing but types and the seams here: the page imports the loop's rules, and they import this.

/** One step of a scenario, built by HQ from the tester's own browser calls (never from its words), so it can be replayed without a model. `url` is a path on
 *  the app ("/", "/?tab=reading"). fill types `text`; select picks `value`; press presses the key in `text`. The element: `role` and `name`, or `name` alone (its
 *  text), or `field` (an input's label or placeholder), or `css` (a Playwright selector, with `nth` the match it takes: 0 the first, -1 the last). `label`: what
 *  the step is called in a timeline. */
export type Step = { action: 'navigate' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'hover' | 'back' | 'reset'; role?: string; name?: string; text?: string
  label?: string; value?: string; url?: string; field?: string; css?: string; nth?: number }
/** What should (or shouldn't) be on the page after the last step, from the tester's last look: replays check it in code. */
export type Expect = { role?: string; name?: string; text?: string; visible: boolean }
/** Something HQ's code saw while a scenario ran (no model): the same call twice in one action, a call far slower than its endpoint's normal, a 4xx/5xx, a
 *  browser console error, a request that failed. `path` is the endpoint's pattern (/api/items/:id). */
export type Flag = { kind: 'duplicate' | 'slow' | 'error' | 'console' | 'failed_request'; method?: string; path?: string; status?: number; why: string }
export type Row = { at: number; source: 'tester' | 'hq' | 'api' | 'server' | 'data' | 'browser'; text: string; flags: Flag[] }
/** One scenario as HQ recorded it: its folder (raw logs, timeline.md), its timeline, every flag, and how each step went. */
export type Recorded = { id: string; dir: string; timeline: Row[]; markdown: string; flags: Flag[]; steps: { ok: boolean; why?: string }[]
  expect?: { ok: boolean; why?: string }[] }
export type Endpoint = { method: string; path: string; kind: 'instant' | 'normal' | 'heavy' }

export type Scenario = { id: string; kind: 'basic' | 'weird' | 'complex' | 'retry'; title: string; goal: string; criteria?: string[] }
/** What the UI tester found. `steps`: the scenario's steps up to the finding (its reproduction). */
export type UiFinding = { id: string; scenario: string; kind: 'stuck' | 'confusing' | 'unclear_label' | 'no_feedback' | 'broken' | 'missing'; what: string; expected: string;
  steps: Step[]; expect?: Expect[]; criterion?: string }
/** A scenario the tester ran: its steps, how it went, and its recording's id (Part 3) for the checker. `ok`: nothing worth a finding. `problem`: findings.
 *  `unspecified`: nothing says what should happen. `couldnt_test`: it needs what a browser can't do (the clock), no verdict (Bug 223). `not_run`: the
 *  session ended before it finished. */
export type ScenarioRun = { scenario: Scenario; steps: Step[]; findings: UiFinding[]; recording: string | null
  outcome: 'ok' | 'problem' | 'unspecified' | 'couldnt_test' | 'not_run'; why?: string }
/** A sent finding whose replay broke: the tester tries it again by its goal. Only these words and steps reach it, never anything of the backend checker's.
 *  `own`: the finding is the tester's own, so `what` is what it saw then; else `what` is only HQ's instruction to do the scenario again. */
export type Retry = { goal: string; what: string; expected: string; steps: Step[]; own: boolean }
/** `unrecorded`: why HQ's recorder wasn't on for this run (no test setup, or the app didn't start on it), so there is nothing for the checker to read. */
export type UiRun = { scenarios: ScenarioRun[]; findings: UiFinding[]; unrecorded?: string }

export type Seams = {
  /** Part 3: reset the app, run the steps under HQ's recorder, and check `expect` after the last one. `why`: it couldn't (no test setup, the app wouldn't
   *  start). `stopped`: auto mode went off meanwhile. */
  runScenario: (repoId: string, steps: Step[], o?: { expect?: Expect[]; gen?: number }) => Promise<Recorded | { why: string } | 'stopped'>
  /** Part 3: a recording made while the UI tester ran, by its id. */
  recording: (repoId: string, id: string) => Recorded | null
  /** Part 3: the endpoint labels the setup agent worked out. */
  endpoints: (repoId: string) => Endpoint[]
  /** Part 4: the UI tester's run for this auto run, once it has ended; null when it didn't run. */
  uiRun: (repoId: string, runId: string) => UiRun | null
}
const absent = 'HQ\'s recorder and UI tester weren\'t connected to the findings loop when it started'
const seams: Seams = {
  runScenario: async () => ({ why: absent }),
  recording: () => null,
  endpoints: () => [],
  uiRun: () => null,
}
/** The parts in use now. */
export const inputs = (): Seams => seams
/** index.ts plugs the real parts in at start-up (loopparts.ts); tests plug in stand-ins. Returns what was there, so a test can put it back. */
export function plugIn(p: Partial<Seams>): Seams { const was = { ...seams }; Object.assign(seams, p); return was }
