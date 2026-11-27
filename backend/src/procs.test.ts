// Finding what still runs inside a folder (the Launch helper's leftover test servers) from lsof's listing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { boundTo, inTestCopy, listenersUnder, listenPorts, lstartMs, pgidOf, pidsUnder, portHolder, portHolders, psEnv, whoAnswers, whose } from './procs.ts'

test('lstartMs (Bug 319): ps\'s date for a process, in UTC; anything else is no date', () => {
  const f = (s: string) => lstartMs(s.trim().split(/\s+/))
  assert.equal(f('Fri Nov  6 09:05:07 2026'), Date.UTC(2026, 10, 6, 9, 5, 7)); assert.equal(f('Thu Jan 1 00:00:00 1970'), 0)
  for (const bad of ['-', 'ven.  6 nov 09:05:07 2026', 'Fri Nov 6 09:05 2026', 'Fri Nov 6 09:05:07', 'Fri Nev 6 09:05:07 2026']) assert.ok(Number.isNaN(f(bad)), bad)
  // this machine's own ps (a Mac, Linux on CI), as HQ asks it: the date this process began, whatever language or time zone the user has
  const was = { LANG: process.env.LANG, LC_TIME: process.env.LC_TIME, TZ: process.env.TZ }
  Object.assign(process.env, { LANG: 'fr_FR.UTF-8', LC_TIME: 'fr_FR.UTF-8', TZ: 'Pacific/Chatham' }); let env: NodeJS.ProcessEnv
  try { env = psEnv() } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
  const said = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env }).toString(), at = f(said)
  const began = Date.now() - process.uptime() * 1000 // node's own clock starts a little after the process did
  assert.ok(at <= began + 50 && at > began - 3000, `began ${began}, ps says ${said.trim()} = ${at}`)
})

test('pidsUnder: processes working in the folder or below it, each once; a sibling with the same prefix is not inside', () => {
  const listing = ['p10', 'fcwd', 'n/repo/.claude/worktrees/launch-1', 'p11', 'fcwd', 'n/repo/.claude/worktrees/launch-1/server',
    'p12', 'fcwd', 'n/repo/.claude/worktrees/launch-10', 'p13', 'fcwd', 'n/repo', 'p11', 'fcwd', 'n/repo/.claude/worktrees/launch-1/server'].join('\n')
  assert.deepEqual(pidsUnder(listing, '/repo/.claude/worktrees/launch-1'), [10, 11])
  assert.deepEqual(pidsUnder('', '/x'), [])
})

test('whose (Bug 42): a launch-* leftover is HQ\'s, the rest of the repo is the project, other repos by name, else the folder', () => {
  const repos = [{ id: 'r1', name: 'notes', path: '/u/me/code/notes' }, { id: 'r2', name: 'demo', path: '/u/me/code/demo' },
    { id: 'r3', name: 'inner', path: '/u/me/code/demo/inner' }]
  const w = (cwd: string | null) => whose(cwd, repos, 'r1', '/u/me')
  assert.deepEqual(w('/u/me/code/notes/.claude/worktrees/launch-abc/backend'), { kind: 'hq', name: 'an old Launch helper run of notes' })
  assert.deepEqual(w('/u/me/code/notes/.claude/worktrees/T-7'), { kind: 'project', name: 'notes/.claude/worktrees/T-7' })
  assert.deepEqual(w('/u/me/code/notes/backend'), { kind: 'project', name: 'notes/backend' })
  assert.deepEqual(w('/u/me/code/notes'), { kind: 'project', name: 'notes' })
  assert.deepEqual(w('/u/me/code/demo/src'), { kind: 'repo', name: 'demo' })
  assert.deepEqual(w('/u/me/code/demo/inner/x'), { kind: 'repo', name: 'inner' }) // the closest repo wins
  assert.deepEqual(w('/u/me/code/notes-old'), { kind: 'other', name: '~/code/notes-old' }) // same prefix, not inside
  assert.deepEqual(w('/tmp/srv'), { kind: 'other', name: '/tmp/srv' })
  assert.deepEqual(w(null), { kind: 'other', name: 'an unknown folder' })
})

