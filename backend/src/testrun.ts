// Auto mode's check before a merge (Bug 54): the tests run on what main would become with this ticket, in a throwaway worktree, so a
// mismatch between two tickets that each pass alone is caught. Nobody looks at this code before it runs, so it runs sandboxed, with the
// engineers' rules and none of the user's credentials: sandbox-exec on macOS, bubblewrap on Linux (spikes 2026-11-03: `npm test` passes;
// ~/.ssh, ~/.hq, writes outside the worktree and github.com are refused). Neither can filter by host, so installing packages is its own
// step with the network on and the test step has it off. Sockets are shut too: a test that reaches Docker's or tmux's is out of the box.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { DEFAULTS, ENGINEER_CACHE, GH_CONFIG_DIR, PATHS } from './config.ts'
import { getSetting, now } from './db.ts'
import { emit, patch } from './events.ts'
import { withTurn } from './heavy.ts'
import { combinedCommit } from './localmerge.ts'
import { killUnder } from './procs.ts'
import { runPorts } from './runports.ts'
import { cacheEnv, HOME_SECRETS } from './roles.ts'
import { git } from './reposync.ts'
import { id, real } from './util.ts'
import { seedPackages } from './worktrees.ts'
import { installsPackages, npmLock, onPath, ownInstall, packageManager } from './apprun.ts'
import { countWords, shownLine, summaryLines, testCounts, type Counts } from './testcounts.ts'
import { mergeWatched, nameWatch, type Watch, type Watched } from './criteria.ts'
import { lookIn, type LookPlan } from './smoke.ts'
import { notRun, ruleParts, type NotRun } from './testcensus.ts'
import { chain, partCmd, partsHere, type SavedPart } from './teststepsstore.ts'
import type { Seen } from './smokerules.ts'
import { releaseCopy } from './copyports.ts'

/** `stop`: HQ can't install the packages the project's own way (its package manager isn't installed, say), in words for the user: nothing runs (Bug 392).
 *  `noTool` (Bug 403): the tool `test` names isn't on HQ's PATH, so HQ can't run that command itself; a command of the user's own doesn't need it. */
