// Bug 386 end to end: a turn of the agent's own that ends on an error, with no Stop. On 2.1.322 an API error sends StopFailure without waiting for it (it can
// reach HQ before or after the mod's turn.complete), and a model error (the query loop's model_error: the model policy, an unanswered usage-credits consent,
// model_blocked, its catch-all for a thrown error) sends none; the mod says reason 'error' either way. HQ waits HQ_FAILURE_WAIT_S for a StopFailure, then
// says the turn failed itself, once. The wait starts long (nothing can race it); the tests set it short and restart the backend to let it run out.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_STUCK_TICK_S: '3600', HQ_FAILURE_WAIT_S: '3600' } }) })
after(async () => { await hq?.stop() })
let n = 0
async function tpm(): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(`b386x${++n}`) })).json, a = (await hq.api(`repos/${repo.id}/message`, { body: 'hello b386' })).json.agent
  return waitFor('the TPM', async () => (await hq.state()).agents.find((x: any) => x.id === a.id && x.status === 'working'))
}
const now = async (a: any) => (await hq.state()).agents.find((x: any) => x.id === a.id)
const events = async (a: any, kind: string) => ((await hq.api(`events?agent=${a.id}&limit=500`)).json as any[]).filter((e) => e.kind === kind)
const failures = async (a: any) => (await events(a, 'hook.StopFailure')).map((e) => JSON.parse(e.payload)).reverse() // oldest first
const lines = async (a: any): Promise<string[]> => ((await hq.api(`agents/${a.id}/events`)).json.events as any[]).map((e) => e.text)
const alerts = async (a: any) => (await hq.state()).attention.filter((x: any) => x.kind === 'api_error' && x.agent_id === a.id && !x.resolved_at)
const ask = (a: any, prompt: string) => hq.hook(a.id, { hook_event_name: 'UserPromptSubmit', prompt })
const start = (a: any, turnId: string) => hq.modEvent(a.id, { kind: 'turn.start', turnId, agentId: null })
const ends = (a: any, turnId: string, reason: string) =>
  hq.modEvent(a.id, { kind: 'turn.complete', turnId, agentId: null, isAborted: false, reason, durationMs: 900, answer: '' })
const failed = (a: any, error: string) => hq.hook(a.id, { hook_event_name: 'StopFailure', error })
async function working(a: any, turnId: string): Promise<void> { await ask(a, `go on b386 ${turnId}`); await start(a, turnId)
  await hq.hook(a.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'touch b386.txt' }, tool_use_id: `u386${++n}` }) }
const SAID = 'Turn failed: an error (its terminal says which)'
/** `refused`: a refusal's turn.complete still adds Bug 289's "Escape or No" line on main; Bug 359 (PR #354) takes it away. */
async function saidOnce(a: any, detail: RegExp, refused = false): Promise<void> {
  const x = await now(a); assert.deepEqual([x.status, x.blocked_why, x.activity ?? null], ['blocked', 'api_error', null], a.id)
  const said = (await failures(a)).filter((p) => p.unheard); assert.equal(said.length, 1, a.id)
  const al = await alerts(a); assert.equal(al.length, 1, a.id); assert.match(al[0].detail, detail)
  const l = await lines(a); assert.equal(l.filter((t) => t.startsWith('Turn failed')).length, 1, `${a.id}: ${l.slice(0, 4).join(' | ')}`)
  if (!refused) assert.ok(!l.some((t) => /Escape or No/.test(t)), `${a.id}: ${l.join(' | ')}`)
}

test('Bug 386: an error turn with no StopFailure is said to have failed once the wait runs out, also across a restart; what it must not catch', async () => {
  const model = await tpm(), slow = await tpm(), early = await tpm(), retried = await tpm(), plain = await tpm()
  for (const x of [model, slow, early, retried, plain]) await working(x, 'T1')
  await failed(early, 'overloaded_error') // its StopFailure reached HQ before the mod's report
  for (const x of [model, slow, early, retried]) await ends(x, 'T1', 'error')
  await ends(plain, 'T1', 'answer') // Escape or No on a question: Bug 289's line, no error
  await failed(slow, 'overloaded_error') // within the wait
  await ask(retried, 'try again b386') // the user's next message, within the wait
  // while HQ waits, the model error's turn is over (idle) and nothing says it failed yet
  assert.equal((await now(model)).status, 'idle'); assert.deepEqual(await failures(model), []); assert.equal((await alerts(model)).length, 0)
  // a restart with a short wait: the rest of the wait has run out
  hq.env.HQ_FAILURE_WAIT_S = '0.2'; await hq.restart()
  await waitFor('the model error to be said', async () => (await failures(model)).length === 1)
  await saidOnce(model, /turn ended with an error \(its terminal says which\)$/)
  assert.ok((await lines(model)).includes(SAID))
  for (const x of [slow, early]) {
    assert.deepEqual((await failures(x)).map((p) => [p.error, !!p.unheard]), [['overloaded_error', false]], x.id); assert.equal((await alerts(x)).length, 1, x.id)
  }
  assert.deepEqual(await failures(retried), []); assert.equal((await now(retried)).status, 'working'); assert.equal((await alerts(retried)).length, 0)
  assert.deepEqual(await failures(plain), []); assert.equal((await alerts(plain)).length, 0)
  assert.ok((await lines(plain)).includes('Turn ended: Escape or No on a question on its screen'))
})

test('Bug 386: with HQ up, the wait runs out; a refusal says so; a StopFailure after HQ said it adds no line or ⚠; the next turn\'s does; no repeat on restart', async () => {
  const live = await tpm(), refused = await tpm()
  for (const x of [live, refused]) await working(x, 'T1')
  await ends(live, 'T1', 'error'); await ends(refused, 'T1', 'refusal')
  await waitFor('both to be said', async () => (await failures(live)).length === 1 && (await failures(refused)).length === 1)
  await saidOnce(live, /turn ended with an error \(its terminal says which\)$/)
  await saidOnce(refused, /turn ended with an error \(the API refused its reply\)$/, true)
  assert.ok((await lines(refused)).includes('Turn failed: an error (the API refused its reply)'))
  // its real StopFailure comes after all (a slow hook): logged, but HQ said it already
  const detail = (await alerts(live))[0].detail
  await failed(live, 'overloaded_error')
  assert.deepEqual((await failures(live)).map((p) => [!!p.unheard, !!p.told]), [[true, false], [false, true]])
  await saidOnce(live, /turn ended with an error \(its terminal says which\)$/); assert.equal((await alerts(live))[0].detail, detail)
  // what it must not catch: the next turn's own StopFailure gets its line and its ⚠ (the user's message ended the last one's, Bug 178)
  await working(live, 'T2'); assert.equal((await alerts(live)).length, 0)
  await failed(live, 'rate_limit'); await ends(live, 'T2', 'error')
  assert.equal((await lines(live)).find((t) => t.startsWith('Turn failed')), 'Turn failed: rate_limit') // newest first
  assert.equal((await alerts(live)).length, 1); assert.match((await alerts(live))[0].detail, /rate_limit/)
  // a restart doesn't say any of them again: another agent's failure after it is said, theirs are not
  await hq.restart()
  const next = await tpm(); await working(next, 'T1'); await ends(next, 'T1', 'error')
  await waitFor('the new failure to be said', async () => (await failures(next)).length === 1)
  for (const x of [live, refused]) assert.equal((await failures(x)).filter((p) => p.unheard).length, 1, x.id)
  assert.equal((await failures(live)).length, 3)
})
