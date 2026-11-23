// Bug 294: while a Clear is under way (its TPM and an engineer still writing their handoff notes), every action that would start, finish or
// change work in the project is refused in plain words, from the page (the API it calls) and from the agents' own tools (MCP), and the
// clear still finishes. Clear clashes had turned up one at a time (Bugs 152, 177, 196, 197/220, 219, 231); this test sends them all at once.
// Each action is checked on its own and every refusal that doesn't come is listed, so a broken guard names the action it lets through.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_FRESH_START_TIMEOUT_S: '30' } }); await hq.api('settings', { key: 'concurrency_cap', value: 20 }) })
after(async () => { await hq?.stop() })

const NAME = 'b294clr' // unique across the e2e files (they're merged together)
const agent = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
/** An engineer on a new ticket, through its plan: `approve` takes it on to implementing, otherwise its plan waits for review. */
async function engineer(f: any, title: string, approve: boolean): Promise<{ t: any; eng: any; review: any }> {
  const t = (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor(`the engineer on ${t.key}`, async () => (await agent(eng.id))?.status === 'working')
  const b = (await hq.modNext(eng.id)).batch; await hq.modEvent(eng.id, { kind: 'batch_received', id: b.id })
  await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  const held = hq.hook(eng.id, exitPlanMode(`Plan: ${title}.`)).catch(() => null) // a fake engineer held at the gate never hangs up (a real one dies with its stop)
  const review = await waitFor(`${t.key}'s review`, async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  if (approve) { await hq.api(`reviews/${review.id}/answer`, { verdict: 'approve' }); await held }
  return { t, eng, review }
}
/** What HQ answered an action: its refusal, or how it went through. */
type Said = { refused: string | null; went: string }
const viaApi = async (p: string, body: unknown = {}): Promise<Said> => {
  const r = await hq.api(p, body), error = r.status !== 200 || r.json?.ok === false ? String(r.json?.error ?? r.json) : null
  return { refused: error, went: `${r.status} ${JSON.stringify(r.json).slice(0, 200)}` }
}
const viaMcp = async (agentId: string, tool: string, args: Record<string, unknown>): Promise<Said> => {
  const r = await hq.mcp(agentId, tool, args); return { refused: r.isError ? r.text : null, went: r.text.slice(0, 200) }
}

test('Bug 294: during a Clear every action on the project is refused in plain words, nothing new starts, and the clear finishes', async () => {
  const dir = hq.repo(NAME)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: NAME, request: `Build ${NAME}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const one = await engineer(f, 'Hello', true) // mid-work: asked for a note
  const two = await engineer(f, 'Plan', false) // its plan waits: stopped at once
  const three = (await hq.api('tickets', { featureId: f.id, title: 'Later', size: 'S', spec: 'Later.' })).json // nobody on it yet
  const ask = await hq.mcp(tpm.id, 'ask_user', { question: 'Dark or light?', choices: ['Dark', 'Light'] }); assert.equal(ask.isError, false, ask.text)
  const askId = (await hq.state()).asks.find((a: any) => a.repo_id === repo.id).id
  assert.equal((await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })).status, 200) // Launch would start the app straight away
  const s0 = await hq.state(), ids = new Set(s0.agents.map((a: any) => a.id)), said0 = new Set(s0.messages.map((m: any) => m.id))

  const r = await hq.api(`repos/${repo.id}/clear`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual([...r.json.noting].sort(), [one.eng.display_name, tpm.display_name].sort()); assert.equal(r.json.stopped.length, 1)
  await waitFor('the engineer at plan review stopped', async () => (await agent(two.eng.id))?.status === 'exited')

  const CLOSED = `${NAME} is being cleared; wait until it's done.`
  const actions: [string, () => Promise<Said>, string][] = [
    // The page (what its buttons call)
    ['Approve the plan', () => viaApi(`reviews/${two.review.id}/answer`, { verdict: 'approve' }), CLOSED],
    ['Revise the plan', () => viaApi(`reviews/${two.review.id}/answer`, { verdict: 'revise', message: 'smaller', note: 'smaller' }), CLOSED],
    ['Start (every ready ticket)', () => viaApi(`repos/${repo.id}/start-ready`), CLOSED],
    ["Start (a feature's ready tickets)", () => viaApi(`features/${f.id}/start-ready`), CLOSED],
    ['Start an engineer on a ticket', () => viaApi(`tickets/${three.id}/launch`), CLOSED],
    ['Launch app', () => viaApi(`previews/${repo.id}/start`), CLOSED],
    ['Launch helper', () => viaApi(`previews/${repo.id}/setup`), CLOSED],
    ['Merge into main', () => viaApi(`tickets/${one.t.id}/merge`), CLOSED],
    ['Try again (auto mode, a parked ticket)', () => viaApi(`tickets/${three.id}/auto-retry`), CLOSED], // Bug 335
    ['Make PR', () => viaApi(`tickets/${one.t.id}/make-pr`), CLOSED],
    ["The TPM box's message", () => viaApi(`repos/${repo.id}/message`, { body: 'Also add a footer.' }), CLOSED],
    ["A message in the TPM's Agent tab", () => viaApi(`agents/${tpm.id}/message`, { body: 'One more thing.', reason: 'fyi' }), CLOSED],
    ["Urgent in the engineer's Agent tab", () => viaApi(`agents/${one.eng.id}/message`, { body: 'Stop and do this instead.', urgent: true }), CLOSED],
    ["An answer to the TPM's question", () => viaApi(`asks/${askId}/answer`, { answer: 'Dark' }), CLOSED],
    // Bug 347: ✕ would stop the engineer mid-note (HQ's empty note archived instead) and the archive would say "cancelled"
    ['✕ on a ticket whose engineer writes its note', () => viaApi(`tickets/${one.t.id}/cancel`), CLOSED],
    ['✕ on a ticket nobody is on', () => viaApi(`tickets/${three.id}/cancel`), CLOSED],
    ['✕ on the feature', () => viaApi(`features/${f.id}/cancel`), CLOSED],
    ['Auto mode on', () => viaApi(`repos/${repo.id}/auto`, { on: true }), CLOSED],
    ['Auto mode off', () => viaApi(`repos/${repo.id}/auto`, { on: false }), CLOSED],
    ['Start TPM again', () => viaApi(`repos/${repo.id}/restart-tpm`), CLOSED],
    ['A new request', () => viaApi('features', { repoId: repo.id, title: 'more', request: 'More.' }), `Error: ${CLOSED}`],
    ['A second Clear', () => viaApi(`repos/${repo.id}/clear`), `${NAME} is already being cleared.`],
    ['Remove from HQ', () => viaApi(`repos/${repo.id}/remove`, { landing: null }), CLOSED],
    ['Write the first map', () => viaApi(`repos/${repo.id}/first-map`), CLOSED], // Bug 333: it would start the app the Clear stopped
    // The agents' tools: the TPM and the engineer are still running, and may act on something else before they write their notes
    ['start_feature (TPM)', () => viaMcp(tpm.id, 'start_feature', { title: 'Footer', request: 'Add a footer.' }), CLOSED],
    ['create_ticket (TPM)', () => viaMcp(tpm.id, 'create_ticket', { title: 'Footer', size: 'S', spec: 'x', criteria: [{ kind: 'backend', text: 'It says hi.' }] }), `Error: ${CLOSED}`],
    ['assign_ticket (TPM)', () => viaMcp(tpm.id, 'assign_ticket', { key: three.key }), `Error: ${CLOSED}`],
    ['ask_user (TPM)', () => viaMcp(tpm.id, 'ask_user', { question: 'Footer too?', choices: ['Yes', 'No'] }), CLOSED], // nobody may answer it now
    ['cancel_ticket (TPM)', () => viaMcp(tpm.id, 'cancel_ticket', { key: three.key, why: 'Not needed.' }), CLOSED], // it asks the user first
    ['open_pr (engineer)', () => viaMcp(one.eng.id, 'open_pr', { title: 'Hello', body: '## Deviations from approved plan\nNone.' }), CLOSED],
  ]
  const problems: string[] = []
  for (const [what, act, words] of actions) {
    const said = await act().catch((e: Error): Said => ({ refused: `threw: ${e.message}`, went: '' })) // say which, and go on to the next
    if (said.refused !== words) problems.push(`${what}: ${said.refused === null ? `went through (${said.went})` : `refused with other words: ${said.refused}`}`)
  }
  assert.deepEqual(problems, [])

  // Nothing of it happened: no new feature, ticket or agent, the plan unanswered, the app and auto mode off, the question still open
  const s = await hq.state()
  assert.deepEqual(s.features.filter((x: any) => x.repo_id === repo.id).map((x: any) => x.id), [f.id])
  assert.deepEqual(s.tickets.filter((x: any) => x.feature_id === f.id).map((x: any) => `${x.key} ${x.status}`).sort(),
    [`${one.t.key} implementing`, `${two.t.key} plan_review`, `${three.key} queued`])
  assert.deepEqual(s.agents.filter((a: any) => !ids.has(a.id)).map((a: any) => a.id), [])
  assert.equal((await agent(two.eng.id)).status, 'exited'); assert.equal(s.tickets.find((x: any) => x.id === three.id).assignee_agent_id, null)
  assert.notEqual(s.previews.find((x: any) => x.id === repo.id)?.status, 'running'); assert.equal(s.repos.find((x: any) => x.id === repo.id).auto_mode, 0)
  assert.notEqual(s.maps.find((x: any) => x.id === repo.id)?.first?.running, true) // Bug 333: no first-map session either
  assert.deepEqual(s.asks.filter((a: any) => a.repo_id === repo.id).map((a: any) => `${a.id} ${a.answered_at}`), [`${askId} null`]) // still open, and no new one
  assert.deepEqual(s.messages.filter((m: any) => !said0.has(m.id) && m.from_id === 'user').map((m: any) => m.body), []) // none sent, to be lost with the board

  // The clear goes on as if nothing had been asked: both notes, then the board goes and the TPM comes back
  assert.equal((await hq.mcp(one.eng.id, 'write_handoff_note', { text: '## Where I stopped\n- hello (B294-ENG)' })).isError, false)
  assert.equal((await hq.mcp(tpm.id, 'write_handoff_note', { text: '## What the user wants\n- a demo (B294-TPM)' })).isError, false)
  await waitFor('the board gone', async () => !(await hq.state()).features.some((x: any) => x.repo_id === repo.id), 30_000)
  const next = await waitFor('the TPM back', async () => { const id = (await hq.state()).repos.find((x: any) => x.id === repo.id).tpm_agent_id; return id && id !== tpm.id ? id : null }, 30_000)
  await waitFor('it to run', async () => (await agent(next))?.status === 'working')
  const end = await hq.state()
  assert.equal(end.repos.find((x: any) => x.id === repo.id).clearing_at, null)
  assert.deepEqual(end.agents.filter((a: any) => a.repo_id === repo.id && a.status !== 'exited').map((a: any) => a.id), [next]) // only the new TPM runs
  const base = path.join(hq.hqHome, 'archive', NAME), [stamp] = fs.readdirSync(base)
  assert.match(fs.readFileSync(path.join(base, stamp!, 'SUMMARY.md'), 'utf8'), new RegExp(`\\| ${three.key} Later \\| queued \\|`)) // T-03 never started
  // After the clear the project takes work again: what was refused is no longer
  assert.equal((await hq.api(`repos/${repo.id}/message`, { body: 'Start over, please.' })).status, 200)
})