export type TestPlan = { install: string | null; test: string; stop?: string; noTool?: string }
const has = (root: string, ...p: string[]) => fs.existsSync(path.join(root, ...p))
const npmTest = (root: string): boolean => {
  try {
    const t = String((JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts?.test ?? '')
    return !!t.trim() && !/no test specified/i.test(t) // npm init's placeholder always fails
  } catch { return false }
}
/** npm's install for the folder `rel` of the checkout, as the preview's installStep reads it. Bug 430: an npm workspace root that lists no packages itself
 *  still installs (its members list theirs), and a member with no lockfile of its own follows its workspace root's: `npm ci` there, where npm puts the
 *  packages (and seedPackages copies the main checkout's). */
const nodeInstall = (root: string, rel: string): string | null => {
  const dir = path.join(root, rel); if (!installsPackages(dir, root)) return null // Bug 446: a member that lists none still gets its root's
  const lock = npmLock(dir, root), at = lock ? path.relative(root, path.dirname(lock)) || '.' : rel
  if (has(root, at, 'node_modules')) return null // seedPackages copied the main checkout's
  const install = lock ? 'npm ci' : 'npm install'
  return at === '.' ? install : `(cd ${JSON.stringify(at)} && ${install})`
}
/** How each package manager runs a package.json's test script (`bun test` is Bun's own test runner, not the script). */
const TEST_SCRIPT = { npm: 'npm test', yarn: 'yarn test', pnpm: 'pnpm test', bun: 'bun run test' } as const
/** Bug 392: how a Node folder of the checkout installs its packages and runs its test script: with its own package manager, by the preview's rule
 *  (apprun.ts packageManager, ownInstall: the lockfile followed, never written). npm's as before. Its tool missing: `stop`, never npm instead, which ignores
 *  the others' lockfiles; packages already there (seedPackages copied the main checkout's) need no install. Bug 403: the test script runs with the project's
 *  own tool whatever HQ's PATH holds (engineers run the same command, and npm in its place made it depend on HQ's PATH); with that tool missing, `noTool`.
 *  `again`: what the user does once the tool is installed, in the words of whoever shows it (auto's red bar has Resume, a ticket's test Test again). */
function nodePart(root: string, rel: string, again: string): Omit<TestPlan, 'install'> & { install: string | null } {
  const dir = path.join(root, rel), pm = packageManager(dir), test = TEST_SCRIPT[pm.tool], at = (s: string) => rel === '.' ? s : `${rel}: ${s}`
  if (pm.tool === 'npm') return { install: nodeInstall(root, rel), test }
  const own = has(dir, 'node_modules') ? {} : ownInstall(dir, onPath, again), install = own.install ? (rel === '.' ? own.install : `(cd ${JSON.stringify(rel)} && ${own.install})`) : null
  const name = TOOL_NAME[pm.tool], noTool = onPath(pm.tool) ? null : `it uses ${name} (${pm.why}), and ${pm.tool} isn't installed on this computer (HQ looked in its PATH), `
    + `so HQ can't run its tests (${test}). Install ${name}, then ${again}.`
  return { install, test, ...(own.stop ? { stop: at(own.stop) } : {}), ...(noTool ? { noTool: at(noTool) } : {}) }
}
const TOOL_NAME = { yarn: 'Yarn', pnpm: 'pnpm', bun: 'Bun' } as const
const partTest = (p: string, run: string): string => `(cd ${JSON.stringify(p)} && ${run})`
/** One part of a test command HQ builds for a repo split into folders: the folder, and what runs in it. */
export type TestPart = { dir: string; run: string; install?: string | null }
/** Bug 411: the parts of a test command, when it is the chain HQ builds for a repo split into folders (detectTests: `(cd "web" && npm test) && …`, also when
 *  the user saved it as theirs). HQ runs such a command one part at a time and judges each part's output on its own (runParts). null for any other command:
 *  HQ can't take the user's own command apart, so it runs whole, as before. */
export function testParts(cmd: string): TestPart[] | null {
  const c = cmd.trim(), ms = [...c.matchAll(/\(cd ("[^"\\$`/]+") && (npm test|yarn test|pnpm test|bun run test)\)/g)], ds = ms.map((m) => JSON.parse(m[1]!) as string)
  return ds.length && !ds.some((d) => d === '.' || d === '..') && ms.map((m, i) => partCmd(ds[i]!, m[2]!)).join(' && ') === c // that command exactly, or none
    ? ds.map((dir, i) => ({ dir, run: ms[i]![2]! })) : null
}
/** Bug 376: the folders a test command starts its runners in, when it is the command HQ builds for a repo split into folders (testParts). A runner prints
 *  its files from the folder it starts in, so a file line in its output counts only for a file in one of these (criteria.ts namesFile). null for any other
 *  command: HQ can't tell where the user's own command starts its runners (`npm test` at the root may run each workspace's), so a file line counts for every
 *  file whose path ends the same, as before. */
export const testFolders = (cmd: string): string[] | null => testParts(cmd)?.map((p) => p.dir) ?? null
/** Bug 424: how a requirements.txt project's packages go into a .venv of its own, the way engineers are told to (engineer.prompt.md): with uv when it is
 *  installed. pip works in HQ's own sandbox, but on a Mac it can't download in an engineer's (Bug 412: it checks certificates through macOS's trustd, which
 *  that sandbox blocks), so an engineer given HQ's install to run got a certificate error; uv carries its own list. pip when there is no uv, as before.
 *  `--allow-existing`: an engineer may run it again in its worktree, and uv 0.12 refuses a .venv that is already there. */
const reqsInstall = (): string => onPath('uv') ? 'uv venv -q --allow-existing .venv && uv pip install -q -r requirements.txt'
  : 'python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt'
/** How to test the checkout at `root`, worked out from its files with no model and no tokens; null when it has no tests HQ can find.
 *  The root's own test script wins; a repo split into folders (server/, web/) runs each folder's. `again`: see nodePart. */
export function detectTests(root: string, again = 'test again'): TestPlan | null {
  try {
    if (has(root, 'package.json') && npmTest(root)) return nodePart(root, '.', again)
    const parts = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && has(root, d.name,
      'package.json') && npmTest(path.join(root, d.name))).map((d) => d.name).sort()
    if (parts.length) {
      const each = parts.map((p) => ({ p, ...nodePart(root, p, again) })), stop = each.find((e) => e.stop)?.stop, noTool = each.find((e) => e.noTool)?.noTool
      // two members of one workspace: its install once (Bug 430)
      return { install: [...new Set(each.flatMap((e) => e.install ?? []))].join(' && ') || null, test: each.map((e) => partTest(e.p, e.test)).join(' && '), ...(stop ? { stop } : {}),
        ...(noTool ? { noTool } : {}) }
    }
  } catch { return null }
  if (has(root, 'pyproject.toml') || has(root, 'pytest.ini') || has(root, 'requirements.txt')) {
    if (has(root, 'pyproject.toml') && !has(root, 'requirements.txt')) return { install: 'uv sync', test: 'uv run pytest -q' }
    if (has(root, 'requirements.txt')) return { install: reqsInstall(), test: '.venv/bin/python -m pytest -q' }
  }
  if (has(root, 'Cargo.toml')) return { install: 'cargo fetch', test: 'cargo test' }
  if (has(root, 'go.mod')) return { install: 'go mod download', test: 'go test ./...' }
  if (has(root, 'Makefile') && /^test:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'))) return { install: null, test: 'make test' }
  return null
}

/** Bug 411: the test files of commit `ref` in this checkout that the rules' command (detectTests) runs nothing of: a backend/ full of pytest tests beside
 *  a frontend/ whose `npm test` is all the rules found. Read from git's list of the commit's files and the checkout's manifests; no tokens. [] when there are
 *  none, and when git can't say (a folder that is no repo): the page then says nothing, which is what it said before. */
export async function rulesSkip(checkout: string, ref = 'HEAD'): Promise<NotRun[]> {
  try {
    const files = await filesAt(checkout, ref), set = new Set(files), plan = detectTests(checkout)
    return notRun(files, plan ? ruleParts(plan.test) : [], (p) => set.has(p), (p) => { try { return fs.readFileSync(path.join(checkout, p), 'utf8') } catch { return '' } })
  } catch { return [] }
}
/** The files of commit `ref`, as git lists them (so nothing installed or ignored), from any checkout of the repo. A big repo's list is long: its own buffer. */
export const filesAt = (checkout: string, ref = 'HEAD'): Promise<string[]> => new Promise((resolve, reject) => execFile('git', ['--no-optional-locks', '-c', 'core.quotepath=off',
  'ls-tree', '-r', '--name-only', ref], { cwd: checkout, maxBuffer: 256 << 20, timeout: 30_000 }, (e, o) => e ? reject(e) : resolve(o.split('\n').filter(Boolean))))

const q = (s: string): string => JSON.stringify(s)
/** What a test run can't read: HQ's and Claude's own files and the user's credentials. The install step has the network on, so a
 *  package's install script could send what it reads. */
const hiddenPaths = (): string[] => [PATHS.home, GH_CONFIG_DIR, ...HOME_SECRETS.map((p) => path.join(os.homedir(), p))].map(real)
/** macOS's sandbox for a test run. `network`: outside access for installing packages, else localhost only. `block` (Bug 374): localhost ports the run may
 *  neither call nor listen on: the ones HQ moved its copy of the app off (testports.ts), where somebody else's server answers (the user's preview). A place
 *  that still names one fails there; it never reaches that server. Later rules win, so these come last. */
export function sandboxProfile(wt: string, o: { network: boolean; block?: number[] }): string {
  const block = (o.block ?? []).filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
  const tmp = real(os.tmpdir())
  const writes = [wt, ENGINEER_CACHE, tmp, '/private/tmp', '/private/var/folders'].map((p) => `(subpath ${q(p)})`).join(' ')
  const hidden = hiddenPaths().map((p) => `(subpath ${q(p)})`).join(' ')
  return ['(version 1)', '(allow default)', '(deny file-write*)',
    `(allow file-write* ${writes} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/"))`,
    `(deny file-read* ${hidden})`,
    // `open` hands a program to launchd, outside this sandbox (spike 2026-11-03: it ran one that wrote where this profile refuses).
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd" "com.apple.coreservices.quarantine-resolver") (global-name-prefix "com.apple.lsd"))',
    // The only sockets a run can reach are its own, and the one macOS looks names up through (spike 2026-11-03: DNS fails without it).
    ...(o.network ? ['(deny network-outbound (remote unix-socket))', '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))']
      : ['(deny network-outbound)', `(allow network-outbound (remote ip "localhost:*") (remote unix-socket (subpath ${q(wt)})))`, '(allow network-bind (local ip "localhost:*"))',
        ...block.flatMap((p) => [`(deny network-outbound (remote ip "localhost:${p}"))`, `(deny network-bind (local ip "*:${p}"))`])]),
  ].join('\n')
}
/** macOS's sandbox for the UI tester's browser (uitester.ts): it writes only in `dir` (its own temp folder) and reaches only the app, on localhost `port`.
 *  It can't read the project (`project`: the user's checkout, and with it every throwaway checkout under it) nor anything a test run can't. Playwright MCP
 *  blocks file:// pages itself; this holds whatever gets past that. Spike 2026-11-17: HQ's own page on another port answers net::ERR_ACCESS_DENIED. */
export function browserProfile(dir: string, port: number, project: string): string {
  const hidden = [...hiddenPaths(), real(project)].map((p) => `(subpath ${q(p)})`).join(' '), d = q(real(dir))
  return ['(version 1)', '(allow default)', '(deny file-write*)',
    `(allow file-write* (subpath ${d}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/"))`,
    `(deny file-read* ${hidden})`,
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd" "com.apple.coreservices.quarantine-resolver") (global-name-prefix "com.apple.lsd"))',
    '(deny network-outbound)', `(allow network-outbound (remote ip "localhost:${port}") (remote unix-socket (subpath ${d})))`, '(allow network-bind (local ip "localhost:*"))',
  ].join('\n')
}
/** Linux's sandbox for a test run, the same rules with bubblewrap: the whole machine read-only, then what's writable, then what's hidden.
 *  /tmp and /run are the run's own, which takes tmux's, Docker's and ssh-agent's sockets out of reach; a read-only mount alone doesn't. */
export function bwrapArgs(wt: string, o: { network: boolean }): string[] {
  const gitFile = path.join(wt, '.git')
  const linked = fs.existsSync(gitFile) && fs.statSync(gitFile).isFile() ? /^gitdir: (.+)\/worktrees\/[^/]+$/m.exec(fs.readFileSync(gitFile, 'utf8'))?.[1] : null
  return ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run', '--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve',
    ...(linked ? ['--ro-bind', linked, linked] : []), // the repo's history, for a test that runs git and a repo under /tmp
    '--bind', wt, wt, '--bind', ENGINEER_CACHE, ENGINEER_CACHE,
    ...hiddenPaths().filter((p) => fs.existsSync(p)).flatMap((p) => fs.statSync(p).isDirectory() ? ['--perms', '0000', '--tmpfs', p] : ['--ro-bind', '/dev/null', p]),
    '--unshare-all', ...(o.network ? ['--share-net'] : []), '--die-with-parent', '--new-session', '--chdir', wt]
}
const sandboxBin = (): string => process.env.HQ_SANDBOX_BIN ?? (process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'bwrap')
/** How to run `cmd` sandboxed on this machine. `block`: see sandboxProfile (Linux gives the run a network of its own, with nothing of the machine's in it). */
export function sandboxCommand(cwd: string, cmd: string, o: { network: boolean; block?: number[] }): { bin: string; args: string[] } {
  const wt = real(cwd), sh = ['/bin/sh', '-c', cmd]
  return { bin: sandboxBin(), args: [...(process.platform === 'darwin' ? ['-p', sandboxProfile(wt, o)] : bwrapArgs(wt, o)), ...sh] }
}
let worked: string | null = null // the sandbox last seen working; a failure is looked at again each time, the user may have just fixed it
/** Why this machine can't run auto mode, in words for the user with the fix, or null when it can. It runs the sandbox for real: a Linux
 *  can have bubblewrap and still refuse it (Ubuntu can block what it needs). Engineers' sandbox on Linux needs bubblewrap and socat too. */
export async function sandboxProblem(): Promise<string | null> {
  const bin = sandboxBin(), mac = process.platform === 'darwin'
  if (!mac && process.platform !== 'linux') return 'Auto mode runs on macOS and Linux only: it won\'t test unread code without a sandbox, and HQ has none here.'
  if (!mac && ((!bin.includes('/') && !onPath(bin)) || !onPath('socat'))) {
    return 'On Linux, auto mode needs bubblewrap and socat to sandbox code nobody has read. Install them with `sudo apt install bubblewrap socat` (or your system\'s package manager), then try again.'
  }
  if (worked === bin) return null
  const r = await runSandboxed(ENGINEER_CACHE, 'exit 0', { network: false, timeoutMs: 15_000 })
  if (r.code === 0) { worked = bin; return null }
  const why = r.output.split('\n')[0]?.slice(0, 200) || 'it stopped with no message'
  return mac ? `HQ couldn't start macOS's sandbox: ${why}` : `bubblewrap is installed but can't run here: ${why} Some systems and containers block it; HQ's README says what to change.`
}
/** `output`: the last TAIL characters. `earlier`: the lines before those that named a failure or an error, '' when none did (Bug 82). `summary`: the test runners'
 *  summary lines from anywhere in the output, null when there were too many to keep (testcounts.ts, Bug 126). */
export type RunResult = { code: number | null; output: string; earlier: string; timedOut: boolean; sandboxFailed: boolean; summary?: string[] | null; names?: Watched
  cmd?: string; ran?: PartRan[] } // cmd (Bug 411): of a command run part by part, the part this result is of (the one that failed or was stopped); ran: when all passed, each part
/** One part of a run that passed: its folder, its command, and the count its runner's summary gave (null: none HQ could read). */
export type PartRan = { dir: string; cmd: string; counts: Counts | null }
const TAIL = 8000, EARLIER = 4000
/** How long a run past its time limit gets after Ctrl+C before it's killed: node's test runner names the tests still running when it
 *  gets one, and prints nothing when it's killed outright (Bug 82: one engineer got 3,000 characters of passing tests). Seen on
 *  macOS; on Linux bubblewrap doesn't pass the signal on, so the run goes at once, as it always did. */
const GRACE_MS = 10_000
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// A line that names a failure, as node, pytest, go, cargo, jest and mocha (`2 failing`, its list of failures follows) print them, and one that names an error
const FAILED = /^(✖|×|---\s*FAIL\b|FAIL(ED)?\b|not ok\b|E\s|Traceback\b|thread '.*' panicked|\d+ failing$)/i, ERRORED = /^\w*(error|exception)\b/i
const PASSED = /^(✔|✓|▶|ok\b|PASS(ED)?\b|---\s*PASS\b)/ // a test that passed, or the next one starting: what failed has been told
/** The lines of a run's output that name a failure (and up to 10 after it) or an error (up to 3), wherever they come. node
 *  prints why a test file crashed where it happens, and its summary at the end only says "test failed" (Bug 82). The first
 *  ones are kept: a later failure is often the first one's knock-on. An error on its own gets half the room: passing tests log errors
 *  too, and a dozen of them mustn't crowd out the failure. `before(at)`: those that start before `at`, the start of the tail. */
export function failureLines(): { take: (chunk: string) => void; before: (at: number) => string } {
  const kept: { n: number; at: number; text: string }[] = []
  let rest = '', seen = 0, n = 0, left = 0, used = 0, strong = false
  const line = (raw: string, at: number) => {
    const text = shownLine(raw).replace(ANSI, '').trimEnd().slice(0, 300), s = text.trim()
    if (FAILED.test(s)) { left = 11; strong = true } else if (ERRORED.test(s)) { strong &&= left > 0; left = Math.max(left, 4) } else if (PASSED.test(s)) left = 0
    if (left > 0 && used < (strong ? EARLIER : EARLIER / 2)) { kept.push({ n, at, text }); used += text.length + 1 }
    left = Math.max(0, left - 1); n++
  }
  return {
    take: (chunk) => {
      const s = rest + chunk; let from = 0
      for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', from)) { line(s.slice(from, i), seen + from); from = i + 1 }
      seen += from; rest = s.slice(from)
      if (rest.length > TAIL) { line(rest, seen); seen += rest.length; rest = '' } // a line with no end in sight
    },
    before: (at) => kept.filter((k) => k.at < at).map((k, i, a) => (i && k.n !== a[i - 1]!.n + 1 ? `…\n${k.text}` : k.text)).join('\n').trim(),
  }
}
const running = new Map<number, string>() // the process groups of the runs under way, and the folder each runs in
/** The backend is going down. A run's time limit is a timer in this process, so a run left behind would never end (Bug 69). */
export function killTestRuns(): void { for (const g of running.keys()) { try { process.kill(-g, 'SIGKILL') } catch { /* gone */ } } }
/** The folders test runs are under way in: their servers are the run's, not leftovers (Bug 75). */
export const testRunDirs = (): string[] => [...running.values()]
/** A run's own temp folder on a Mac, gone when the run ends, however it ends: a run that's killed never deletes its own temp files, and
 *  in the shared one nothing knew whose they were (Bug 81: 15 GB of coverage records). Named by the backend's pid, so a later backend can
 *  tell a dead one's from a live one's (an isolated HQ shares the folder). On Linux bubblewrap gives each run its own /tmp already. */
const RUN_TMP = 'hq-run-tmp-'
const runTmp = (): string => fs.mkdtempSync(path.join(real(os.tmpdir()), `${RUN_TMP}${process.pid}-`))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
/** Removes the temp folders of runs whose backend is gone: one that died mid-run never got to. */
export function sweepRunTmp(): string[] {
  const dir = real(os.tmpdir()), gone: string[] = []
  for (const d of fs.readdirSync(dir)) {
    const pid = Number(/^hq-run-tmp-(\d+)-/.exec(d)?.[1])
    if (!pid || pid === process.pid || pidAlive(pid)) continue
    try { fs.rmSync(path.join(dir, d), { recursive: true, force: true }); gone.push(d) } catch { /* someone else's, or busy: next start */ }
  }
  return gone
}
/** Runs `cmd` in `cwd` in the sandbox with a clean environment: no tokens, no agent ids, nothing of the backend's but PATH and HOME.
 *  With no sandbox nothing runs: HQ never runs this code bare. `env`: added to that (a test run's own ports, Bug 273). `folders`: where the command starts
 *  its runners, when the caller knows (a part of a command run part by part); else read from the command (testFolders). */
export function runSandboxed(cwd: string, cmd: string, o: { network: boolean; timeoutMs: number; signal?: AbortSignal; watch?: Watch; env?: Record<string, string>
  block?: number[]; folders?: string[] | null }):
  Promise<RunResult> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ code: null, output: '', earlier: '', timedOut: false, sandboxFailed: false }) // stopped before it began: nothing runs
    const tmp = process.platform === 'darwin' ? runTmp() : null
    const env = { ...cleanEnv(tmp), ...(o.network ? {} : NO_NETWORK_ENV), ...o.env }
    const { bin, args } = sandboxCommand(cwd, cmd, o)
    const p = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); if (p.pid) running.set(p.pid, cwd)
    let output = '', total = 0, timedOut = false, hard: NodeJS.Timeout | undefined
    const fails = failureLines(), sums = summaryLines(), names = nameWatch(o.watch ?? { names: [], files: [] }, o.folders !== undefined ? o.folders : testFolders(cmd))
    const take = (s: string) => { total += s.length; output = (output + s).slice(-TAIL); fails.take(s); sums.take(s); names.take(s) }
    p.stdout.setEncoding('utf8').on('data', take); p.stderr.setEncoding('utf8').on('data', take)
    const signal = (s: NodeJS.Signals) => { try { process.kill(-p.pid!, s) } catch { /* gone */ } }, kill = () => signal('SIGKILL')
    const timer = setTimeout(() => { timedOut = true; signal('SIGINT'); hard = setTimeout(kill, GRACE_MS) }, o.timeoutMs)
    o.signal?.addEventListener('abort', kill) // nobody will read what it says, so no grace for its last words (Bug 89)
    let result: RunResult | null = null // the first word wins: a program that won't start sends 'error' and then 'close'
    const done = (r: RunResult) => { clearTimeout(timer); clearTimeout(hard); o.signal?.removeEventListener('abort', kill); if (result) return; result = r
      void (tmp ? fs.promises.rm(tmp, { recursive: true, force: true }) : Promise.resolve()).catch(() => {}).then(() => resolve(r)) }
    p.on('error', (e) => done({ code: null, output: `${bin} wouldn't start, and HQ won't run the tests without it: ${(e as Error).message}`, earlier: '', timedOut,
      sandboxFailed: true }))
    p.on('close', (code) => { kill(); running.delete(p.pid!)
      done({ code, output: output.trim(), earlier: fails.before(total - output.length), timedOut, sandboxFailed: /^(sandbox-exec|bwrap): /m.test(output), summary: sums.lines(),
        names: names.seen() }) })
  })
}

