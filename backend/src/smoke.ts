// HQ's look at the built app before an auto merge (the rules are in smokerules.ts): HQ's own headless browser and its one-time download, and the run itself,
// which starts the app from its launch recipe in a test run's throwaway checkout and opens its pages (smokerun.mjs), all inside the test sandbox.
// Spikes, 2026-11-16, macOS: Chromium's headless shell starts under HQ's sandbox-exec profile with the network off (0.3 s), loads localhost pages, and can't
// reach any other host. It does not start inside an engineer's Claude Code sandbox (2.1.322 refuses the Mach service Chromium registers at launch), so this
// is HQ's check, not something an engineer can run. Linux under bubblewrap isn't checked yet: if the browser doesn't start there, the look is skipped.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Recipe } from './apprun.ts'
import { copyMainData } from './trydata.ts'
import { shq } from './util.ts'
import { movedNoStart, type MovedPort, type Seen } from './smokerules.ts'
import { blocked, placePorts } from './testports.ts'
import { toolCaches } from './testrun.ts'

/** What HQ starts to look at a project's app: its launch recipe (the user's own command, or the steps they OK'd for the preview), the checkout whose own
 *  settings and data a copy is taken of (as Try it does), and the recipe in a few words for a report. */
export type LookPlan = { recipe: Recipe; repoPath: string; how: string
  /** Bug 374: ports the project hard-wires that HQ moved in the checkout this plan runs in (prepareApp): `recipe` already has the new ones. */
  moved?: MovedPort[] }
export const lookHow = (r: Recipe): string => r.parts.map((p) => r.parts.length > 1 ? `${p.name}: ${p.run}` : p.run).join(' + ')

const RUNNER = path.join(import.meta.dirname, 'smokerun.mjs')
/** A stand-in for smokerun.mjs, for tests that have no browser: then HQ fetches none either. */
const STAND_IN = process.env.HQ_LOOK_RUNNER || null
const START_MS = (Number(process.env.HQ_LOOK_START_S) || 60) * 1000, PAGE_MS = 15_000, MAX_PAGES = 8, DEPTH = 1
/** The whole look's time limit: the start, every page with its wait for the network to go quiet, and the browser's own start. */
const LOOK_MS = START_MS + MAX_PAGES * (PAGE_MS + 6000) + 30_000
const INSTALL_MS = 10 * 60_000

const require = createRequire(import.meta.url)
/** HQ's own playwright-core: its folder, which the sandboxed runner imports by path (the checkout it looks at has no such package). */
const pwCore = (): string => path.dirname(require.resolve('playwright-core/package.json'))
/** Where the browser is kept: Playwright's own cache folder (~/Library/Caches/ms-playwright, ~/.cache/ms-playwright), which the sandbox can read and any
 *  Playwright on this machine shares. HQ's own folder is no good: the sandbox hides it. HQ_BROWSERS_PATH names another folder. */
const browsersEnv = (): Record<string, string> => process.env.HQ_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.HQ_BROWSERS_PATH } : {}

/** Is HQ's browser on this machine already? From playwright-core's own list of browser revisions and the cache folder: no download, no process. */
export function browserHere(): boolean { const d = shellDir(); return !!d && fs.existsSync(path.join(d, 'INSTALLATION_COMPLETE')) }
/** The folder HQ's browser is (or will be) in: playwright-core's revision of it, in Playwright's cache folder. Null when that can't be read. */
function shellDir(): string | null {
  try {
    const all = (JSON.parse(fs.readFileSync(path.join(pwCore(), 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] }).browsers
    const rev = all.find((b) => b.name === 'chromium-headless-shell')?.revision, home = os.homedir()
    const dir = process.env.HQ_BROWSERS_PATH ?? (process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright')
      : path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'ms-playwright'))
    return rev ? path.join(dir, `chromium_headless_shell-${rev}`) : null
  } catch { return null }
}
/** HQ's browser's program, for what starts it by path (the UI tester's Playwright MCP, uitester.ts, which otherwise wants a full Chrome). Null when it isn't
 *  downloaded yet (ensureBrowser). */
export function headlessShell(): string | null {
  const d = shellDir(); if (!d || !browserHere()) return null
  const sub = fs.readdirSync(d).find((n) => n.startsWith('chrome-headless-shell-')), exe = sub && path.join(d, sub, 'chrome-headless-shell')
  return exe && fs.existsSync(exe) ? exe : null
}
let have = false, fetching: Promise<string | null> | null = null
/** Makes sure HQ's headless browser is on this machine: Playwright's installer, which downloads it once (about 180 MB) and does nothing when it's there.
 *  Null when it is; else why not, for the user. A failure is tried again at the next look: they may have been offline. One download at a time. */
export function ensureBrowser(): Promise<string | null> {
  if (have || STAND_IN || (have = browserHere())) return Promise.resolve(null)
  fetching ??= new Promise<string | null>((resolve) => {
    execFile(process.execPath, [path.join(pwCore(), 'cli.js'), 'install', 'chromium-headless-shell'], { env: { ...process.env, ...browsersEnv() }, timeout: 10 * 60_000 }, (err, _out, errOut) => {
      if (!err) { have = true; return resolve(null) }
      const why = String(errOut || err.message).split('\n').map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? 'unknown error'
      resolve(`HQ couldn't download its browser (${why})`)
    })
  }).finally(() => { fetching = null })
  return fetching
}

type Run = (cwd: string, cmd: string, o: { network: boolean; timeoutMs: number; signal?: AbortSignal; block?: number[]; env?: Record<string, string> }) =>
  Promise<{ code: number | null; output: string; timedOut: boolean }>
