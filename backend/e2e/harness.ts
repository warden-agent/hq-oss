// HQ end-to-end harness: an isolated backend (temp HQ_HOME and HOME, free ports, its own tmux socket) whose Claude Code is
// fake-claude.mjs, so tests drive the real hooks, MCP tools and UI API with no model and no tokens. It never touches ~/.hq,
// ~/.claude.json, the live tmux server or HQ's ports.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, type TestContext } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { elapsedMs, pidsUnder } from '../src/procs.ts'
import { CHECKED_VERSION } from '../src/claudeversion.ts'
import { PORT_TAKEN_EXIT } from '../src/ports.ts'

const BACKEND = path.resolve(import.meta.dirname, '..')
const FAKE = path.join(import.meta.dirname, 'fake-claude.mjs')
const STOP_MS = 10_000, PIPE_MS = 3000 // a backend exits at once on SIGTERM (index.ts), and its pipes close with it
const START_MS = 20_000 // for the backend to listen, and again to answer

export const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** Polls `fn` every 100ms until it returns something truthy. */
export async function waitFor<T>(what: string, fn: () => T | Promise<T>, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)) }
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
/** Thirteen ports for one test HQ alone, in a block of fourteen: its own three (the page, hooks, agents' tools) and ten for its previews (Bug 44).
 *  Test HQs that run at the same time, of this run or another, never share a port. The blocks lie in 29400–32767: below the ports an OS hands
 *  out by itself (Linux from 32768, macOS from 49152) and above HQ's windows for engineers (slotports.ts, to 29399). The first of the fourteen
 *  is the claim: this process listens on it for as long as the test HQ lives, so the OS itself keeps two test HQs off one block, and a claim
 *  goes with its process. HQ gets the thirteen after it.
 *  Bug 321: the preview ports used to start at a port the OS had just handed out, so they lay among the ports every other socket on the
 *  machine gets. On Linux an outgoing connection takes one of those as its own end, and nothing can listen there while it is open or for a
 *  minute after it closes, though nothing answers there either: HQ took such a port as free and the app ended with EADDRINUSE (one or two
 *  preview tests in every whole-suite run in Docker, 2026-11-19; macOS lets the listen through).
 *  Bug 325: HQ's own three were still ports the OS handed out. A test that takes its backend down gives them up until it is back, and on
 *  Linux the OS hands a port just given up to one of the next programs that ask for any port (measured: 3 of 200 tries within 30 asks,
 *  bind0.mjs). The backend that came back found its port "in use by node" (3 of 13 whole-suite runs in Docker), held by a program that was
 *  gone a moment later: by all signs another test file's listener, though it was never caught at it. Nothing is handed a port in these blocks.
 *  `from`: the block to try first (a test's; a random one otherwise, so runs spread out). `avoid`: ports a test gave its test HQ itself. */
