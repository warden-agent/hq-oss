// What the findings loop (Part 5) takes from the parts built beside it, as the sessions building them agreed on 2026-11-17: Part 3's recorded scenarios
// (timeline rows and their flags, runScenario, the endpoint labels) and Part 4's UI tester (its steps, findings and runUiTest). The loop imports only this file.
// The shapes follow what those branches have (tester-part3 9825f43, ui-tester 6d51f34, 2026-11-17), cut to the fields the loop reads.
// Until those parts are on main, nothing is plugged in here: the checker and the replay say "not set up" and step aside. index.ts plugs the real ones in.

/** One step of a scenario, built by HQ from the tester's own browser calls (never from its words), so it can be replayed without a model. `url` is a path on
 *  the app ("/", "/?tab=reading"). fill types `text`; select picks `value`; press presses the key in `text`. */
export type Step = { action: 'navigate' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'hover' | 'back' | 'reset'; role?: string; name?: string; text?: string
  label?: string; value?: string; url?: string }
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
 *  `unspecified`: nothing says what should happen. `not_run`: the session ended before it finished. */
export type ScenarioRun = { scenario: Scenario; steps: Step[]; findings: UiFinding[]; recording: string | null; outcome: 'ok' | 'problem' | 'unspecified' | 'not_run'; why?: string }
/** A sent finding whose replay broke: the tester tries it again by its goal. Only these words and steps reach it, never anything of the backend checker's. */
export type Retry = { goal: string; what: string; expected: string; steps: Step[] }
export type UiRun = { scenarios: ScenarioRun[]; findings: UiFinding[] }

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
const absent = 'the recorded test setup (Part 3) and the UI tester (Part 4) are not part of this HQ yet'
const seams: Seams = {
  runScenario: async () => ({ why: absent }),
  recording: () => null,
  endpoints: () => [],
  uiRun: () => null,
}
/** The parts in use now. */
export const inputs = (): Seams => seams
/** index.ts plugs the real parts in at start-up; tests plug in stand-ins. Returns what was there, so a test can put it back. */
export function plugIn(p: Partial<Seams>): Seams { const was = { ...seams }; Object.assign(seams, p); return was }
