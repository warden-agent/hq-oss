// A scenario against a project's app (Tester & Checker, Part 3): HQ starts the app from its test setup (testsetupstore.ts) on a clean seed, in a throwaway
// checkout of main inside its test sandbox (localhost only, none of the user's credentials), drives HQ's headless browser through the given steps, records
// everything (recorder.mjs) and puts it in one timeline (timeline.ts). Steps are given, not chosen: no model, no tokens. The UI tester (Part 4) chooses its
// own steps and uses the recorder the same way; a replay is this with the steps it saved.
// Everything is kept in HQ's own folder for the project: ~/.hq/projects/<repo>/scenarios/<id>/, the raw logs next to timeline.md. The checkout goes.
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.ts'
import { emit } from './events.ts'
import { getRepo } from './records.ts'
import { git } from './reposync.ts'
import { mergeBase } from './conflicts.ts'
import { runnableRecipe, row } from './preview.ts'
import { appSpec, blocked, browsersPrefix, prepareApp, startWhy, type LookPlan, lookHow } from './smoke.ts'
import { moveLine } from './testports.ts'
import { autoGen, detectTests, inCheckout, runSandboxed, type Shown } from './testrun.ts'
import { buildTimeline, type Flag, type Row } from './timeline.ts'
import { readSetup, type TestSetup } from './testsetupstore.ts'
import { id, shq } from './util.ts'
import type { Recipe } from './apprun.ts'

/** `field`: an input named by its label or placeholder, when it has no role and name. `css`: a Playwright selector, for an element with neither (`nth`: which
 *  of its matches, 0 the first, -1 the last). `label`: what the step is called in the timeline. */
export type Step = { action: 'navigate' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'hover' | 'back' | 'reset'
  role?: string; name?: string; text?: string; value?: string; url?: string; label?: string; field?: string; css?: string; nth?: number }
export type StepResult = { ok: boolean; why?: string }
/** What should (`visible`) or shouldn't be on the page once the steps are done: checked in code after the last one (a replay of a finding). */
export type Expect = { role?: string; name?: string; text?: string; visible: boolean }
/** `expect`: how each expectation held, when some were given and every step could be done. */
export type ScenarioResult = { id: string; dir: string; started: boolean; why: string | null; steps: StepResult[]; expect?: StepResult[]; timeline: Row[]; flags: Flag[]; summary: string
  markdown: string; clean: boolean }

const RUNNER = path.join(import.meta.dirname, 'scenariorun.mjs')
/** A stand-in for scenariorun.mjs, for tests with no browser. */
const STAND_IN = (): string | null => process.env.HQ_SCENARIO_RUNNER || null
const STEP_MS = 5000, SETTLE_MAX_MS = 10_000
const KEEP = 50
export const scenariosDir = (repoId: string): string => path.join(PATHS.projects, repoId, 'scenarios')

/** What the recorder is told (recorder.mjs's spec), for an app checked out at `wt`: the start steps' parts, each run as the test setup's production start
 *  says, the state paths and the seed. `out`: where it writes, in the checkout (the one folder the sandbox and HQ both reach). `plan`: as prepareApp left it
 *  for this checkout: a port it moved there (Bug 374) is moved in the setup's own commands too. */
export function recordingSpec(wt: string, plan: LookPlan, setup: TestSetup, out: string) {
  const base = appSpec(wt, plan), here = (cmd: string): string => moveLine(cmd, plan.moved ?? [])
  return { ...base, root: wt, out, snapshot: setup.snapshot, seed: setup.seed, // the seed writes data before the app starts: a number in it is no port
    parts: plan.recipe.parts.map((p) => { const s = setup.start.find((x) => x.part === p.name)!
      return { name: p.name, cwd: path.join(wt, p.dir), run: here(s.run), build: s.build ? here(s.build) : s.build, port: p.port } }) }
}
/** Why there's no test setup, in words that can't be read as "the project has no tests" (Bug 223: a project with `npm test` was told it had "no test setup
 *  yet"). The setup is HQ's way of starting and recording the app for scenarios, not the project's own tests; when it has those, the words say so. */
export function noSetupWhy(repoId: string): string {
  const repo = getRepo(repoId); let tests: string | null = repo?.test_cmd ?? null
  if (repo && !tests) { try { tests = detectTests(repo.path)?.test ?? null } catch { /* no checkout to read */ } }
  return `HQ isn't set up to record this app yet: Set up testing is under the preview's ⚙${tests ? `. This is separate from the project's own tests, \`${tests}\`,`
    + ' which still run as usual' : ''}`
}
/** The start steps and the test setup (`draft`, else the saved one), or why there's nothing to run. */
export function planFor(repoId: string, draft?: TestSetup): { plan: LookPlan; setup: TestSetup } | { why: string } {
  const repo = getRepo(repoId); if (!repo) return { why: 'unknown project' }
  const recipe: Recipe | null = runnableRecipe(row(repoId), repo.path)
  if (!recipe) return { why: `HQ doesn't know how to start ${repo.name} yet: Launch it once first` }
  const setup = draft ?? readSetup(repoId).setup; if (!setup) return { why: noSetupWhy(repoId) }
  const parts = recipe.parts.map((p) => p.name).filter((n) => !setup.start.some((s) => s.part === n))
  if (parts.length) return { why: `the test setup has no production start for ${parts.join(', ')}: the start steps changed since; ask Claude to set up testing again` }
  return { plan: { recipe, repoPath: repo.path, how: lookHow(recipe) }, setup }
}

