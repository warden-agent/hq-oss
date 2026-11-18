// The UI tester: as an auto run ends (never in manual mode, never per ticket), a code-blind tester uses the whole app in a real browser the way a person would,
// and reports where one would get stuck or confused. What it finds is a report in the run's summary; nothing is fixed or sent back by itself.
// 1. One call (Sonnet, no tools) writes about 30 scenarios from the feature map and the run's screen criteria as a plain "what's new" list (uitesterrules.ts).
// 2. HQ starts the app once, in a throwaway checkout of main, inside its test sandbox, under the tester's host (uitesthost.mjs), which resets it before each
//    scenario and records each step on HQ's clock.
// 3. The scenarios run in small batches, each a fresh Claude Code session locked down as the `tester` role (roles.ts): Playwright MCP and HQ's two scenario
//    tools, nothing else; its browser in a sandbox of its own that reaches the app's port only and can't read the project (testrun.ts browserProfile).
// 4. HQ turns what the browser ran into replayable steps, keeps each scenario's log, and the findings with their steps, in its own folder for the project.
// macOS only for now: on Linux the browser's sandbox would need the app in the same network namespace, which isn't built.
// Spike on the real 2.1.322, 2026-11-17: Playwright MCP 0.0.84 under HQ's sandbox; refused tools are off the tester's list; file:// and other ports refused;
// hooks given with --settings run with --setting-sources ''; a hook's deny holds. One small scenario: 10 s, about 30,000 tokens.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PATHS } from './config.ts'
import { call, PLAIN } from './checker.ts'
import { modelFor, testerFlags } from './roles.ts'
import { appSpec, headlessShell, prepareApp, type LookPlan } from './smoke.ts'
import { autoWork, browserProfile, inCheckout, runSandboxed, showing } from './testrun.ts'
import { featureMap } from './uitestinputs.ts'
import {
  BUDGET, keepPlan, ON_ELEMENT, keepReport, LOOK_TOOLS, numbered, PER_SESSION, PLAN_SCHEMA, PLAN_SYSTEM, planPrompt, SCENARIOS, stepsOf, TESTER_SYSTEM, testerPrompt, whatsNew,
  type Scenario, type ScenarioResult, type Step, type UiTest,
} from './uitesterrules.ts'
import type { Criterion } from './criteria.ts'
import { shq } from './util.ts'

const HOST = path.join(import.meta.dirname, 'uitesthost.mjs'), TOOLS = path.join(import.meta.dirname, 'uitestmcp.mjs')
const require = createRequire(import.meta.url)
const MCP_CLI = (): string => path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js')
const sdk = (): string => { const p = require.resolve('@modelcontextprotocol/sdk/server/mcp.js'), at = '@modelcontextprotocol/sdk'; return p.slice(0, p.indexOf(at) + at.length) }
const zod = (): string => path.dirname(require.resolve('zod'))
/** A session's time limit, and the whole run's (the host and the app go with it). */
const SESSION_MS = (Number(process.env.HQ_UITEST_SESSION_S) || 900) * 1000, HOST_START_MS = 120_000
/** The browser's own folder: short, because the browser's sockets go in it and a socket's path may be 104 bytes at most. Named by the backend's pid, so a
 *  later backend can sweep a dead one's (sweepUiTmp). */
const TMP_ROOT = '/private/tmp', TMP_PREFIX = 'hq-ut-'

export type RunInput = { repoPath: string; repoId: string; runId: string; sha: string; plan: LookPlan; gen: number;
  tickets: { key: string; title: string; criteria: Criterion[] }[]; retry?: { goal: string; what: string; expected: string; steps: Step[] }[] }

const skipped = (why: string, quiet?: boolean): UiTest => ({ at: Date.now(), state: 'skipped', why, ...(quiet ? { quiet } : {}) })
/** Where a run's scenarios, logs and findings are kept: HQ's own folder for the project, never the user's repo. Part 5 (findings) reads them from here. */
export const uiTestDir = (repoId: string, runId: string): string => path.join(PATHS.projects, repoId, 'uitest', runId)

/** The tester on `sha` (main as the run leaves it). `stopped`: auto mode went off or stopped meanwhile; nothing is kept. Everything it starts (the checkout,
 *  the host with the app under it, each session with its browser) ends with it, however it ends. */
