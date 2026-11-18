// Bug 183: an urgent message is typed into the agent's terminal in the same small pieces as any typed batch (tmux.ts typeLine). Sent with one
// `send-keys`, 2,385 characters reached a real 2.1.322 TPM as its last 341: Claude Code took the rest for a paste and lost it.
// Real SQLite in a temp HQ_HOME; a stand-in tmux on PATH that writes down every call and shows an empty prompt, so no real tmux is ever called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-urgenttyped-'))
process.env.HQ_HOME = path.join(root, 'hq')
const bin = path.join(root, 'bin'), log = path.join(root, 'tmux.log'); fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
const { migrate, run, one } = await import('./db.ts'); migrate()
const { interruptAndType, sendMessage } = await import('./delivery.ts')
const { getAgent } = await import('./agents.ts')

run(`INSERT INTO agents(id, role, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at)
  VALUES ('tpm-1', 'tpm', 'haiku', 'hq-urgenttyped-1', ?, 'x', 'idle', 0, ?)`, root, Date.now())
const { socket } = await import('./tmux.ts')
/** The calls without the socket each names first (Bug 242). */
const calls = (): string[][] => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((c: string[]) => {
  assert.deepEqual(c.slice(0, 2), ['-S', socket()]); return c.slice(2)
})

test('an urgent message of 2,000+ characters goes in after the Escape in pieces of at most 250, whole and in order, then Enter', async () => {
  const body = `Urgent check. ${Array.from({ length: 450 }, (_, i) => `w${i} 🙂`).join(' ')} FINAL-MARKER`
  assert.ok(body.length > 2000)
  const m = sendMessage({ channel: 'dm', from: 'user', to: 'tpm-1', reason: 'urgent', body })
  await interruptAndType(getAgent('tpm-1')!, m)
  const keys = calls().filter((c) => c[0] === 'send-keys')
  assert.deepEqual(keys[0], ['send-keys', '-t', 'hq-urgenttyped-1', 'Escape'])
  const typed = keys.slice(1, -1)
  assert.ok(typed.length >= 9, `${typed.length} pieces`)
  for (const c of typed) { assert.deepEqual(c.slice(0, 5), ['send-keys', '-t', 'hq-urgenttyped-1', '-l', '--']); assert.ok(c[5]!.length <= 250, `${c[5]!.length} characters`) }
  assert.equal(typed.map((c) => c[5]).join(''), body)
  assert.deepEqual(keys.at(-1), ['send-keys', '-t', 'hq-urgenttyped-1', 'Enter'])
  assert.ok(one<{ ack_at: number | null }>('SELECT ack_at FROM messages WHERE id = ?', m.id)!.ack_at, 'marked delivered')
})
