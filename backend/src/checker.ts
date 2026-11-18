// A second reader for auto mode: one fresh, one-shot question to Claude with no tools. On auto the same engineer writes the plan, the code and the tests, so
// if it misreads the ticket all three agree with each other. This asks a session that saw none of the engineer's reasoning: the plan check (plancheck.ts)
// before building, and the diff check (diffcheck.ts) before a merge. Not an agent: no terminal, no tools, no MCP, no hooks, no session kept; a few thousand
// tokens, a few seconds, and it ends by itself.
// Spike on the real 2.1.322, 2026-11-16: `claude -p --tools "" --json-schema …` answered in about 3 s with ~1,500 tokens in and ~400 out, through the same
// login the agents use (`--bare` can't be used: it never reads that login); an API error exits 1 with `is_error: true` in the same JSON.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CLAUDE_BIN, PATHS } from './config.ts'
import { modelFor } from './roles.ts'
import type { Finding } from './checks.ts'

export type Asked = { kind: 'answer'; findings: Finding[]; ms: number; tokens: number; model: string } | { kind: 'error'; why: string } | { kind: 'stopped' }

export const MAX_FINDINGS = 3
const SCHEMA = JSON.stringify({ type: 'object', required: ['verdict', 'findings'], properties: { verdict: { type: 'string', enum: ['ok', 'send_back'] },
  findings: { type: 'array', maxItems: MAX_FINDINGS, items: { type: 'object', required: ['about', 'problem'], properties: { about: { type: 'string' }, problem: { type: 'string' } } } } } })
const TIMEOUT_MS = (Number(process.env.HQ_CHECK_TIMEOUT_S) || 180) * 1000

/** The rules both checks hold the reader to, enforced here and not left to it: every finding is about a criterion of the ticket or is the check's own kind
 *  (`other`), at most three, each with something to say. What's left is what HQ acts on; none left means the reader found nothing. */
export function keepFindings(raw: unknown, ids: string[], other: string): Finding[] {
  const list = Array.isArray(raw) ? raw : [], out: Finding[] = []
  for (const f of list) {
    const about = String((f as Finding | null)?.about ?? '').trim(), problem = String((f as Finding | null)?.problem ?? '').replace(/\s+/g, ' ').trim()
    const id = ids.find((x) => x.toLowerCase() === about.toLowerCase()) ?? (about.toLowerCase() === other ? other : null)
    if (id && problem.length >= 10 && out.length < MAX_FINDINGS) out.push({ about: id, problem: problem.slice(0, 600) })
  }
  return out
}
const running = new Set<number>() // the process groups of the calls under way
/** The backend is going down: a call's time limit is a timer in this process, and nobody would read its answer. */
export function killChecks(): void { for (const g of running) { try { process.kill(-g, 'SIGKILL') } catch { /* gone */ } } }
/** Where the calls run: a folder of HQ's own with nothing in it, so no project's files or settings are in reach. */
const cwd = (): string => { const d = path.join(PATHS.home, 'checks'); fs.mkdirSync(d, { recursive: true }); return d }
/** What the call's environment keeps of the backend's: everything but the variables a Claude Code session sets for what it starts (the backend may have
 *  been started from one), which would make this look like a session inside a session. */
const env = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k))), DISABLE_AUTOUPDATER: '1' })

type Raw = { is_error?: boolean; result?: unknown; structured_output?: { verdict?: unknown; findings?: unknown }; usage?: Record<string, number>; total_cost_usd?: number }
export type Called = { kind: 'result'; r: Raw; ms: number; tokens: number } | { kind: 'error'; why: string } | { kind: 'stopped' }
/** One headless Claude Code call (`claude -p`, the prompt on its input), in a process group of its own that ends with the call: when it answers, at its time
 *  limit, when `signal` fires, or when the backend goes down. `result`: what it printed as its last JSON line, when the call itself didn't fail. `error`: why
 *  not, in words for the user. `stopped`: `signal` ended it; nothing follows. `env`: more variables for it (and for what it starts). `cwd`: the folder it starts in
 *  (HQ's own empty folder, by default; a checkout when it has read tools and needs one to read, backendcheck.ts). */
