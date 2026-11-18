// How HQ cuts a line it types into an agent's terminal (Bug 110): Claude Code takes more than 800 characters arriving at once for a paste.
// Bug 242: which tmux server HQ talks to, named in every call. A stand-in tmux on PATH writes the calls down, so no real tmux is called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as tmux from './tmux.ts'
import { pieces, prepareSocket, socketPath } from './tmux.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-tmuxsock-')), bin = path.join(root, 'bin'), log = path.join(root, 'calls.log'); fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
const gone = path.join(root, 'gone') // a TMUX_TMPDIR whose folder was deleted: a bare tmux then lists the default (live) server
delete process.env.TMUX; delete process.env.TMUX_PANE; process.env.TMUX_TMPDIR = gone

test('Bug 242: the socket is the one a bare tmux would take, without its fall back to the default server', () => {
  assert.equal(socketPath({ TMUX: '/private/tmp/tmux-501/default,123,0', TMUX_TMPDIR: '/x' }, 501), '/private/tmp/tmux-501/default') // live HQ, in hq-backend
  assert.equal(socketPath({ TMUX_TMPDIR: '/x/gone' }, 501), '/x/gone/tmux-501/default') // a gone folder stays the answer
  assert.equal(socketPath({}, 501), '/tmp/tmux-501/default'); assert.equal(socketPath({ TMUX: '', TMUX_TMPDIR: '' }, 501), '/tmp/tmux-501/default')
  assert.equal(socketPath({ TMUX: ',1,0', TMUX_TMPDIR: '/y' }, 7), '/y/tmux-7/default') // tmux too skips a TMUX with no path
})
test('Bug 242: every call names that socket with -S first, the terminal view too', async () => {
  const sock = path.join(gone, `tmux-${process.getuid?.() ?? 0}`, 'default')
  assert.equal(tmux.socket(), sock)
  await tmux.hasSession('s'); await tmux.newSession('s', 'true', { cwd: root }); await tmux.capturePane('s'); await tmux.visiblePane('s')
  await tmux.sendKeys('s', 'hi'); await tmux.typeLine('s', 'x'); await tmux.sendEscape('s'); await tmux.setHook('s', 'client-attached', 'true')
  await tmux.paneDead('s'); await tmux.paneDeadStatus('s'); await tmux.panePid('s'); await tmux.clientPids('s'); await tmux.killSession('s')
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
  assert.ok(calls.length >= 14, `${calls.length} calls`)
  for (const c of calls) assert.deepEqual(c.slice(0, 2), ['-S', sock], c.join(' '))
  assert.match(fs.readFileSync(new URL('./terminal.ts', import.meta.url), 'utf8'), /pty\.spawn\('tmux', \['-S', socket\(\), 'attach-session'/)
})
test('Bug 242: start-up makes the socket folder as tmux would, and stops on a TMUX_TMPDIR that is gone', () => {
  const uid = process.getuid?.() ?? 0
  assert.throws(() => prepareSocket(path.join(gone, `tmux-${uid}`, 'default')), /tmux folder .*gone \(TMUX_TMPDIR\) doesn't exist/)
  assert.equal(fs.existsSync(gone), false, 'nothing made in its place')
  const here = path.join(root, 'here'); fs.mkdirSync(here)
  prepareSocket(path.join(here, `tmux-${uid}`, 'default'))
  assert.equal(fs.statSync(path.join(here, `tmux-${uid}`)).mode & 0o777, 0o700)
  prepareSocket(path.join(here, `tmux-${uid}`, 'default')) // twice is fine
})

test('pieces: a line comes back whole, in order, no piece longer than asked', () => {
  const line = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
  const got = pieces(line, 250)
  assert.equal(got.join(''), line); assert.ok(got.length > 1); assert.ok(got.every((p) => p.length > 0 && p.length <= 250))
  assert.deepEqual(pieces('short', 250), ['short']); assert.deepEqual(pieces('', 250), [])
  assert.deepEqual(pieces('abcdef', 2), ['ab', 'cd', 'ef']); assert.deepEqual(pieces('abcde', 2), ['ab', 'cd', 'e'])
})
test('pieces: a character made of two halves (an emoji) is never cut in the middle', () => {
  const line = 'ab🙂cd🙂🙂ef'
  for (const max of [1, 2, 3, 4, 5]) {
    const got = pieces(line, max); assert.equal(got.join(''), line, `max ${max}`)
    for (const p of got) assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(p), `max ${max}: "${p}" starts or ends with half a character`)
  }
  assert.deepEqual(pieces('🙂🙂', 1), ['🙂', '🙂']) // one whole character is the least a piece can hold
})
