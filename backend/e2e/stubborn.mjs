// Bug 113: loaded into a test HQ's backend through NODE_OPTIONS (harness.test.ts), to show the harness's teardown has a time limit.
// HQ_STUBBORN=term: the backend doesn't stop on SIGTERM. HQ_STUBBORN=pipe: it starts a process that keeps its output, out of reach of the harness's
// clean-up (not in the test HQ's folder, no path of it on its command line); that process's pid goes to HQ_STUBBORN_PID.
import { spawn } from 'node:child_process'
import fs from 'node:fs'

if (process.argv[1]?.endsWith('src/index.ts')) { // the backend only: agents and test runs get NODE_OPTIONS too
  if (process.env.HQ_STUBBORN === 'term') process.prependListener('SIGTERM', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000) })
  if (process.env.HQ_STUBBORN === 'pipe') {
    const c = spawn('sleep', ['600'], { cwd: '/', stdio: ['ignore', 'inherit', 'inherit'], detached: true }); c.unref(); fs.writeFileSync(process.env.HQ_STUBBORN_PID, String(c.pid))
  }
}
