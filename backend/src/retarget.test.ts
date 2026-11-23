// Bug 338: a Clear while an agent was already writing its handoff note for a Fresh start only changed `fresh_start_then`. The request in
// its terminal still said "Fresh start", so a TPM wrote the in-flight headings, not a Clear's. retarget (freshstart.ts) now gives it the
// request in the new words: rewritten when not handed out yet, a new one that replaces it when it is. Against a real SQLite DB in a temp
// HQ_HOME; typing into a terminal is e2e/retarget.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noteLine } from '../../frontend/src/api.ts'
import { deliveryMark } from '../../frontend/src/msgmark.ts'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b338-'))
const { migrate, run, one, q } = await import('./db.ts')
migrate()
const { freshStart, retarget } = await import('./freshstart.ts')
const { nextBatchFor } = await import('./delivery.ts')
const { eventLine } = await import('./eventtext.ts')
const { getAgent } = await import('./agents.ts')
const { saveNote } = await import('./notes.ts')

const t0 = Date.now()
run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('b338r', 'b338x', '/tmp/b338x', 'local', ?)", t0)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('b338f', 'b338r', 'b338', 'B', 'b', 'planning', ?, ?)", t0, t0)
run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES ('b338t', 'b338f', 'B-1', 'b-1', 'B one', 'implementing', ?, ?)", t0, t0)
/** A running TPM (the project's, no feature: Bug 52) or engineer, asked for nothing yet. */
const agent = (id: string, role: 'tpm' | 'engineer') => {
  run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, token_hash, status, tmux_session, started_at)
    VALUES (?,?,'b338r',?,?,'opus',?,'working','hq-b338-none',?)`, id, role, role === 'tpm' ? null : 'b338f', role === 'tpm' ? null : 'b338t', id, t0)
  return id
}
type Row = { id: string; to_id: string | null; body: string; delivered_at: number | null; delivery_method: string | null; ack_at: number | null; dropped_why: string | null }
const asks = (id: string) => q<Row>("SELECT * FROM messages WHERE to_id = ? AND reason = 'fresh_start' ORDER BY rowid", id)
const requested = (id: string) => q<{ payload: string }>("SELECT payload FROM events WHERE agent_id = ? AND kind = 'fresh_start.requested' ORDER BY id", id)
  .map((e) => eventLine('fresh_start.requested', JSON.parse(e.payload) as Record<string, unknown>))
const box = (id: string) => noteLine(getAgent(id) as never)
const TPM_CLEAR = '## What the user wants from this project (in their words)'

test('Bug 338: a Clear before the request was handed out rewrites it in the Clear\'s words; still one request', async () => {
  const id = agent('b338-tpm-queued', 'tpm')
  await freshStart(id, { how: 'after_turn', then: 'continue' })
  assert.match(asks(id)[0]!.body, /^Fresh start:/); assert.match(asks(id)[0]!.body, /## In flight/)
  await retarget(id, 'clear')
  const [m, ...more] = asks(id)
  assert.equal(more.length, 0, 'no second request')
  assert.match(m!.body, /^The user is clearing this project's board from HQ/); assert.ok(m!.body.includes(TPM_CLEAR))
  assert.doesNotMatch(m!.body, /Fresh start|## In flight|This replaces/)
  assert.equal(getAgent(id)!.fresh_start_then, 'clear'); assert.equal(getAgent(id)!.fresh_start_msg, m!.id)
  assert.equal(box(id), 'clearing the project · writing its handoff note…')
  assert.deepEqual(requested(id), ['Asked for its handoff note: a fresh start. A new session takes over from it',
    'Asked again for its handoff note: you are clearing the project. A new TPM takes over from it after the clear'])
  const b = nextBatchFor(getAgent(id)!, 'mod')!; assert.ok(b.text.includes(TPM_CLEAR)); assert.doesNotMatch(b.text, /Fresh start/)
})

test('Bug 338: a Clear after the request was handed out sends one that replaces it; only that one is handed out, the old one never again', async () => {
  for (const role of ['tpm', 'engineer'] as const) {
    const id = agent(`b338-${role}-handed`, role)
    await freshStart(id, { how: 'after_turn', then: 'continue' })
    const first = nextBatchFor(getAgent(id)!, 'mod')!; assert.match(first.text, /Fresh start/, role)
    // On a dialog (a permission prompt while it writes): nothing typed, the new request waits for the mod (e2e types into a terminal)
    run("UPDATE agents SET status = 'blocked', blocked_why = 'permission' WHERE id = ?", id)
    await retarget(id, 'clear')
    const [old, now] = asks(id)
    assert.ok(old!.delivered_at && now, role); assert.match(old!.body, /^Fresh start:/, role) // what it was told stays as it was
    assert.match(now!.body, /^This replaces HQ's earlier request for your handoff note: what happens after it has changed\.\s*HQ interrupted your last step/, role)
    assert.match(now!.body, role === 'tpm' ? /The user is clearing this project's board/ : /The user is clearing this project from HQ: this session is ending, and no new session/, role)
    assert.ok(role === 'tpm' ? now!.body.includes(TPM_CLEAR) : now!.body.includes('for whoever picks the work up later'), role)
    assert.equal(getAgent(id)!.fresh_start_msg, now!.id, role)
    assert.equal(requested(id).at(-1), `Asked again for its handoff note: you are clearing the project. ${role === 'tpm' ? 'A new TPM takes over from it after the clear'
      : 'Nobody takes over: the note is archived'}`, role)
    // its turn ends with the old batch never started (an interrupt), and the old request goes back in the queue: only the new one comes up
    run('UPDATE batches SET dropped_at = ? WHERE id = ?', Date.now(), first.id)
    run('UPDATE messages SET batch_id = NULL, delivered_at = NULL, delivery_method = NULL WHERE id = ?', old!.id)
    run("UPDATE agents SET status = 'idle', blocked_why = NULL WHERE id = ?", id)
    const b = nextBatchFor(getAgent(id)!, 'mod')!
    assert.ok(b.text.includes(`[msg ${now!.id}]`), role); assert.ok(!b.text.includes(`[msg ${old!.id}]`), role)
    const gone = one<Row>('SELECT * FROM messages WHERE id = ?', old!.id)!
    assert.deepEqual([gone.delivery_method, gone.dropped_why], ['dropped', 'replaced'], role)
    assert.match(deliveryMark(gone).title, /asked for the note again in other words/, role)
  }
})

test('Bug 338, what must not change: nothing new once the note is in, the session ended, the words are the same, or there is no fresh start', async () => {
  const noted = agent('b338-eng-noted', 'engineer')
  await freshStart(noted, { how: 'after_turn', then: 'continue' }); nextBatchFor(getAgent(noted)!, 'mod')
  saveNote(getAgent(noted)!, '## Done\n- all (B338-NOTE)')
  await retarget(noted, 'clear')
  assert.equal(asks(noted).length, 1); assert.equal(getAgent(noted)!.fresh_start_then, 'clear') // completeFreshStart ends it as a Clear

  const gone = agent('b338-tpm-gone', 'tpm')
  await freshStart(gone, { how: 'after_turn', then: 'park' }); nextBatchFor(getAgent(gone)!, 'mod')
  run("UPDATE agents SET status = 'exited' WHERE id = ?", gone)
  await retarget(gone, 'clear')
  assert.equal(asks(gone).length, 1); assert.equal(getAgent(gone)!.fresh_start_then, 'clear') // the sweep writes HQ's note for the Clear

  const same = agent('b338-tpm-same', 'tpm')
  await freshStart(same, { how: 'after_turn', then: 'clear' }); nextBatchFor(getAgent(same)!, 'mod')
  await retarget(same, 'clear')
  assert.equal(asks(same).length, 1); assert.equal(requested(same).length, 1)

  const idle = agent('b338-tpm-idle', 'tpm')
  await retarget(idle, 'clear')
  assert.equal(asks(idle).length, 0); assert.equal(getAgent(idle)!.fresh_start_then, null)
  // a normal fresh start's single request is still handed out (the guard against replaced ones lets it through)
  await freshStart(idle, { how: 'after_turn', then: 'continue' })
  assert.match(nextBatchFor(getAgent(idle)!, 'mod')!.text, /Fresh start/)
})
