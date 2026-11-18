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
import { appSpec, browsersPrefix, prepareApp, type LookPlan, lookHow } from './smoke.ts'
import { autoGen, inCheckout, runSandboxed, type Shown } from './testrun.ts'
import { buildTimeline, type Flag, type Row } from './timeline.ts'
import { readSetup, type TestSetup } from './testsetupstore.ts'
import { id, shq } from './util.ts'
import type { Recipe } from './apprun.ts'

export type Step = { action: 'navigate' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'back' | 'reset'
  role?: string; name?: string; text?: string; value?: string; url?: string; label?: string }
export type StepResult = { ok: boolean; why?: string }
export type ScenarioResult = { id: string; dir: string; started: boolean; why: string | null; steps: StepResult[]; timeline: Row[]; flags: Flag[]; summary: string; markdown: string; clean: boolean }

const RUNNER = path.join(import.meta.dirname, 'scenariorun.mjs')
/** A stand-in for scenariorun.mjs, for tests with no browser. */
const STAND_IN = (): string | null => process.env.HQ_SCENARIO_RUNNER || null
const STEP_MS = 5000, SETTLE_MAX_MS = 10_000
const KEEP = 50
export const scenariosDir = (repoId: string): string => path.join(PATHS.projects, repoId, 'scenarios')

/** What the recorder is told (recorder.mjs's spec), for an app checked out at `wt`: the start steps' parts, each run as the test setup's production start
 *  says, the state paths and the seed. `out`: where it writes, in the checkout (the one folder the sandbox and HQ both reach). */
export function recordingSpec(wt: string, plan: LookPlan, setup: TestSetup, out: string) {
  const base = appSpec(wt, plan)
  return { ...base, root: wt, out, snapshot: setup.snapshot, seed: setup.seed,
    parts: plan.recipe.parts.map((p) => { const s = setup.start.find((x) => x.part === p.name)!; return { name: p.name, cwd: path.join(wt, p.dir), run: s.run, build: s.build, port: p.port } }) }
}
/** The start steps and the test setup (`draft`, else the saved one), or why there's nothing to run. */
export function planFor(repoId: string, draft?: TestSetup): { plan: LookPlan; setup: TestSetup } | { why: string } {
  const repo = getRepo(repoId); if (!repo) return { why: 'unknown project' }
  const recipe: Recipe | null = runnableRecipe(row(repoId), repo.path)
  if (!recipe) return { why: `HQ doesn't know how to start ${repo.name} yet: Launch it once first` }
  const setup = draft ?? readSetup(repoId).setup; if (!setup) return { why: `${repo.name} has no test setup yet` }
  const parts = recipe.parts.map((p) => p.name).filter((n) => !setup.start.some((s) => s.part === n))
  if (parts.length) return { why: `the test setup has no production start for ${parts.join(', ')}: the start steps changed since; ask Claude to set up testing again` }
  return { plan: { recipe, repoPath: repo.path, how: lookHow(recipe) }, setup }
}

/** Runs one scenario on `sha` (main's head by default): the app on its seed, then `steps`. `setup`: one to check instead of the saved one (the setup helper's
 *  draft). `show`: on the board meanwhile. Resolves with the timeline, or `{ why }` when it couldn't run at all; 'stopped' when auto mode stopped it. */
export async function runScenario(repoId: string, steps: Step[], o: { name?: string; sha?: string; setup?: TestSetup; show?: Shown['what'] } = {}):
  Promise<ScenarioResult | { why: string } | 'stopped'> {
  const repo = getRepo(repoId); if (!repo) return { why: 'unknown project' }
  const found = planFor(repoId, o.setup); if ('why' in found) return found
  const { plan, setup } = found
  const sha = o.sha ?? await git(repo.path, ['rev-parse', mergeBase(repo).ref]).catch(() => null)
  if (!sha) return { why: `HQ couldn't find ${repo.default_branch}'s head` }
  const sid = id('scn'), dest = path.join(scenariosDir(repoId), sid), name = o.name ?? `scenario ${sid}`
  const show: Shown | null = o.show ? { repoId, ticketId: null, what: o.show } : null
  const r = await inCheckout(repo.path, sha, `scenario-${sid}`, autoGen(repo.path), show, async (wt, signal): Promise<ScenarioResult | { why: string } | 'stopped'> => {
    const cant = await prepareApp(wt, plan, { signal, run: runSandboxed })
    if (cant?.kind === 'stopped') return 'stopped'
    if (cant) return { why: cant.kind === 'no_start' ? `the app couldn't be installed (${cant.why})` : cant.why }
    const out = path.join(wt, '.hq-scenario'); fs.rmSync(out, { recursive: true, force: true })
    const spec = { ...recordingSpec(wt, plan, setup, out), steps, stepMs: STEP_MS }
    const limit = spec.startMs * 2 + 10 * 60_000 + steps.length * (STEP_MS * 3 + SETTLE_MAX_MS) + 60_000 // a reset starts the app again; a build may take a while
    const run = await runSandboxed(wt, `${browsersPrefix()}${shq(process.execPath)} ${shq(STAND_IN() ?? RUNNER)} ${shq(JSON.stringify(spec))}`, { network: false, timeoutMs: limit, signal })
    if (signal.aborted) return 'stopped'
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (fs.existsSync(out)) fs.cpSync(out, dest, { recursive: true }); else fs.mkdirSync(dest, { recursive: true })
    let res: { started: boolean | null; why: string | null; output?: string | null; steps: StepResult[] } | null = null
    try { res = JSON.parse(fs.readFileSync(path.join(dest, 'result.json'), 'utf8')) } catch { /* it never wrote one */ }
    if (!res) {
      const said = run.output.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200)
      res = { started: false, why: run.timedOut ? `the scenario took over ${Math.round(limit / 60_000)} minutes` : `the scenario ended with no result${said ? ` (${said})` : ''}`, steps: [] }
    }
    if (res.output) fs.writeFileSync(path.join(dest, 'start-output.log'), res.output)
    const t = buildTimeline(dest, { endpoints: setup.endpoints, limits: setup.limits, name })
    return { id: sid, dir: dest, started: !!res.started, why: res.why, steps: res.steps, timeline: t.rows, flags: t.flags,
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
