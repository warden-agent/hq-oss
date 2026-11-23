// Bug 308: a Clear's note request, the box and the Events tab all said "fresh start" though no new session followed (a Clear stops the
// engineer; its note goes to the archive). Now each case says what it is, in all three places, against a real SQLite DB in a temp HQ_HOME:
// a fresh start (a new session at once, or at Resume), a switch of projects (the work waits for the user to come back), a Clear.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noteLine, endedLine } from '../../frontend/src/api.ts'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b308-'))
const { migrate, run, one } = await import('./db.ts')
migrate()
const { completeFreshStart, freshStart } = await import('./freshstart.ts')
const { eventLine } = await import('./eventtext.ts')
const { getAgent } = await import('./agents.ts')

const t0 = Date.now()
run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('b308r', 'b308x', '/tmp/b308x', 'local', ?)", t0)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('b308f', 'b308r', 'b308', 'B', 'b', 'planning', ?, ?)", t0, t0)
run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES ('b308t', 'b308f', 'B-1', 'b-1', 'B one', 'implementing', ?, ?)", t0, t0)
/** A running TPM (the project's, no feature: Bug 52) or engineer, asked for nothing yet. */
const agent = (id: string, role: 'tpm' | 'engineer') => {
  run('DELETE FROM agents WHERE id = ?', id)
  run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, token_hash, status, tmux_session, started_at)
    VALUES (?,?,'b308r',?,?,'opus',?,'working','hq-b308-none',?)`, id, role, role === 'tpm' ? null : 'b308f', role === 'tpm' ? null : 'b308t', id, t0)
  return id
}
const ask = (id: string) => one<{ body: string }>("SELECT body FROM messages WHERE to_id = ? AND reason = 'fresh_start' ORDER BY rowid DESC LIMIT 1", id)!.body
const lastLine = (id: string, kind: string) => {
  const e = one<{ payload: string }>('SELECT payload FROM events WHERE agent_id = ? AND kind = ? ORDER BY id DESC LIMIT 1', id, kind)!
  return eventLine(kind, JSON.parse(e.payload) as Record<string, unknown>)
}
const box = (id: string) => noteLine(getAgent(id) as never)

test('Bug 308: a Clear asks for a note in its own words: no "fresh start", and the engineer is told nobody takes over', async () => {
  for (const role of ['engineer', 'tpm'] as const) {
    const id = agent(`b308-${role}-clear`, role)
    await freshStart(id, { how: 'after_turn', then: 'clear' })
    const body = ask(id)
    assert.doesNotMatch(body, /fresh start|clean context/i, role)
    assert.match(body, /^The user is clearing this project/, role)
    assert.match(body, /this session is ending/, role)
    assert.match(body, /Call write_handoff_note once/, role)
    assert.equal(box(id), 'clearing the project · writing its handoff note…', role)
    if (role === 'engineer') {
      assert.match(body, /no new session takes over now/); assert.match(body, /for whoever picks the work up later, under these headings/)
      assert.doesNotMatch(body, /who takes over/)
      assert.equal(lastLine(id, 'fresh_start.requested'), 'Asked for its handoff note: you are clearing the project. Nobody takes over: the note is archived')
    } else {
      assert.match(body, /A new TPM session starts after the clear/); assert.match(body, /for the TPM who takes over/)
      assert.equal(lastLine(id, 'fresh_start.requested'), 'Asked for its handoff note: you are clearing the project. A new TPM takes over from it after the clear')
    }
    run("UPDATE agents SET status = 'exited' WHERE id = ?", id) // its session ended: completeFreshStart stops nothing (no tmux here)
    await completeFreshStart(id, 'note')
    assert.equal(getAgent(id)!.ended_why, 'cleared')
    assert.equal(lastLine(id, 'fresh_start.done'), role === 'engineer' ? 'Its session ended: the project is being cleared. Nobody takes over: its note is archived'
      : 'Its session ended: the project is being cleared. A new TPM takes over from its note after the clear')
  }
})

test('Bug 308: switching projects asks for a note that waits for the user to come back, says so everywhere, and parks the work', async () => {
  run("DELETE FROM agents WHERE repo_id = 'b308r'"); run("UPDATE tickets SET parked_at = NULL WHERE id = 'b308t'")
  const eng = agent('b308-eng-switch', 'engineer'), tpm = agent('b308-tpm-switch', 'tpm')
  // parkRepo asks with how 'now' (typed into a terminal; there is none here): e2e/freshstart.test.ts checks it asks with 'switch'
  for (const id of [eng, tpm]) {
    await freshStart(id, { how: 'after_turn', then: 'switch' })
    const body = ask(id)
    assert.doesNotMatch(body, /fresh start|clean context/i)
    assert.match(body, /The user switched to another project in HQ: this session is ending, and a new one takes over from your note when they come back to this one\./)
    assert.equal(box(id), 'you switched projects · writing its handoff note…')
    assert.equal(lastLine(id, 'fresh_start.requested'), 'Asked for its handoff note: you switched to another project. A new session takes over from it when you come back')
    run("UPDATE agents SET status = 'exited' WHERE id = ?", id)
    await completeFreshStart(id, 'note')
    assert.equal(lastLine(id, 'fresh_start.done'), 'Its session ended: you switched to another project. Its work waits until you come back')
    const a = getAgent(id)!
    assert.equal(a.ended_why, 'parked')
    assert.match(endedLine(a as never, { agents: [a as never] }, a.ended_at ?? Date.now())!, /^stopped: its work was parked/)
  }
  assert.ok(one<{ parked_at: number | null }>("SELECT parked_at FROM tickets WHERE id = 'b308t'")!.parked_at, 'the ticket waits for Resume')
  assert.ok(one<{ tpm_parked_at: number | null }>("SELECT tpm_parked_at FROM repos WHERE id = 'b308r'")!.tpm_parked_at, 'the TPM waits too')
})

test('Bug 308, what must not change: a real fresh start still says fresh start, at once or at Resume', async () => {
  for (const then of ['continue', 'park'] as const) {
    const id = agent(`b308-eng-${then}`, 'engineer')
    await freshStart(id, { how: 'after_turn', then })
    const body = ask(id)
    assert.match(body, then === 'park'
      ? /^Fresh start: this session is ending so that a new one can take over with a clean context when the user presses Resume\. Stop what you are doing now\./
      : /^Fresh start: this session is ending so that a new one can take over with a clean context\. Stop what you are doing now\./)
    assert.match(body, /for the engineer who takes over, under these headings/)
    assert.equal(box(id), 'fresh start · writing its handoff note…')
    assert.equal(lastLine(id, 'fresh_start.requested'),
      `Asked for its handoff note: a fresh start. A new session takes over from it${then === 'park' ? ' when you press Resume' : ''}`)
  }
  // the done lines, from the payloads completeFreshStart writes (a 'continue' one starts a real session, so it isn't run here)
  assert.equal(eventLine('fresh_start.done', { by: 'note', then: 'continue', role: 'engineer' }), 'Its session ended: a fresh start. A new session takes over from its note')
  assert.equal(eventLine('fresh_start.done', { by: 'note', then: 'park', role: 'tpm' }), 'Its session ended: a fresh start. Its work waits until you press Resume')
  // rows from before Bug 308 (no role; a switch was saved as 'park') still read sensibly
  assert.equal(eventLine('fresh_start.requested', { how: 'now', then: 'clear' }),
    "Asked for its handoff note: you are clearing the project. An engineer's note is archived; a TPM's is read by the new TPM after the clear")
  assert.equal(eventLine('fresh_start.done', { by: 'fallback', then: 'clear' }), 'Its session ended: the project is being cleared. Its note is archived')
  assert.equal(noteLine({ id: 'x', role: 'engineer', status: 'working', fresh_start_at: 5, fresh_start_then: null }), 'fresh start · writing its handoff note…')
  assert.equal(noteLine({ id: 'x', role: 'engineer', status: 'exited', fresh_start_at: 5, fresh_start_then: 'clear' }), null)
})
