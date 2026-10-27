// HQ end-to-end harness: an isolated backend (temp HQ_HOME and HOME, free ports, its own tmux socket) whose Claude Code is
// fake-claude.mjs, so tests drive the real hooks, MCP tools and UI API with no model and no tokens. It never touches ~/.hq,
// ~/.claude.json, the live tmux server or HQ's ports.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const BACKEND = path.resolve(import.meta.dirname, '..')
const FAKE = path.join(import.meta.dirname, 'fake-claude.mjs')

export const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** Polls `fn` every 100ms until it returns something truthy. */
export async function waitFor<T>(what: string, fn: () => T | Promise<T>, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)) }
}
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})

export type Hq = Awaited<ReturnType<typeof startHq>>
/** `env`: extra environment for the backend (a fake `gh` on PATH, say). */
export async function startHq(o: { env?: NodeJS.ProcessEnv } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-')))
  const tmuxDir = fs.mkdtempSync('/tmp/hq-e2e-') // unix socket paths must stay short
  const home = path.join(root, 'home'), hqHome = path.join(root, 'hq'); fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, '.claude.json'), '{ "projects": {} }') // HQ marks workspaces trusted in it
  const ports = { ui: await freePort(), hooks: await freePort(), mcp: await freePort() }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HQ_HOME: hqHome, HQ_UI_PORT: String(ports.ui), HQ_HOOKS_PORT: String(ports.hooks), HQ_MCP_PORT: String(ports.mcp), HQ_CLAUDE_BIN: FAKE, TMUX_TMPDIR: tmuxDir,
    GIT_AUTHOR_NAME: 'HQ e2e', GIT_AUTHOR_EMAIL: 'e2e@hq.test', GIT_COMMITTER_NAME: 'HQ e2e', GIT_COMMITTER_EMAIL: 'e2e@hq.test', GIT_CONFIG_NOSYSTEM: '1', ...o.env }
  delete env.TMUX; delete env.TMUX_PANE // inside tmux these would point every tmux call at the live server
  let proc: ChildProcess | null = null; let log = ''
  const uiToken = () => { try { return fs.readFileSync(path.join(hqHome, 'ui-token'), 'utf8').trim() } catch { return '' } }
  const agentToken = (agentId: string) => fs.readFileSync(path.join(hqHome, 'agents', agentId, 'token'), 'utf8').trim()

  async function api(p: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(`http://127.0.0.1:${ports.ui}/api/${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${uiToken()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text(); let json: any = text; try { json = JSON.parse(text) } catch { /* plain text */ }
    return { status: r.status, json }
  }
  const state = async (): Promise<any> => (await api('state')).json
  async function startBackend(): Promise<void> {
    const p = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] }); proc = p
    p.stdout!.on('data', (d) => { log += d }); p.stderr!.on('data', (d) => { log += d })
    await waitFor('the backend to answer', async () => (await fetch(`http://127.0.0.1:${ports.ui}/api/state`, { headers: { authorization: `Bearer ${uiToken()}` } }).catch(() => null))?.ok, 20_000)
  }
  async function stopBackend(): Promise<void> {
    const p = proc; proc = null; if (!p || p.exitCode !== null) return
    const gone = new Promise((r) => p.once('exit', r)); p.kill('SIGTERM'); await gone
  }
  await startBackend()

  return {
    root, home, hqHome, ports, env, api, state, agentToken,
    log: () => log,
    restart: async () => { await stopBackend(); await startBackend() },
    /** Stops everything and deletes the temp dirs; the backend's output stays in <tmpdir>/hq-e2e-last.log. */
    async stop(): Promise<void> {
      await stopBackend(); fs.writeFileSync(path.join(os.tmpdir(), 'hq-e2e-last.log'), log)
      try { execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore' }) } catch { /* no server left */ }
      fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tmuxDir, { recursive: true, force: true })
    },
    /** tmux as the backend sees it (its own socket). */
    tmux: (...args: string[]): string => { try { return execFileSync('tmux', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return '' } },
    /** A local-only repo: `npm start` runs server.js, which answers with version.txt; node_modules exists, so the preview never installs. */
    repo(name: string): string {
      const d = path.join(root, 'repos', name); fs.mkdirSync(d, { recursive: true }); sh(d, 'init', '-q', '-b', 'main')
      const files: Record<string, string> = { '.gitignore': 'node_modules/\ndata/\n', 'package.json': JSON.stringify({ name, private: true, scripts: { start: 'node server.js' } }),
        'server.js': "require('http').createServer((q, s) => s.end(require('fs').readFileSync(__dirname + '/version.txt', 'utf8'))).listen(process.env.PORT)\n", 'version.txt': 'v1\n' }
      for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t)
      fs.mkdirSync(path.join(d, 'node_modules')); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base'); return d
    },
    /** Posts one hook event as the agent (what Claude Code's http hooks send). `signal` lets a test drop a held call. */
    async hook(agentId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
      const r = await fetch(`http://127.0.0.1:${ports.hooks}/hooks/${agentToken(agentId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'fake', ...body }), signal })
      return r.json()
    },
    /** The mod's long-poll for the next message batch (what register.js asks every 1.5 s). `{}` means nothing to deliver. */
    async modNext(agentId: string, wait = 0, signal?: AbortSignal): Promise<any> {
      const r = await fetch(`http://127.0.0.1:${ports.hooks}/mod/${agentToken(agentId)}/next?wait=${wait}`, { signal }); return r.json()
    },
    /** One mod event as the agent (batch_received, batch_submitted, batch_submit_failed, …). */
    async modEvent(agentId: string, body: Record<string, unknown>): Promise<any> {
      const r = await fetch(`http://127.0.0.1:${ports.hooks}/mod/${agentToken(agentId)}/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json()
    },
    /** Calls one hq MCP tool as the agent. */
    async mcp(agentId: string, tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
      const client = new Client({ name: 'hq-e2e', version: '0.0.1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ports.mcp}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agentToken(agentId)}` } } }))
      try { const r = await client.callTool({ name: tool, arguments: args }) as { content: { text: string }[]; isError?: boolean }; return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError } }
      finally { await client.close() }
    },
  }
}

/** An ExitPlanMode permission request as Claude Code sends it in plan mode. */
export const exitPlanMode = (plan: string) => ({ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan, planFilePath: null }, permission_mode: 'plan' })
/** Whether a promise is still pending after `ms`. */
export const pendingAfter = (p: Promise<unknown>, ms: number): Promise<boolean> => Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))])
/** `git worktree list --porcelain` lock line for a worktree path, or null. */
export function lockOf(repo: string, wt: string): string | null {
  const block = sh(repo, 'worktree', 'list', '--porcelain').split('\n\n').find((b) => b.startsWith(`worktree ${wt}\n`))
  return block?.split('\n').find((l) => l.startsWith('locked'))?.replace(/^locked ?/, '') ?? null
}