/** Bug 411: a test command made of several folders' suites (testParts, or a project's saved test steps), one part after another, as its `&&` would: the first
 *  part that fails ends it, and the result is that part's (its own command in `cmd`, its own output). They share one time limit. A part with an `install`
 *  installs first, in its folder, with the network on (`installed: false` when that is what failed); its tests run with it off. Each part's output is
 *  watched on its own, in its own folder, for the tests a ticket named (criteria.ts mergeWatched): one suite's output says nothing about another's tests.
 *  When all pass, what they printed comes back in order, each under its command. */
export async function runParts(cwd: string, parts: TestPart[], o: { timeoutMs: number; signal?: AbortSignal; watch?: Watch; env?: Record<string, string> }):
  Promise<RunResult & { installed?: false }> {
  const began = Date.now(), seen: { dir: string; seen: Watched }[] = [], out: string[] = [], ran: PartRan[] = []; let summary: string[] | null = []
  const left = (): number => o.timeoutMs - (Date.now() - began)
  const late = (cmd: string): RunResult => ({ code: null, output: 'The parts before it used up the time limit, so this one never started.', earlier: '', timedOut: true, sandboxFailed: false, cmd })
  for (const p of parts) {
    if (p.install) {
      const cmd = partCmd(p.dir, p.install); if (left() <= 0) return late(cmd)
      const i = await runSandboxed(cwd, cmd, { network: true, timeoutMs: left(), signal: o.signal, env: { ...o.env, ...toolCaches(p.install) } })
      if (o.signal?.aborted || i.sandboxFailed || i.code !== 0) return { ...i, cmd, installed: false }
    }
    const cmd = partCmd(p.dir, p.run); if (left() <= 0) return late(cmd)
    const r = await runSandboxed(cwd, cmd, { network: false, timeoutMs: left(), signal: o.signal, watch: o.watch, env: o.env, folders: p.dir === '.' ? null : [p.dir] })
    if (o.signal?.aborted || r.sandboxFailed || r.code !== 0 || failedAnyway(r)) return { ...r, cmd } // Bug 426: a part that hid its failure ends it too
    seen.push({ dir: p.dir, seen: r.names ?? { prints: false, passed: [], skipped: [], unsure: [] } }); out.push(`$ ${cmd}\n${r.output}`)
    ran.push({ dir: p.dir, cmd, counts: testCounts(r.summary ?? null) })
    summary = summary && r.summary ? [...summary, ...r.summary] : null // one part with too many to keep: no count for the whole
  }
  return { code: 0, output: out.join('\n\n').slice(-TAIL), earlier: '', timedOut: false, sandboxFailed: false, summary, names: mergeWatched(seen), ran }
}
/** Bug 426: a run that exited 0 although its output says a test failed (`mocha || true`, a script that hides its runner's exit code): the counts, read from
 *  the runners' summary lines (testcounts.ts), with at least one failed. null for any other run. HQ goes by the counts then: the run failed. Only a failed
 *  count does it (failing, fail, failed, error, cancelled); pending, skipped, todo, pytest's xfailed and vitest's "expected fail" are no failure. */
