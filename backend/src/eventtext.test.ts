// Bug 121: the Events tab's lines. Against a real SQLite DB in a temp HQ_HOME: an agent's history comes back newest first, in plain words,
// with HQ's chatter (mod polls, the other half of a tool call, a page opening its terminal) left out before the limit, not after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-eventtext-'))
const { migrate, run } = await import('./db.ts')
migrate()
const { emit } = await import('./events.ts')
const { agentEvents, eventLine, field, lineOwner } = await import('./eventtext.ts')

const agent = (id: string, role: string, name: string) =>
  run('INSERT INTO agents(id, role, model_alias, token_hash, started_at, display_name) VALUES (?,?,?,?,?,?)', id, role, 'opus', 'x', 1, name)
agent('tpm-1', 'tpm', 'TPM'); agent('eng-1', 'engineer', 'eng PAY-1'); agent('eng-2', 'engineer', 'eng PAY-2')
const hook = (agentId: string, kind: string, payload: Record<string, unknown>) => emit({ agentId, source: 'hook', kind, payload })

test('a cut-off tool input still gives its command or file', () => {
  const cmd = JSON.stringify({ command: 'python3 -m unittest tests/test_x.py -v && echo "done"', description: 'x'.repeat(400) }).slice(0, 120) + '…'
  assert.equal(field(cmd, 'command'), 'python3 -m unittest tests/test_x.py -v && echo "done"')
  const cut = JSON.stringify({ command: 'echo ' + 'a'.repeat(400) }).slice(0, 300) + '…' // cut inside the command itself
  assert.match(field(cut, 'command'), /^echo a+…$/) // still says it's cut
  assert.equal(field('{"file_path":"/w/src/a\\', 'file_path'), '/w/src/a…') // cut in the middle of an escape
  assert.equal(field('{"file_path":"C:\\\\w\\\\a.py"}', 'file_path'), 'C:\\w\\a.py') // whole escapes are read
  assert.equal(field('not json', 'command'), '')
  assert.equal(eventLine('hook.PreToolUse:Read', { input: '{"file_path":"/Users/x/repo/src/parser.py"}' }), 'Read src/parser.py')
  assert.equal(eventLine('hook.PreToolUse:Bash', { input: cmd, sub: true }), 'Helper · Command: python3 -m unittest tests/test_x.py -v && echo "done"')
})

test('what the tab leaves out: the other half of a tool call, HQ\'s plumbing, a page opening the terminal', () => {
  for (const k of ['hook.PostToolUse:Bash', 'mod.turn.step', 'mod.poll_error', 'mcp.update_handoff', 'tmux.attached', 'tmux.detached', 'batch.handed', 'hook.ConfigChange'])
    assert.equal(eventLine(k, {}), null, k)
  // and what it must not leave out: a failed tool call is not the other half of one, and an unknown kind shows by name
  assert.equal(eventLine('hook.PostToolUseFailure:Bash', { error: 'Exit code 1\nFAILED (failures=2)' }), 'Bash failed: Exit code 1 FAILED (failures=2)')
  assert.equal(eventLine('hook.PreToolUse:mcp__hq__update_handoff', {}), 'Asked HQ: update handoff')
  assert.equal(eventLine('some.new_kind', {}), 'some.new_kind')
  assert.equal(eventLine('hook.PermissionRequest:Bash', {}), null) // HQ answers it: the tool call itself is the line
  assert.equal(eventLine('hook.PreToolUse:Bash', { input: '{"command":"cd \\"/w/my repo/.claude/worktrees/A-1\\" && npm test"}' }), 'Command: npm test')
  assert.equal(eventLine('hook.UserPromptSubmit', { prompt: 'HQ message batch B-1a:\n[fyi] from HQ [msg msg-9f]: HQ: A-1 merged.' }), 'Messages: [fyi] from HQ: HQ: A-1 merged.')
  assert.equal(eventLine('gate.verdict', { verdict: 'approve', by: 'auto' }), 'Plan approved by HQ')
  assert.equal(eventLine('attention.context_high', { detail: 'eng A-1 is at 114k of context' }), 'Alert: eng A-1 is at 114k of context')
  assert.equal(eventLine('agent.recovered', {}), 'Its terminal is back')
})

