// Bug 43: the TPM asks the user with ask_user; the question waits on the board ("Your turn") until the user answers it with a
// choice button (the TPM gets the answer as the user's message) or writes to the TPM. Asks belong to the project (Bug 52): an
// answer to a TPM that isn't running starts it again with the answer.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ f: any; tpm: any }> {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const b = (await hq.modNext(tpm.id)).batch; await hq.modEvent(tpm.id, { kind: 'batch_received', id: b.id })
  await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  return { f, tpm }
}
const asks = async (f: any) => (await hq.state()).asks.filter((a: any) => a.repo_id === f.repo_id)
/** The TPM ends its turn, so HQ hands it the next batch. */
async function nextBatch(agentId: string): Promise<string> {
  await hq.hook(agentId, { hook_event_name: 'Stop', last_assistant_message: 'Done for now.' })
  const b = await waitFor('a batch for the TPM', async () => (await hq.modNext(agentId)).batch)
  await hq.modEvent(agentId, { kind: 'batch_received', id: b.id }); return b.text
}

test('Bug 43: ask_user shows the question until a choice answers it, and the TPM gets the answer', async () => {
  const { f, tpm } = await setup('ask-choice')
  const r = await hq.mcp(tpm.id, 'ask_user', { question: 'Should the app open dark, light, or follow the device?', choices: ['Dark', 'Light', 'Follow the device'] })
  assert.equal(r.isError, false, r.text); assert.match(r.text, /Your turn/)
  const [a] = await asks(f); assert.equal(a.question, 'Should the app open dark, light, or follow the device?')
  assert.deepEqual(JSON.parse(a.choices), ['Dark', 'Light', 'Follow the device']); assert.equal(a.answered_at, null)
  assert.ok((await hq.mcp(tpm.id, 'ask_user', { question: 'x', choices: ['1', '2', '3', '4', '5'] })).isError) // at most 4 choices
  assert.ok((await hq.mcp(tpm.id, 'ask_user', { question: '' })).isError)

  const ans = await hq.api(`asks/${a.id}/answer`, { answer: 'Follow the device' }); assert.equal(ans.status, 200, JSON.stringify(ans.json))
  assert.deepEqual(await asks(f), [])
  assert.match(await nextBatch(tpm.id), /You asked: "Should the app open dark, light, or follow the device\?"\nThe user's answer: Follow the device/)
  const again = await hq.api(`asks/${a.id}/answer`, { answer: 'Dark' }); assert.equal(again.status, 409); assert.match(again.json.error, /already answered/)
})

test('Bug 43: writing to the TPM answers its open questions; no TPM running means start it first; cancelling closes them', async () => {
  const { f, tpm } = await setup('ask-talk')
  await hq.mcp(tpm.id, 'ask_user', { question: 'Which page first?' }); await hq.mcp(tpm.id, 'ask_user', { question: 'Keep the old colours?', choices: ['Yes', 'No'] })
  assert.equal((await asks(f)).length, 2)
  await hq.api(`agents/${tpm.id}/message`, { body: 'Home first, and no, new colours.', reason: 'fyi' })
  assert.deepEqual(await asks(f), [])

  await hq.mcp(tpm.id, 'ask_user', { question: 'Ship it on Friday?', choices: ['Yes', 'No'] })
  const [open] = await asks(f)
  await hq.api(`agents/${tpm.id}/stop`, {})
  await waitFor('the TPM to stop', async () => (await hq.state()).agents.find((x: any) => x.id === tpm.id)?.status === 'exited')
  // The answer brings the project's TPM back, with the answer in its launch prompt (Bug 52)
  const r = await hq.api(`asks/${open.id}/answer`, { answer: 'Yes' }); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(await asks(f), [])
  const next = await waitFor('a new TPM', async () => { const id = (await hq.state()).repos.find((x: any) => x.id === f.repo_id).tpm_agent_id; return id !== tpm.id ? id : null })
  const b = await waitFor('its launch prompt', async () => (await hq.modNext(next)).batch)
  assert.match(b.text, /You are taking over as the TPM of project "ask-talk"/)
  assert.match(b.text, /The user's new message, verbatim:\n"""\nYou asked: "Ship it on Friday\?"\nThe user's answer: Yes\n"""/)
})
