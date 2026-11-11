// The DM limits (Bug 86), against a real SQLite DB in a temp HQ_HOME: they count only agent-to-agent messages, and a message
// that passes on what the user just told the agent is never held back. Also what they must still catch: chatter between agents.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-dm-'))
const { migrate, run, now } = await import('./db.ts')
migrate()
const { dmAllowed, recordReply, sendMessage } = await import('./delivery.ts')
type Agent = Parameters<typeof dmAllowed>[0]

const tpm = { id: 'tpm-1', role: 'tpm', repo_id: null, feature_id: null } as unknown as Agent
const dm = (from: string, to: string, reason = 'fyi') => sendMessage({ channel: 'dm', from, to, reason, body: `${reason} from ${from}` })
const userSays = (body = 'Please carry on.') => sendMessage({ channel: 'dm', from: 'user', to: tpm.id, reason: 'fyi', body })
const allowed = (to: string, reason = 'fyi') => dmAllowed(tpm, to, reason)
const ago = (id: string, ms: number) => run('UPDATE messages SET created_at = ? WHERE id = ?', now() - ms, id)
const MIN = 60_000
beforeEach(() => { run('DELETE FROM messages'); run('DELETE FROM settings') })

test('the TPM\'s replies to the user and its messages to the user don\'t count against the hourly cap (Bug 86)', () => {
  for (let i = 0; i < 5; i++) recordReply(tpm, `Reply ${i}`)
  dm(tpm.id, 'user', 'blocker') // what it tells the user through send_message
  dm(tpm.id, 'eng-1', 'answer'); const answered = dm(tpm.id, 'eng-1', 'answer'); ago(answered.id, 6 * MIN)
  assert.deepEqual(allowed('eng-2'), { ok: true }, 'two agent-to-agent DMs in the hour, not eight')
})

test('the Bug 86 run: answered a blocker 55 s ago, then the user says "carry on" and the TPM tells the engineer', () => {
  const a = dm(tpm.id, 'eng-1', 'answer'); ago(a.id, 55_000)
  assert.match(allowed('eng-1').why ?? '', /one per 5 min/, 'chatter is still held back by the window')
  userSays('HQ is back, please carry on.')
  assert.deepEqual(allowed('eng-1'), { ok: true }, 'passing on what the user said gets through the window')
})

test('passing on the user\'s words gets through the hourly cap too, and doesn\'t count toward it', () => {
  run("INSERT INTO settings(key, value) VALUES ('dm_per_hour', '3')")
  for (const e of ['eng-1', 'eng-2', 'eng-3']) dm(tpm.id, e, 'answer')
  assert.match(allowed('eng-4').why ?? '', /3 per hour/)
  userSays('Tell everyone: blue buttons.')
  for (const e of ['eng-1', 'eng-2', 'eng-3', 'eng-4']) { assert.deepEqual(allowed(e), { ok: true }, e); dm(tpm.id, e) }
  assert.match(allowed('eng-1').why ?? '', /3 per hour/, 'eng-1 has had it: the three answers still count')
  run("UPDATE settings SET value = '4' WHERE key = 'dm_per_hour'"); assert.deepEqual(allowed('eng-1', 'blocker'), { ok: true }, 'the relayed four don\'t')
})

test('one message of the user\'s frees one DM per recipient, not a stream of them', () => {
  dm(tpm.id, 'eng-1'); userSays()
  assert.deepEqual(allowed('eng-1'), { ok: true }); dm(tpm.id, 'eng-1')
  assert.match(allowed('eng-1').why ?? '', /one per 5 min/, 'the next one is chatter again')
  userSays('One more thing.'); assert.deepEqual(allowed('eng-1'), { ok: true })
})

test('an old message of the user\'s isn\'t what the TPM passes on', () => {
  const u = userSays(); ago(u.id, 61 * MIN)
  run("INSERT INTO settings(key, value) VALUES ('dm_per_hour', '1')")
  dm(tpm.id, 'eng-2', 'answer')
  assert.match(allowed('eng-1').why ?? '', /1 per hour/)
})

test('what the user said to another agent frees nothing for this one; engineers\' chatter is still capped', () => {
  sendMessage({ channel: 'dm', from: 'user', to: 'tpm-2', reason: 'fyi', body: 'Hi.' })
  dm(tpm.id, 'eng-1'); assert.match(allowed('eng-1').why ?? '', /one per 5 min/)
  const eng = { ...tpm, id: 'eng-1', role: 'engineer' } as Agent
  dm('eng-1', tpm.id); assert.match(dmAllowed(eng, tpm.id, 'fyi').why ?? '', /one per 5 min/)
  assert.deepEqual(dmAllowed(eng, tpm.id, 'blocker'), { ok: true }, 'a blocker still gets through the window')
})
