// Bug 342: the live HQ runs inside tmux (session hq-backend), so $TMUX is set in its env. tmux refuses an attach whose client has
// $TMUX set and whose tty has the name of a pane on that server ("sessions should be nested with care, unset $TMUX to force"). A pane
// that ended (remain-on-exit: a crashed app, an agent that exited) keeps its tty's name, and the system hands that name to the next
// terminal opened, which is often the one HQ opens for a terminal view. Test runs drop $TMUX (scripts/own-tmp.mjs); this one puts it back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false } })()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-term-')), sock = path.join(root, 's')
process.env.HQ_HOME = path.join(root, 'hq'); process.env.TMUX = `${sock},1,0`; process.env.TMUX_PANE = '%0'
const { migrate } = await import('./db.ts'); migrate()
const { openPreviewTerminal, attachEnv } = await import('./terminal.ts')
const { tmux, socket } = await import('./tmux.ts')

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  for (const end = Date.now() + ms; !(await ok());) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)) }
}

test('Bug 342: a terminal view drops $TMUX and $TMUX_PANE and keeps the rest', () => {
  const env = attachEnv({ TMUX: '/private/tmp/tmux-501/default,9,0', TMUX_PANE: '%3', HOME: '/h', PATH: '/bin', TERM: 'screen' })
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin', TERM: 'xterm-256color' })
})

test('Bug 342: inside tmux, a view opens even when its tty has the name of a pane that ended', { skip: !hasTmux && 'no tmux' }, async (t) => {
  t.after(() => { try { execFileSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' }) } catch {}; fs.rmSync(root, { recursive: true, force: true }) })
  assert.equal(socket(), sock, 'HQ inside tmux uses the server it runs on')
  // Apps that crashed: each held its own tty while it ran, and all of them are free again once they end.
  for (let i = 0; i < 12; i++) await tmux('new-session', '-d', '-s', `b342dead${i}`, 'sleep 1; exit 3', ';', 'set-option', '-t', `b342dead${i}`, 'remain-on-exit', 'on')
  await tmux('new-session', '-d', '-s', 'b342app', 'echo b342 app is up; exec sleep 600')
  const panes = async () => (await tmux('list-panes', '-a', '-F', '#{pane_dead} #{pane_tty}')).trim().split('\n')
  await until('the 12 apps to end', async () => (await panes()).filter((l) => l.startsWith('1 ')).length === 12)
  const deadTtys = new Set((await panes()).filter((l) => l.startsWith('1 ')).map((l) => l.slice(2)))
  const clients = async () => (await tmux('list-clients', '-t', 'b342app', '-F', '#{client_tty}').catch(() => '')).trim()
  let reused = 0
  for (let i = 0; i < 5; i++) {
    let out = '', ended = false
    const view = openPreviewTerminal('b342app', 80, 24, (d) => { out += d }, () => { ended = true })
    await until('the view to show the app or end', () => /b342 app is up/.test(out) || ended)
    assert.doesNotMatch(out, /nested with care/); assert.match(out, /b342 app is up/); assert.equal(ended, false)
    if (deadTtys.has(await clients())) reused++
    view.kill(); await until('the view to close', async () => (await clients()) === '')
  }
  assert.ok(reused > 0, `no view got a tty an ended pane had (${[...deadTtys].join(' ')}): this test showed nothing`)
})
