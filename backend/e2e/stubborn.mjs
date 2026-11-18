// Bug 113: loaded into a test HQ's backend through NODE_OPTIONS (harness.test.ts), to show the harness's teardown has a time limit.
// HQ_STUBBORN=term: the backend doesn't stop on SIGTERM. HQ_STUBBORN=pipe: it starts a process that keeps its output, out of reach of the harness's
// clean-up (not in the test HQ's folder, no path of it on its command line); that process's pid goes to HQ_STUBBORN_PID.
// Bug 166: HQ_STUBBORN=deaf: the backend starts a tmux server on the test HQ's own socket, as one with agents would have, and then never gets as far as
// listening. Its pid and the tmux server's go to HQ_STUBBORN_PID.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

if (process.argv[1]?.endsWith('src/index.ts')) { // the backend only: agents and test runs get NODE_OPTIONS too
  if (process.env.HQ_STUBBORN === 'term') process.prependListener('SIGTERM', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000) })
  if (process.env.HQ_STUBBORN === 'pipe') {
    const c = spawn('sleep', ['600'], { cwd: '/', stdio: ['ignore', 'inherit', 'inherit'], detached: true }); c.unref(); fs.writeFileSync(process.env.HQ_STUBBORN_PID, String(c.pid))
  }
  if (process.env.HQ_STUBBORN === 'deaf') {
    const sock = path.join(process.env.TMUX_TMPDIR, `tmux-${process.getuid()}`, 'default'), tmux = (...a) => execFileSync('tmux', ['-S', sock, ...a], { encoding: 'utf8' }).trim()
    tmux('new-session', '-d', '-s', 'probe', 'sleep 600')
    fs.writeFileSync(process.env.HQ_STUBBORN_PID, JSON.stringify({ backend: process.pid, tmux: Number(tmux('display', '-p', '#{pid}')) }))
    setInterval(() => {}, 1000); await new Promise(() => {}) // index.ts never runs
  }
}
