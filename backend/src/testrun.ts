// Auto mode's check before a merge (Bug 54): the tests run on what main would become with this ticket, in a throwaway worktree, so a
// mismatch between two tickets that each pass alone is caught. Nobody looks at this code before it runs, so it runs sandboxed, with the
// engineers' rules and none of the user's credentials: sandbox-exec on macOS, bubblewrap on Linux (spikes 2026-11-03: `npm test` passes;
// ~/.ssh, ~/.hq, writes outside the worktree and github.com are refused). Neither can filter by host, so installing packages is its own
// step with the network on and the test step has it off. Sockets are shut too: a test that reaches Docker's or tmux's is out of the box.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DEFAULTS, ENGINEER_CACHE, GH_CONFIG_DIR, PATHS } from './config.ts'
import { getSetting } from './db.ts'
import { withTurn } from './heavy.ts'
import { combinedCommit } from './localmerge.ts'
import { killUnder } from './procs.ts'
import { cacheEnv } from './roles.ts'
import { git } from './reposync.ts'
import { real } from './util.ts'
import { seedPackages } from './worktrees.ts'

export type TestPlan = { install: string | null; test: string }
const has = (root: string, ...p: string[]) => fs.existsSync(path.join(root, ...p))
const npmTest = (root: string): boolean => {
  try {
    const t = String((JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts?.test ?? '')
    return !!t.trim() && !/no test specified/i.test(t) // npm init's placeholder always fails
  } catch { return false }
}
const nodeInstall = (root: string, rel: string): string | null => {
  if (has(root, rel, 'node_modules')) return null // seedPackages copied the main checkout's
  const pkg = JSON.parse(fs.readFileSync(path.join(root, rel, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object }
  if (!pkg.dependencies && !pkg.devDependencies) return null
  const install = has(root, rel, 'package-lock.json') ? 'npm ci' : 'npm install'
  return rel === '.' ? install : `(cd ${JSON.stringify(rel)} && ${install})`
}
/** How to test the checkout at `root`, worked out from its files with no model and no tokens; null when it has no tests HQ can find.
 *  The root's own test script wins; a repo split into folders (server/, web/) runs each folder's. */
export function detectTests(root: string): TestPlan | null {
  try {
    if (has(root, 'package.json') && npmTest(root)) return { install: nodeInstall(root, '.'), test: 'npm test' }
    const parts = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && has(root, d.name,
      'package.json') && npmTest(path.join(root, d.name))).map((d) => d.name).sort()
    if (parts.length) {
      const installs = parts.flatMap((p) => nodeInstall(root, p) ?? [])
      return { install: installs.join(' && ') || null, test: parts.map((p) => `(cd ${JSON.stringify(p)} && npm test)`).join(' && ') }
    }
  } catch { return null }
  if (has(root, 'pyproject.toml') || has(root, 'pytest.ini') || has(root, 'requirements.txt')) {
    if (has(root, 'pyproject.toml') && !has(root, 'requirements.txt')) return { install: 'uv sync', test: 'uv run pytest -q' }
    if (has(root, 'requirements.txt')) return { install: 'python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt', test: '.venv/bin/python -m pytest -q' }
  }
  if (has(root, 'Cargo.toml')) return { install: 'cargo fetch', test: 'cargo test' }
  if (has(root, 'go.mod')) return { install: 'go mod download', test: 'go test ./...' }
  if (has(root, 'Makefile') && /^test:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'))) return { install: null, test: 'make test' }
  return null
}

const q = (s: string): string => JSON.stringify(s)
/** What a test run can't read: HQ's and Claude's own files and the user's credentials. The install step has the network on, so a
 *  package's install script could send what it reads. */
const hiddenPaths = (): string[] => [PATHS.home, GH_CONFIG_DIR, ...['.claude', '.claude.json', '.ssh', '.aws', '.config/gh', '.config/gcloud', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  '.docker', '.kube', '.gnupg', '.cargo/credentials.toml', '.cargo/credentials'].map((p) => path.join(os.homedir(), p))].map(real)
/** macOS's sandbox for a test run. `network`: outside access for installing packages, else localhost only. */
export function sandboxProfile(wt: string, o: { network: boolean }): string {
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
      : ['(deny network-outbound)', `(allow network-outbound (remote ip "localhost:*") (remote unix-socket (subpath ${q(wt)})))`, '(allow network-bind (local ip "localhost:*"))']),
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
/** How to run `cmd` sandboxed on this machine. */
export function sandboxCommand(cwd: string, cmd: string, o: { network: boolean }): { bin: string; args: string[] } {
  const wt = real(cwd), sh = ['/bin/sh', '-c', cmd]
  return { bin: sandboxBin(), args: [...(process.platform === 'darwin' ? ['-p', sandboxProfile(wt, o)] : bwrapArgs(wt, o)), ...sh] }
}
const onPath = (bin: string): boolean => (process.env.PATH ?? '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, bin)))
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
/** `output`: the last TAIL characters. `earlier`: the lines before those that named a failure or an error, '' when none did (Bug 82). */
export type RunResult = { code: number | null; output: string; earlier: string; timedOut: boolean; sandboxFailed: boolean }
const TAIL = 8000, EARLIER = 4000
/** How long a run past its time limit gets after Ctrl+C before it's killed: node's test runner names the tests still running when it
 *  gets one, and prints nothing when it's killed outright (Bug 82: one engineer got 3,000 characters of passing tests). Seen on
 *  macOS; on Linux bubblewrap doesn't pass the signal on, so the run goes at once, as it always did. */
const GRACE_MS = 10_000
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// A line that names a failure, as node, pytest, go, cargo and jest print them (all that failedLine picks), and one that names an error
const FAILED = /^(✖|×|---\s*FAIL\b|FAIL(ED)?\b|not ok\b|E\s|Traceback\b|thread '.*' panicked)/i, ERRORED = /^\w*(error|exception)\b/i
const PASSED = /^(✔|✓|▶|ok\b|PASS(ED)?\b|---\s*PASS\b)/ // a test that passed, or the next one starting: what failed has been told
/** The lines of a run's output that name a failure (and up to 10 after it) or an error (up to 3), wherever they come. node
 *  prints why a test file crashed where it happens, and its summary at the end only says "test failed" (Bug 82). The first
 *  ones are kept: a later failure is often the first one's knock-on. An error on its own gets half the room: passing tests log errors
 *  too, and a dozen of them mustn't crowd out the failure. `before(at)`: those that start before `at`, the start of the tail. */
export function failureLines(): { take: (chunk: string) => void; before: (at: number) => string } {
  const kept: { n: number; at: number; text: string }[] = []
  let rest = '', seen = 0, n = 0, left = 0, used = 0, strong = false
  const line = (raw: string, at: number) => {
    const text = raw.replace(ANSI, '').trimEnd().slice(0, 300), s = text.trim()
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
 *  With no sandbox nothing runs: HQ never runs this code bare. */
export function runSandboxed(cwd: string, cmd: string, o: { network: boolean; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ code: null, output: '', earlier: '', timedOut: false, sandboxFailed: false }) // stopped before it began: nothing runs
    const tmp = process.platform === 'darwin' ? runTmp() : null
    const env = { HOME: os.homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmp ?? '/tmp', LANG: process.env.LANG ?? 'en_US.UTF-8',
      CI: '1', ...cacheEnv(), ...(process.env.RUSTUP_HOME ? { RUSTUP_HOME: process.env.RUSTUP_HOME } : {}) } // rustup's toolchains, if they aren't in ~/.rustup
    const { bin, args } = sandboxCommand(cwd, cmd, o)
    const p = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); if (p.pid) running.set(p.pid, cwd)
    let output = '', total = 0, timedOut = false, hard: NodeJS.Timeout | undefined
    const fails = failureLines(), take = (s: string) => { total += s.length; output = (output + s).slice(-TAIL); fails.take(s) }
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
      done({ code, output: output.trim(), earlier: fails.before(total - output.length), timedOut, sandboxFailed: /^(sandbox-exec|bwrap): /m.test(output) }) })
  })
}

