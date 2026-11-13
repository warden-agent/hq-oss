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
import { pidsUnder } from '../src/procs.ts'
import { CHECKED_VERSION } from '../src/claudeversion.ts'

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
/** `n` different free ports. Bug 92: picked one after another, each closed before the next pick, two can be the same port. */
async function freePorts(n: number): Promise<number[]> {
  const held = await Promise.all(Array.from({ length: n }, () => new Promise<net.Server>((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => resolve(s))
  })))
  const ports = held.map((s) => (s.address() as net.AddressInfo).port)
  await Promise.all(held.map((s) => new Promise((r) => s.close(r)))); return ports
}
/** The TCP ports `pid` listens on (lsof exits 1 when it finds none). */
export function listeningPorts(pid: number): number[] {
  let out = ''; try { out = execFileSync('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch (e) { out = String((e as { stdout?: string }).stdout ?? '') }
  return out.split('\n').filter((l) => l.startsWith('n')).map((l) => Number(/:(\d+)$/.exec(l)?.[1])).filter(Boolean)
}

const answers = (port: number, host: string): Promise<boolean> => new Promise((resolve) => {
  const c = net.connect({ host, port }); c.once('connect', () => { c.destroy(); resolve(true) }); c.once('error', () => resolve(false))
})
/** Ten ports nothing listens on (IPv4 or IPv6), for this test HQ's previews alone (Bug 44): test HQs that run at the same time,
 *  and the live HQ, never hand out the same port. */
async function previewRange(avoid: number[]): Promise<string> {
  for (;;) {
    const base = await freePort(); if (base + 9 > 65535) continue
    const ports = Array.from({ length: 10 }, (_, i) => base + i); if (ports.some((p) => avoid.includes(p))) continue // not HQ's own ports

    if ((await Promise.all(ports.flatMap((p) => [answers(p, '127.0.0.1'), answers(p, '::1')]))).some(Boolean)) continue
    return `${base}-${base + 9}`
  }
}
/** lsof's list of working folders. It exits 1 when it can't see every process, and what it saw is still on stdout. */
const workingFolders = (): string => { try { return execFileSync('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch (e) { return String((e as { stdout?: string }).stdout ?? '') } }
/** SIGKILLs every process group that has a process naming `root` on its command line (a preview's supervisor runs a spec under
 *  HQ_HOME) or working inside it (a test run: `npm test` has no path on its command line, Bug 69), except this test process's own
 *  group. Bug 47: nothing a run started outlives it, even when tmux's hang-up doesn't reach it. Synchronous, so it also works in an
 *  exit handler. */
function killLeftovers(root: string): void {
  const rows = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' }).split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => !!m).map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), cmd: m[3]! }))
  const mine = rows.find((r) => r.pid === process.pid)?.pgid, inside = new Set(pidsUnder(workingFolders(), root))
  for (const g of new Set(rows.filter((r) => (r.cmd.includes(root) || inside.has(r.pid)) && r.pgid > 1 && r.pgid !== mine).map((r) => r.pgid))) {
    try { process.kill(-g, 'SIGKILL') } catch { /* gone */ }
  }
}
/** Test HQs still running: an interrupted run (Ctrl-C, a crash before `after`) stops them on its way out. */
const live = new Set<() => void>()
const abortAll = () => { for (const f of live) f() }
process.once('exit', abortAll)
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { abortAll(); process.exit(130) })

export type Hq = Awaited<ReturnType<typeof startHq>>
/** `env`: extra environment for the backend (a fake `gh` on PATH, say). `ports`: the first try's ports, for a test of a taken one. */
export async function startHq(o: { env?: NodeJS.ProcessEnv; ports?: Partial<Record<'ui' | 'hooks' | 'mcp', number>> } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-')))
  const tmuxDir = fs.mkdtempSync(path.join(process.env.HQ_SHORT_TMPDIR ?? '/tmp', 'hq-e2e-')) // unix socket paths must stay short
  const home = path.join(root, 'home'), hqHome = path.join(root, 'hq'); fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, '.claude.json'), '{ "projects": {} }') // HQ marks workspaces trusted in it
  const pick = async () => { const [ui, hooks, mcp] = await freePorts(3); return { ui: ui!, hooks: hooks!, mcp: mcp! } }
  const ports = { ...await pick(), ...o.ports }
  const screens = path.join(root, 'screens'); fs.mkdirSync(screens)
  const env: NodeJS.ProcessEnv = { ...process.env, HQ_FAKE_SCREEN_DIR: screens, HOME: home, HQ_HOME: hqHome, HQ_CLAUDE_BIN: FAKE, TMUX_TMPDIR: tmuxDir,
    HQ_AGENT_TMP: path.join(tmuxDir, 'a-'), // agents' own temp folders go with the run (Bug 81)
    HQ_FAKE_VERSION: CHECKED_VERSION, HQ_INSTALLED_CLAUDE: '', // the fake is the version HQ was checked on, and this machine's own Claude Code isn't looked at (Bug 97)
    GIT_AUTHOR_NAME: 'HQ e2e', GIT_AUTHOR_EMAIL: 'e2e@hq.test', GIT_COMMITTER_NAME: 'HQ e2e', GIT_COMMITTER_EMAIL: 'e2e@hq.test', GIT_CONFIG_NOSYSTEM: '1', ...o.env }
  const usePorts = async () => {
    Object.assign(env, { HQ_UI_PORT: String(ports.ui), HQ_HOOKS_PORT: String(ports.hooks), HQ_MCP_PORT: String(ports.mcp), HQ_PREVIEW_PORTS: await previewRange(Object.values(ports)) })
  }
  await usePorts()
  delete env.TMUX; delete env.TMUX_PANE // inside tmux these would point every tmux call at the live server
  // This run's own tmux server, named in every call the harness makes. With its folder gone, a bare `tmux` falls back to the default server, which is
  // the user's own: live HQ, its agents and their sessions. On 2026-11-07 a second stop() killed it that way. A server that isn't running has no socket.
  const sock = path.join(tmuxDir, `tmux-${process.getuid?.() ?? 0}`, 'default')
  fs.mkdirSync(path.dirname(sock), { mode: 0o700 }) // tmux makes this folder only when it goes through TMUX_TMPDIR
  const killTmux = () => { try { if (fs.existsSync(sock)) execFileSync('tmux', ['-S', sock, 'kill-server'], { env, stdio: 'ignore' }) } catch { /* gone meanwhile */ } }
  let proc: ChildProcess | null = null; let log = ''
  const uiToken = () => { try { return fs.readFileSync(path.join(hqHome, 'ui-token'), 'utf8').trim() } catch { return '' } }
  const agentToken = (agentId: string) => fs.readFileSync(path.join(hqHome, 'agents', agentId, 'token'), 'utf8').trim()
  /** One hook event as the agent, nothing more (see `hook`). */
  const hookOnce = async (agentId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> => {
    const headers = { 'content-type': 'application/json', 'x-hq-token': agentToken(agentId) } // where Claude Code's http hooks send it (Bug 87)
    const r = await fetch(`http://127.0.0.1:${ports.hooks}/hooks`, { method: 'POST', headers, body: JSON.stringify({ session_id: 'fake', ...body }), signal })
    return r.json()
  }

  async function api(p: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(`http://127.0.0.1:${ports.ui}/api/${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${uiToken()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text(); let json: any = text; try { json = JSON.parse(text) } catch { /* plain text */ }
    return { status: r.status, json }
  }
  const state = async (): Promise<any> => (await api('state')).json
  /** Starts the backend and waits until it listens on all three of its ports. Bug 92: a port can be taken between the pick and the backend's
   *  listen (by a test HQ in another file, say). HQ then runs on without that server, and a test's MCP calls reached a hooks server (404).
   *  False when a port was taken: the backend is stopped again. */
  async function tryStart(): Promise<boolean> {
    const p = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] })
    proc = p; const from = log.length // this start's output
    p.stdout!.on('data', (d) => { log += d }); p.stderr!.on('data', (d) => { log += d })
    const got = await waitFor('the backend to listen on its ports', () => {
      if (p.exitCode !== null || p.signalCode !== null) throw new Error(`the test HQ exited at startup:\n${log}`)
      const mine = listeningPorts(p.pid!); return Object.values(ports).every((x) => mine.includes(x)) ? 'all' : /EADDRINUSE/.test(log.slice(from)) ? 'taken' : null
    }, 20_000)
    if (got === 'taken') { await stopBackend(); return false }
    await waitFor('the backend to answer', async () => (await fetch(`http://127.0.0.1:${ports.ui}/api/state`, { headers: { authorization: `Bearer ${uiToken()}` } }).catch(() => null))?.ok, 20_000)
    return true
  }
  /** A restart keeps its ports: running agents were given them. */
  async function startBackend(): Promise<void> {
    if (!await tryStart()) throw new Error(`a port of this test HQ (${JSON.stringify(ports)}) was taken while it was down:\n${log}`)
  }
  async function stopBackend(): Promise<void> {
    const p = proc; proc = null; if (!p || p.exitCode !== null || p.signalCode !== null) return // killed from outside: its exit event has already gone
    const gone = new Promise((r) => p.once('exit', r)); p.kill('SIGTERM'); await gone
  }
  const abort = () => { // the test process is going: its folders go too, last, since no tmux call may come after (Bug 81)
    try { proc?.kill('SIGKILL') } catch { /* gone */ }
    killTmux(); killLeftovers(root)
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tmuxDir, { recursive: true, force: true })
  }
  live.add(abort)
  for (let tries = 1; !await tryStart(); tries++) { // nothing has its ports yet: new ones
    if (tries === 3) { abort(); live.delete(abort); throw new Error(`the test HQ's ports were taken ${tries} times:\n${log}`) }
    Object.assign(ports, await pick()); await usePorts()
  }
  let stopped = false

  return {
    root, home, hqHome, ports, env, api, state, agentToken,
    log: () => log,
    restart: async () => { await stopBackend(); await startBackend() },
    /** The backend alone goes away and comes back (agents, like their tmux server, stay): a restart with time in between. */
    down: stopBackend, up: startBackend,
    /** Stops everything and deletes the temp dirs; the backend's output stays in <tmpdir>/hq-e2e-last.log (the shared one, past own-tmp.mjs's). */
    async stop(): Promise<void> { // twice is fine: a test may stop it and its afterEach again
      if (stopped) return; stopped = true
      await stopBackend(); fs.writeFileSync(path.join(process.env.HQ_OUTER_TMPDIR ?? os.tmpdir(), 'hq-e2e-last.log'), log)
      live.delete(abort); killLeftovers(root) // previews first: HQ leaves them running on purpose (a restart picks them up)
      killTmux()
      fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tmuxDir, { recursive: true, force: true })
    },
    /** What Claude Code's status file says for this agent (Bug 62, presence.ts): `status` busy, idle or waiting, changed now unless `at` says when. */
    async session(agentId: string, status: string, at = Date.now()): Promise<void> {
      const sid = (await state()).agents.find((a: any) => a.id === agentId)?.claude_session_id, dir = path.join(home, '.claude', 'sessions')
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f), j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j.sessionId === sid) fs.writeFileSync(p, JSON.stringify({ ...j, status, statusUpdatedAt: at }))
      }
    },
    /** Draws `text` as the agent's screen (fake-claude.mjs shows it), e.g. a dialog's menu. */
    async screen(agentId: string, text: string): Promise<void> {
      const sid = (await state()).agents.find((a: any) => a.id === agentId)?.claude_session_id; fs.writeFileSync(path.join(screens, `${sid}.txt`), text)
    },
    /** Starts `cmd` as the agent's Bash command would run: a child of its (fake) Claude Code in a process group of its own. Its pid. */
    async spawn(agentId: string, cmd: string): Promise<number> {
      const sid = (await state()).agents.find((a: any) => a.id === agentId)?.claude_session_id, done = path.join(screens, `${sid}.spawned`)
      fs.rmSync(done, { force: true }); fs.writeFileSync(path.join(screens, `${sid}.spawn`), cmd)
      return waitFor('the fake Claude Code to start it', () => { try { return Number(fs.readFileSync(done, 'utf8')) || null } catch { return null } }, 5000) as Promise<number>
    },
    /** tmux as the backend sees it (its own socket). */
    tmux: (...args: string[]): string => { try { return execFileSync('tmux', ['-S', sock, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return '' } },
    /** A local-only repo: `npm start` runs server.js, which answers with version.txt; node_modules exists, so the preview never installs. */
    repo(name: string): string {
      const d = path.join(root, 'repos', name); fs.mkdirSync(d, { recursive: true }); sh(d, 'init', '-q', '-b', 'main')
      const files: Record<string, string> = { '.gitignore': 'node_modules/\ndata/\n', 'package.json': JSON.stringify({ name, private: true, scripts: { start: 'node server.js' } }),
        'server.js': "require('http').createServer((q, s) => s.end(require('fs').readFileSync(__dirname + '/version.txt', 'utf8'))).listen(process.env.PORT)\n", 'version.txt': 'v1\n' }
      for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t)
      fs.mkdirSync(path.join(d, 'node_modules')); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base'); return d
    },
    /** Posts one hook event as the agent (what Claude Code's http hooks send) and returns HQ's answer. `signal` lets a test drop a held
     *  call. A Stop that HQ answers with a block (a message batch handed over in the answer, Bug 103) goes on as in Claude Code: the
     *  agent works on the message and its turn ends again, with another Stop. `hookOnce` sends only the one event. */
    async hook(agentId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
      const first = await hookOnce(agentId, body, signal)
      for (let r = first, n = 0; body.hook_event_name === 'Stop' && r?.decision === 'block'; n++) {
        if (n === 5) throw new Error(`${agentId}: HQ blocked its Stop ${n + 1} times in a row`)
        r = await hookOnce(agentId, { hook_event_name: 'Stop', last_assistant_message: "Read HQ's message." }, signal)
      }
      return first
    },
    hookOnce,
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