test('whoAnswers (Bug 44): the app alone is shown; another listener beside it is a clash; another one alone is waited for, then shown', () => {
  const h = (pid: number, pgid: number | null) => ({ pid, pgid, cmd: 'node', cwd: null })
  assert.deepEqual(whoAnswers([h(5, 4), h(6, 4)], 4, 0), { kind: 'show' }) // a --reload server: watcher and worker
  assert.deepEqual(whoAnswers([], 4, 0), { kind: 'wait' }) // lsof sees nobody: Bug 410, the reply may have come from a program that has just gone
  assert.deepEqual(whoAnswers([], 4, 16_000), { kind: 'show' }) // a machine whose lsof can't see the app at all
  assert.deepEqual(whoAnswers([h(5, 4), h(9, 9)], 4, 0), { kind: 'clash', others: [h(9, 9)] })
  assert.deepEqual(whoAnswers([h(9, 9)], 4, 1000), { kind: 'wait' }) // the app may still be starting
  assert.deepEqual(whoAnswers([h(9, 9)], 4, 16_000), { kind: 'show' }) // a port Docker forwards
  assert.deepEqual(whoAnswers([h(9, null)], null, 0), { kind: 'wait' })
})

test('whoAnswers (Bug 410): HQ\'s own test copy of an app is never shown as the preview\'s page, however long it waits; beside the app it is a clash', () => {
  const copy = { pid: 9, pgid: 9, cmd: 'node', cwd: '/u/me/shop/.claude/worktrees/hq-test-T-02/backend' }, app = { pid: 5, pgid: 4, cmd: 'node', cwd: '/u/me/garden' }
  assert.deepEqual(whoAnswers([copy], 4, 0), { kind: 'wait' })
  assert.deepEqual(whoAnswers([copy], 4, 10 * 60_000), { kind: 'wait' })
  assert.deepEqual(whoAnswers([app, copy], 4, 0), { kind: 'clash', others: [copy] })
  assert.deepEqual(whoAnswers([app], 4, 0), { kind: 'show' })
  // what it must not catch: an engineer's worktree, the user's own folder named like one, a Launch helper's run
  for (const cwd of ['/u/me/shop/.claude/worktrees/T-02', '/u/me/hq-test-shop', '/u/me/shop/.claude/worktrees/launch-1/x', null]) {
    assert.equal(inTestCopy(cwd), false, String(cwd)); assert.deepEqual(whoAnswers([{ ...copy, cwd }], 4, 16_000), { kind: 'show' }, String(cwd))
  }
  assert.equal(inTestCopy('/u/me/shop/.claude/worktrees/hq-test-main'), true)
})

test('listenPorts (Bug 226): each process\'s listening ports, once each, on any address', () => {
  const listing = ['p20', 'f5', 'n127.0.0.1:3180', 'f6', 'n[::1]:3180', 'p21', 'f7', 'n*:4087', 'f8', 'nlocalhost:4088', 'p22', 'f9', 'nweird'].join('\n')
  assert.deepEqual([...listenPorts(listing)], [[20, [3180]], [21, [4087, 4088]]])
  assert.deepEqual([...listenPorts('')], [])
})

test('listenersUnder (Bug 226): a server working in the folder is found with its port; one elsewhere, or in a spared group, is not', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-listen-'))), other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-listen-')))
  const serve = (cwd: string) => {
    const k = spawn(process.execPath, ['-e', "const s = require('http').createServer(); s.listen(0, '127.0.0.1', () => console.log(s.address().port))"],
      { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return { k, port: new Promise<number>((resolve) => k.stdout!.once('data', (d) => resolve(Number(String(d).trim())))) }
  }
  const inside = serve(dir), outside = serve(other)
  t.after(() => { for (const x of [inside.k, outside.k]) { try { process.kill(-x.pid!, 'SIGKILL') } catch { /* gone */ } } })
  const port = await inside.port; await outside.port
  const found = await listenersUnder(dir)
  assert.deepEqual(found.map((l) => [l.pid, l.port]), [[inside.k.pid, port]])
  assert.deepEqual(await listenersUnder(dir, [(await pgidOf(inside.k.pid!))!]), []) // the helper's own group is spared
  assert.deepEqual(await listenersUnder(path.join(dir, 'nope')), [])
})