export function call(o: { args: string[]; prompt: string; signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string>; cwd?: string }): Promise<Called> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ kind: 'stopped' })
    const began = Date.now(), limit = o.timeoutMs ?? TIMEOUT_MS
    const p = spawn(CLAUDE_BIN, ['-p', ...o.args], { cwd: o.cwd ?? cwd(), env: { ...env(), ...o.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); if (p.pid) running.add(p.pid)
    let out = '', err = '', timedOut = false, result: Called | null = null
    const kill = () => { try { process.kill(-p.pid!, 'SIGKILL') } catch { /* gone */ } }
    const timer = setTimeout(() => { timedOut = true; kill() }, limit)
    o.signal?.addEventListener('abort', kill)
    const done = (r: Called) => { if (result) return; result = r; clearTimeout(timer); o.signal?.removeEventListener('abort', kill); if (p.pid) running.delete(p.pid); resolve(r) }
    p.stdout.setEncoding('utf8').on('data', (s: string) => { out = (out + s).slice(-200_000) }); p.stderr.setEncoding('utf8').on('data', (s: string) => { err = (err + s).slice(-2000) })
    p.on('error', (e) => done({ kind: 'error', why: `Claude Code wouldn't start (${e.message})` }))
    p.stdin.on('error', () => {}) // it went before it read the prompt: `close` says why
    p.on('close', (code) => {
      kill() // what it started (an MCP server of HQ's, with an app and a browser under it) goes with it
      if (o.signal?.aborted) return done({ kind: 'stopped' })
      if (timedOut) return done({ kind: 'error', why: `no answer within ${Math.round(limit / 1000)} s` })
      const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).at(-1)
      let r: Raw | null = null
      try { r = line ? JSON.parse(line) : null } catch { r = null }
      const said = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      const said0 = err.split('\n').filter((l) => /[a-z]{3}/i.test(l) && !/^\s*at /.test(l)) // not a stack trace's lines, or the marks under one
      const lastWords = said0.find((l) => /error/i.test(l)) ?? said0.at(-1)
      if (!r) return done({ kind: 'error', why: said(lastWords) || `Claude Code ended with code ${code} and no answer` })
      if (r.is_error || code !== 0) return done({ kind: 'error', why: said(r.result) || `Claude Code ended with code ${code}` })
      const u = r.usage ?? {}, tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
      done({ kind: 'result', r, ms: Date.now() - began, tokens })
    })
    p.stdin.end(o.prompt)
  })
}
/** The flags every call of HQ's shares: nothing of the user's or a project's settings, no slash commands, no session kept, one JSON line out. */
export const PLAIN = ['--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json']

/** Asks a reader once. `system`: who the reader is and its rules. `prompt`: what it reads. `ids`: the ticket's criterion ids, and `other` the one more thing a
 *  finding may be about. An answer is the findings that keep to the rules (keepFindings); `error` is anything else, with why, in words for the user: the
 *  call failed, ran out of time, or answered with something that isn't the answer asked for. `stopped`: `signal` ended it; nothing follows. */
export async function ask(o: { system: string; prompt: string; ids: string[]; other: string; signal?: AbortSignal }): Promise<Asked> {
  const model = modelFor('architect')
  const c = await call({ args: ['--model', model, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...PLAIN, '--json-schema', SCHEMA, '--system-prompt', o.system],
    prompt: o.prompt, signal: o.signal })
  if (c.kind !== 'result') return c
  const a = c.r.structured_output
  if (!a || (a.verdict !== 'ok' && a.verdict !== 'send_back') || !Array.isArray(a.findings)) return { kind: 'error', why: 'the answer wasn\'t in the form HQ asked for' }
  return { kind: 'answer', findings: a.verdict === 'ok' ? [] : keepFindings(a.findings, o.ids, o.other), ms: c.ms, tokens: c.tokens, model }
}
