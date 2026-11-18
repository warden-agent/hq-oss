// Bug 231: a plan answered while its project is being cleared (or removed) moved the clear's stopped engineer back to "working", and the
// clear waited for it forever. HQ now refuses any answer (Approve, Revise, from the UI or HQ's plan check) while the project is closed, and an
// approve never brings a stopped engineer back to life. Real SQLite in a temp HQ_HOME.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerResponse } from 'node:http'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-gateclosed-'))
const { migrate, run, one, q, setSetting } = await import('./db.ts')
migrate()
setSetting('gate_timeout_s', 65) // held calls give up after 5 s, so a failing test can't keep the run alive
const { onExitPlanMode, answerReview } = await import('./gate.ts')
const { removing } = await import('./records.ts')

function hookCall() {
  let resolve!: (v: any) => void; const closers: (() => void)[] = []
  const answer = new Promise<any>((r) => { resolve = r })
  const res = { writeHead: () => res, end: (s: string) => { resolve(JSON.parse(s)); for (const c of closers) c() },
    on: (ev: string, cb: () => void) => { if (ev === 'close') closers.push(cb); return res } }
  return { res: res as unknown as ServerResponse, answer, drop: () => { for (const c of closers) c() } }
}
const pending = (p: Promise<unknown>) => Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 50))])
const now = Date.now()
for (const r of ['r1', 'r2']) {
  run('INSERT INTO repos(id, name, path, created_at) VALUES (?, ?, ?, ?)', r, r === 'r1' ? 'garden' : 'kitchen', `/tmp/${r}`, now)
  run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES (?, ?, 'w', 'Watering', 'x', 'planning', ?, ?)", `f-${r}`, r, now, now)
}
let n = 0
/** A ticket in `repo` whose engineer has sent a plan: its open review, the held hook call, and readers for the rows. */
function planWaiting(repo: string) {
  const i = ++n, t = `t${i}`, e = `e${i}`
  run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES (?, ?, ?, 'x', 'X', 'planning', ?, ?)", t, `f-${repo}`, `T-${i}`, now, now)
  run("INSERT INTO agents(id, role, feature_id, ticket_id, model_alias, token_hash, status, started_at) VALUES (?, 'engineer', ?, ?, 'sonnet', 'h', 'working', ?)", e, `f-${repo}`, t, now)
  const call = hookCall(); onExitPlanMode(one<any>('SELECT * FROM agents WHERE id = ?', e)!, { tool_input: { plan: `Plan ${i}`, planFilePath: null } }, call.res)
  const review = () => one<any>('SELECT * FROM review_requests WHERE ticket_id = ?', t)!
  return { call, id: review().id, review, ticket: () => one<any>('SELECT status FROM tickets WHERE id = ?', t)!.status,
    agent: () => one<any>('SELECT status, in_plan_mode FROM agents WHERE id = ?', e)!.status, stop: () => run("UPDATE agents SET status = 'exited' WHERE id = ?", e) }
}
const clearing = (repo: string, on: boolean) => run('UPDATE repos SET clearing_at = ? WHERE id = ?', on ? now : null, repo)

test('during a Clear, Approve and Revise are refused and change nothing: the stopped engineer stays stopped, the review stays open', async () => {
  const p = planWaiting('r1'); p.stop(); clearing('r1', true) // what clearRepo does to an engineer at plan review: lock, then stop it
  for (const verdict of ['approve', 'approve_with_edits', 'user_engineer', 'revise', 'user_architect', 'escalate'] as const) {
    const r = answerReview(p.id, verdict, { by: verdict === 'approve' ? 'plan_check' : 'user', message: 'no', note: 'keep the old colours' })
    assert.deepEqual(r, { ok: false, held: true, error: "garden is being cleared; wait until it's done." }, verdict)
  }
  assert.equal(p.agent(), 'exited'); assert.equal(p.ticket(), 'plan_review'); assert.equal(p.review().status, 'open')
  assert.equal(await pending(p.call.answer), true) // the held call isn't answered either
  assert.equal(q("SELECT 1 FROM messages WHERE body LIKE '%keep the old colours%'").length, 0) // Revise's note to the TPM wasn't sent
  p.call.drop(); clearing('r1', false)
})

test('while the project is being removed, an answer is refused too', () => {
  const p = planWaiting('r1'); removing.add('r1')
  try { assert.deepEqual(answerReview(p.id, 'approve', { by: 'user' }), { ok: false, held: true, error: 'garden is being removed from HQ.' }) } finally { removing.delete('r1') }
  assert.equal(p.ticket(), 'plan_review'); assert.equal(p.agent(), 'plan_review'); p.call.drop()
})

test('what it must not catch: another project\'s Clear, and the same project once the clear is done, answer as before', async () => {
  clearing('r1', true)
  const other = planWaiting('r2')
  assert.deepEqual(answerReview(other.id, 'approve', { by: 'user' }), { ok: true, held: true })
  assert.equal((await other.call.answer).hookSpecificOutput.decision.behavior, 'allow'); assert.equal(other.ticket(), 'implementing'); assert.equal(other.agent(), 'working')
  clearing('r1', false)
  const p = planWaiting('r1')
  assert.deepEqual(answerReview(p.id, 'revise', { by: 'user', message: 'smaller' }), { ok: true, held: true })
  assert.equal((await p.call.answer).hookSpecificOutput.decision.message, 'smaller'); assert.equal(p.ticket(), 'planning')
})

test('an approve for an engineer that has stopped (no Clear) moves its ticket on but leaves the engineer stopped', () => {
  const p = planWaiting('r1'); p.call.drop(); p.stop()
  assert.deepEqual(answerReview(p.id, 'approve', { by: 'user' }), { ok: true, held: false })
  assert.equal(p.ticket(), 'implementing'); assert.equal(p.agent(), 'exited') // its box offers Resume, not a "working" engineer that isn't there
})
