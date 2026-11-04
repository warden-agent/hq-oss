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
import { combinedCommit } from './localmerge.ts'
import { cacheEnv } from './roles.ts'
import { git } from './reposync.ts'
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

const real = (p: string): string => { try { return fs.realpathSync(p) } catch { return p } }
const q = (s: string): string => JSON.stringify(s)
/** What a test run can't read: HQ's and Claude's own files and the user's credentials. The install step has the network on, so a
 *  package's install script could send what it reads. */
const hiddenPaths = (): string[] => [PATHS.home, GH_CONFIG_DIR, ...['.claude', '.claude.json', '.ssh', '.aws', '.config/gh', '.config/gcloud', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  '.docker', '.kube', '.gnupg'].map((p) => path.join(os.homedir(), p))].map(real)
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
export type RunResult = { code: number | null; output: string; timedOut: boolean; sandboxFailed: boolean }
const TAIL = 8000
/** Runs `cmd` in `cwd` in the sandbox with a clean environment: no tokens, no agent ids, nothing of the backend's but PATH and HOME.
 *  With no sandbox nothing runs: HQ never runs this code bare. */
export function runSandboxed(cwd: string, cmd: string, o: { network: boolean; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = { HOME: os.homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: process.platform === 'darwin' ? real(os.tmpdir()) : '/tmp', LANG: process.env.LANG ?? 'en_US.UTF-8',
      CI: '1', ...cacheEnv() }
    const { bin, args } = sandboxCommand(cwd, cmd, o)
    const p = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    const take = (b: Buffer) => { output = (output + b.toString()).slice(-TAIL) }
    p.stdout.on('data', take); p.stderr.on('data', take)
    const kill = () => { try { process.kill(-p.pid!, 'SIGKILL') } catch { /* gone */ } }
    const timer = setTimeout(() => { timedOut = true; kill() }, o.timeoutMs)
    p.on('error', (e) => { clearTimeout(timer)
      resolve({ code: null, output: `${bin} wouldn't start, and HQ won't run the tests without it: ${(e as Error).message}`, timedOut, sandboxFailed: true }) })
    p.on('close', (code) => { clearTimeout(timer); kill(); resolve({ code, output: output.trim(), timedOut, sandboxFailed: /^(sandbox-exec|bwrap): /m.test(output) }) })
  })
}

export const testWorktree = (repoPath: string, key: string): string => path.join(repoPath, '.claude', 'worktrees', `hq-test-${key}`)
async function dropWorktree(repoPath: string, wt: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', wt]).catch(() => {})
  fs.rmSync(wt, { recursive: true, force: true }); await git(repoPath, ['worktree', 'prune']).catch(() => {})
}
/** What a backend that stopped mid-test left behind. */
export async function sweepTestWorktrees(repoPath: string): Promise<void> {
  const dir = path.join(repoPath, '.claude', 'worktrees')
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (d.startsWith('hq-test-')) await dropWorktree(repoPath, path.join(dir, d))
}

export type TestResult = { kind: 'pass'; test: string } | { kind: 'fail'; test: string; output: string } | { kind: 'no_tests' }
  | { kind: 'conflicts'; files: string[] } | { kind: 'error'; why: string }
/** The tests on commit `sha`. `custom`: the user's own command (it replaces the test step; the install step still comes from the files). */
async function runAt(repoPath: string, sha: string, key: string, custom: string | null): Promise<TestResult> {
  const wt = testWorktree(repoPath, key); await dropWorktree(repoPath, wt)
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true })
    await git(repoPath, ['worktree', 'add', '--detach', '--quiet', wt, sha])
    await seedPackages(repoPath, wt)
    const found = detectTests(wt); const plan: TestPlan | null = custom ? { install: found?.install ?? null, test: custom } : found
    if (!plan) return { kind: 'no_tests' }
    const timeoutMs = getSetting('test_timeout_min', DEFAULTS.test_timeout_min) * 60_000
    if (plan.install) {
      const i = await runSandboxed(wt, plan.install, { network: true, timeoutMs })
      if (i.sandboxFailed) return { kind: 'error', why: `HQ couldn't start its sandbox: ${i.output.slice(0, 200)}` }
      if (i.code !== 0) return { kind: 'fail', test: plan.install, output: i.timedOut ? `Installing packages took over ${timeoutMs / 60_000} minutes.` : i.output }
    }
    const r = await runSandboxed(wt, plan.test, { network: false, timeoutMs })
    if (r.sandboxFailed) return { kind: 'error', why: `HQ couldn't start its sandbox: ${r.output.slice(0, 200)}` }
    if (r.code === 0) return { kind: 'pass', test: plan.test }
    return { kind: 'fail', test: plan.test, output: r.timedOut ? `The tests took over ${timeoutMs / 60_000} minutes and were stopped.\n${r.output}` : r.output }
  } catch (e) { return { kind: 'error', why: (e as Error).message.split('\n')[0] ?? 'unknown error' } }
  finally { await dropWorktree(repoPath, wt) }
}
/** The tests on `branch` merged into `base` (a ref): main isn't touched, and the commit tested goes away unused. */
export async function testCombined(repoPath: string, base: string, branch: string, key: string, custom: string | null): Promise<TestResult> {
  const c = await combinedCommit(repoPath, base, branch)
  if ('conflicts' in c) return { kind: 'conflicts', files: c.conflicts }
  if ('error' in c) return { kind: 'error', why: c.error }
  return runAt(repoPath, c.sha, key, custom)
}
/** The tests on `base` alone: when a ticket fails, is it the ticket, or was main already broken? */
export const testBase = (repoPath: string, base: string, key: string, custom: string | null): Promise<TestResult> => runAt(repoPath, base, `${key}-main`, custom)
