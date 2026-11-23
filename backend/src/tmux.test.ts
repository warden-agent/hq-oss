// How HQ cuts a line it types into an agent's terminal (Bug 110): Claude Code takes more than 800 characters arriving at once for a paste.
// Bug 242: which tmux server HQ talks to, named in every call. A stand-in tmux on PATH writes the calls down, so no real tmux is called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as tmux from './tmux.ts'
import { closeUpDead, deadPaneCode, pieces, prepareSocket, socketPath } from './tmux.ts'

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

// What the real tmux prints for a dead pane (asked on 2026-11-19: tmux 3.8 on the Mac, tmux 3.6 in the Linux CI image).
test('Bug 320: a pane ended by a signal is 128 plus that signal, whether tmux names it (3.8) or gives its number (3.6)', () => {
  assert.equal(deadPaneCode('1::kill'), 137); assert.equal(deadPaneCode('1::9'), 137) // was 128 with the number: "stopped with code 128"
  assert.equal(deadPaneCode('1::term'), 143); assert.equal(deadPaneCode('1::15'), 143)
  assert.equal(deadPaneCode('1::hup'), 129); assert.equal(deadPaneCode('1::1'), 129)
  assert.equal(deadPaneCode('1::SIGKILL\n'), 137)
  assert.equal(deadPaneCode('1:3:'), 3); assert.equal(deadPaneCode('1:0:'), 0) // it ended by itself: its own code
  assert.equal(deadPaneCode('1:1:9'), 1) // a code of its own comes first, as before
  assert.equal(deadPaneCode('1::'), 128); assert.equal(deadPaneCode('1::nosuchsignal'), 128) // dead and tmux can't say how: as before
  assert.equal(deadPaneCode('0::'), null); assert.equal(deadPaneCode(''), null); assert.equal(deadPaneCode('::'), null) // running, or no such session
})
// What `capture-pane -p` gave for a dead 50-row pane on tmux 3.8 (2026-11-20): the output at the top, tmux's line on the bottom row.
test('Bug 302: a dead pane\'s output comes with tmux\'s line right under it, not after a screenful of blank lines', () => {
  const dead = 'HQ preview: node quick.js\nline 1\n\nline 2\nstopped (3)\n' + '\n'.repeat(44) + 'Pane is dead (status 3, Fri Nov 20 16:56:05 2026)\n'
  assert.equal(closeUpDead(dead), 'HQ preview: node quick.js\nline 1\n\nline 2\nstopped (3)\nPane is dead (status 3, Fri Nov 20 16:56:05 2026)') // its own blank line stays
  assert.equal(closeUpDead(dead).split('\n').slice(-40).length, 6) // the helper's last 40 lines: all of it
  const styled = '\x1b[31mboom\x1b[39m\n\x1b[0m\n   \n\x1b[0mPane is dead (signal kill, x)\x1b[0m\n'
  assert.equal(closeUpDead(styled), '\x1b[31mboom\x1b[39m\n\x1b[0mPane is dead (signal kill, x)\x1b[0m')
  assert.equal(closeUpDead('\n\n\nPane is dead (status 0, x)'), 'Pane is dead (status 0, x)') // it printed nothing
  assert.equal(closeUpDead('ok\n\n\x1b[0mPane is dead (status 1, x)\n\x1b[0m\n\x1b[39m'), 'ok\n\x1b[0mPane is dead (status 1, x)') // styles on blank rows under it
  // what it must leave alone: a running app's blank lines in its output, and an app that prints those words itself mid-way
  assert.equal(closeUpDead('up on :3000\n\n\nGET /\n\n\n\n'), 'up on :3000\n\n\nGET /')
  assert.equal(closeUpDead('Pane is dead (status 1, x)\n\n\nstill here\n'), 'Pane is dead (status 1, x)\n\n\nstill here')
  assert.equal(closeUpDead('a\n\n  Pane is dead, said the app'), 'a\n\n  Pane is dead, said the app')
  assert.equal(closeUpDead(''), '')
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
