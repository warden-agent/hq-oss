// The UI tester: as an auto run ends (never in manual mode, never per ticket), a code-blind tester uses the whole app in a real browser the way a person would,
// and reports where one would get stuck or confused. What it finds is a report in the run's summary; nothing is fixed or sent back by itself.
// 1. One call (Sonnet, no tools) writes about 30 scenarios from the feature map and the run's screen criteria as a plain "what's new" list (uitesterrules.ts).
// 2. HQ starts the app once, in a throwaway checkout of main, inside its test sandbox, under the tester's host (uitesthost.mjs), which resets it before each
//    scenario and records each step on HQ's clock.
// 3. The scenarios run in small batches, each a fresh Claude Code session locked down as the `tester` role (roles.ts): Playwright MCP and HQ's two scenario
//    tools, nothing else; its browser in a sandbox of its own that reaches the app's port only and can't read the project (testrun.ts browserProfile).
// 4. HQ turns what the browser ran into replayable steps, keeps each scenario's log, and the findings with their steps, in its own folder for the project.
// 5. With a test setup (Part 3), the app runs under HQ's recorder instead: its production start on the setup's seed, every API call, server line and data
//    change written down per scenario, kept next to the scenario's log as <id>.rec/ for the backend checker (Part 5). The tester sees none of it.
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
import { recordingFor } from './scenario.ts'
import { buildTimeline } from './timeline.ts'
import type { TestSetup } from './testsetupstore.ts'
import { stepWords as loopWords } from './findingrules.ts'
import type { Retry } from './loopinputs.ts'
import {
  BUDGET, keepPlan, ON_ELEMENT, keepReport, LOOK_TOOLS, numbered, PER_SESSION, PLAN_SCHEMA, PLAN_SYSTEM, planPrompt, SCENARIOS, stepsOf, stepWords, TESTER_SYSTEM, testerPrompt, whatsNew,
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
const SESSION_MS = (Number(process.env.HQ_UITEST_SESSION_S) || 900) * 1000, HOST_START_MS = 120_000, SEED_MS = 120_000, BUILD_MS = 10 * 60_000
/** The browser's own folder: short, because the browser's sockets go in it and a socket's path may be 104 bytes at most. Named by the backend's pid, so a
 *  later backend can sweep a dead one's (sweepUiTmp). */
const TMP_ROOT = '/private/tmp', TMP_PREFIX = 'hq-ut-'

export type RunInput = { repoPath: string; repoId: string; runId: string; sha: string; plan: LookPlan; gen: number;
  tickets: { key: string; title: string; criteria: Criterion[] }[]; retry?: Retry[] }

const skipped = (why: string, quiet?: boolean): UiTest => ({ at: Date.now(), state: 'skipped', why, ...(quiet ? { quiet } : {}) })
/** Where a run's scenarios, logs and findings are kept: HQ's own folder for the project, never the user's repo. Part 5 (findings) reads them from here. */
export const uiTestDir = (repoId: string, runId: string): string => path.join(PATHS.projects, repoId, 'uitest', runId)
/** A scenario's recording: its id as findings name it ("<run>/<scenario>"), and its folder. */
export const recordingId = (runId: string, sid: string): string => `${runId}/${sid}`
export function recordingDir(repoId: string, id: string): string | null {
  const m = /^([\w-]+)\/([\w-]+)$/.exec(id); if (!m) return null
  const dir = path.join(uiTestDir(repoId, m[1]!), `${m[2]}.rec`); return fs.existsSync(path.join(dir, 'actions.jsonl')) ? dir : null
}
/** Recordings are kept for the newest runs only: the checker reads a run's as it ends, and a fix is judged on a new recording, not the old one. */
const KEEP_RUNS = 5
function pruneRecordings(repoId: string): void {
  try {
    const root = path.dirname(uiTestDir(repoId, 'x')), runs = fs.readdirSync(root).map((n) => ({ n, t: fs.statSync(path.join(root, n)).mtimeMs })).sort((a, b) => b.t - a.t)
    for (const r of runs.slice(KEEP_RUNS)) for (const f of fs.readdirSync(path.join(root, r.n))) if (f.endsWith('.rec')) fs.rmSync(path.join(root, r.n, f), { recursive: true, force: true })
  } catch { /* none yet */ }
}

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
  // Findings a replay couldn't reproduce by script (Part 5): tried again by goal, first. The goal leads as given: Part 5 matches results back by it. Under it,
  // what was seen then (the tester's own finding) or HQ's instruction (the checker's: its words never reach the tester), and the old steps in words, which
  // no longer fit the app: the tester finds its own way. The title is what the summary calls it
  const retry = (o.retry ?? []).map((f) => ({ title: `Again: ${(f.own ? f.what : f.expected || f.what).slice(0, 80)}`, goal: [f.goal, f.own ? `Seen before: ${f.what}` : f.what,
    f.steps.length ? `The steps then, which may not fit the app any more (find your own way): ${f.steps.map(loopWords).join(' → ')}` : ''].filter(Boolean).join('\n') }))
  const scenarios = keepPlan(planned.r.structured_output as unknown, SCENARIOS, news.ids, retry)
  if (!scenarios.length) return skipped('the tester\'s plan had no scenarios HQ could use')
  // Its folder starts empty: a run whose tester was stopped halfway and starts again keeps nothing of the first try
  const dir = uiTestDir(o.repoId, o.runId); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(scenarios, null, 1))

  // 2–4. The app, and the scenarios in batches
  const r = await inCheckout(o.repoPath, o.sha, 'uitest', o.gen, { repoId: o.repoId, ticketId: null, what: 'tester' }, async (wt, signal): Promise<UiTest | 'stopped'> => {
    const cant = await prepareApp(wt, o.plan, { signal, run: runSandboxed })
    if (cant?.kind === 'stopped') return 'stopped'
    if (cant) return skipped(cant.kind === 'no_start' ? `the app couldn't be started (${cant.why})` : cant.why)
    // HQ_UITEST_BROWSER_EXE: for the e2e's stand-in Claude Code, which starts no browser
    const exe = process.env.HQ_UITEST_BROWSER_EXE || headlessShell(); if (!exe) return skipped('HQ\'s browser isn\'t on this machine')
    const out = path.join(wt, '.hq-uitest'), hostStop = new AbortController(), stop = () => hostStop.abort(); signal.addEventListener('abort', stop)
    const rec = recordingFor(o.repoId, wt, o.plan) // the project's test setup: with one, the app runs under HQ's recorder
    const spec = { ...appSpec(wt, o.plan), out, budget: BUDGET, looks: LOOK_TOOLS, shots: ['take_screenshot'], onElement: ON_ELEMENT, ...('record' in rec ? { record: rec.record } : {}) }
    const sessions = Math.ceil(scenarios.length / PER_SESSION) // the host's time limit: every session's, and the app's start
    // Under the recorder the start is the setup's: its seed command first, and a production build when it has one (the recorder's own limits for each)
    const startMs = HOST_START_MS + ('record' in rec ? SEED_MS + (rec.record.parts.some((x) => x.build) ? BUILD_MS : 0) : 0)
    const host = runSandboxed(wt, `exec ${shq(process.execPath)} ${shq(HOST)} ${shq(JSON.stringify(spec))}`,
      { network: false, timeoutMs: SESSION_MS * sessions + startMs, signal: hostStop.signal })
    const tmp = fs.mkdtempSync(path.join(TMP_ROOT, `${TMP_PREFIX}${process.pid}-`))
    try {
      const up = await hostUp(out, signal, startMs)
      if (up === 'stopped') return 'stopped'
      if (!up.started) return skipped(up.why ?? 'the app didn\'t start')
      const origin = `http://localhost:${up.port}`, results: ScenarioResult[] = []
      const setup = 'setup' in rec && up.recorded ? rec.setup : null
      const unrecorded = setup ? null : 'why' in rec ? rec.why : `the app didn't start on its test setup (${up.unrecorded ?? 'no reason given'})`
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
        // The host couldn't reset the app for a scenario and told the tester to stop: that's why the rest weren't run, not the session's end (Bug 170)
        const reset = resetFailed(out)
        for (const s of batch) {
          const res = resultOf(s, out, origin, news.ids, reset ? `HQ couldn't reset the app: ${reset}`
            : c.kind === 'error' ? `the session ended early (${c.why})` : 'the session ended before it')
          if (setup && res.outcome !== 'not_run' && keepRecording(path.join(out, 'rec', s.id), path.join(dir, `${s.id}.rec`), path.join(b, 'out'), setup, s, ranOf(s, out, origin))) {
            res.recording = recordingId(o.runId, s.id)
          }
          results.push(res); fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(res, null, 1))
        }
      }
      pruneRecordings(o.repoId)
      const findings = numbered(results.flatMap((x) => x.findings))
      return { at: Date.now(), state: 'done', model, tokens, cost_usd: Math.round(cost * 100) / 100, ms: Date.now() - began, sessions, findings, ...(unrecorded ? { unrecorded } : {}),
        scenarios: results.map((x) => ({ id: x.scenario.id, kind: x.scenario.kind, title: x.scenario.title, outcome: x.outcome, actions: x.steps.length, ...(x.why ? { why: x.why } : {}),
          ...(x.scenario.criteria?.length ? { criteria: x.scenario.criteria } : {}) })) }
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

type Up = { started: boolean; why?: string; ctrl: number; port: number; recorded?: boolean; unrecorded?: string }
/** Keeps a scenario's recording in HQ's folder: the recorder's logs as the host left them (`from`, in the checkout, which goes), the page's console errors
 *  from the browser tools' own log (`browserOut`), and the timeline built from them. False when there is nothing to keep. */
function keepRecording(from: string, to: string, browserOut: string, setup: TestSetup, s: Scenario, ran: Map<number, string> = new Map()): boolean {
  try {
    if (!fs.existsSync(path.join(from, 'actions.jsonl'))) return false
    fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(from, to, { recursive: true })
    // Each action under the name of what the browser ran for it ("click button Add"), which the host couldn't know when it stamped the action's start
    if (ran.size) {
      const marks = fs.readFileSync(path.join(to, 'actions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { label: string; action: number })
      fs.writeFileSync(path.join(to, 'actions.jsonl'), marks.map((m) => `${JSON.stringify(m.label === 'reset' ? m : { ...m, label: ran.get(m.action) ?? m.label })}\n`).join(''))
    }
    const seen = consoleErrors(path.join(to, 'console-refs.jsonl'), browserOut)
    if (seen.length) fs.appendFileSync(path.join(to, 'browser.jsonl'), seen.map((x) => `${JSON.stringify(x)}\n`).join(''))
    buildTimeline(to, { endpoints: setup.endpoints, limits: setup.limits, name: `${s.id} ${s.title}` })
    return true
  } catch { return false }
}
/** What the browser ran for each recorded action of a scenario, by the action's number, in a few words: from the host's log, where each step has the
 *  recorder's number for it and the browser tool's answer with the code it ran. */
function ranOf(s: Scenario, out: string, origin: string): Map<number, string> {
  const ran = new Map<number, string>()
  try {
    const k = JSON.parse(fs.readFileSync(path.join(out, `${s.id}.json`), 'utf8')) as { log: (Logged & { action?: number })[] }
    for (const e of k.log) { const steps = e.ok && e.action ? stepsOf(e.answer, origin) : []; if (steps.length) ran.set(e.action!, steps.map(stepWords).join(', then ').slice(0, 200)) }
  } catch { /* never begun */ }
  return ran
}
/** The console errors the browser tools wrote down for a scenario. The host noted which lines of the tools' console log each step added (uitesthost.mjs);
 *  the log itself is in the browser's own folder, which only HQ reads. Its lines, as Playwright MCP 0.0.84 writes them (looked at for real, 2026-11-17):
 *  `[  1234ms] [ERROR] text @ http://…:12` for console.error, `[  1240ms] TypeError: …` for an uncaught error. */
function consoleErrors(refs: string, browserOut: string): { at: number; kind: 'console'; text: string; action: number | null }[] {
  let lines: { at: number; file: string; from: number; to: number; action: number | null }[] = []
  try { lines = fs.readFileSync(refs, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
  const out: { at: number; kind: 'console'; text: string; action: number | null }[] = [], logs = new Map<string, string[]>()
  for (const r of lines) {
    if (!logs.has(r.file)) { try { logs.set(r.file, fs.readFileSync(path.join(browserOut, r.file), 'utf8').split('\n')) } catch { logs.set(r.file, []) } }
    for (const l of logs.get(r.file)!.slice(r.from - 1, r.to)) {
      // console.error says [ERROR]; an uncaught error has no level, and its stack follows on lines of their own. A failed request is the API row's to tell
      const m = /^\[\s*\d+ms\] (?:\[([A-Z]+)\] )?(.*)$/.exec(l); if (!m || (m[1] && m[1] !== 'ERROR') || /^Failed to load resource/.test(m[2]!)) continue
      out.push({ at: r.at, kind: 'console', text: m[2]!.replace(/ @ \S+$/, '').slice(0, 500), action: r.action })
    }
  }
  return out
}
/** Waits for the host to say the app is up (or why not). */
async function hostUp(out: string, signal: AbortSignal, limit: number): Promise<Up | 'stopped'> {
  for (const t0 = Date.now(); Date.now() - t0 < limit;) {
    if (signal.aborted) return 'stopped'
    try { return JSON.parse(fs.readFileSync(path.join(out, 'host.json'), 'utf8')) as Up } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  return { started: false, why: `the app wasn't up within ${Math.round(limit / 1000)} s`, ctrl: 0, port: 0 }
}

/** Why the host's last reset failed in a session (uitesthost.mjs), if one did; read once, so the next session starts with none. */
function resetFailed(out: string): string | null {
  const f = path.join(out, 'reset-failed.json')
  try { return String((JSON.parse(fs.readFileSync(f, 'utf8')) as { why?: unknown }).why ?? 'no reason given') } catch { return null } finally { fs.rmSync(f, { force: true }) }
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
export const _forTests = { resultOf, browserServer, consoleErrors, keepRecording, ranOf, resetFailed }
