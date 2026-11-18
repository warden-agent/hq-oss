// The real parts behind the findings loop's seams (loopinputs.ts), and the one place where their shapes meet the loop's: Part 3's scripted scenarios and
// test setup (scenario.ts, testsetupstore.ts) and Part 4's UI tester (uitester.ts). index.ts plugs these in as HQ starts; without that the checker reads
// nothing and no fix is ever replayed. What differs between the parts is translated here, in code, and nowhere else:
// - A step. The tester keeps what the browser ran: the typed text, the key or the option in `value`, an input's label or placeholder in `label`, an
//   element's own text in `text`. The loop and the scripted runner read the typed text or key in `text`, a label or placeholder in `field`, and an
//   element's text in `name`.
// - An expectation. The tester notes whether the element it looked for was on the page when it reported the finding (what it saw). The loop checks what
//   should be there once it's fixed. So one that was missing becomes "it shows"; one that was there says nothing a script can check, and is left out (the
//   tester then retries that finding by its goal).
import fs from 'node:fs'
import path from 'node:path'
import { one } from './db.ts'
import { runScenario, scenariosDir } from './scenario.ts'
import { buildTimeline } from './timeline.ts'
import { testSetupOf } from './testsetupstore.ts'
import { recordingDir, uiTestDir } from './uitester.ts'
import { uiTestOf, type Expect as SeenExpect, type ScenarioResult, type Scenario as UiScenario, type Step as UiStep } from './uitesterrules.ts'
import type { Expect, Recorded, ScenarioRun, Seams, Step, UiFinding, UiRun } from './loopinputs.ts'

/** A step as the tester kept it, as the loop and the scripted runner read it. */
export function loopStep(s: UiStep): Step {
  const el = { ...(s.role ? { role: s.role, ...(s.name ? { name: s.name } : {}) } : s.text ? { name: s.text } : s.label ? { field: s.label } : {}),
    ...(s.css ? { css: s.css } : {}), ...(s.nth !== undefined ? { nth: s.nth } : {}) } // the selector finds it, when there is one (Bug 198)
  if (s.action === 'navigate') return { action: 'navigate', url: s.url ?? '/' }
  if (s.action === 'back') return { action: 'back' }
  if (s.action === 'fill' || s.action === 'press') return { action: s.action, ...el, text: s.value ?? '' }
  if (s.action === 'select') return { action: 'select', ...el, value: s.value ?? '' }
  return { action: s.action, ...el }
}
/** What a replay should find on the page once a finding is fixed, from what the tester saw when it reported it. */
export function loopExpect(seen: SeenExpect[] | undefined): Expect[] | undefined {
  const want = (seen ?? []).filter((e) => !e.visible && (e.role || e.name || e.text)).map((e) => ({ ...e, visible: true }))
  return want.length ? want : undefined
}

/** A recording folder as the loop reads it: its timeline, built from the recorder's logs. */
function recorded(repoId: string, id: string, dir: string, name: string): Recorded {
  const setup = testSetupOf(repoId), t = buildTimeline(dir, { endpoints: setup?.endpoints, limits: setup?.limits, name })
  return { id, dir, timeline: t.rows, markdown: t.markdown, flags: t.flags, steps: [] }
}
const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return null } }

export const realParts: Seams = {
  async runScenario(repoId, steps, o) {
    const r = await runScenario(repoId, steps, { name: 'Replay of a finding', expect: o?.expect, gen: o?.gen })
    if (r === 'stopped' || !('id' in r)) return r
    if (!r.started) return { why: r.why ?? 'the app didn\'t start' }
    return { id: r.id, dir: r.dir, timeline: r.timeline, markdown: r.markdown, flags: r.flags, steps: r.steps, ...(r.expect ? { expect: r.expect } : {}) }
  },
  /** One the UI tester's run made ("<run>/<scenario>"), or a scripted scenario's (its id). */
  recording(repoId, id) {
    const ui = recordingDir(repoId, id)
    if (ui) { // under the name the tester's run gave it: its scenario's id and title
      const sid = id.split('/')[1]!, title = readJson<ScenarioResult>(path.join(path.dirname(ui), `${sid}.json`))?.scenario.title
      return recorded(repoId, id, ui, title ? `${sid} ${title}` : sid)
    }
    const dir = /^[\w-]+$/.test(id) ? path.join(scenariosDir(repoId), id) : null
    return dir && fs.existsSync(path.join(dir, 'actions.jsonl')) ? recorded(repoId, id, dir, id) : null
  },
  endpoints: (repoId) => testSetupOf(repoId)?.endpoints ?? [],
  /** From what the tester kept in HQ's folder for the run, and only for a run whose tester finished: one that was stopped halfway keeps nothing. */
  uiRun(repoId, runId) {
    const u = uiTestOf(one<{ ui_test: string | null }>('SELECT ui_test FROM auto_runs WHERE id = ? AND repo_id = ?', runId, repoId)?.ui_test)
    if (u?.state !== 'done') return null
    const dir = uiTestDir(repoId, runId), plan = readJson<UiScenario[]>(path.join(dir, 'plan.json')); if (!plan) return null
    const results = plan.map((s) => readJson<ScenarioResult>(path.join(dir, `${s.id}.json`))).filter((r): r is ScenarioResult => !!r)
    let n = 0 // numbered across the run (U1, U2…), as the run's summary has them
    const scenarios: ScenarioRun[] = results.map((r) => {
      const findings = r.findings.map((f): UiFinding => {
        const want = loopExpect(f.expect)
        return { id: `U${++n}`, scenario: f.scenario, kind: f.kind, what: f.what, expected: f.expected, steps: f.steps.map(loopStep), ...(f.criterion ? { criterion: f.criterion } : {}),
          ...(want ? { expect: want } : {}) }
      })
      return { scenario: r.scenario, steps: r.steps.map(loopStep), findings, recording: r.recording, outcome: r.outcome, ...(r.why ? { why: r.why } : {}) }
    })
    return { scenarios, findings: scenarios.flatMap((x) => x.findings), ...(u.unrecorded ? { unrecorded: u.unrecorded } : {}) } satisfies UiRun
  },
}