/** A part's install is needed in a fresh checkout unless its packages came with it: HQ copies the main checkout's node_modules into a test checkout
 *  (worktrees.ts seedPackages), and an npm install on top of them would only rewrite files. Anything else (uv sync, go build) is quick when up to date. */
const installs = (p: Recipe['parts'][number], dir: string): boolean => !!p.install && !(/^(npm|yarn|pnpm|bun)\b/.test(p.install.trim()) && fs.existsSync(path.join(dir, 'node_modules')))

export type Prepared = { kind: 'ready'; plan: LookPlan } | Exclude<Seen, { kind: 'looked' }> | { kind: 'stopped' }
/** Gets a throwaway checkout ready for the app to run in: HQ's browser on the machine, a copy of the user's own settings and data (as Try it takes), a port
 *  of its own for a part whose hard-wired one is in use (Bug 374, testports.ts), and each part's install, with the network on, as for the tests.
 *  `ready`: the plan as it runs in this checkout (`moved`: the ports HQ changed there), for appSpec and, as `block`, for every sandboxed run of it. Else why
 *  the app can't be started here. */
export async function prepareApp(wt: string, plan0: LookPlan, o: { signal: AbortSignal; run: Run }): Promise<Prepared> {
  const stopped = { kind: 'stopped' } as const
  const none = await ensureBrowser(); if (none) return { kind: 'skipped', why: none }
  if (o.signal.aborted) return stopped
  const copied = await copyMainData(plan0.repoPath, wt, plan0.recipe.worktree_files).catch(() => []) // an app that needs its .env or its data to start gets a copy, never the user's own
  const placed = await placePorts(wt, plan0, copied).catch((e) => ({ skip: `HQ couldn't check the app's ports (${(e as Error).message.split('\n')[0]})` }))
  if ('skip' in placed) return { kind: 'skipped', why: placed.skip }
  if (o.signal.aborted) return stopped
  const plan = placed.plan
  for (const p of plan.recipe.parts) {
    const dir = path.join(wt, p.dir); if (!installs(p, dir)) continue
    // Bug 454: where Yarn, pnpm and Bun keep what they download, as for HQ's test runs: else a folder of the one run, and pnpm's store in the checkout
    const i = await o.run(dir, p.install!, { network: true, timeoutMs: INSTALL_MS, signal: o.signal, env: toolCaches(p.install!) })
    if (o.signal.aborted) return stopped
    if (i.code !== 0) return { kind: 'no_start', why: `installing its ${p.name} part failed (\`${p.install}\`)`, output: i.output.slice(-3000) }
  }
  return { kind: 'ready', plan }
}
/** Why an app didn't start. When HQ moved a port for this run (Bug 374) that may be the reason (a part that listens on its old port whatever it is told is
 *  refused it), so the words are about the port: who has it, what HQ tried, and what frees it (smokerules.ts movedNoStart). */
export const startWhy = (why: string, plan: LookPlan): string => plan.moved?.length ? movedNoStart(why, plan.moved) : why
export { blocked }
/** What the sandboxed scripts are told about the app and the browser: the recipe's parts in `wt`, which one has the page, and HQ's own playwright-core.
 *  The app counts as started once every part listens on its port, the moved ones (Bug 374) on their new one (appstart.mjs, Bug 388). */
export const appSpec = (wt: string, plan: LookPlan) => ({ parts: plan.recipe.parts.map((p) => ({ name: p.name, cwd: path.join(wt, p.dir), run: p.run, port: p.port })),
  show: plan.recipe.show, pwCore: pwCore(), startMs: START_MS })
/** `PLAYWRIGHT_BROWSERS_PATH=… ` in front of a sandboxed command, when HQ's browser isn't in Playwright's usual folder. */
export const browsersPrefix = (): string => Object.entries(browsersEnv()).map(([k, v]) => `${k}=${shq(v)} `).join('')
/** Starts the app in `wt` (a throwaway checkout of the commit to look at) and opens its pages. `run`: the sandboxed runner (testrun.ts runSandboxed): the app,
 *  and the browser with it, run with localhost only and none of the user's credentials. `stopped`: the signal ended it (auto mode went off): nothing follows. */
export async function lookIn(wt: string, plan0: LookPlan, o: { signal: AbortSignal; run: Run }): Promise<Seen | { kind: 'stopped' }> {
  const stopped = { kind: 'stopped' } as const
  const got = await prepareApp(wt, plan0, o); if (got.kind !== 'ready') return got
  const plan = got.plan // as it runs here: on other ports, when its own were in use (Bug 374)
  const out = path.join(wt, '.hq-look.json'); fs.rmSync(out, { force: true }) // in the checkout: the one folder this and the sandboxed run both reach; it goes with it
  const spec = { ...appSpec(wt, plan), out, pageMs: PAGE_MS, maxPages: MAX_PAGES, depth: DEPTH }
  const r = await o.run(wt, `${browsersPrefix()}${shq(process.execPath)} ${shq(STAND_IN ?? RUNNER)} ${shq(JSON.stringify(spec))}`,
    { network: false, timeoutMs: LOOK_MS, signal: o.signal, block: blocked(plan) })
  if (o.signal.aborted) return stopped
  try {
    const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as Seen
    if (!plan.moved?.length) return seen
    return seen.kind === 'skipped' ? seen : { ...seen, moved: plan.moved } // a start that failed too: the verdict's words are about the port then (judge)
  } catch { /* it never wrote one */ }
  const said = r.output.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200)
  return { kind: 'skipped', why: r.timedOut ? `HQ's look at the app took over ${Math.round(LOOK_MS / 60_000)} minutes` : `HQ's look at the app ended with no result${said ? ` (${said})` : ''}` }
}