export const PORT_BLOCKS = { from: 29400, size: 14, count: Math.floor((32768 - 29400) / 14) }
export type PortBlock = { own: [number, number, number]; range: string; block: number; release: () => void }
export async function claimPorts(avoid: number[] = [], from = Math.floor(Math.random() * PORT_BLOCKS.count)): Promise<PortBlock> {
  for (let n = 0; n < PORT_BLOCKS.count; n++) {
    const block = (from + n) % PORT_BLOCKS.count, first = PORT_BLOCKS.from + block * PORT_BLOCKS.size
    const ports = Array.from({ length: PORT_BLOCKS.size - 1 }, (_, i) => first + 1 + i); if ([first, ...ports].some((p) => avoid.includes(p))) continue
    const claim = await new Promise<net.Server | null>((resolve) => { const s = net.createServer(); s.once('error', () => resolve(null)); s.listen(first, '127.0.0.1', () => resolve(s)) })
    if (!claim) continue // another test HQ's, or some other program's
    claim.unref() // it never keeps a test file alive
    if ((await Promise.all(ports.flatMap((p) => [answers(p, '127.0.0.1'), answers(p, '::1')]))).some(Boolean)) { claim.close(); continue } // something of the user's listens in it
    return { own: [ports[0]!, ports[1]!, ports[2]!], range: `${ports[3]}-${ports[12]}`, block, release: () => { claim.close() } }
  }
  throw new Error(`no block of ports is free: all ${PORT_BLOCKS.count} from ${PORT_BLOCKS.from} are claimed or have something listening in them`)
}
/** lsof's list of working folders. It exits 1 when it can't see every process, and what it saw is still on stdout. */
const workingFolders = (): string => { try { return execFileSync('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch (e) { return String((e as { stdout?: string }).stdout ?? '') } }
/** SIGKILLs every process group that has a process naming `root` on its command line (a preview's supervisor runs a spec under
 *  HQ_HOME) or working inside it (a test run: `npm test` has no path on its command line, Bug 69), except this test process's own
 *  group. Bug 47: nothing a run started outlives it, even when tmux's hang-up doesn't reach it. Synchronous, so it also works in an
 *  exit handler. Bug 199: never a group with a process that began before this test HQ (`born`): the test HQ didn't start that group,
 *  it's someone else's (a shell that looked into the folder, say), and a signal to it would stop processes the test never started. */
export function leftoverGroups(rows: { pid: number; pgid: number; cmd: string; start: number }[], root: string, inside: Set<number>, mine: number | undefined,
  born: number): number[] {
  const hit = new Set(rows.filter((r) => (r.cmd.includes(root) || inside.has(r.pid)) && r.pgid > 1 && r.pgid !== mine).map((r) => r.pgid))
  for (const r of rows) if (r.start < born) hit.delete(r.pgid) // ps counts whole seconds, so a start read from it is never early
  return [...hit]
}
function killLeftovers(root: string, born: number): void {
  const now = Date.now(), rows = execFileSync('ps', ['-axo', 'pid=,pgid=,etime=,command='], { encoding: 'utf8' }).split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s(.*)$/.exec(l)).filter((m) => !!m)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), start: now - elapsedMs(m[3]!), cmd: m[4]! }))
  const mine = rows.find((r) => r.pid === process.pid)?.pgid, inside = new Set(pidsUnder(workingFolders(), root))
  for (const g of leftoverGroups(rows, root, inside, mine, born)) { try { process.kill(-g, 'SIGKILL') } catch { /* gone */ } }
}
/** Test HQs still running: an interrupted run (Ctrl-C, a crash before `after`) stops them on its way out. */
const live = new Set<() => void>()
const abortAll = () => { for (const f of live) f() }
process.once('exit', abortAll)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => { abortAll(); process.exit(128 + os.constants.signals[sig]) }) // SIGHUP: own-tmp.mjs passes it on

/** What this file's test HQs have printed, for the test that fails. The log used to go to one file every test HQ of every test file wrote
 *  (hq-e2e-last.log), so after a failure it was nearly always some other test's. Now a failed test gets a file of its own, with what each
 *  test HQ alive during it printed since that test began: <tmpdir>/hq-e2e-failed/<checkout>/<test file>--<test>.log, named in the test's
 *  own output. A file's old ones go when the file runs again. `HQ_E2E_LOG_TAIL=<lines>` also prints the end of it (80 lines in CI, where
 *  the machine is gone after the run). Only under the test runner: one-off demo scripts import this file as a plain script.
 *  A test that ends with its test HQ's backend down (it failed between `down()` and `up()`) used to leave it down for every test after it in
 *  the file, which then failed at once with ECONNREFUSED: one real failure and a row of false ones. The backend is started again here. */
const said = new Set<{ log: () => string; from: number; gone: boolean; down: () => boolean; up: () => Promise<void> }>()
const FAILED = path.join(process.env.HQ_OUTER_TMPDIR ?? os.tmpdir(), 'hq-e2e-failed', path.basename(path.dirname(BACKEND)))
if (process.env.NODE_TEST_CONTEXT) {
  const mine = `${path.basename(process.argv[1] ?? 'test').replace(/\.test\.[cm]?[jt]s$/, '')}--`
  try { for (const f of fs.readdirSync(FAILED)) if (f.startsWith(mine)) fs.rmSync(path.join(FAILED, f), { force: true }) } catch { /* none yet */ }
  beforeEach(() => { for (const s of said) { if (s.gone) said.delete(s); else s.from = s.log().length } })
  afterEach(async (t) => {
    const test = t as TestContext & { passed?: boolean; error?: unknown }
    for (const s of said) if (!s.gone && s.down()) { await s.up(); test.diagnostic('this test ended with its test HQ down: the backend was started again for the tests after it') }
    if (test.passed !== false || !said.size) return
    const text = [...said].map((s, i) => `--- test HQ ${i + 1}${s.gone ? ' (stopped during the test)' : ''}\n${s.log().slice(s.from)}`).join('\n')
    const file = path.join(FAILED, `${mine}${test.name.replace(/[^\w]+/g, '-').slice(0, 80)}.log`)
    try { fs.mkdirSync(FAILED, { recursive: true }); fs.writeFileSync(file, `${test.name}\n${String((test.error as Error | undefined)?.message ?? '')}\n\n${text}\n`) } catch { return }
    test.diagnostic(`what the test HQ printed during this test: ${file}`)
    const tail = Number(process.env.HQ_E2E_LOG_TAIL ?? (process.env.CI ? 80 : 0))
    if (tail > 0) console.error(`[the test HQ's output, "${test.name}"]\n${text.split('\n').slice(-tail).join('\n')}`)
  })
}