export function failedAnyway(r: Pick<RunResult, 'code' | 'summary'>): Counts | null {
  const c = r.code === 0 ? testCounts(r.summary ?? null) : null
  return c && c.failed > 0 ? c : null
}
/** Bug 426: what HQ adds after what failed, for such a run: why it says failed when the command said all was well. '' for any other. */
export const exitedAnyway = (r: Pick<Failed, 'test' | 'exit0'>): string =>
  r.exit0 ? ` (\`${r.test}\` exited 0 all the same, but its output says ${countWords(r.exit0)})` : ''

export const testWorktree = (repoPath: string, key: string): string => path.join(repoPath, '.claude', 'worktrees', `hq-test-${key}`)
async function dropWorktree(repoPath: string, wt: string): Promise<void> {
  if (fs.existsSync(wt)) await killUnder(wt).catch(() => []) // a run that outlived its backend: on a Mac its working folder is all that still names it (Bug 69)
  await git(repoPath, ['worktree', 'remove', '--force', wt]).catch(() => {})
  fs.rmSync(wt, { recursive: true, force: true }); releaseCopy(wt) // Bug 410: what its app was given is free again, once nothing runs there
  await git(repoPath, ['worktree', 'prune']).catch(() => {})
}
/** What a backend that stopped mid-test left behind. */
export async function sweepTestWorktrees(repoPath: string): Promise<void> {
  const dir = path.join(repoPath, '.claude', 'worktrees')
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (d.startsWith('hq-test-')) await dropWorktree(repoPath, path.join(dir, d))
}

