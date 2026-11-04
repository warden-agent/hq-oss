// Bug 61: an alert goes once the user has dealt with it. Against a real SQLite DB in a temp HQ_HOME: the user's message to an agent
// clears what that agent told them or is blocked on, nobody else's message does, and a new session inherits the open notice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-notices-'))
const { migrate, run } = await import('./db.ts')
migrate()
const { attention, openAttention } = await import('./attention.ts')
const { sendMessage } = await import('./delivery.ts')
const { handOver } = await import('./tpm.ts')

const agent = (id: string, role: string) => run('INSERT INTO agents(id, role, model_alias, token_hash, started_at) VALUES (?,?,?,?,?)', id, role, 'opus', 'x', 1)
for (const [id, role] of [['tpm-1', 'tpm'], ['eng-1', 'engineer'], ['eng-2', 'engineer']] as const) agent(id, role)
const open = () => openAttention().map((a) => `${a.kind} ${a.agent_id}`).sort()
const toUser = (from: string, body: string) => sendMessage({ channel: 'dm', from, to: 'user', reason: 'fyi', body })
const dm = (from: string, to: string, body = 'ok') => sendMessage({ channel: 'dm', from, to, reason: 'fyi', body })
const clearAll = () => run('UPDATE needs_attention SET resolved_at = 1 WHERE resolved_at IS NULL')

test('the user\'s reply clears what that agent told them and what it\'s blocked on, and nothing else', () => {
  clearAll(); toUser('eng-1', 'done?'); toUser('eng-2', 'also done?')
  attention('blocked', 'eng-1: needs a key', { agentId: 'eng-1', ticketId: 't1' }); attention('dialog', 'eng-1: allow this?', { agentId: 'eng-1', ticketId: 't1' })
  dm('user', 'eng-1')
  assert.deepEqual(open(), ['dialog eng-1', 'message_for_user eng-2']) // a dialog takes the terminal: a message doesn't answer it
})

test('HQ\'s notices and the TPM\'s messages clear nothing', () => {
  clearAll(); toUser('eng-1', 'done?'); attention('blocked', 'eng-1: needs a key', { agentId: 'eng-1', ticketId: 't1' })
  dm('hq', 'eng-1'); dm('tpm-1', 'eng-1'); dm('eng-2', 'eng-1')
  assert.deepEqual(open(), ['blocked eng-1', 'message_for_user eng-1'])
})

test('a new message alerts again after a reply, even in the same words', () => {
  clearAll(); toUser('eng-1', 'done?'); const first = openAttention()[0]!.id
  dm('user', 'eng-1'); assert.deepEqual(open(), [])
  toUser('eng-1', 'done?'); assert.deepEqual(open(), ['message_for_user eng-1']); assert.notEqual(openAttention()[0]!.id, first)
})

test('a new session inherits what the old one told the user, so a reply to it clears; nothing else moves', () => {
  clearAll(); agent('tpm-2', 'tpm'); toUser('tpm-1', 'which one?')
  attention('dialog', 'tpm: allow this?', { agentId: 'tpm-1' }); attention('stuck', 'tpm: quiet', { agentId: 'tpm-1' })
  handOver('tpm-1', 'tpm-2')
  assert.deepEqual(open(), ['dialog tpm-1', 'message_for_user tpm-2', 'stuck tpm-1'])
  dm('user', 'tpm-2'); assert.deepEqual(open(), ['dialog tpm-1', 'stuck tpm-1'])
})

test('a notice already dealt with stays with the old session', () => {
  clearAll(); agent('eng-3', 'engineer'); toUser('eng-1', 'done?'); clearAll(); toUser('eng-2', 'mine')
  handOver('eng-1', 'eng-3'); assert.deepEqual(open(), ['message_for_user eng-2'])
})