test('an agent\'s history: newest first, its own lines only, named as on the board, chatter dropped before the limit', () => {
  run('PRAGMA foreign_keys = OFF') // a ticket with no feature or repo: only its key is read
  run('INSERT INTO tickets(id, feature_id, key, slug, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'tkt-1', 'f-1', 'PAY-1', 'pay-1', 'Payments', 1, 1)
  emit({ agentId: 'eng-1', source: 'system', kind: 'ticket.launched', payload: { ticket: 'tkt-1', fix: false } })
  hook('eng-1', 'hook.UserPromptSubmit', { prompt: 'Work on PAY-1' })
  hook('eng-1', 'hook.PreToolUse:Bash', { input: '{"command":"python3 -m unittest"}' })
  hook('eng-2', 'hook.PreToolUse:Bash', { input: '{"command":"npm test"}' }) // someone else's
  for (let i = 0; i < 50; i++) { hook('eng-1', 'mod.turn.step', {}); hook('eng-1', 'hook.PostToolUse:Bash', {}) } // a busy agent's noise
  hook('eng-1', 'tmux.attached', { external: false }) // the user opening its Agent tab
  emit({ agentId: 'eng-1', source: 'system', kind: 'message.sent', payload: { to: 'tpm-1' } })
  const got = agentEvents('eng-1', 4)
  assert.deepEqual(got.map((e) => e.text), ['Sent a message to TPM', 'Command: python3 -m unittest', 'Got a prompt: Work on PAY-1', 'Started on PAY-1'])
  assert.ok(got.every((e) => e.agentId === 'eng-1' && e.id > 0))
  assert.ok(got[0]!.id > got[1]!.id, 'newest first, by row id')
  assert.deepEqual(agentEvents('nobody'), [])
})

test('emit gives each event its row id (the tab joins history and live lines by it)', () => {
  const a = emit({ agentId: 'eng-1', source: 'system', kind: 'agent.interrupted', payload: {} }), b = emit({ agentId: 'eng-1', source: 'system', kind: 'agent.lost', payload: {} })
  assert.ok(typeof a.id === 'number' && b.id === a.id + 1)
  assert.equal(agentEvents('eng-1', 1)[0]!.id, b.id)
})

test('HQ\'s own events about a ticket (no agent) go to the ticket\'s engineer: its test run, a refused merge; another ticket\'s don\'t', () => {
  run('UPDATE agents SET ticket_id = ? WHERE id = ?', 'tkt-1', 'eng-1'); run('UPDATE tickets SET assignee_agent_id = ? WHERE id = ?', 'eng-1', 'tkt-1')
  emit({ agentId: null, source: 'system', kind: 'auto.tested', payload: { ticket: 'tkt-1', key: 'PAY-1', result: 'fail', test: 'npm test' } })
  emit({ agentId: null, source: 'ui', kind: 'ticket.merge_refused', payload: { ticket: 'tkt-1', key: 'PAY-1', why: 'conflicts with main in a.py' } })
  emit({ agentId: null, source: 'system', kind: 'auto.tested', payload: { ticket: 'tkt-2', key: 'PAY-2', result: 'pass' } })
  emit({ agentId: null, source: 'system', kind: 'worktree.removed', payload: { ticket: 'PAY-1', path: '/x' } }) // a key, not a ticket id: not matched
  assert.deepEqual(agentEvents('eng-1', 2).map((e) => e.text), ["HQ didn't merge PAY-1: conflicts with main in a.py", 'HQ tested PAY-1 before merging: the tests fail'])
  assert.ok(agentEvents('eng-1', 2).every((e) => e.agentId === 'eng-1'))
  assert.ok(!agentEvents('eng-2').some((e) => e.text.includes('PAY-1 before merging')) && !agentEvents('tpm-1').some((e) => e.text.includes('PAY')))
  assert.equal(lineOwner(null, { ticket: 'tkt-1' }), 'eng-1') // the live feed sends it to the same tab
  assert.equal(lineOwner(null, { ticket: 'PAY-1' }), null); assert.equal(lineOwner('tpm-1', { ticket: 'tkt-1' }), 'tpm-1')
})