export async function runUiTest(o: RunInput): Promise<UiTest | 'stopped'> {
  if (process.platform !== 'darwin') return skipped('the UI tester runs on macOS only for now: its browser\'s sandbox is macOS\'s')
  const model = modelFor('tester'), began = Date.now(), map = featureMap(o.repoId), news = whatsNew(o.tickets)
  let tokens = 0, cost = 0
  // 1. The scenarios
  // Auto going off or stopping ends the planning call too, and the board says what HQ is doing meanwhile
  const work = autoWork(o.repoPath, o.gen), page = showing({ repoId: o.repoId, ticketId: null, what: 'tester' })
  const planned = await call({ args: ['--model', model, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...PLAIN, '--json-schema', PLAN_SCHEMA,
    '--system-prompt', PLAN_SYSTEM], prompt: planPrompt(map, news.lines, SCENARIOS), signal: work.signal }).finally(() => { work.done(); page.over() })
  if (planned.kind === 'error') return skipped(`the tester couldn't plan its scenarios (${planned.why})`)
  if (planned.kind === 'stopped') return 'stopped'
  tokens += planned.tokens; cost += planned.r.total_cost_usd ?? 0
  // Findings a replay couldn't reproduce by script (Part 5): tried again by goal, first. The goal goes through as given: Part 5 matches results back by it
  const retry = (o.retry ?? []).map((f) => ({ title: `Again: ${f.what.slice(0, 80)}`, goal: f.goal }))
  const scenarios = keepPlan(planned.r.structured_output as unknown, SCENARIOS, news.ids, retry)
  if (!scenarios.length) return skipped('the tester\'s plan had no scenarios HQ could use')
  const dir = uiTestDir(o.repoId, o.runId); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(scenarios, null, 1))

  // 2–4. The app, and the scenarios in batches
  const r = await inCheckout(o.repoPath, o.sha, 'uitest', o.gen, { repoId: o.repoId, ticketId: null, what: 'tester' }, async (wt, signal): Promise<UiTest | 'stopped'> => {
    const cant = await prepareApp(wt, o.plan, { signal, run: runSandboxed })
    if (cant?.kind === 'stopped') return 'stopped'
    if (cant) return skipped(cant.kind === 'no_start' ? `the app couldn't be started (${cant.why})` : cant.why)
    // HQ_UITEST_BROWSER_EXE: for the e2e's stand-in Claude Code, which starts no browser
    const exe = process.env.HQ_UITEST_BROWSER_EXE || headlessShell(); if (!exe) return skipped('HQ\'s browser isn\'t on this machine')
    const out = path.join(wt, '.hq-uitest'), hostStop = new AbortController(), stop = () => hostStop.abort(); signal.addEventListener('abort', stop)
    const spec = { ...appSpec(wt, o.plan), out, budget: BUDGET, looks: LOOK_TOOLS, shots: ['take_screenshot'], onElement: ON_ELEMENT }
    const sessions = Math.ceil(scenarios.length / PER_SESSION) // the host's time limit: every session's, and the app's start
    const host = runSandboxed(wt, `exec ${shq(process.execPath)} ${shq(HOST)} ${shq(JSON.stringify(spec))}`,
      { network: false, timeoutMs: SESSION_MS * sessions + HOST_START_MS, signal: hostStop.signal })
    const tmp = fs.mkdtempSync(path.join(TMP_ROOT, `${TMP_PREFIX}${process.pid}-`))
    try {
      const up = await hostUp(out, signal)
      if (up === 'stopped') return 'stopped'
      if (!up.started) return skipped(up.why ?? 'the app didn\'t start')
      const origin = `http://localhost:${up.port}`, results: ScenarioResult[] = []
      for (let i = 0, n = 0; i < scenarios.length; i += PER_SESSION, n++) {
        const batch = scenarios.slice(i, i + PER_SESSION), b = path.join(tmp, `b${n}`)
        for (const d of ['empty', 'home', 'out']) fs.mkdirSync(path.join(b, d), { recursive: true })
        const scenarioTools = { type: 'stdio', command: process.execPath, args: [TOOLS, JSON.stringify({ sdk: sdk(), zod: zod(), ctrl: up.ctrl })] }
        const mcp = { browser: browserServer(b, up.port, o.repoPath, exe), uitest: scenarioTools }
        const c = await call({ args: [...testerFlags({ model, mcp, ctrl: up.ctrl }), ...PLAIN, '--system-prompt', TESTER_SYSTEM], cwd: path.join(b, 'empty'),
          prompt: testerPrompt({ map, news: news.lines, scenarios: batch, budget: BUDGET }), signal, timeoutMs: SESSION_MS })
        if (c.kind === 'stopped' || signal.aborted) return 'stopped'
        // A session that ended mid-scenario (its time limit, an API error, or it simply stopped) leaves it open: it's written as it stands, and the next
        // session's first scenario can begin
        await fetch(`http://127.0.0.1:${up.ctrl}/close`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000) }).catch(() => {})
        if (c.kind === 'result') { tokens += c.tokens; cost += c.r.total_cost_usd ?? 0 }
        for (const s of batch) {
          const res = resultOf(s, out, origin, news.ids, c.kind === 'error' ? `the session ended early (${c.why})` : 'the session ended before it')
          results.push(res); fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(res, null, 1))
        }
      }
      const findings = numbered(results.flatMap((x) => x.findings))
      return { at: Date.now(), state: 'done', model, tokens, cost_usd: Math.round(cost * 100) / 100, ms: Date.now() - began, sessions, findings,
        scenarios: results.map((x) => ({ id: x.scenario.id, kind: x.scenario.kind, title: x.scenario.title, outcome: x.outcome, actions: x.steps.length, ...(x.why ? { why: x.why } : {}) })) }
    } finally {
      signal.removeEventListener('abort', stop); stop(); await host
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
  return r
}

