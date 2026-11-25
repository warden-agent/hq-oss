// The tester: as an auto run ends, one agent tries what the run built the way a person would, in a real browser (the rules are in testerrules.ts). Only
// features the run touched, only their screen criteria, a fixed number of actions each, and pages read as text, not screenshots: about 20,000 tokens a
// feature on the small engineer model. What it finds goes in the run's summary; nothing is sent back, because by now the work is merged.
// It is one headless Claude Code call (checker.ts), not an agent with a terminal. Its only tools are HQ's browser tools (testermcp.mjs), which Claude Code
// starts from the command HQ gives it: that command is HQ's own test sandbox around the MCP server, so the app and the browser run with localhost only and
// none of the user's credentials, in a throwaway checkout of main. An agent can't start a browser itself: Claude Code's own sandbox refuses it (smoke.ts).
// Spike on the real 2.1.322, 2026-11-17: four criteria tried in 6 actions (of 15), both planted problems found, nothing false, 12 s, about 20,000 tokens.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULTS, PATHS } from './config.ts'
import { getSetting } from './db.ts'
import { call, PLAIN } from './checker.ts'
import { appSpec, blocked, browsersPrefix, prepareApp, startWhy, type LookPlan } from './smoke.ts'
import { cleanEnv, inCheckout, ownTmp, runSandboxed, sandboxCommand } from './testrun.ts'
import { keepReport, testerPrompt, TESTER_SYSTEM, type ToTry, type Tried } from './testerrules.ts'
import { shq } from './util.ts'

const MCP = path.join(import.meta.dirname, 'testermcp.mjs')
/** Actions a feature gets (each open, click or type), and how long the whole try may take. */
export const TESTER_ACTIONS = Number(process.env.HQ_TESTER_ACTIONS) || 15
const TIMEOUT_MS = (Number(process.env.HQ_TESTER_TIMEOUT_S) || 600) * 1000
const TOOLS = ['open', 'click', 'type', 'done'].map((t) => `mcp__browse__${t}`).join(',')
const require = createRequire(import.meta.url)
/** HQ's own MCP SDK and zod, for the sandboxed server to import by path (the checkout it runs in has neither). */
const sdk = (): string => { const p = require.resolve('@modelcontextprotocol/sdk/server/mcp.js'), at = '@modelcontextprotocol/sdk'; return p.slice(0, p.indexOf(at) + at.length) }
const zod = (): string => path.dirname(require.resolve('zod'))
/** The tester's model: the small engineer's, unless the user has set one for it. */
export const testerModel = (): string => { const m = getSetting('models', DEFAULTS.models) as typeof DEFAULTS.models & { tester?: string }; return m.tester ?? m.engineer_s }

type Out = { started: boolean | null; why: string | null; actions: { tool: string; ok: boolean }[]; report: unknown }
/** The command Claude Code starts the browser tools with: HQ's test sandbox around the MCP server, in `wt`, with the clean environment a test run gets
 *  (Claude Code starts its MCP servers bare). `out`: where the server writes what the agent did, in the checkout, the one folder HQ and it both reach.
 *  `plan`: as prepareApp left it for this checkout (a port it moved is refused to the sandbox, Bug 374). */
export function serverCommand(wt: string, plan: LookPlan, out: string, tmp: string | null, more: Record<string, unknown> = {}): { command: string; args: string[] } {
  const spec = { ...appSpec(wt, plan), sdk: sdk(), zod: zod(), cap: TESTER_ACTIONS, out, ...more } // more: the first-map session's mode, cap and rules (firstmap.ts)
  const inner = `cd ${shq(wt)} && ${browsersPrefix()}exec ${shq(process.execPath)} ${shq(MCP)} ${shq(JSON.stringify(spec))}`, box = sandboxCommand(wt, inner, { network: false, block: blocked(plan) })
  return { command: '/usr/bin/env', args: ['-i', ...Object.entries(cleanEnv(tmp)).map(([k, v]) => `${k}=${v}`), box.bin, ...box.args] }
}
/** Tries one feature on `sha` (main as the run leaves it). `stopped`: auto mode went off or stopped meanwhile; nothing is kept. Everything it starts (the
 *  checkout, the call, the sandboxed server with the app and the browser under it) ends with it, however it ends. */
export function tryFeature(o: { repoPath: string; repoId: string; sha: string; plan: LookPlan; feature: ToTry; gen: number; runId: string }): Promise<Tried | 'stopped'> {
  const f = o.feature, base = { feature: f.handle, title: f.title, tickets: f.tickets }
  const skipped = (why: string): Tried => ({ ...base, state: 'skipped', why })
  return inCheckout(o.repoPath, o.sha, 'tester', o.gen, { repoId: o.repoId, ticketId: null, what: 'tester' }, async (wt, signal): Promise<Tried | 'stopped'> => {
    const got = await prepareApp(wt, o.plan, { signal, run: runSandboxed })
    if (got.kind === 'stopped') return 'stopped'
    if (got.kind !== 'ready') return skipped(got.kind === 'no_start' ? `the app couldn't be started (${got.why})` : got.why)
    const plan = got.plan
    const out = path.join(wt, '.hq-tester.json'), own = ownTmp()
    try {
      const servers = { mcpServers: { browse: { type: 'stdio', ...serverCommand(wt, plan, out, own.tmp) } } }
      const m = testerModel(), today = new Date().toISOString().slice(0, 10)
      const c = await call({ args: ['--model', m, '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(servers), '--allowedTools', TOOLS, ...PLAIN, '--system-prompt', TESTER_SYSTEM],
        prompt: testerPrompt(f, TESTER_ACTIONS, today), signal, timeoutMs: TIMEOUT_MS, env: { HQ_TESTER_OUT: out } }) // HQ_TESTER_OUT: for the e2e's stand-in, which has no MCP
      if (c.kind === 'stopped') return 'stopped'
      let seen: Out | null = null; try { seen = JSON.parse(fs.readFileSync(out, 'utf8')) as Out } catch { /* the server never wrote one */ }
      keep(o.repoId, o.runId, f.handle, seen)
      if (c.kind === 'error') return skipped(`the tester couldn't be asked (${c.why})`)
      if (seen?.started === false) return skipped(startWhy(seen.why ?? 'the app couldn\'t be started', plan))
      if (!seen?.report) return skipped(seen ? 'the tester ended without saying what it found' : 'the tester\'s browser tools never started')
      return { ...base, state: 'tried', ...keepReport(seen.report, f.criteria.map((x) => x.id)), actions: seen.actions.length, ms: c.ms, tokens: c.tokens, model: m }
    } finally { await own.done() }
  })
}
/** What the tester did on a feature, step by step, kept in HQ's own folder for the project (never in the user's repo): the record a later replay would start
 *  from. Nothing reads it yet. */
function keep(repoId: string, runId: string, handle: string, seen: Out | null): void {
  if (!seen?.actions.length) return
  try {
    const dir = path.join(PATHS.projects, repoId, 'tried'); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${runId}-${handle.replace(/[^A-Za-z0-9-]/g, '_')}.json`), JSON.stringify({ at: Date.now(), feature: handle, ...seen }, null, 1))
  } catch { /* a record only: the summary has what matters */ }
}