/** `hung`: it never finished, and HQ stopped it at the time limit. `unproven`: the run passed, but it skipped or never ran a test the ticket named for one of
 *  its criteria (criteria.ts); `output` is then HQ's own list of those, not the run's, and `missing` how many they are (Bug 373); `outside` (Bug 411): how many
 *  of those are in a folder the test command runs nothing in, which is the command's gap and not the ticket's. `names`: what a passing run printed about the tests it was asked to
 *  watch for. `output` and `earlier` are a run's (RunResult). `stopped`: auto mode went off
 *  or stopped the project during the run, which HQ ended there; it says nothing about the code, and nothing may follow from it (Bugs 89, 115).
 *  `seen`: what HQ's look at the app showed, when the run was asked to look once the tests had passed (smoke.ts). `looked`: a look with no tests before it
 *  (main alone, to tell what a ticket changed). `look` on a failure: it's HQ's look that failed, not the tests, and `output` is HQ's report of it. `review`:
 *  likewise for what a fresh reader of the ticket's changes found (diffcheck.ts). `exit0` (Bug 426): the command exited 0, but these counts from its output
 *  have a failed test in them, so HQ calls it a failure (failedAnyway). */
export type TestResult = { kind: 'pass'; test: string; output: string; counts: Counts | null; ms: number; names: Watched; seen?: Seen; parts?: PartRan[] }
  | { kind: 'fail'; test: string; output: string; earlier: string; hung?: boolean; unproven?: boolean; missing?: number; outside?: number; look?: boolean; review?: boolean
    asked?: boolean; tester?: boolean; basePassed?: boolean; rulesInstall?: boolean; exit0?: Counts } | { kind: 'no_tests' } // asked: the user's check found it
  // (hqcheck.ts), not auto mode; tester: the UI tester's findings (with look); basePassed (Bug 405): HQ ran main alone too, and its tests passed (or it has none),
  // so the failure is the ticket's; rulesInstall (Bug 416): it was the install step of HQ's own rules (detectTests) that failed, with no saved test steps
  | { kind: 'conflicts'; files: string[] } | { kind: 'error'; why: string } | { kind: 'stopped' } | { kind: 'looked'; seen: Seen }
/** Auto mode's own runs under way, by project folder (Bug 89). A repair's try of a test command isn't one: with auto off its result goes to the user. */
const autoRuns = new Map<string, Set<AbortController>>(), stops = new Map<string, number>()
/** How many times auto mode's runs were stopped in this project. Auto reads it before it looks at anything, and a run started with an older
 *  count is stopped as it starts: auto may go off while HQ is still at the git steps before the run, with nothing yet to stop. */
export const autoGen = (repoPath: string): number => stops.get(repoPath) ?? 0
/** Auto mode went off or stopped the project (Bug 115): its runs in this project end now, a run still waiting for its turn never starts, and each one says `stopped`. */
export function stopAutoTests(repoPath: string): number {
  stops.set(repoPath, autoGen(repoPath) + 1); const s = autoRuns.get(repoPath); for (const c of s ?? []) c.abort(); return s?.size ?? 0
}
/** Who can stop a run: auto mode (its count, autoGen), a stop signal of its own (a ticket's check), or nobody (null). */
export type Owner = number | AbortSignal | null
const ownedBy = (repoPath: string, gen: Owner): { signal: AbortSignal; done: () => void } => {
  const c = new AbortController(); if (gen === null) return { signal: c.signal, done: () => {} }
  if (typeof gen !== 'number') { // its own stop: fired already, or later
    const stop = () => c.abort(); if (gen.aborted) c.abort(); else gen.addEventListener('abort', stop, { once: true })
    return { signal: c.signal, done: () => gen.removeEventListener('abort', stop) }
  }
  if (gen !== autoGen(repoPath)) c.abort()
  const s = autoRuns.get(repoPath) ?? new Set(); autoRuns.set(repoPath, s.add(c))
  return { signal: c.signal, done: () => { s.delete(c); if (!s.size && autoRuns.get(repoPath) === s) autoRuns.delete(repoPath) } }
}
export type Failed = Extract<TestResult, { kind: 'fail' }>
/** Bug 106: HQ's own test runs under way, for the page. While HQ tests a finished ticket every agent can be idle or gone, for minutes, and the board said the same
 *  words before, during and after. `what`: a ticket merged into main; main alone (as a run starts, or after a ticket failed: was main already broken?); a repair's
 *  try of a test command. `state`: in line for its turn (heavy.ts), or running; `since`: when that began. Kept in memory, like the runs themselves: a backend that
 *  stops takes its runs with it, and the next snapshot a page gets has none. */
