// Claude Code's own session status file (Bug 62, presence.ts): found by session id, and anything odd reads as "don't know", never as "the dialog is gone".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { presenceOf } = await import('./presence.ts')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-presence-'))
const put = (name: string, body: unknown) => fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))

test('presenceOf: the file with this session id, as 2.1.300 writes it', () => {
  put('101.json', { pid: 101, sessionId: 'other', status: 'idle', statusUpdatedAt: 5 })
  put('102.json', { pid: 102, sessionId: 'mine', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 7, kind: 'interactive' })
  put('102.abc.key', 'not json'); put('103.json', '{ half written')
  assert.deepEqual(presenceOf('mine', dir), { pid: 102, sessionId: 'mine', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 7, kind: 'interactive' })
})

test('presenceOf: no session, no file, no folder, or a file without a status and a time all read as unknown', () => {
  assert.equal(presenceOf(null, dir), null); assert.equal(presenceOf('nobody', dir), null); assert.equal(presenceOf('mine', path.join(dir, 'missing')), null)
  put('104.json', { pid: 104, sessionId: 'old-format', state: 'idle' }); assert.equal(presenceOf('old-format', dir), null)
})