export type Hq = Awaited<ReturnType<typeof startHq>>
type BeatName = import('../src/beats.ts').Beat
/** `env`: extra environment for the backend (a fake `gh` on PATH, say). `ports`: the first try's ports, for a test of a taken one. `startMs`: how long a start
 *  may take to listen, and then to answer (a test of one that doesn't). */
export async function startHq(o: { env?: NodeJS.ProcessEnv; ports?: Partial<Record<'ui' | 'hooks' | 'mcp', number>>; startMs?: number } = {}) {
  const born = Date.now() // Bug 199: nothing older than this test HQ is its leftover
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-')))
  const tmuxDir = fs.mkdtempSync(path.join(process.env.HQ_SHORT_TMPDIR ?? '/tmp', 'hq-e2e-')) // unix socket paths must stay short
  const home = path.join(root, 'home'), hqHome = path.join(root, 'hq'); fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, '.claude.json'), '{ "projects": {} }') // HQ marks workspaces trusted in it
  // Its ports: a block of its own (claimPorts). `o.ports` puts one of its three elsewhere for the first try (a test of a taken port)
  let block = await claimPorts(Object.values(o.ports ?? {}))
  const own = () => ({ ui: block.own[0], hooks: block.own[1], mcp: block.own[2] })
  const ports = { ...own(), ...o.ports }
  const screens = path.join(root, 'screens'); fs.mkdirSync(screens)
  const env: NodeJS.ProcessEnv = { ...process.env, HQ_FAKE_SCREEN_DIR: screens, HOME: home, HQ_HOME: hqHome, HQ_CLAUDE_BIN: FAKE, TMUX_TMPDIR: tmuxDir,
    HQ_AGENT_TMP: path.join(tmuxDir, 'a-'), // agents' own temp folders go with the run (Bug 81)
    HQ_FAKE_VERSION: CHECKED_VERSION, HQ_INSTALLED_CLAUDE: '', // the fake is the version HQ was checked on, and this machine's own Claude Code isn't looked at (Bug 97)
    GIT_AUTHOR_NAME: 'HQ e2e', GIT_AUTHOR_EMAIL: 'e2e@hq.test', GIT_COMMITTER_NAME: 'HQ e2e', GIT_COMMITTER_EMAIL: 'e2e@hq.test', GIT_CONFIG_NOSYSTEM: '1', ...o.env }
  const usePorts = () => { Object.assign(env, { HQ_UI_PORT: String(ports.ui), HQ_HOOKS_PORT: String(ports.hooks), HQ_MCP_PORT: String(ports.mcp), HQ_PREVIEW_PORTS: block.range }) }
  usePorts()
  delete env.TMUX; delete env.TMUX_PANE // inside tmux these would point every tmux call at the live server
  // This run's own tmux server, named in every call the harness makes. With its folder gone, a bare `tmux` falls back to the default server, which is
  // the user's own: live HQ, its agents and their sessions. On 2026-11-07 a second stop() killed it that way. A server that isn't running has no socket.
  const sock = path.join(tmuxDir, `tmux-${process.getuid?.() ?? 0}`, 'default')
  fs.mkdirSync(path.dirname(sock), { mode: 0o700 }) // tmux makes this folder only when it goes through TMUX_TMPDIR
  const killTmux = () => { try { if (fs.existsSync(sock)) execFileSync('tmux', ['-S', sock, 'kill-server'], { env, stdio: 'ignore' }) } catch { /* gone meanwhile */ } }
  let proc: ChildProcess | null = null; let log = ''; let stopped = false
  const mark = { log: () => log, from: 0, gone: false, down: () => !stopped && proc === null, up: () => startBackend() }; said.add(mark)
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
  const beatCount = async (name: BeatName): Promise<number> => { const r = await api('beats'); if (r.status !== 200) throw new Error(`GET /api/beats answered ${r.status}`); return r.json[name] }
  /** Starts the backend and waits until it listens on all three of its ports. Bug 92: a port can be taken between the pick and the backend's
   *  listen (by a test HQ in another file, say). HQ then ran on without that server, and a test's MCP calls reached a hooks server (404).
   *  Since Bug 118 the backend stops by itself then, with its own exit code. False when a port was taken. Bug 166: a start that fails or runs out of time
   *  stops the backend it spawned before it throws; a live one kept the test file running for good. */
  async function tryStart(): Promise<boolean> {
    const p = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] })
    proc = p; started.push(p); const from = log.length, ms = o.startMs ?? START_MS // this start's output
    p.stdout!.on('data', (d) => { log += d }); p.stderr!.on('data', (d) => { log += d })
    try {
      const got = await waitFor('the backend to listen on its ports', () => {
        if (p.exitCode === PORT_TAKEN_EXIT) return 'taken'
        if (p.exitCode !== null || p.signalCode !== null) throw new Error(`the test HQ exited at startup:\n${log.slice(from)}`)
        const mine = listeningPorts(p.pid!); return Object.values(ports).every((x) => mine.includes(x)) ? 'all' : null
      }, ms)
      if (got === 'taken') { await stopBackend(); return false }
      await waitFor('the backend to answer', async () => (await fetch(`http://127.0.0.1:${ports.ui}/api/state`, { headers: { authorization: `Bearer ${uiToken()}` } }).catch(() => null))?.ok, ms)
      return true
    } catch (e) {
      const problems = [(e as Error).message]; await stopBackend().catch((x) => { problems.push((x as Error).message) })
      if (!(e as Error).message.includes('exited at startup')) problems.push(`its output:\n${log.slice(from)}`)
      throw new Error(problems.join('\n'))
    }
  }
  /** A restart keeps its ports: running agents were given them. When one was taken meanwhile, the error also says what the program HQ named is
   *  and what started it: on Linux this failed preview-stop-restart.test.ts in 2 of 12 whole-suite runs with only "node (pid …)" to go on. */
  async function startBackend(): Promise<void> {
    const from = log.length; if (await tryStart()) return
    const ps = (pids: string[]): string => { try { return pids.length ? execFileSync('ps', ['-o', 'pid=,ppid=,etime=,args=', '-p', pids.join(',')], { encoding: 'utf8' }) : '' } catch { return '' } }
    const holders = ps([...new Set([...log.slice(from).matchAll(/\(pid (\d+)\)/g)].map((m) => m[1]!))])
    const parents = ps([...new Set(holders.split('\n').map((l) => l.trim().split(/\s+/)[1] ?? '').filter((x) => Number(x) > 1))])
    const who = holders ? `\nits holder now (pid, parent, running for, command):\n${holders}started by:\n${parents || '(gone)\n'}this test process is pid ${process.pid}` : ''
    throw new Error(`a port of this test HQ (${JSON.stringify(ports)}) was taken while it was down:\n${log}${who}`)
  }
  /** Bug 113: every wait has a time limit, teardown too. A backend still there STOP_MS after SIGTERM is killed, and the test is told. */
  async function stopBackend(): Promise<void> {
    const p = proc; proc = null; if (!p || p.exitCode !== null || p.signalCode !== null) return // killed from outside: its exit event has already gone
    const gone = new Promise((r) => p.once('exit', r)); p.kill('SIGTERM')
    if (!await pendingAfter(gone, STOP_MS)) return // limit: a teardown's own time limit (Bug 113), not a pause: it ends as soon as the backend has
    p.kill('SIGKILL'); await gone; throw new Error(`the test HQ's backend didn't stop within ${STOP_MS / 1000} s of SIGTERM, so it was killed`)
  }
  /** Bug 113: something HQ started that still holds the backend's output keeps the test file from ever exiting (CI waited 16 minutes). Its pipes close
   *  here, and the test is told. False when they were already closed. */
  const outputHeld = async (p: ChildProcess): Promise<boolean> => {
    const closed = (s: NodeJS.ReadableStream & { closed?: boolean } | null) => !s || s.closed ? Promise.resolve() : new Promise((r) => s.once('close', r))
    if (!await pendingAfter(Promise.all([closed(p.stdout), closed(p.stderr)]), PIPE_MS)) return false // limit: as above, for its pipes
    p.stdout?.destroy(); p.stderr?.destroy(); return true
  }
  const started: ChildProcess[] = [] // every backend process this test HQ ran (restarts too), kept past stopBackend for their pipes
  const abort = () => { // the test process is going: its folders go too, last, since no tmux call may come after (Bug 81)
    mark.gone = true; block.release()
    try { proc?.kill('SIGKILL') } catch { /* gone */ }
    killTmux(); killLeftovers(root, born)
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tmuxDir, { recursive: true, force: true })
  }
  live.add(abort)
  try {
    for (let tries = 1; !await tryStart(); tries++) { // nothing has its ports yet: another block, whole
      if (tries === 3) throw new Error(`the test HQ's ports were taken ${tries} times:\n${log}`)
      const next = await claimPorts(); block.release(); block = next; Object.assign(ports, own()); usePorts()
    }
  } catch (e) { // Bug 166: no test HQ to stop for the file's after(), so all of it goes here: its tmux server, what it started, its folders, its pipes
    live.delete(abort); abort(); await Promise.all(started.map(outputHeld)); throw e
  }

  return {
    root, home, hqHome, ports, env, api, state, agentToken,
    log: () => log,
    /** HQ's database, opened the way HQ's own connection is: it waits out a write lock where a plain open fails at once with "database is
     *  locked" (Bug 158; tests that opened it themselves failed now and then on a busy machine). The caller closes it. */
    db: (o: { readOnly?: boolean } = {}): DatabaseSync =>
      new (process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(path.join(hqHome, 'hq.sqlite'), { timeout: 5000, ...o }),
    /** Waits until HQ's look `name` has ended `n` more times (src/beats.ts), in place of a sleep before checking that something did NOT
     *  happen. One beat proves nothing: a look that began before the test's last action may end just after it. Two mean a whole look ran after
     *  it; the default of three leaves one to spare. The test HQ must run that loop fast (HQ_AUTO_TICK_MS, HQ_STUCK_TICK_S, HQ_FINISHED_TICK_S,
     *  HQ_LEFTOVER_TICK_S), or `ms` runs out. A look that runs on events and not on a clock a test can speed up (`merges`) is counted from
     *  before the action, `from: await hq.beat(name)`, and set off twice (two syncs): its second end is a look that began after the first.
     *  For `auto` a pass only starts HQ's test runs and merges, so by default this also waits until the page shows none under way;
     *  `runs: 'leave'` for a test that holds one back on purpose. */
    async beats(name: BeatName, n = 3, o: { ms?: number; runs?: 'leave'; from?: number } = {}): Promise<void> {
      const from = o.from ?? await beatCount(name), ms = o.ms ?? 15_000
      await waitFor(`HQ's ${name} look to end ${n} more time${n === 1 ? '' : 's'} (it had ended ${from} times)`, async () => (await beatCount(name)) >= from + n, ms)
      if (name === 'auto' && o.runs !== 'leave') await waitFor("HQ's own test runs to end", async () => (await state()).testRuns.length === 0, ms)
    },
    /** How often HQ's look `name` has ended so far. */
    beat: (name: BeatName): Promise<number> => beatCount(name),
    restart: async () => { await stopBackend(); await startBackend() },
    /** The backend alone goes away and comes back (agents, like their tmux server, stay): a restart with time in between. */
    down: stopBackend, up: startBackend,
    /** Stops everything and deletes the temp dirs. What the backend printed is kept for a test that fails (see `said`). */
    async stop(): Promise<void> { // twice is fine: a test may stop it and its afterEach again
      if (stopped) return; stopped = true
      const problems: string[] = []; await stopBackend().catch((e) => { problems.push((e as Error).message) }); mark.gone = true
      live.delete(abort); killLeftovers(root, born) // previews first: HQ leaves them running on purpose (a restart picks them up)
      killTmux(); block.release() // once nothing of this test HQ can still listen in the block
      fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tmuxDir, { recursive: true, force: true })
      if ((await Promise.all(started.map(outputHeld))).some(Boolean)) problems.push(`a process the test HQ started still held its output ${PIPE_MS / 1000} s after it stopped`)
      if (problems.length) throw new Error(problems.join('; '))
    },
    /** What Claude Code's status file says for this agent (Bug 62, presence.ts): `status` busy, idle or waiting, changed now unless `at` says when.
     *  Given the agent as read before, it needs no backend (Bug 217: a dialog answered while HQ is down). */
    async session(agent: string | { id: string; claude_session_id: string }, status: string, at = Date.now()): Promise<void> {
      const agentId = typeof agent === 'string' ? agent : agent.id, dir = path.join(home, '.claude', 'sessions')
      const sid = typeof agent === 'string' ? (await state()).agents.find((a: any) => a.id === agentId)?.claude_session_id : agent.claude_session_id
      const own = (): { p: string; j: any } | null => { // Bug 159: another agent's file can be one being written; it isn't this one
        let files: string[] = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return null }
        for (const f of files) { try { const p = path.join(dir, f), j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j.sessionId === sid) return { p, j } } catch { /* not whole */ } }
        return null
      }
      const { p, j } = await waitFor(`${agentId}'s status file (session ${sid})`, own, 5000) // a test never changes nothing without being told
      fs.writeFileSync(`${p}.tmp`, JSON.stringify({ ...j, status, statusUpdatedAt: at })); fs.renameSync(`${p}.tmp`, p) // whole, like the fake's (HQ reads only .json)
    },
    /** Draws `text` as the agent's screen (fake-claude.mjs shows it), e.g. a dialog's menu. Given the agent as read before, it needs no backend. */
    async screen(agent: string | { id: string; claude_session_id: string }, text: string): Promise<void> {
      const sid = typeof agent === 'string' ? (await state()).agents.find((a: any) => a.id === agent)?.claude_session_id : agent.claude_session_id
      fs.writeFileSync(path.join(screens, `${sid}.txt`), text)
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
    /** The mod's long-poll for the next message batch (what register.js asks; modhost.ts runs the real one). `{}` means nothing to deliver. */
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
/** Whether a promise is still pending after `ms`. Its timer goes when the promise settles: a stopped backend's 10 s one kept a failed file running (Bug 166). */
export const pendingAfter = (p: Promise<unknown>, ms: number): Promise<boolean> => new Promise((resolve) => {
  const t = setTimeout(() => resolve(true), ms), done = () => { clearTimeout(t); resolve(false) }; p.then(done, done)
})
/** Whether a promise is still pending once everything that has already arrived has had its turn: ten turns of the event loop, and no time. An
 *  answer HQ sent before the caller's last request came back is seen (its bytes are read on one turn, its body on a later one); an answer HQ
 *  sends after that is not. So for "HQ is holding this": wait for what shows the hold (an event, the line on its box), then ask this.
 *  `pendingAfter` is for a hold nothing shows, and counts as a fixed wait. */
export const pending = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false; const set = () => { done = true }; p.then(set, set)
  for (let i = 0; i < 10 && !done; i++) await new Promise((r) => setImmediate(r))
  return !done
}
/** `git worktree list --porcelain` lock line for a worktree path, or null. git finds a lock's file and then reads it, and dies when the lock
 *  goes in between ("failed to read '…/locked'": HQ unlocked it at that moment; bugs.test.ts, 1 of 12 whole-suite runs on Linux, 2026-11-19).
 *  That answer says nothing about the lock, so git is asked again. */
export function lockOf(repo: string, wt: string): string | null {
  let list = ''
  for (let tries = 1; ; tries++) {
    try { list = sh(repo, 'worktree', 'list', '--porcelain'); break }
    catch (e) { if (tries === 5 || !/failed to read '[^']*\/locked'/.test(String((e as { stderr?: unknown }).stderr))) throw e }
  }
  const block = list.split('\n\n').find((b) => b.startsWith(`worktree ${wt}\n`))
  return block?.split('\n').find((l) => l.startsWith('locked'))?.replace(/^locked ?/, '') ?? null
}