export const testWorktree = (repoPath: string, key: string): string => path.join(repoPath, '.claude', 'worktrees', `hq-test-${key}`)
async function dropWorktree(repoPath: string, wt: string): Promise<void> {
  if (fs.existsSync(wt)) await killUnder(wt).catch(() => []) // a run that outlived its backend: on a Mac its working folder is all that still names it (Bug 69)
  await git(repoPath, ['worktree', 'remove', '--force', wt]).catch(() => {})
  fs.rmSync(wt, { recursive: true, force: true }); await git(repoPath, ['worktree', 'prune']).catch(() => {})
}
/** What a backend that stopped mid-test left behind. */
export async function sweepTestWorktrees(repoPath: string): Promise<void> {
  const dir = path.join(repoPath, '.claude', 'worktrees')
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (d.startsWith('hq-test-')) await dropWorktree(repoPath, path.join(dir, d))
}

/** `hung`: it never finished, and HQ stopped it at the time limit. `output` and `earlier` are a run's (RunResult). `stopped`: auto mode went off
 *  during the run, which HQ ended there; it says nothing about the code, and nothing may follow from it (Bug 89). */
export type TestResult = { kind: 'pass'; test: string } | { kind: 'fail'; test: string; output: string; earlier: string; hung?: boolean } | { kind: 'no_tests' }
  | { kind: 'conflicts'; files: string[] } | { kind: 'error'; why: string } | { kind: 'stopped' }
