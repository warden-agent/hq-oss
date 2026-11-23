// Bug 322 end to end: Launch skips a preview port that nothing answers on but nothing can listen on either. On Linux that is the local end of an
// outgoing connection, or one closed under a minute ago; here a socket bound to the port and not listening holds it, which does the same on macOS.
// HQ used to take the port as free, the app ended with EADDRINUSE ("stopped with code 1") and Launch picked the same port again.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { startHq, sh, waitFor, type Hq } from './harness.ts'

let hq: Hq
let holder: ChildProcess | null = null
before(async () => { hq = await startHq() })
after(async () => { holder?.kill('SIGKILL'); await hq?.stop() })

/** Binds 127.0.0.1:`port` without listening (Python: Node's sockets set SO_REUSEADDR, which Linux lets a listener through) and keeps it until killed. */
async function bindOnly(port: number): Promise<ChildProcess> {
  const code = 'import socket, sys\ns = socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1]))); print("bound", flush=True); sys.stdin.read()'
  const py = spawn('python3', ['-c', code, String(port)], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => { py.stdout!.once('data', () => resolve()); py.once('error', reject); py.once('exit', () => reject(new Error(`python3 could not bind ${port}`))) })
  return py
}

test('Launch takes the next preview port when the first can\'t be listened on, though nothing answers there; the app runs and answers', { timeout: 60_000 }, async () => {
  const [lo] = hq.env.HQ_PREVIEW_PORTS!.split('-').map(Number)
  holder = await bindOnly(lo!)
  const dir = hq.repo('b322held') // the app listens where HQ's preview is reached (as Vite does on localhost), so it can't share the held port on any OS
  fs.writeFileSync(path.join(dir, 'server.js'), "require('http').createServer((q, s) => s.end('b322 up')).listen(process.env.PORT, '127.0.0.1')\n")
  sh(dir, 'commit', '-qam', 'loopback')
  const repo = (await hq.api('repos', { path: dir })).json
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  const p = await waitFor('the app to run, stop or crash', async () => {
    const x = (await hq.state()).previews.find((y: any) => y.id === repo.id); return x && ['running', 'stopped', 'crashed'].includes(x.status) ? x : null
  }, 20_000)
  assert.notEqual(p.port, lo, 'not the held port')
  assert.equal(p.status, 'running', p.detail)
  assert.equal(await (await fetch(`http://127.0.0.1:${p.port}/`)).text(), 'b322 up')
})
