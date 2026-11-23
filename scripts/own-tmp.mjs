// Runs a command with temp folders of its own and deletes them when the command ends (Bug 81): HQ's tests had left thousands of
// hq-* folders in the shared ones, from runs stopped before their own clean-up could run (the test runner kills a test file
// outright). A run killed along with this script is cleaned up by the next one, found by the pid in the folders' names.
// TMPDIR is the run's own; HQ_SHORT_TMPDIR is one under /tmp, for unix sockets, whose paths must stay short (a tmux server the run
// left there is stopped by its socket first); HQ_OUTER_TMPDIR is the shared one, for what must outlive the run; HQ_AGENT_TMP keeps
// the agents tests launch in the run's folder too (they'd otherwise get /tmp/hq<id>-<agent> folders, as live HQ's do).
// Bug 199: TMUX_TMPDIR is the run's own too (and TMUX is dropped), so a tmux call in a test that names no socket of its own reaches
// a server of this run, never the user's: unit tests sent kill-session and has-session to the live HQ's server, and tmux takes a
// name that is only the start of a session's name ("hq-" for "hq-backend") as that session.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// --tests=<glob>, first (npm test, npm run e2e): the test files to run when the command line names none (Bug 200). npm adds what
// follows `--` at the end, so files named there replace the glob, and every option goes before the files: node reads anything
// after the first file as that file's own argument. The glob goes to node unexpanded (quoted in package.json): node --test
// expands it itself, where sh would match one folder level for `**`, or keep it as it is when nothing matches.
// More than one --tests= (npm run coverage:all): both suites in one run, so that one report covers them.
const VALUED = new Set(['-r', '-C', ...['require', 'import', 'conditions', 'env-file', 'env-file-if-exists', 'experimental-loader', 'loader',
  'input-type', 'disable-warning', 'unhandled-rejections', 'title', 'watch-path', 'test-name-pattern', 'test-skip-pattern', 'test-reporter',
  'test-reporter-destination', 'test-concurrency', 'test-timeout', 'test-shard', 'test-isolation', 'test-global-setup', 'test-rerun-failures',
  'test-coverage-include', 'test-coverage-exclude', 'test-coverage-branches', 'test-coverage-functions', 'test-coverage-lines'].map((o) => `--${o}`)])
// Bug 291: a test file that stops part-way, or runs fewer tests than it declares, still exits 0, and node calls that a pass. The
// test runs get whole-files.mjs as a second reporter, which fails such a run and names the file. node wants every reporter named
// once one is, so the usual one (spec, to stdout) is named too. A run that names a reporter of its own is left as it is.
// What made files stop part-way is --test-force-exit throwing away the end of a file's report: flush-report.mjs, preloaded into
// every test process, keeps that from happening (see there).
const WHOLE = ['--test-reporter=spec', '--test-reporter-destination=stdout',
  `--test-reporter=${path.join(import.meta.dirname, 'whole-files.mjs')}`, '--test-reporter-destination=stderr']
const FLUSH = `--import=${pathToFileURL(path.join(import.meta.dirname, 'flush-report.mjs')).href}`
function testFiles(argv) {
  if (!argv[0]?.startsWith('--tests=')) return argv
  const globs = []; while (argv[0]?.startsWith('--tests=')) globs.push(argv.shift().slice('--tests='.length))
  const [cmd, ...rest] = argv, opts = [], files = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('-')) files.push(a)
    else if (VALUED.has(a) && i + 1 < rest.length) opts.push(a, rest[++i]) // `--test-name-pattern two`: `two` is no file
    else opts.push(a)
  }
  const whole = opts.some((o) => o === '--test-reporter' || o.startsWith('--test-reporter=')) ? [] : WHOLE
  return [cmd, ...opts, FLUSH, ...whole, ...(files.length ? files : globs)]
}

const outer = fs.realpathSync(os.tmpdir()), short = fs.realpathSync('/tmp'), uid = process.getuid?.() ?? 0
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
/** Stops a tmux server whose socket is there, by that socket: never a bare tmux call, it would reach the user's own server. */
const stopTmux = (sock) => { if (fs.existsSync(sock)) try { execFileSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' }) } catch { /* not running */ } }
function remove(dir) {
  stopTmux(path.join(dir, `tmux-${uid}`, 'default')) // the run's own (TMUX_TMPDIR)
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) stopTmux(path.join(dir, d, `tmux-${uid}`, 'default')) // test HQs' (harness.ts)
  fs.rmSync(dir, { recursive: true, force: true })
}
for (const root of new Set([outer, short])) for (const d of fs.readdirSync(root)) {
  const pid = Number(/^hqt-(\d+)-/.exec(d)?.[1])
  if (pid && pid !== process.pid && !alive(pid)) try { remove(path.join(root, d)) } catch { /* someone else's, or busy: the next run */ }
}
const tmp = fs.mkdtempSync(path.join(outer, `hqt-${process.pid}-`)), sockets = fs.mkdtempSync(path.join(short, `hqt-${process.pid}-`))
const [cmd, ...args] = testFiles(process.argv.slice(2))
const env = { ...process.env, TMPDIR: tmp, HQ_SHORT_TMPDIR: sockets, HQ_OUTER_TMPDIR: outer, HQ_AGENT_TMP: path.join(tmp, 'a-'), TMUX_TMPDIR: sockets }
delete env.TMUX; delete env.TMUX_PANE // inside tmux, TMUX would win over TMUX_TMPDIR
const child = spawn(cmd, args, { stdio: 'inherit', env })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig))
child.on('exit', (code, sig) => {
  remove(sockets); remove(tmp)
  process.exit(code ?? 128 + (os.constants.signals[sig] ?? 0))
})