export type Shown = { repoId: string; ticketId: string | null; what: 'ticket' | 'main' | 'command' | 'look' | 'look_main' | 'review' | 'tester' | 'map' | 'scenario'
  | 'setup_check' | 'checker' | 'replay' | 'steps_check' }
/** `behind`: while it waits, who holds the turns it waits for (heavy.ts; Bug 289: the board says behind whom). */
export type TestRunView = { id: string; repo_id: string; ticket_id: string | null; what: Shown['what']; state: 'waiting' | 'running'; since: number; behind: string[] }
const views = new Map<string, TestRunView>()
export const testRunViews = (): TestRunView[] => [...views.values()].map((v) => ({ ...v }))
/** Puts a run on the page until `over`, however it ends. `state` moves it between waiting and running. Nothing to show: both do nothing. */
function onPage(s: Shown | null): { state: (to: TestRunView['state'], behind?: string[]) => void; what: (to: Shown['what']) => void; over: () => void } {
  if (!s) return { state: () => {}, what: () => {}, over: () => {} }
  const v: TestRunView = { id: id('test'), repo_id: s.repoId, ticket_id: s.ticketId, what: s.what, state: 'running', since: now(), behind: [] }
  views.set(v.id, v); patch('test_run', v.id, { ...v })
  return {
    // still waiting, behind someone else now: the same wait, so its clock goes on
    state: (to, behind = []) => { const b = to === 'waiting' ? behind : [], moved = v.state !== to
      if ((!moved && b.join('\n') === v.behind.join('\n')) || !views.has(v.id)) return
      if (moved) { v.state = to; v.since = now() }
      v.behind = b; patch('test_run', v.id, { state: to, since: v.since, behind: b }) },
    // the tests are over and the look has begun: the same run, saying what it's doing now
    what: (to) => { if (v.what === to || !views.has(v.id)) return; v.what = to; v.since = now(); patch('test_run', v.id, { what: to, since: v.since }) },
    over: () => { if (views.delete(v.id)) patch('test_run', v.id, null) },
  }
}
/** Bug 392: where Yarn, pnpm and Bun keep what they download, for an install in the sandbox: their own folders in the home can't be written there, and
 *  each fell back to a folder of the one run (Yarn 1.22, Yarn 4.19, pnpm 10.34, Bun 1.4: spike 2026-11-24), so every run downloaded everything again.
 *  Bug 450: pnpm's store has two names. pnpm 10 and older read npm_config_store_dir only, pnpm 11 and 12 pnpm_config_store_dir only (spike 2026-11-27,
 *  pnpm 9.15, 10.34, 11.29, 12.23); with the wrong one pnpm 12 put a store in the checkout's node_modules/.pnpm-store. npm's spelling only for a pnpm
 *  install: npm 11 warns about any npm_config_ setting it doesn't know; it reads no pnpm_config_ ones, so that one goes with every install. */
const PNPM_STORE = path.join(ENGINEER_CACHE, 'pnpm-store')
export const toolCaches = (install: string): Record<string, string> => ({ YARN_CACHE_FOLDER: path.join(ENGINEER_CACHE, 'yarn'),
  YARN_GLOBAL_FOLDER: path.join(ENGINEER_CACHE, 'yarn-berry'), BUN_INSTALL_CACHE_DIR: path.join(ENGINEER_CACHE, 'bun'), pnpm_config_store_dir: PNPM_STORE,
  ...(/\bpnpm install\b/.test(install) ? { npm_config_store_dir: PNPM_STORE } : {}) })
/** Bug 431: what a run with the network off (the tests, HQ's look at the app) tells package managers, so none goes looking for the network on its own.
 *  pnpm 12 does before a script: `verifyDepsBeforeRun` installs when node_modules is missing or is the copy seedPackages made (to pnpm a moved folder is
 *  out of date), and a v12 `packageManager` pin not yet in pnpm-lock.yaml fetches pnpm's own details. Offline, each retried for 70 s, then failed, and the
 *  install had emptied the copy first, so tests that pass failed too. `false`, not `error`: `error` fails every run with a copied node_modules. Spelled
 *  pnpm_config_: pnpm 12 reads no npm_config_ settings, and npm warns about any it doesn't know. Spike 2026-11-26 (pnpm 12.23.0, Yarn 4.19.0, Bun
 *  1.4.5): Yarn and Bun install nothing before a script, and a missing install fails in a second either way. */
const NO_NETWORK_ENV = { pnpm_config_verify_deps_before_run: 'false', pnpm_config_pm_on_fail: 'ignore' }
/** The clean environment everything in the sandbox runs with: no tokens, no agent ids, nothing of the backend's but PATH and HOME. `tmp`: its own temp folder. */
export const cleanEnv = (tmp: string | null): Record<string, string> => ({ HOME: os.homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmp ?? '/tmp',
  LANG: process.env.LANG ?? 'en_US.UTF-8', CI: '1', ...cacheEnv(), ...(process.env.RUSTUP_HOME ? { RUSTUP_HOME: process.env.RUSTUP_HOME } : {}) }) // rustup's toolchains, if they aren't in ~/.rustup
/** A temp folder of its own for something HQ runs sandboxed on a Mac (null on Linux, where bubblewrap gives each run its own /tmp), and what removes it. */
export function ownTmp(): { tmp: string | null; done: () => Promise<void> } {
  const tmp = process.platform === 'darwin' ? runTmp() : null
  return { tmp, done: () => (tmp ? fs.promises.rm(tmp, { recursive: true, force: true }) : Promise.resolve()).catch(() => {}) }
}
/** A throwaway checkout of `sha` for work of auto mode's that isn't a test run (the tester, tester.ts): made, handed to `fn` with the signal that auto mode
 *  going off or stopping fires, and removed with everything still running in it, however `fn` ends. In turn with builds and test runs, and on the page
 *  (`show`) meanwhile. `stopped`: the signal fired before `fn` began. `key`: the checkout's folder (hq-test-<key>), and the name the line of turns gives it;
 *  `{ dir, name }` when they differ (Bug 460: a folder of each run's own, under the same name for the user). */
