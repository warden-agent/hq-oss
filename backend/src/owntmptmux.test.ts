// Bug 199: a test run (scripts/own-tmp.mjs) gets a tmux folder of its own, so a tmux call in a test that names no socket never
// reaches the user's live server, and the server the run started there is stopped when the run ends. The child here only starts a
// server by an explicit -S inside the folder it was given, so even without the fix nothing reaches the default server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const OWN_TMP = path.resolve(import.meta.dirname, '../../scripts/own-tmp.mjs')
const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false } })()

test('Bug 199: a run gets its own TMUX_TMPDIR (and no TMUX), and the tmux server it starts there is gone when it ends', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-owntmp-')), 'env.json')
  const child = `
    const fs = require('node:fs'), { execFileSync } = require('node:child_process'), e = process.env, uid = process.getuid()
    const sock = e.TMUX_TMPDIR && e.TMUX_TMPDIR.startsWith(e.HQ_SHORT_TMPDIR) ? e.TMUX_TMPDIR + '/tmux-' + uid + '/default' : null
    if (sock && ${hasTmux}) { fs.mkdirSync(e.TMUX_TMPDIR + '/tmux-' + uid, { recursive: true, mode: 0o700 })
      execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-s', 'owntmp', 'sleep 120']) }
    const pid = sock && ${hasTmux} ? Number(execFileSync('tmux', ['-S', sock, 'display', '-p', '#{pid}'], { encoding: 'utf8' })) : 0
    fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ tmuxTmpdir: e.TMUX_TMPDIR ?? null, short: e.HQ_SHORT_TMPDIR, tmux: e.TMUX ?? null, pane: e.TMUX_PANE ?? null, sock, pid }))`
  execFileSync(process.execPath, [OWN_TMP, process.execPath, '-e', child], { env: { ...process.env, TMUX: '/private/tmp/tmux-0/default,1,0', TMUX_PANE: '%1' }, stdio: 'ignore' })
  const got = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(path.dirname(out), { recursive: true, force: true })
  assert.ok(!hasTmux || got.pid > 0, "a tmux server ran there"); assert.equal(got.tmuxTmpdir, got.short, "the run's short folder")
  assert.equal(got.tmux, null); assert.equal(got.pane, null) // inside tmux these would win over TMUX_TMPDIR
  assert.equal(fs.existsSync(got.short), false, 'the folder is gone')
  const alive = () => { try { process.kill(got.pid, 0); return true } catch { return false } }
  for (const end = Date.now() + 3000; got.pid && alive() && Date.now() < end;) execFileSync('sleep', ['0.1'])
  if (got.pid) assert.equal(alive(), false, "the run's tmux server is stopped")
})