/** The recorder's spec for the UI tester's host (uitester.ts), which runs the app under the recorder for its whole run, when the project has a test setup
 *  that covers every part of `plan`'s start steps; else why its run isn't recorded. */
export function recordingFor(repoId: string, wt: string, plan: LookPlan): { record: ReturnType<typeof recordingSpec>; setup: TestSetup } | { why: string } {
  const setup = readSetup(repoId).setup; if (!setup) return { why: noSetupWhy(repoId) }
  const parts = plan.recipe.parts.map((p) => p.name).filter((n) => !setup.start.some((s) => s.part === n))
  if (parts.length) return { why: `the test setup has no production start for ${parts.join(', ')}: the start steps changed since` }
  return { record: recordingSpec(wt, plan, setup, ''), setup } // `out`: the host's own choice
}

/** Runs one scenario on `sha` (main's head by default): the app on its seed, then `steps`, then `expect` looked for on the page. `setup`: one to check
 *  instead of the saved one (the setup helper's draft). `show`: on the board meanwhile. `gen`: the auto run it is part of, as its caller read it (testrun.ts
 *  autoGen). Resolves with the timeline, or `{ why }` when it couldn't run at all; 'stopped' when auto mode stopped it. */
export async function runScenario(repoId: string, steps: Step[], o: { name?: string; sha?: string; setup?: TestSetup; show?: Shown['what']; expect?: Expect[]; gen?: number } = {}):
  Promise<ScenarioResult | { why: string } | 'stopped'> {
  const repo = getRepo(repoId); if (!repo) return { why: 'unknown project' }
  const found = planFor(repoId, o.setup); if ('why' in found) return found
  const { plan, setup } = found
  const sha = o.sha ?? await git(repo.path, ['rev-parse', mergeBase(repo).ref]).catch(() => null)
  if (!sha) return { why: `HQ couldn't find ${repo.default_branch}'s head` }
  const sid = id('scn'), dest = path.join(scenariosDir(repoId), sid), name = o.name ?? `scenario ${sid}`
  const show: Shown | null = o.show ? { repoId, ticketId: null, what: o.show } : null
  const r = await inCheckout(repo.path, sha, `scenario-${sid}`, o.gen ?? autoGen(repo.path), show, async (wt, signal): Promise<ScenarioResult | { why: string } | 'stopped'> => {
    const got = await prepareApp(wt, plan, { signal, run: runSandboxed })
    if (got.kind === 'stopped') return 'stopped'
    if (got.kind !== 'ready') return { why: got.kind === 'no_start' ? `the app couldn't be installed (${got.why})` : got.why }
    const here = got.plan // as it runs in this checkout: on other ports, when its own were in use (Bug 374)
    const out = path.join(wt, '.hq-scenario'); fs.rmSync(out, { recursive: true, force: true })
    const spec = { ...recordingSpec(wt, here, setup, out), steps, stepMs: STEP_MS, ...(o.expect?.length ? { expect: o.expect } : {}) }
    // a reset starts the app again; a build may take a while
    const limit = spec.startMs * 2 + 10 * 60_000 + steps.length * (STEP_MS * 3 + SETTLE_MAX_MS) + (o.expect?.length ?? 0) * STEP_MS + 60_000
    const run = await runSandboxed(wt, `${browsersPrefix()}${shq(process.execPath)} ${shq(STAND_IN() ?? RUNNER)} ${shq(JSON.stringify(spec))}`,
      { network: false, timeoutMs: limit, signal, block: blocked(here) })
    if (signal.aborted) return 'stopped'
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (fs.existsSync(out)) fs.cpSync(out, dest, { recursive: true }); else fs.mkdirSync(dest, { recursive: true })
    let res: { started: boolean | null; why: string | null; output?: string | null; steps: StepResult[]; expect?: StepResult[] } | null = null
    try { res = JSON.parse(fs.readFileSync(path.join(dest, 'result.json'), 'utf8')) } catch { /* it never wrote one */ }
    if (!res) {
      const said = run.output.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200)
      res = { started: false, why: run.timedOut ? `the scenario took over ${Math.round(limit / 60_000)} minutes` : `the scenario ended with no result${said ? ` (${said})` : ''}`, steps: [] }
    }
    if (!res.started && res.why) res.why = startWhy(res.why, here)
    if (res.output) fs.writeFileSync(path.join(dest, 'start-output.log'), res.output)
    const t = buildTimeline(dest, { endpoints: setup.endpoints, limits: setup.limits, name })
    return { id: sid, dir: dest, started: !!res.started, why: res.why, steps: res.steps, ...(res.expect ? { expect: res.expect } : {}), timeline: t.rows, flags: t.flags,
      summary: res.started ? t.summary : `${name}: didn't run (${res.why})`, markdown: t.markdown, clean: !!res.started && t.clean }
  })
  prune(repoId)
  if (r !== 'stopped' && 'id' in r) emit({ agentId: null, source: 'system', kind: 'scenario.done', payload: { repo: repo.name, id: r.id, name, summary: r.summary, flags: r.flags.length } })
  return r
}
/** Only the newest scenarios are kept. */
function prune(repoId: string): void {
  try {
    const dir = scenariosDir(repoId), all = fs.readdirSync(dir).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)
    for (const x of all.slice(KEEP)) fs.rmSync(path.join(dir, x.n), { recursive: true, force: true })
  } catch { /* none yet */ }
}