export async function inCheckout<T>(repoPath: string, sha: string, key: string | { dir: string; name: string }, auto: Owner, show: Shown | null,
  fn: (wt: string, signal: AbortSignal) => Promise<T>): Promise<T | 'stopped'> {
  const { dir, name } = typeof key === 'string' ? { dir: key, name: key } : key
  const wt = testWorktree(repoPath, dir), { signal, done } = ownedBy(repoPath, auto); let page = onPage(null)
  try {
    if (signal.aborted) return 'stopped'
    await dropWorktree(repoPath, wt); fs.mkdirSync(path.dirname(wt), { recursive: true })
    await git(repoPath, ['worktree', 'add', '--detach', '--quiet', wt, sha]); await seedPackages(repoPath, wt)
    page = onPage(signal.aborted ? null : show)
    return await withTurn(`HQ's tester (${name})`, 'tests', async () => { if (signal.aborted) return 'stopped' as const; page.state('running'); return fn(wt, signal) },
      (b) => page.state('waiting', b), { ticket: show?.ticketId, place: repoPath })
  } finally { done(); await dropWorktree(repoPath, wt).finally(page.over) }
}
/** On the page while auto mode does something for a ticket that isn't a run of this module's: a reader on its changes (diffcheck.ts), say. */
export const showing = (s: Shown): { over: () => void } => onPage(s)
/** A signal that auto mode going off or stopping the project fires, for work of auto mode's that isn't a test run (Bugs 89, 115): `gen` is autoGen's count as
 *  auto read it, and `done` gives the signal up. */
