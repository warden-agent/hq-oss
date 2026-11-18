// Finding what still runs inside a folder (the Launch helper's leftover test servers) from lsof's listing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { listenersUnder, listenPorts, pgidOf, pidsUnder, whoAnswers, whose } from './procs.ts'

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
  assert.deepEqual(whoAnswers([], 4, 0), { kind: 'show' }) // lsof sees nobody
  assert.deepEqual(whoAnswers([h(5, 4), h(9, 9)], 4, 0), { kind: 'clash', others: [h(9, 9)] })
  assert.deepEqual(whoAnswers([h(9, 9)], 4, 1000), { kind: 'wait' }) // the app may still be starting
  assert.deepEqual(whoAnswers([h(9, 9)], 4, 16_000), { kind: 'show' }) // a port Docker forwards
  assert.deepEqual(whoAnswers([h(9, null)], null, 0), { kind: 'wait' })
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
