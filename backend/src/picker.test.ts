// Folder picker: osascript result parsing and one-dialog-at-a-time, with a fake runner (no real dialog).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePick, pickFolder } from './picker.ts'

const fail = (stderr: string, killed = false): [Error & { killed: boolean }, string, string] => [Object.assign(new Error('Command failed: osascript'), { killed }), '', stderr]

test('parsePick', () => {
  assert.equal(parsePick(null, '/Users/me/projects/spike-repo/\n', ''), '/Users/me/projects/spike-repo')
  assert.equal(parsePick(null, '/\n', ''), '/')
  assert.equal(parsePick(...fail('36:138: execution error: User canceled. (-128)\n')), null)
  assert.throws(() => parsePick(...fail('', true)), /timed out/)
  assert.throws(() => parsePick(...fail('0:5: syntax error: nope (-2741)\n')), /folder picker failed: 0:5: syntax error: nope/)
})

test('one dialog at a time', async () => {
  let calls = 0; let done!: (p: string | null) => void
  const slow = () => { calls++; return new Promise<string | null>((r) => { done = r }) }
  const a = pickFolder('/x', slow); const b = pickFolder('/y', slow)
  done('/picked'); assert.deepEqual(await Promise.all([a, b]), ['/picked', '/picked']); assert.equal(calls, 1)
  assert.equal(await pickFolder('/z', async () => { calls++; return null }), null); assert.equal(calls, 2) // next click opens a new dialog
})
