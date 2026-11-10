// Runs a command with temp folders of its own and deletes them when the command ends (Bug 81): HQ's tests had left thousands of
// hq-* folders in the shared ones, from runs stopped before their own clean-up could run (the test runner kills a test file
// outright). A run killed along with this script is cleaned up by the next one, found by the pid in the folders' names.
// TMPDIR is the run's own; HQ_SHORT_TMPDIR is one under /tmp, for unix sockets, whose paths must stay short (a tmux server the run
// left there is stopped by its socket first); HQ_OUTER_TMPDIR is the shared one, for what must outlive the run; HQ_AGENT_TMP keeps
// the agents tests launch in the run's folder too (they'd otherwise get /tmp/hq<id>-<agent> folders, as live HQ's do).
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const outer = fs.realpathSync(os.tmpdir()), short = fs.realpathSync('/tmp'), uid = process.getuid?.() ?? 0
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function remove(dir) {
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const sock = path.join(dir, d, `tmux-${uid}`, 'default') // never a bare tmux call: it would reach the user's own server
    if (fs.existsSync(sock)) try { execFileSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' }) } catch { /* not running */ }
  }
  fs.rmSync(dir, { recursive: true, force: true })
}
for (const root of new Set([outer, short])) for (const d of fs.readdirSync(root)) {
  const pid = Number(/^hqt-(\d+)-/.exec(d)?.[1])
  if (pid && pid !== process.pid && !alive(pid)) try { remove(path.join(root, d)) } catch { /* someone else's, or busy: the next run */ }
}
const tmp = fs.mkdtempSync(path.join(outer, `hqt-${process.pid}-`)), sockets = fs.mkdtempSync(path.join(short, `hqt-${process.pid}-`))
const [cmd, ...args] = process.argv.slice(2)
const child = spawn(cmd, args, { stdio: 'inherit',
  env: { ...process.env, TMPDIR: tmp, HQ_SHORT_TMPDIR: sockets, HQ_OUTER_TMPDIR: outer, HQ_AGENT_TMP: path.join(tmp, 'a-') } })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig))
child.on('exit', (code, sig) => {
  remove(sockets); remove(tmp)
  process.exit(code ?? 128 + (os.constants.signals[sig] ?? 0))
})
