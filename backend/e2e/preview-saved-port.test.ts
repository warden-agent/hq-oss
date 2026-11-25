// Bug 356 end to end: Start on a stopped app whose saved port another program now holds. Ending the old run waits for its port to come free, but
// nothing of HQ's ran there: the stopped app's port is the other program's. That wait used to run out every time (3 s) before HQ took the next port.
// Here the wait is set to 60 s (HQ_PREVIEW_PORT_FREE_MS), so a Start that still waited for it would take a minute, not a moment.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { startHq, sh, waitFor, type Hq } from './harness.ts'

const FREE_MS = 60_000
let hq: Hq
const holders: ChildProcess[] = []
before(async () => { hq = await startHq({ env: { HQ_PREVIEW_PORT_FREE_MS: String(FREE_MS) } }) })
after(async () => { for (const h of holders) h.kill('SIGKILL'); await hq?.stop() })

/** Python holds 127.0.0.1:`port` until killed: listening on it, or only bound to it (Bug 322's kind of busy port). */
async function hold(port: number, listen: boolean): Promise<ChildProcess> {
  const code = 'import socket, sys\ns = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n' // the ended app's port can be in TIME_WAIT
    + 's.bind(("127.0.0.1", int(sys.argv[1])))\n'
    + (listen ? 's.listen()\n' : '') + 'print("held", flush=True); sys.stdin.read()'
  const py = spawn('python3', ['-c', code, String(port)], { stdio: ['pipe', 'pipe', 'inherit'] }); holders.push(py)
  await new Promise<void>((resolve, reject) => { py.stdout!.once('data', () => resolve()); py.once('error', reject); py.once('exit', () => reject(new Error(`python3 could not hold ${port}`))) })
  return py
}

for (const listen of [true, false]) {
  // Linux lets a listener share a port another socket only bound with SO_REUSEADDR (Bug 322's note), so that port isn't busy there
  const skip = !listen && process.platform !== 'darwin' ? 'a port only bound with SO_REUSEADDR is not busy on Linux' : false
  test(`Start on a stopped app whose saved port another program ${listen ? 'listens on' : 'has bound'} takes the next port at once`, { timeout: 90_000, skip }, async () => {
    const dir = hq.repo(`b356${listen ? 'listen' : 'bound'}`)
    fs.writeFileSync(path.join(dir, 'server.js'), "require('http').createServer((q, s) => s.end('b356 up')).listen(process.env.PORT, '127.0.0.1')\n")
    sh(dir, 'commit', '-qam', 'loopback')
    const repo = (await hq.api('repos', { path: dir })).json
    await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
    const settled = (not: number | null) => waitFor('the app to run, stop or crash', async () => {
      const x = (await hq.state()).previews.find((y: any) => y.id === repo.id)
      return x && ['running', 'stopped', 'crashed'].includes(x.status) && x.port !== not ? x : null
    }, 20_000)
    assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
    const first = await settled(null); assert.equal(first.status, 'running', first.detail)
    assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)
    const h = await hold(first.port, listen)
    const t0 = Date.now(), r = await hq.api(`previews/${repo.id}/start`, {}), took = Date.now() - t0
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.ok(took < FREE_MS / 2, `Start took ${took} ms: it waited for a port nothing of HQ's ran on`)
    const again = await settled(first.port)
    assert.equal(again.status, 'running', again.detail)
    assert.equal(await (await fetch(`http://127.0.0.1:${again.port}/`)).text(), 'b356 up')
    assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200); h.kill('SIGKILL')
  })
}
