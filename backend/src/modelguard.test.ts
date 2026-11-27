// The model check against a real SQLite DB in a temp HQ_HOME, with the plan gate doing the approving. Bug 105: the mod reports a request
// only once its response has ended, so the one that asks to leave plan mode can be reported after HQ has approved the plan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerResponse } from 'node:http'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-modelguard-'))
// Bug 195: a switch nobody asked for pauses the role, and the pause looks at its agents' terminals (pause.ts). These have none: no tmux of anyone's is asked
process.env.TMUX_TMPDIR = process.env.HQ_HOME; delete process.env.TMUX
const { migrate, run, one, q, getSetting, setSetting } = await import('./db.ts')
migrate()
const { onExitPlanMode, answerReview } = await import('./gate.ts')
const { onTurnStep, onPostModelSwitch, fallbackWords } = await import('./modelguard.ts')

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
async function approvedAtOnce(id: string, plan = `Plan of ${id}`): Promise<void> {
  let answer!: (v: any) => void; const answered = new Promise<any>((r) => { answer = r })
  const res = { writeHead: () => res, end: (s: string) => answer(JSON.parse(s)), on: () => res } as unknown as ServerResponse
  onExitPlanMode(agent(id), { tool_input: { plan, planFilePath: null } }, res)
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

// Bug 141. Real 2.1.322 (a throwaway spike): `--model haiku --permission-mode plan` makes every planning request on Sonnet; when the
// plan is allowed it switches to Haiku by itself (PostModelSwitch, source auto, 20 ms after the allow) and builds on Haiku. `--model claude-haiku-5-5`
// plans on Haiku and never switches.
const HAIKU = 'claude-haiku-5-5'
const toHaiku = (id: string) => onPostModelSwitch(agent(id), { from_model: SONNET, to_model: HAIKU, source: 'auto', requested_model: null })
const fallback = (id: string, from: string, to: string) => [['model_fallback', fallbackWords({ id, role: 'engineer', display_name: null }, from, to)]]
const unpause = () => setSetting('paused_roles', [])

test('Bug 141: an engineer on haiku plans on Sonnet, switches to Haiku at the approval, and nothing is raised or paused', async () => {
  unpause()
  const e = engineer('haiku')
  step(e, SONNET, ['Read']); step(e, SONNET, ['Write']); step(e, SONNET, ['ExitPlanMode'])
  assert.deepEqual(alerts(e), [])
  await approvedAtOnce(e); toHaiku(e); step(e, HAIKU, ['Edit']); step(e, HAIKU, [])
  assert.deepEqual(alerts(e), []); assert.deepEqual(getSetting('paused_roles', []), [])
  assert.equal(agent(e).model_live, HAIKU); assert.equal(agent(e).in_plan_mode, 0)
  assert.equal(one<any>('SELECT expected FROM model_switches WHERE agent_id = ?', e).expected, 1)
})

test('Bug 141: the request that asked to leave plan mode, reported after the switch to Haiku, is no alarm either', async () => {
  unpause()
  const e = engineer('haiku')
  step(e, SONNET, ['Read']); await approvedAtOnce(e); toHaiku(e); step(e, SONNET, ['Write', 'ExitPlanMode'])
  assert.deepEqual(alerts(e), []); assert.equal(agent(e).model_live, HAIKU)
})

test('Bug 141: every other switch Claude Code makes by itself still pauses the role', async () => {
  unpause()
  const noPlan = engineer('haiku') // Sonnet → Haiku while still planning: no plan was allowed
  toHaiku(noPlan)
  assert.deepEqual(alerts(noPlan), fallback(noPlan, SONNET, HAIKU)); assert.deepEqual(getSetting('paused_roles', []), ['engineer'])
  assert.equal(agent(noPlan).in_plan_mode, 1)
  unpause()
  const late = engineer('haiku') // the allow was long before the switch
  await approvedAtOnce(late); run('UPDATE agents SET last_gate_allow_at = ? WHERE id = ?', Date.now() - 60_000, late); toHaiku(late)
  assert.deepEqual(alerts(late), fallback(late, SONNET, HAIKU)); assert.deepEqual(getSetting('paused_roles', []), ['engineer'])
  unpause()
  const back = engineer('haiku') // back to Sonnet while building
  await approvedAtOnce(back); toHaiku(back)
  onPostModelSwitch(agent(back), { from_model: HAIKU, to_model: SONNET, source: 'auto', requested_model: null })
  assert.deepEqual(alerts(back), fallback(back, HAIKU, SONNET)); assert.deepEqual(getSetting('paused_roles', []), ['engineer'])
  unpause()
  const other = engineer('opusplan') // opusplan's switch is opus → sonnet, not haiku's sonnet → haiku
  await approvedAtOnce(other); toHaiku(other)
  assert.deepEqual(alerts(other), fallback(other, SONNET, HAIKU))
  unpause()
})

test('Bug 141: building on Sonnet is still a mismatch for haiku, and the full Haiku id is expected to plan on Haiku', async () => {
  unpause()
  const e = engineer('haiku')
  await approvedAtOnce(e); toHaiku(e); step(e, SONNET, ['Edit'])
  assert.deepEqual(alerts(e), mismatch(e, SONNET, 'haiku'))
  const full = engineer(HAIKU)
  step(full, SONNET, ['Read'])
  assert.deepEqual(alerts(full), [['model_mismatch', `engineer ${full}: main-loop request on ${SONNET}, expected haiku (plan mode)`]])
  assert.deepEqual(getSetting('paused_roles', []), [])
})

// Bug 385. Real 2.1.322 on haiku (a throwaway spike): an approved engineer that calls EnterPlanMode sends PreToolUse in acceptEdits,
// PostToolUse in plan, then PostModelSwitch Haiku → Sonnet (source auto) 2 ms later, and the request that made the call is reported 1 ms after that, on Haiku.
const { emit } = await import('./events.ts')
/** A tool hook of the agent's own loop (or a helper's), as handleHook records it; `mode` is what the hook's permission_mode sets. */
function hook(id: string, ev: 'PreToolUse' | 'PostToolUse', tool: string, mode: 'plan' | 'acceptEdits', sub = false): void {
  emit({ agentId: id, source: 'hook', kind: `hook.${ev}:${tool}`, payload: { event: ev, tool, mode, ...sub ? { sub: true } : {} } })
  if (!sub) run('UPDATE agents SET in_plan_mode = ? WHERE id = ?', mode === 'plan' ? 1 : 0, id)
}
const toSonnet = (id: string) => onPostModelSwitch(agent(id), { from_model: HAIKU, to_model: SONNET, source: 'auto', requested_model: null })

test('Bug 385: an approved engineer on haiku goes back into plan mode by itself, switches back to Sonnet, and nothing is raised or paused', async () => {
  unpause()
  const e = engineer('haiku')
  await approvedAtOnce(e); toHaiku(e); hook(e, 'PreToolUse', 'Edit', 'acceptEdits'); step(e, HAIKU, ['Edit'])
  hook(e, 'PreToolUse', 'EnterPlanMode', 'acceptEdits'); hook(e, 'PostToolUse', 'EnterPlanMode', 'plan'); toSonnet(e)
  step(e, HAIKU, ['EnterPlanMode']) // the request that made the call, reported after the switch
  assert.deepEqual(alerts(e), []); assert.deepEqual(getSetting('paused_roles', []), [])
  assert.equal(agent(e).model_live, SONNET); assert.equal(agent(e).in_plan_mode, 1)
  hook(e, 'PreToolUse', 'Write', 'plan'); step(e, SONNET, ['Write']); step(e, SONNET, ['ExitPlanMode']) // the new plan, on the planning model
  await approvedAtOnce(e, 'New plan'); toHaiku(e); step(e, HAIKU, ['Edit']) // approved again: back to Haiku, as the first time
  assert.deepEqual(alerts(e), []); assert.deepEqual(getSetting('paused_roles', []), [])
  assert.deepEqual(q<any>('SELECT expected FROM model_switches WHERE agent_id = ? ORDER BY id', e).map((r) => r.expected), [1, 1, 1])
})

test('Bug 385: the switch read before the PostToolUse that says plan mode still counts, by the EnterPlanMode call under way', async () => {
  unpause()
  const e = engineer('haiku')
  await approvedAtOnce(e); toHaiku(e); hook(e, 'PreToolUse', 'EnterPlanMode', 'acceptEdits')
  hook(e, 'PreToolUse', 'Read', 'acceptEdits', true) // a helper's call meanwhile doesn't hide it
  toSonnet(e)
  assert.deepEqual(alerts(e), []); assert.deepEqual(getSetting('paused_roles', []), []); assert.equal(agent(e).in_plan_mode, 1)
})

test('Bug 385: opusplan, the same way: the late EnterPlanMode request on Sonnet is no mismatch, and Opus planning after it is expected', async () => {
  unpause()
  const e = engineer('opusplan')
  await approvedAtOnce(e); switched(e); step(e, SONNET, ['Edit'])
  hook(e, 'PreToolUse', 'EnterPlanMode', 'acceptEdits'); hook(e, 'PostToolUse', 'EnterPlanMode', 'plan')
  onPostModelSwitch(agent(e), { from_model: SONNET, to_model: OPUS, source: 'auto', requested_model: null })
  step(e, SONNET, ['EnterPlanMode']); step(e, OPUS, ['Write'])
  assert.deepEqual(alerts(e), []); assert.deepEqual(getSetting('paused_roles', []), []); assert.equal(agent(e).model_live, OPUS)
})

test('Bug 385: what the plan-mode excuse must not catch still alarms', async () => {
  unpause()
  const build = engineer('haiku') // back to Sonnet while building, with no EnterPlanMode: a fallback
  await approvedAtOnce(build); toHaiku(build); hook(build, 'PreToolUse', 'EnterPlanMode', 'acceptEdits'); hook(build, 'PostToolUse', 'EnterPlanMode', 'plan')
  toSonnet(build); hook(build, 'PreToolUse', 'ExitPlanMode', 'plan'); await approvedAtOnce(build, 'New plan'); toHaiku(build)
  hook(build, 'PreToolUse', 'Edit', 'acceptEdits'); assert.deepEqual(alerts(build), []) // replanned once, fine; then building
  toSonnet(build)
  assert.deepEqual(alerts(build), fallback(build, HAIKU, SONNET)); assert.deepEqual(getSetting('paused_roles', []), ['engineer'])
  unpause()
  const other = engineer('haiku') // entering plan mode, but onto a model the alias never plans on
  await approvedAtOnce(other); toHaiku(other); hook(other, 'PreToolUse', 'EnterPlanMode', 'acceptEdits'); hook(other, 'PostToolUse', 'EnterPlanMode', 'plan')
  onPostModelSwitch(agent(other), { from_model: HAIKU, to_model: OPUS, source: 'auto', requested_model: null })
  assert.deepEqual(alerts(other), fallback(other, HAIKU, OPUS)); assert.deepEqual(getSetting('paused_roles', []), ['engineer'])
  unpause()
  const late = engineer('opusplan') // an EnterPlanMode request on a model the alias never uses is still a mismatch
  await approvedAtOnce(late); switched(late); hook(late, 'PostToolUse', 'EnterPlanMode', 'plan')
  step(late, 'claude-fable-5-2', ['EnterPlanMode'])
  assert.deepEqual(alerts(late), [['model_mismatch', `engineer ${late}: main-loop request on claude-fable-5-2, expected opus (plan mode)`]])
  unpause()
})
