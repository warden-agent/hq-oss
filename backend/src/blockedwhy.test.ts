// Bug 72: an agent whose turn ended with an API error is `blocked` with `blocked_why` 'api_error'. That's no dialog: the box says what happened,
// and Fresh start and typing into its terminal aren't refused for a dialog that isn't there. Migration 32 gives agents already blocked their reason.
// Bug 218: an agent that leaves `blocked` loses its reason (agents.ts update), and a later migration clears the reasons left on rows from before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentWord, apiErrored, onDialog as pageOnDialog, type Agent as PageAgent } from '../../frontend/src/api.ts'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-blockedwhy-'))
const { migrate, run, q } = await import('./db.ts')
const { onDialog, update, getAgent } = await import('./agents.ts')
const { bus } = await import('./events.ts')
const { freshStartBlocker } = await import('./freshstart.ts')

const agent = (id: string, status: string): void => run("INSERT INTO agents(id, role, model_alias, token_hash, status, started_at) VALUES (?, 'tpm', 'opus', 'h', ?, 0)", id, status)
const notice = (agentId: string, kind: string, resolved: number | null = null): void =>
  run('INSERT INTO needs_attention(id, agent_id, kind, detail, created_at, resolved_at) VALUES (?, ?, ?, ?, 1, ?)', `${agentId}-${kind}`, agentId, kind, kind, resolved)

test('migration 32: an agent already blocked gets its reason; a dialog wins, an API error alone is one, and anything else is left alone', () => {
  migrate(31)
  agent('err', 'blocked'); notice('err', 'api_error')
  agent('both', 'blocked'); notice('both', 'api_error'); notice('both', 'dialog')
  agent('dlg', 'blocked'); notice('dlg', 'dialog')
  agent('old', 'blocked'); notice('old', 'api_error', 5) // that notice was dealt with: assume a dialog, where nothing gets typed
  agent('idle', 'idle'); notice('idle', 'api_error')
  migrate()
  const why = Object.fromEntries(q<{ id: string; blocked_why: string | null }>('SELECT id, blocked_why FROM agents').map((r) => [r.id, r.blocked_why]))
  assert.deepEqual(why, { err: 'api_error', both: 'dialog', dlg: 'dialog', old: 'dialog', idle: null })
})

test('migration for Bug 218: a reason left on an agent that isn\'t blocked goes; a blocked agent keeps its own', () => {
  run('DELETE FROM agents'); run('DELETE FROM needs_attention')
  run("UPDATE meta SET value = '38' WHERE key = 'schema_version'") // the first test ran every migration: replay the last one (39; 37, 38 are Bugs 215, 219)
  for (const [id, status, why] of [['w', 'working', 'api_error'], ['i', 'idle', 'dialog'], ['x', 'exited', 'api_error'], ['b', 'blocked', 'api_error'], ['d', 'blocked', 'dialog']]) {
    agent(id!, status!); run('UPDATE agents SET blocked_why = ? WHERE id = ?', why!, id!)
  }
  migrate(39) // only Bug 218's (39); 40 is Bug 226's
  const why = Object.fromEntries(q<{ id: string; blocked_why: string | null }>('SELECT id, blocked_why FROM agents').map((r) => [r.id, r.blocked_why]))
  assert.deepEqual(why, { w: null, i: null, x: null, b: 'api_error', d: 'dialog' })
})

test('update: a status other than blocked clears the reason; blocked keeps or changes it; no status leaves it', () => {
  const patches: Record<string, unknown>[] = []; const onPatch = (p: { entity: string; patch: Record<string, unknown> }) => { if (p.entity === 'agent') patches.push(p.patch) }
  bus.on('patch', onPatch)
  agent('u', 'working')
  const why = () => getAgent('u')!.blocked_why
  update('u', { status: 'blocked', blocked_why: 'api_error' }); assert.equal(why(), 'api_error')
  update('u', { last_event_at: 5 }); assert.equal(why(), 'api_error', 'a write with no status says nothing about the block')
  update('u', { status: 'blocked', blocked_why: 'dialog' }); assert.equal(why(), 'dialog')
  update('u', { status: 'working' }); assert.equal(why(), null, 'working again')
  assert.equal(patches.at(-1)!.blocked_why, null, 'the page hears it too')
  for (const status of ['idle', 'paused', 'plan_review', 'exited']) {
    update('u', { status: 'blocked', blocked_why: 'api_error' }); update('u', { status }); assert.equal(why(), null, status)
  }
  bus.off('patch', onPatch)
})

const a = (status: string, blocked_why: string | null = null) => ({ id: 'tpm-1', role: 'tpm', status, blocked_why, display_name: 'TPM', fresh_start_at: null }) as never
test('backend: an API error is no dialog; a dialog, a reason not known, and a usage pause still are', () => {
  assert.equal(onDialog(a('blocked', 'api_error')), false)
  for (const [status, why] of [['blocked', 'dialog'], ['blocked', null], ['paused', null]] as const) assert.equal(onDialog(a(status, why)), true, `${status} ${why}`)
  assert.equal(onDialog(a('idle', 'api_error')), false, 'a reason left from before means nothing once it isn\'t blocked')
  assert.equal(freshStartBlocker(a('blocked', 'api_error')), null)
  assert.match(freshStartBlocker(a('blocked', 'dialog')) ?? '', /waiting on a dialog/)
})

const p = (status: string, blocked_why: string | null = null): PageAgent => ({ id: 'e', role: 'engineer', status, blocked_why })
test('page: the box says an API error stopped it, and a dialog is still a dialog', () => {
  assert.equal(agentWord(p('blocked', 'api_error')), 'stopped by an API error')
  assert.equal(agentWord(p('blocked', 'dialog')), 'waiting on a dialog'); assert.equal(agentWord(p('blocked')), 'waiting on a dialog')
  assert.equal(agentWord(p('idle', 'api_error')), 'idle')
  assert.deepEqual([apiErrored(p('blocked', 'api_error')), pageOnDialog(p('blocked', 'api_error'))], [true, false])
  assert.deepEqual([apiErrored(p('blocked', 'dialog')), pageOnDialog(p('blocked', 'dialog')), pageOnDialog(p('paused'))], [false, true, true])
})