/** The browser tools as Claude Code starts them: Playwright MCP in the browser's sandbox, with nothing of the backend's environment, its home and temp folder
 *  its own (`b`), told the app's address as the one origin it may ask for. */
function browserServer(b: string, port: number, project: string, exe: string): { type: 'stdio'; command: string; args: string[] } {
  const env = { HOME: path.join(b, 'home'), TMPDIR: b, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'en_US.UTF-8' }
  const flags = ['--headless', '--isolated', '--browser', 'chromium', '--executable-path', exe, '--no-sandbox', '--output-dir', path.join(b, 'out'),
    '--viewport-size', '1280x800', '--allowed-origins', `http://localhost:${port}`, '--block-service-workers', '--image-responses', 'allow']
  const run = `cd ${shq(path.join(b, 'empty'))} && exec ${shq(process.execPath)} ${shq(MCP_CLI())} ${flags.map(shq).join(' ')}`
  // Chromium's own sandbox is off (--no-sandbox): macOS refuses a sandbox inside a sandbox, and the page then crashes at once (spike). HQ's holds.
  return { type: 'stdio', command: '/usr/bin/env', args: ['-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), '/usr/bin/sandbox-exec', '-p', browserProfile(b, port, project),
    '/bin/sh', '-c', run] }
}

type Up = { started: boolean; why?: string; ctrl: number; port: number }
/** Waits for the host to say the app is up (or why not). */
async function hostUp(out: string, signal: AbortSignal): Promise<Up | 'stopped'> {
  for (const t0 = Date.now(); Date.now() - t0 < HOST_START_MS;) {
    if (signal.aborted) return 'stopped'
    try { return JSON.parse(fs.readFileSync(path.join(out, 'host.json'), 'utf8')) as Up } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  return { started: false, why: `the app wasn't up within ${HOST_START_MS / 1000} s`, ctrl: 0, port: 0 }
}

type Logged = { at: number; ms: number; tool: string; input: unknown; ok: boolean; answer: string }
type Kept = { id: string; log: Logged[]; report: unknown }
/** A scenario as the host recorded it: its steps from the code the browser ran, its log, and what of the tester's report HQ keeps. `notRun`: why, when the
 *  host has nothing for it. */
function resultOf(s: Scenario, out: string, origin: string, ids: string[], notRun: string): ScenarioResult {
  let k: Kept | null = null; try { k = JSON.parse(fs.readFileSync(path.join(out, `${s.id}.json`), 'utf8')) as Kept } catch { /* never begun */ }
  if (!k) return { scenario: s, outcome: 'not_run', why: notRun, steps: [], log: [], findings: [], notes: [], recording: null }
  const per = k.log.map((e) => (e.ok ? stepsOf(e.answer, origin) : []))
  const acts: Step[][] = [], pages: { after: number; text: string }[] = []
  k.log.forEach((e, i) => {
    if (e.tool === 'snapshot' && e.ok) pages.push({ after: acts.length, text: /### Snapshot\s*```yaml\n([\s\S]*?)```/.exec(e.answer)?.[1] ?? '' })
    if (per[i]!.length) acts.push(per[i]!)
  })
  const log = k.log.map((e, i) => ({ at: e.at, ms: e.ms, tool: e.tool, ok: e.ok, ...(per[i]!.length ? { step: per[i] } : {}),
    ...(!e.ok ? { note: e.answer.replace(/\s+/g, ' ').slice(0, 200) } : {}) }))
  if (!k.report) return { scenario: s, outcome: 'not_run', why: 'the tester didn\'t finish it', steps: per.flat(), log, findings: [], notes: [], recording: null }
  return { scenario: s, ...keepReport(k.report, s, acts, pages, ids), steps: per.flat(), log, recording: null }
}

/** Removes the browser folders of testers whose backend is gone: one that died mid-run never got to. */
export function sweepUiTmp(): string[] {
  if (process.platform !== 'darwin') return []
  const gone: string[] = []
  for (const d of fs.readdirSync(TMP_ROOT)) {
    const pid = Number(new RegExp(`^${TMP_PREFIX}(\\d+)-`).exec(d)?.[1]); if (!pid || pid === process.pid) continue
    try { process.kill(pid, 0); continue } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') continue }
    try { fs.rmSync(path.join(TMP_ROOT, d), { recursive: true, force: true }); gone.push(d) } catch { /* next start */ }
  }
  return gone
}
export const _forTests = { resultOf, browserServer }