/** Auto mode's own runs under way, by project folder (Bug 89). A repair's try of a test command isn't one: with auto off its result goes to the user. */
const autoRuns = new Map<string, Set<AbortController>>(), stops = new Map<string, number>()
/** How many times auto mode's runs were stopped in this project. Auto reads it before it looks at anything, and a run started with an older
 *  count is stopped as it starts: auto may go off while HQ is still at the git steps before the run, with nothing yet to stop. */
export const autoGen = (repoPath: string): number => stops.get(repoPath) ?? 0
/** Auto mode went off: its runs in this project end now, a run still waiting for its turn never starts, and each one says `stopped`. */
export function stopAutoTests(repoPath: string): number {
  stops.set(repoPath, autoGen(repoPath) + 1); const s = autoRuns.get(repoPath); for (const c of s ?? []) c.abort(); return s?.size ?? 0
}
const ownedBy = (repoPath: string, gen: number | null): { signal: AbortSignal; done: () => void } => {
  const c = new AbortController(); if (gen === null) return { signal: c.signal, done: () => {} }
  if (gen !== autoGen(repoPath)) c.abort()
  const s = autoRuns.get(repoPath) ?? new Set(); autoRuns.set(repoPath, s.add(c))
  return { signal: c.signal, done: () => { s.delete(c); if (!s.size && autoRuns.get(repoPath) === s) autoRuns.delete(repoPath) } }
}
export type Failed = Extract<TestResult, { kind: 'fail' }>
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
 *  `auto`: auto mode's own run, which turning it off stops: autoGen's count as auto read it. */
async function runAt(repoPath: string, sha: string, key: string, custom: string | null, auto: number | null): Promise<TestResult> {
  const wt = testWorktree(repoPath, key), { signal, done } = ownedBy(repoPath, auto), stopped = { kind: 'stopped' } as const
  try {
    if (signal.aborted) return stopped
    await dropWorktree(repoPath, wt)
    fs.mkdirSync(path.dirname(wt), { recursive: true })
    await git(repoPath, ['worktree', 'add', '--detach', '--quiet', wt, sha])
    await seedPackages(repoPath, wt)
    const found = detectTests(wt); const plan: TestPlan | null = custom ? { install: found?.install ?? null, test: custom } : found
    if (!plan) return { kind: 'no_tests' }
    const timeoutMs = getSetting('test_timeout_min', DEFAULTS.test_timeout_min) * 60_000
    return await withTurn(`HQ's test of ${key}`, 'tests', async (): Promise<TestResult> => { // in line with engineers' own builds and test runs (Bug 76); the time limit starts with the run
      if (signal.aborted) return stopped // it waited for its turn and auto went off meanwhile
      if (plan.install) {
        const i = await runSandboxed(wt, plan.install, { network: true, timeoutMs, signal })
        if (signal.aborted) return stopped
        if (i.sandboxFailed) return { kind: 'error', why: `HQ couldn't start its sandbox: ${i.output.slice(0, 200)}` }
        if (i.code !== 0) return { kind: 'fail', test: plan.install, output: i.timedOut ? `Installing packages took over ${timeoutMs / 60_000} minutes.` : i.output, earlier: i.earlier }
      }
      const r = await runSandboxed(wt, plan.test, { network: false, timeoutMs, signal })
      if (signal.aborted) return stopped
      if (r.sandboxFailed) return { kind: 'error', why: `HQ couldn't start its sandbox: ${r.output.slice(0, 200)}` }
      if (r.code === 0) return { kind: 'pass', test: plan.test }
      return { kind: 'fail', test: plan.test, hung: r.timedOut, output: r.output, earlier: r.earlier } // a run that hung: whoever reads it says so
    })
  } catch (e) { return { kind: 'error', why: (e as Error).message.split('\n')[0] ?? 'unknown error' } }
  finally { done(); await dropWorktree(repoPath, wt) }
}
/** The tests on `branch` merged into `base` (a ref): main isn't touched, and the commit tested goes away unused. */
export async function testCombined(repoPath: string, base: string, branch: string, key: string, custom: string | null, auto: number | null = null): Promise<TestResult> {
  const c = await combinedCommit(repoPath, base, branch)
  if ('conflicts' in c) return { kind: 'conflicts', files: c.conflicts }
  if ('error' in c) return { kind: 'error', why: c.error }
  return runAt(repoPath, c.sha, key, custom, auto)
}
/** The tests on `base` alone: when a ticket fails, is it the ticket, or was main already broken? */
export const testBase = (repoPath: string, base: string, key: string, custom: string | null, auto: number | null = null): Promise<TestResult> =>
  runAt(repoPath, base, `${key}-main`, custom, auto)
