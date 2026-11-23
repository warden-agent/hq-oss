// Bug 350: the user switched away from a project and straight back before its agents' handoff notes were in. resumeRepo found nothing
// parked yet, and the notes then parked the work with nobody to resume it. Now resumeRepo tells each agent still writing the switch's note
// that a new session takes over from it at once (a fresh start's 'continue', retarget), and completeFreshStart reads that again after it
// has stopped the session. Against a real SQLite DB in a temp HQ_HOME; the whole switch, typed into terminals, is e2e/freshstart.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b350-'))
process.env.TMUX_TMPDIR = process.env.HQ_HOME; delete process.env.TMUX // stopAgent's tmux call goes to this test's own socket
const { migrate, run, q } = await import('./db.ts')
migrate()
const { completeFreshStart, freshStart, resumeRepo, retarget } = await import('./freshstart.ts')
const { getAgent } = await import('./agents.ts')

const t0 = Date.now()
run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('b350r', 'b350x', '/tmp/b350x', 'local', ?)", t0)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('b350f', 'b350r', 'b350', 'B', 'b', 'planning', ?, ?)", t0, t0)
let n = 0
/** A running engineer on a ticket of its own (no branch: a new session for it fails at once, without starting anything). */
const engineer = (id: string) => {
  const t = `b350t${++n}`
  run(`INSERT INTO tickets(id, feature_id, key, slug, title, status, assignee_agent_id, created_at, updated_at)
    VALUES (?, 'b350f', ?, ?, 'B', 'implementing', ?, ?, ?)`, t, `B-${n}`, `b-${n}`, id, t0, t0)
  run(`INSERT INTO agents(id, role, repo_id, feature_id, ticket_id, model_alias, token_hash, status, tmux_session, started_at)
    VALUES (?, 'engineer', 'b350r', 'b350f', ?, 'opus', ?, 'working', 'hq-b350-none', ?)`, id, t, id, t0)
  return id
}
const asks = (id: string) => q<{ body: string }>("SELECT body FROM messages WHERE to_id = ? AND reason = 'fresh_start' ORDER BY rowid", id)
const done = (id: string) => q<{ payload: string }>("SELECT payload FROM events WHERE agent_id = ? AND kind = 'fresh_start.done'", id)
  .map((e) => (JSON.parse(e.payload) as { then: string }).then)

test('Bug 350: coming back while an agent writes the switch\'s note: a new session takes over from it at once, in the request\'s words too', async () => {
  const id = engineer('b350-eng-back')
  await freshStart(id, { how: 'after_turn', then: 'switch' }) // the switch away (not handed out yet: no terminal to type into here)
  const r = await resumeRepo('b350r')
  assert.deepEqual(r.resumed, ['b350-eng-back (from its note)'])
  assert.equal(getAgent(id)!.fresh_start_then, 'continue')
  const [m, ...more] = asks(id); assert.equal(more.length, 0)
  assert.match(m!.body, /^Fresh start: this session is ending so that a new one can take over/); assert.doesNotMatch(m!.body, /switched to another project/)
})

test('Bug 350, what it must not catch: a Clear\'s note request, a fresh start waiting for Resume, another project\'s switch', async () => {
  const clear = engineer('b350-eng-clear'), park = engineer('b350-eng-park')
  await freshStart(clear, { how: 'after_turn', then: 'clear' }); await freshStart(park, { how: 'after_turn', then: 'park' })
  run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('b350o', 'b350y', '/tmp/b350y', 'local', ?)", t0)
  run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('b350g', 'b350o', 'b350g', 'G', 'g', 'planning', ?, ?)", t0, t0)
  const other = engineer('b350-eng-other'); run("UPDATE agents SET repo_id = 'b350o', feature_id = 'b350g' WHERE id = ?", other)
  await freshStart(other, { how: 'after_turn', then: 'switch' })
  assert.deepEqual((await resumeRepo('b350r')).resumed, [])
  assert.deepEqual([clear, park, other].map((x) => getAgent(x)!.fresh_start_then), ['clear', 'park', 'switch'])
})

test('Bug 350: back while the switch\'s session was being stopped: its new session is asked for, not parked', async () => {
  const id = engineer('b350-eng-ending')
  await freshStart(id, { how: 'after_turn', then: 'switch' })
  const ending = completeFreshStart(id, 'note') // read 'switch', now waits for its terminal to go
  await retarget(id, 'continue') // the user is back (resumeRepo)
  await ending
  assert.deepEqual(done(id), ['continue'])
  assert.equal(getAgent(id)!.ended_why, 'fresh_start')
  // the new session couldn't start here (no branch): parked, with a notice that says so and Resume to try again
  assert.ok(q("SELECT 1 FROM needs_attention WHERE agent_id = ? AND kind = 'fresh_start_failed'", id).length)
})

test('Bug 350, what it must not catch: a Clear that comes while the session is being stopped doesn\'t take over a switch\'s ending', async () => {
  const id = engineer('b350-eng-cleared')
  await freshStart(id, { how: 'after_turn', then: 'switch' })
  const ending = completeFreshStart(id, 'note')
  await retarget(id, 'clear')
  await ending
  assert.deepEqual(done(id), ['switch']); assert.equal(getAgent(id)!.ended_why, 'parked')
})
