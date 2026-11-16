// The model check against a real SQLite DB in a temp HQ_HOME, with the plan gate doing the approving. Bug 105: the mod reports a request
// only once its response has ended, so the one that asks to leave plan mode can be reported after HQ has approved the plan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerResponse } from 'node:http'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-modelguard-'))
const { migrate, run, one, q, getSetting } = await import('./db.ts')
migrate()
const { onExitPlanMode, answerReview } = await import('./gate.ts')
const { onTurnStep, onPostModelSwitch } = await import('./modelguard.ts')

const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5'
const t0 = Date.now()
run("INSERT INTO repos(id, name, path, created_at) VALUES ('r1', 'demo', '/tmp/demo', ?)", t0)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f1', 'r1', 'kl', 'item list', 'x', 'planning', ?, ?)", t0, t0)
let n = 0
/** An engineer on its own ticket, planning (as its hooks say while it's in plan mode). */
function engineer(alias: string): string {
  const id = `e${++n}`, tk = `t${n}`
  run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES (?, 'f1', ?, 'api', 'API', 'planning', ?, ?)", tk, `APP-${n}`, t0, t0)
  run("INSERT INTO agents(id, role, feature_id, ticket_id, model_alias, token_hash, status, in_plan_mode, started_at) VALUES (?, 'engineer', 'f1', ?, ?, 'h', 'working', 1, ?)", id, tk, alias, t0)
  return id
}
const agent = (id: string) => one<any>('SELECT * FROM agents WHERE id = ?', id)!
/** One request of the agent's own loop, as the mod reports it: its model and the tools it asked to run. */
const step = (id: string, model: string, tools?: string[]) => onTurnStep(agent(id), { kind: 'turn.step', model, agentId: null, usageModel: model, ...(tools ? { tools } : {}) })
const alerts = (id: string) => q<any>("SELECT kind, detail FROM needs_attention WHERE agent_id = ? AND kind LIKE 'model_%'", id).map((a) => [a.kind, a.detail])
const mismatch = (id: string, model: string, expected: string) => [['model_mismatch', `engineer ${id}: main-loop request on ${model}, expected ${expected}`]]
/** The plan goes to HQ and auto mode approves it at once: the hook is answered before anything else from the agent is read. */
async function approvedAtOnce(id: string): Promise<void> {
  let answer!: (v: any) => void; const answered = new Promise<any>((r) => { answer = r })
  const res = { writeHead: () => res, end: (s: string) => answer(JSON.parse(s)), on: () => res } as unknown as ServerResponse
  onExitPlanMode(agent(id), { tool_input: { plan: `Plan of ${id}`, planFilePath: null } }, res)
  const review = one<any>("SELECT id FROM review_requests WHERE ticket_id = ? AND status = 'open'", agent(id).ticket_id)!
  assert.deepEqual(answerReview(review.id, 'approve', { by: 'auto' }), { ok: true, held: true })
  assert.equal((await answered).hookSpecificOutput.decision.behavior, 'allow')
  assert.equal(agent(id).in_plan_mode, 0) // HQ counts it as building from here on
}
const switched = (id: string) => onPostModelSwitch(agent(id), { from_model: OPUS, to_model: SONNET, source: 'auto', requested_model: null })

test('Bug 105: the request that asked to leave plan mode is reported after the approval, and nothing is raised', async () => {
  const e = engineer('opusplan')
  step(e, OPUS, ['Read']); step(e, OPUS, ['Write']) // planning, on the planning model
  await approvedAtOnce(e)
  step(e, OPUS, ['Write', 'ExitPlanMode']) // the request that made the call, reported late
  assert.deepEqual(alerts(e), [])
  switched(e); step(e, SONNET, ['Edit']) // then it builds on the build model, as it should
  assert.deepEqual(alerts(e), []); assert.deepEqual(getSetting('paused_roles', []), [])
  assert.equal(agent(e).model_live, SONNET)
})

test('Bug 105: the same late report after the switch to the build model is no alarm either', async () => {
  const e = engineer('opusplan')
  step(e, OPUS, ['Read']); await approvedAtOnce(e); switched(e)
  step(e, OPUS, ['ExitPlanMode'])
  assert.deepEqual(alerts(e), []); assert.equal(agent(e).model_live, SONNET) // and it isn't shown as back on the planning model
})

test('a request on the planning model once the plan is approved is still a mismatch', async () => {
  const e = engineer('opusplan')
  step(e, OPUS, ['Read']); await approvedAtOnce(e); step(e, OPUS, ['ExitPlanMode']); switched(e); step(e, SONNET, ['Edit'])
  assert.deepEqual(alerts(e), [])
  step(e, OPUS, ['Edit']) // building on the planning model
  assert.deepEqual(alerts(e), mismatch(e, OPUS, 'sonnet'))
  const old = engineer('opusplan') // a mod from before the fix names no tools: its late report reads as before
  await approvedAtOnce(old); step(old, OPUS)
  assert.deepEqual(alerts(old), mismatch(old, OPUS, 'sonnet'))
})

test('asking to leave plan mode excuses the planning model only', async () => {
  const one = engineer('sonnet') // one model for planning and building: the planning model is that one
  await approvedAtOnce(one); step(one, OPUS, ['ExitPlanMode'])
  assert.deepEqual(alerts(one), mismatch(one, OPUS, 'sonnet'))
  const other = engineer('opusplan'), FABLE = 'claude-fable-5-2'
  await approvedAtOnce(other); step(other, FABLE, ['ExitPlanMode'])
  assert.deepEqual(alerts(other), mismatch(other, FABLE, 'sonnet'))
})

test('while it plans, a request on the build model is a mismatch; a helper\'s request is never checked', () => {
  const e = engineer('opusplan')
  onTurnStep(agent(e), { kind: 'turn.step', model: SONNET, agentId: 'helper-1', usageModel: SONNET, tools: ['Read'] })
  assert.deepEqual(alerts(e), [])
  step(e, SONNET, ['Read'])
  assert.deepEqual(alerts(e), [['model_mismatch', `engineer ${e}: main-loop request on ${SONNET}, expected opus (plan mode)`]])
})