test('boundTo (Bug 357): a listener, a socket bound without listening, the near end of a connection from the port; not a client of the port', () => {
  const listing = ['p30', 'cnode-MainThread', 'f20', 'n*:7545', 'f21', 'n127.0.0.1:7545->127.0.0.1:50001', // a listener and a connection it took
    'p31', 'cPython', 'f3', 'n127.0.0.1:7545', // bound, not listening (lsof says CLOSED)
    'p32', 'cGoogle Chrome', 'f9', 'n127.0.0.1:50001->127.0.0.1:7545', // a browser on the app: it holds 50001, not 7545
    'p33', 'cPython', 'f4', 'n[::1]:7545', 'p34', 'ccurl', 'f5', 'n[::1]:7545->[::1]:443', // IPv6: bound; a connection made from the port
    'p35', 'cx', 'f6', 'n127.0.0.1:17545', 'f7', 'nprotocol: TCP', 'p36', 'cy', 'f8', 'n*:75450'].join('\n') // other ports; Linux's unplaced socket
  assert.deepEqual(boundTo(listing, 7545), [{ pid: 30, cmd: 'node' }, { pid: 31, cmd: 'Python' }, { pid: 33, cmd: 'Python' }, { pid: 34, cmd: 'curl' }])
  assert.deepEqual(boundTo(listing, 50001), [{ pid: 32, cmd: 'Google Chrome' }]) // the listener's end of that connection is on 7545
  assert.deepEqual(boundTo('', 7545), [])
})

/** A python3 holding a free port of its own: `listen` or only bound (Bug 357). Resolves to its pid and the port once it holds it. */
const python = (listen: boolean, t: { after: (f: () => void) => void }) => new Promise<{ pid: number; port: number }>((resolve, reject) => {
  const code = `import socket, sys, time\ns = socket.socket(); s.bind(('127.0.0.1', 0))\n${listen ? 's.listen()\n' : ''}print(s.getsockname()[1], flush=True); time.sleep(60)`
  const k = spawn('python3', ['-c', code], { stdio: ['ignore', 'pipe', 'ignore'] }); k.on('error', reject)
  t.after(() => { try { k.kill('SIGKILL') } catch { /* gone */ } })
  k.stdout!.once('data', (d) => resolve({ pid: k.pid!, port: Number(String(d).trim()) }))
})
const hasPython = (() => { try { execFileSync('python3', ['-c', '0'], { stdio: 'ignore' }); return true } catch { return false } })()

test('portHolders (Bug 357): a program bound to the port without listening is named; Bug 44\'s listening look still skips it', {
  skip: process.platform !== 'darwin' ? "Linux's lsof can't place a socket that is only bound" : !hasPython && 'no python3' }, async (t) => {
  const b = await python(false, t)
  const held = await portHolders(b.port)
  assert.deepEqual(held.map((h) => [h.pid, h.cwd]), [[b.pid, fs.realpathSync(process.cwd())]])
  assert.match(held[0]!.cmd, /^python/i)
  assert.match((await portHolder(b.port))!, new RegExp(`^python.* \\(pid ${b.pid}\\)$`, 'i'))
  assert.deepEqual(await portHolders(b.port, 'listening'), [])
})

test('portHolders: a listener is named both ways; a client connected to it is not a holder of its port', async (t) => {
  const kid = (code: string) => {
    const k = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] }); t.after(() => { try { k.kill('SIGKILL') } catch { /* gone */ } })
    return { k, said: new Promise<string>((resolve) => k.stdout!.once('data', (d) => resolve(String(d).trim()))) }
  }
  const l = kid("const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => console.log(s.address().port))"), port = Number(await l.said)
  await kid(`require('net').connect(${port}, '127.0.0.1', () => console.log('on')); setTimeout(() => {}, 60000)`).said
  assert.deepEqual((await portHolders(port)).map((h) => h.pid), [l.k.pid]) // the listener's end of the connection it took is its own
  assert.deepEqual((await portHolders(port, 'listening')).map((h) => h.pid), [l.k.pid])
  assert.match((await portHolder(port))!, new RegExp(`\\(pid ${l.k.pid}\\)$`))
})