export const autoWork = (repoPath: string, gen: Owner): { signal: AbortSignal; done: () => void } => ownedBy(repoPath, gen)
/** What failed, for the user: the first line that names it, never a stack trace. The engineer gets the whole output. */
export function failedLine(output: string): string {
  const lines = output.split('\n').map((l) => shownLine(l).replace(ANSI, '').trim()).filter(Boolean)
  let hit: string | undefined
  for (const [i, l] of lines.entries()) {
    hit = /^FAIL\s+\S+$/.test(l) ? jestFailure(lines, i + 1) ?? l // Bug 395: jest's `FAIL ./a.test.js` names the file; the test comes after it
      : /^(✖|×|---\s*FAIL\b|FAIL\b|FAILED\b|not ok\b|error\b|E\s|thread '.+' panicked\b)/i.test(l) && !/^✖ failing tests/i.test(l) ? l
      : /^test .+ \.\.\. FAILED$/.test(l) ? l : /^\d+ failing$/.test(l) ? mochaFailure(lines, i + 1) : undefined // cargo's: its own, then its panic
    if (hit) break
  }
  hit ??= lines.find((l) => /\berror\b|\bfailed?\b/i.test(l) && !/^(at |ℹ|#)/.test(l)) ?? lines.find((l) => /^\w+(Error|Exception)\b/.test(l)) ?? lines.at(-1) ?? ''
  // node's `(1.2ms)`, jest's `(1 ms)`; vitest's bare `3ms` after a failed test (Bug 395)
  return hit.replace(/^(×.*?)\s+\d+ms$/, '$1').replace(/\s*\(\d[\d.]* ?ms\)$/, '').slice(0, 140)
}
/** Bug 395: the first test jest says failed after its `FAIL <file>` line: its `● suite › test` heading (`● Console` is what a test logged), else
 *  its `✕ test` line in the file's list. */
function jestFailure(lines: string[], at: number): string | undefined {
  const rest = lines.slice(at)
  return rest.find((l) => /^● /.test(l) && l !== '● Console') ?? rest.find((l) => /^✕ /.test(l))
}
/** Bug 391: the first test in the list mocha prints after `2 failing`, its suites and title on lines of their own, the last one ending in ":":
 *  `1) book list` / `marks a book due soon:` reads `1) book list marks a book due soon`, as mocha's `list` reporter names it. */
function mochaFailure(lines: string[], at: number): string | undefined {
  if (!/^\d+\) /.test(lines[at] ?? '')) return undefined
  const end = lines.slice(at, at + 8).findIndex((l) => l.endsWith(':'))
  return end < 0 ? lines[at] : lines.slice(at, at + end + 1).join(' ').slice(0, -1)
}
// At most `max` characters of the start or the end, cut between lines
const firstChars = (s: string, max: number): string => { if (s.length <= max) return s; const i = s.lastIndexOf('\n', max); return `${s.slice(0, i > 0 ? i : max)}\n…` }
const lastChars = (s: string, max: number): string => s.length <= max ? s : `…\n${s.slice(s.indexOf('\n', s.length - max) + 1 || s.length - max)}`
/** What a failed run printed, for an engineer, in about `max` characters: the lines that named a failure early on, then the end
 *  (Bug 82: the end alone can be thousands of passing tests, and HQ used to send only that). */
export function failReport(r: Pick<Failed, 'output' | 'earlier'>, max: number): string {
  if (!r.earlier) return lastChars(r.output, max)
  const head = `Lines that named a failure or an error, from earlier in the output:\n${firstChars(r.earlier, Math.max(max / 2, max - r.output.length - 100))}`
  return `${head}\n\nThe end of the output:\n${lastChars(r.output, Math.max(500, max - head.length))}`
}
/** The tests on commit `sha`. `custom`: the user's own command (it replaces the test step; the install step still comes from the files).
 *  `auto`: auto mode's own run, which turning it off or a stop ends: autoGen's count as auto read it. `show`: whose run the page says this is (Bug 106),
 *  from when HQ knows there are tests to run; a run stopped before that is never shown. */
/** `watch`: test names and files to look for in what the run prints (a ticket's map of its criteria's tests). `look`: once the tests pass, start the app in the
 *  same checkout and open its pages (smoke.ts). `only`: the look alone, with no tests before it. `steps` (Bug 411): the project's saved test steps
 *  (teststepsstore.ts). With no command of the user's own they are what runs, part by part, each part installing first; with one, their installs still run
 *  before it (the user's command says what to test, not what it needs installed). */
export type RunOpts = { watch?: Watch; look?: LookPlan | null; only?: 'look'; steps?: { parts: SavedPart[] } | null; again?: string } // again: see nodePart
async function runAt(repoPath: string, sha: string, key: string, custom: string | null, auto: Owner, show: Shown | null, o: RunOpts = {}): Promise<TestResult> {
  const wt = testWorktree(repoPath, key), { signal, done } = ownedBy(repoPath, auto), stopped = { kind: 'stopped' } as const
  let page = onPage(null)
  /** The look, in the checkout as the tests left it: the same turn, sandbox and end as the tests (auto off, a stop, the time limit, the backend going down). */
  const look = async (plan: LookPlan): Promise<Seen | null> => { const s = await lookIn(wt, plan, { signal, run: runSandboxed }); return s.kind === 'stopped' ? null : s }
  try {
    if (signal.aborted) return stopped
    await dropWorktree(repoPath, wt)
    fs.mkdirSync(path.dirname(wt), { recursive: true })
    await git(repoPath, ['worktree', 'add', '--detach', '--quiet', wt, sha])
    await seedPackages(repoPath, wt)
    if (o.only === 'look' && o.look) {
      const plan = o.look; page = onPage(signal.aborted ? null : show)
      return await withTurn(`HQ's look at ${key}`, 'tests', async (): Promise<TestResult> => {
        if (signal.aborted) return stopped
        page.state('running'); const seen = await look(plan); return seen ? { kind: 'looked', seen } : stopped
      }, (b) => page.state('waiting', b), { ticket: show?.ticketId, place: repoPath })
    }
    const found = detectTests(wt, o.again)
    // Bug 411: saved steps come before the rules. A part whose folder has no tests on this commit is left out; with none left, the rules decide as before
    const mine = o.steps ? partsHere(o.steps.parts, await filesAt(wt).catch(() => [])).map((p): TestPart => ({ dir: p.dir, run: p.test, install: p.install ?? null })) : []
    const plan: TestPlan | null = custom ? (mine.length ? { install: null, test: custom } : { install: found?.install ?? null, test: custom, stop: found?.stop })
      : mine.length ? { install: null, test: chain(mine.map((p) => ({ dir: p.dir, test: p.run }))) } : found
    if (!plan) return { kind: 'no_tests' }
    if (plan.stop || plan.noTool) return { kind: 'error', why: (plan.stop || plan.noTool)! } // Bug 392: never npm in its place; Bug 403: nor for the test script
    const timeoutMs = getSetting('test_timeout_min', DEFAULTS.test_timeout_min) * 60_000
    page = onPage(signal.aborted ? null : show)
    return await withTurn(`HQ's test of ${key}`, 'tests', async (): Promise<TestResult> => { // in line with engineers' own builds and test runs (Bug 76); the time limit starts with the run
      if (signal.aborted) return stopped // it waited for its turn and auto went off or stopped meanwhile
      page.state('running')
      // Bug 273: ports of its own while it has its turn, as an engineer has (runports.ts): a test that starts a server on `$PORT || 3000` clashed with
      // another HQ's run or the user's app. Given back however the run ends; a backend that goes down kills the run and forgets the block with it
      const ports = await runPorts().catch(() => null), env = ports?.env
      if (!ports) emit({ agentId: null, source: 'system', kind: 'testrun.no_ports', payload: { key } })
      try {
        if (signal.aborted) return stopped
        if (plan.install) {
          const i = await runSandboxed(wt, plan.install, { network: true, timeoutMs, signal, env: { ...env, ...toolCaches(plan.install) } })
          if (signal.aborted) return stopped
          if (i.sandboxFailed) return { kind: 'error', why: `HQ couldn't start its sandbox: ${i.output.slice(0, 200)}` }
          if (i.code !== 0) {
            return { kind: 'fail', test: plan.install, output: i.timedOut ? `Installing packages took over ${timeoutMs / 60_000} minutes.` : i.output, earlier: i.earlier, rulesInstall: true }
          }
        }
        // Bug 411: a command HQ built from several folders' suites runs one part at a time, each judged on its own output; any other runs whole
        const late = (): string => `Installing packages took over ${timeoutMs / 60_000} minutes.`
        if (custom && mine.length) { // the user's own command, after the saved steps' installs (each in its folder)
          for (const p of mine.filter((x) => x.install)) {
            const cmd = partCmd(p.dir, p.install!), i = await runSandboxed(wt, cmd, { network: true, timeoutMs, signal, env: { ...env, ...toolCaches(p.install!) } })
            if (signal.aborted) return stopped
            if (i.sandboxFailed) return { kind: 'error', why: `HQ couldn't start its sandbox: ${i.output.slice(0, 200)}` }
            if (i.code !== 0) return { kind: 'fail', test: cmd, output: i.timedOut ? late() : i.output, earlier: i.earlier }
          }
        }
        const parts = custom ? testParts(plan.test) : mine.length ? mine : testParts(plan.test), began = Date.now()
        const r = parts ? await runParts(wt, parts, { timeoutMs, signal, watch: o.watch, env }) : await runSandboxed(wt, plan.test, { network: false, timeoutMs, signal, watch: o.watch, env })
        if (signal.aborted) return stopped
        if (r.sandboxFailed) return { kind: 'error', why: `HQ couldn't start its sandbox: ${r.output.slice(0, 200)}` }
        const anyway = failedAnyway(r) // Bug 426: exited 0, but its output says a test failed
        if (r.code === 0 && !anyway) {
          const pass: TestResult = { kind: 'pass', test: plan.test, output: r.output.replace(ANSI, ''), counts: testCounts(r.summary ?? null), ms: Date.now() - began, // Bug 126
            names: r.names ?? { prints: false, passed: [], skipped: [], unsure: [] }, ...(r.ran ? { parts: r.ran } : {}) }
          if (!o.look) return pass
          page.what(show?.what === 'main' ? 'look_main' : 'look'); const seen = await look(o.look) // the tests passed: now, does the app open?
          return seen ? { ...pass, seen } : stopped
        }
        if ('installed' in r && r.installed === false) return { kind: 'fail', test: r.cmd ?? plan.test, output: r.timedOut ? late() : r.output, earlier: r.earlier } // a part's install
        // a run that hung: whoever reads it says so; the part that failed, by its own command
        return { kind: 'fail', test: r.cmd ?? plan.test, hung: r.timedOut, output: r.output, earlier: r.earlier, ...(anyway ? { exit0: anyway } : {}) }
      } finally { ports?.done() }
    }, (b) => page.state('waiting', b), { ticket: show?.ticketId, place: repoPath }) // Bugs 309, 312
  } catch (e) { return { kind: 'error', why: (e as Error).message.split('\n')[0] ?? 'unknown error' } }
  finally { done(); await dropWorktree(repoPath, wt).finally(page.over) } // off the page once its checkout has gone: only then does whoever asked hear the result
}
/** The tests on `branch` merged into `base` (a ref): main isn't touched, and the commit tested goes away unused. */
export async function testCombined(repoPath: string, base: string, branch: string, key: string, custom: string | null, auto: Owner = null,
  show: Shown | null = null, o: RunOpts = {}): Promise<TestResult> {
  const c = await combinedCommit(repoPath, base, branch)
  if ('conflicts' in c) return { kind: 'conflicts', files: c.conflicts }
  if ('error' in c) return { kind: 'error', why: c.error }
  return runAt(repoPath, c.sha, key, custom, auto, show, o)
}
/** HQ's look at the app on `base` alone, no tests: when a ticket's look showed something wrong, was it already like that? */
export const lookAtBase = (repoPath: string, base: string, key: string, plan: LookPlan, auto: Owner = null, show: Shown | null = null): Promise<TestResult> =>
  runAt(repoPath, base, `${key}-main`, null, auto, show, { look: plan, only: 'look' })
/** The tests on `base` alone: when a ticket fails, is it the ticket, or was main already broken? */
export const testBase = (repoPath: string, base: string, key: string, custom: string | null, auto: Owner = null, show: Shown | null = null, o: RunOpts = {}): Promise<TestResult> =>
  runAt(repoPath, base, `${key}-main`, custom, auto, show, o)
