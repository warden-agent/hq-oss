// Plan gate rounds against a real SQLite DB in a temp HQ_HOME: a changed plan closes the open review (Bug 5), a held hook
// call is always answered, and the old round can't be approved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerResponse } from 'node:http'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-gate-'))
const { migrate, run, one, q, setSetting } = await import('./db.ts')
migrate()
setSetting('gate_timeout_s', 65) // held calls give up after 5s, so a failing test can't keep the run alive for 29 minutes
const { onExitPlanMode, onPostExitPlanMode, answerReview, heldCount } = await import('./gate.ts')

/** A hook response the gate can hold: `answer` resolves with what HQ sends back; `drop` is the client hanging up. */
function hookCall() {
  let resolve!: (v: any) => void; const closers: (() => void)[] = []
  const answer = new Promise<any>((r) => { resolve = r })
  const res = { writeHead: () => res, end: (s: string) => { resolve(JSON.parse(s)); for (const c of closers) c() }, on: (ev: string, cb: () => void) => { if (ev === 'close') closers.push(cb); return res } }
  return { res: res as unknown as ServerResponse, answer, drop: () => { for (const c of closers) c() } }
}
const pending = (p: Promise<unknown>) => Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 50))])
const now = Date.now()
run("INSERT INTO repos(id, name, path, created_at) VALUES ('r1', 'pantry', '/tmp/pantry', ?)", now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f1', 'r1', 'kl', 'kitchen list', 'x', 'planning', ?, ?)", now, now)
run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES ('t1', 'f1', 'PAN-1', 'api', 'API', 'planning', ?, ?)", now, now)
run("INSERT INTO agents(id, role, feature_id, ticket_id, model_alias, token_hash, status, started_at) VALUES ('e1', 'engineer', 'f1', 't1', 'sonnet', 'h', 'working', ?)", now)
const agent = () => one<any>("SELECT * FROM agents WHERE id = 'e1'")!
const submit = (plan: string) => { const c = hookCall(); onExitPlanMode(agent(), { tool_input: { plan, planFilePath: null } }, c.res); return c }
const reviews = () => q<any>("SELECT r.*, p.verdict, p.plan_text FROM review_requests r JOIN plan_revisions p ON p.id = r.plan_revision_id WHERE r.ticket_id = 't1' ORDER BY r.round")
const ticket = () => one<any>("SELECT status, plan_round FROM tickets WHERE id = 't1'")!

test('a changed plan closes the open review; the old round cannot be approved; the held call is answered', async () => {
  const a1 = submit('Plan A')
  assert.equal(await pending(a1.answer), true); assert.deepEqual(reviews().map((r) => [r.round, r.status]), [[1, 'open']]); assert.equal(ticket().status, 'plan_review')
  const a2 = submit('Plan A') // the same plan again: re-attached to R-1, the older call told it's still pending
  assert.match((await a1.answer).hookSpecificOutput.decision.message, /Review R-1 still pending/); assert.equal(reviews().length, 1)
  const b = submit('Plan B') // a changed plan: R-1 closes, R-2 opens
  assert.equal((await a2.answer).hookSpecificOutput.decision.message, 'Plan R-1 was replaced by your newer plan (R-2); HQ is reviewing that one.')
  assert.deepEqual(reviews().map((r) => [r.round, r.status, r.closed_reason, r.verdict]), [[1, 'abandoned', 'superseded', 'superseded'], [2, 'open', null, null]])
  assert.equal(heldCount(), 1)
  const r1 = reviews()[0]!, r2 = reviews()[1]!
  assert.deepEqual(answerReview(r1.id, 'approve', { by: 'user' }), { ok: false, held: false, error: 'review not open' })
  assert.equal(ticket().status, 'plan_review') // approving the old round changed nothing
  assert.deepEqual(answerReview(r2.id, 'approve', { by: 'user' }), { ok: true, held: true })
  const allow = (await b.answer).hookSpecificOutput.decision
  assert.equal(allow.behavior, 'allow'); assert.equal(allow.updatedInput.plan, 'Plan B'); assert.equal(ticket().status, 'implementing')
  onPostExitPlanMode(agent(), {}) // Claude Code reports the tool HQ allowed: not an override
  assert.equal(q("SELECT 1 FROM needs_attention WHERE kind = 'user_override'").length, 0)
  assert.deepEqual(reviews().map((r) => r.closed_reason), ['superseded', 'approve'])
})

test('the replaced plan sent again opens a new round instead of dead-ending', async () => {
  const a = submit('Plan A') // R-1 (Plan A) was superseded earlier
  assert.equal(await pending(a.answer), true)
  assert.deepEqual(reviews().map((r) => [r.round, r.status]), [[1, 'abandoned'], [2, 'answered'], [3, 'open']])
  answerReview(reviews()[2]!.id, 'revise', { by: 'user', message: 'no' })
  assert.equal((await a.answer).hookSpecificOutput.decision.message, 'no')
})

test('a client that hangs up leaves nothing held; an approval from the terminal menu closes the one open review', async () => {
  const c = submit('Plan C'); assert.equal(heldCount(), 1); c.drop(); assert.equal(heldCount(), 0)
  const d = submit('Plan D') // C's round closes as superseded even though nobody holds it any more
  assert.deepEqual(reviews().slice(3).map((r) => [r.round, r.status]), [[4, 'abandoned'], [5, 'open']])
  assert.ok(Date.now() - agent().last_gate_allow_at < 15_000) // HQ approved moments ago (first test); still caught
  onPostExitPlanMode(agent(), {})
  assert.deepEqual(reviews().slice(3).map((r) => [r.round, r.status, r.closed_reason]), [[4, 'abandoned', 'superseded'], [5, 'closed', 'user_override']])
  assert.equal(q("SELECT 1 FROM review_requests WHERE status = 'open'").length, 0); assert.equal(heldCount(), 0)
  assert.equal(q("SELECT 1 FROM needs_attention WHERE kind = 'user_override'").length, 1)
  void d
})

/** A second ticket and engineer, so these tests don't depend on t1's rounds. */
function fresh(n: number) {
  run('INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', `t${n}`, 'f1', `PAN-${n}`, `s${n}`, `T${n}`, 'planning', now, now)
  run('INSERT INTO agents(id, role, feature_id, ticket_id, model_alias, token_hash, status, started_at) VALUES (?,?,?,?,?,?,?,?)', `e${n}`, 'engineer', 'f1', `t${n}`, 'sonnet', 'h', 'working', now)
  const ag = () => one<any>('SELECT * FROM agents WHERE id = ?', `e${n}`)!
  const send = (plan: string) => { const c = hookCall(); onExitPlanMode(ag(), { tool_input: { plan, planFilePath: null } }, c.res); return c }
  const rounds = () => q<any>('SELECT r.*, p.verdict FROM review_requests r JOIN plan_revisions p ON p.id = r.plan_revision_id WHERE r.ticket_id = ? ORDER BY r.round', `t${n}`)
  const status = () => one<any>('SELECT status FROM tickets WHERE id = ?', `t${n}`)!.status
  return { ag, send, rounds, status }
}

test('going back to an approved plan closes the newer open round, so it is not taken for a terminal-menu approval', async () => {
  const x = fresh(3)
  const a = x.send('Plan A'); answerReview(x.rounds()[0]!.id, 'approve', { by: 'user' }); await a.answer
  x.send('Plan B') // R-2 opens, and is held
  assert.equal(x.status(), 'plan_review')
  const back = x.send('Plan A') // the approved plan again: allowed straight away
  assert.equal((await back.answer).hookSpecificOutput.decision.behavior, 'allow')
  assert.deepEqual(x.rounds().map((r) => [r.round, r.status, r.closed_reason]), [[1, 'answered', 'approve'], [2, 'abandoned', 'superseded']])
  onPostExitPlanMode(x.ag(), {})
  assert.equal(q("SELECT 1 FROM needs_attention WHERE kind = 'user_override' AND agent_id = 'e3'").length, 0)
  assert.equal(x.status(), 'implementing')
})

test('revision_cap: after 2 send-backs the next round escalates; it can only be approved (or cancelled)', async () => {
  const x = fresh(4)
  const p1 = x.send('Plan 1'); answerReview(x.rounds()[0]!.id, 'revise', { by: 'user', message: 'no' }); await p1.answer
  const p2 = x.send('Plan 2'); answerReview(x.rounds()[1]!.id, 'user_architect', { by: 'user', message: 'no' }); await p2.answer
  const p3 = x.send('Plan 3')
  assert.equal(x.status(), 'escalated')
  assert.match(one<any>("SELECT detail FROM needs_attention WHERE kind = 'cap_reached' AND agent_id = 'e4' AND resolved_at IS NULL")!.detail, /PAN-4: plan sent back 2 times/)
  const r3 = x.rounds()[2]!.id
  for (const v of ['revise', 'user_architect'] as const) {
    const res = answerReview(r3, v, { by: 'user', message: 'again' })
    assert.equal(res.ok, false); assert.match(res.error!, /revision cap reached/)
  }
  assert.equal(await pending(p3.answer), true) // still held: the engineer keeps waiting
  assert.deepEqual(answerReview(r3, 'approve', { by: 'user' }), { ok: true, held: true })
  assert.equal((await p3.answer).hookSpecificOutput.decision.behavior, 'allow'); assert.equal(x.status(), 'implementing')
  assert.equal(q("SELECT 1 FROM needs_attention WHERE kind = 'cap_reached' AND resolved_at IS NULL").length, 0)
})

test('migration 6 closes older open rounds left by the old gate, and only those', () => {
  run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES ('t2', 'f1', 'PAN-2', 'page', 'Page', 'plan_review', ?, ?)", now, now)
  for (const n of [1, 2, 3]) {
    run('INSERT INTO plan_revisions(id, ticket_id, agent_id, round, plan_text, plan_hash, submitted_at) VALUES (?,?,?,?,?,?,?)', `p${n}`, 't2', 'e1', n, `plan ${n}`, `h${n}`, now)
    run('INSERT INTO review_requests(id, ticket_id, plan_revision_id, round, status, opened_at) VALUES (?,?,?,?,?,?)', `R${n}`, 't2', `p${n}`, n, n === 2 ? 'answered' : 'open', now)
  }
  run("UPDATE plan_revisions SET verdict = 'revise' WHERE id = 'p2'")
  setSetting('x', 1); run("UPDATE meta SET value = '5' WHERE key = 'schema_version'")
  migrate(6)
  assert.deepEqual(q<any>("SELECT r.round, r.status, r.closed_reason, p.verdict FROM review_requests r JOIN plan_revisions p ON p.id = r.plan_revision_id WHERE r.ticket_id = 't2' ORDER BY r.round").map((r) => [r.round, r.status, r.closed_reason, r.verdict]),
    [[1, 'abandoned', 'superseded', 'superseded'], [2, 'answered', null, 'revise'], [3, 'open', null, null]])
  assert.equal(one<any>("SELECT value FROM meta WHERE key = 'schema_version'")!.value, '6')
})
