// One TPM per project (Bug 52) end to end (see harness.ts). The project's TPM stays when a feature is done (Bug 34's auto-stop is
// gone), the next request is a new feature on the same TPM, and its tickets count on from the first ones. The TPM box's message
// starts the TPM with the message as its launch prompt (a new project's first message becomes CONTEXT.md), reaches a running TPM
// as a message, and brings a stopped one back from its note. The TPM makes features itself with start_feature.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_DONE_TPM_IDLE_S: '2' } }) })
after(async () => { await hq?.stop() })

const state = () => hq.state()
const status = async (id: string) => (await state()).agents.find((a: any) => a.id === id)?.status
const tpmOf = async (repoId: string): Promise<string | null> => (await state()).repos.find((r: any) => r.id === repoId).tpm_agent_id
const prompt = (id: string) => fs.readFileSync(path.join(hq.hqHome, 'agents', id, 'prompt.md'), 'utf8')
/** A ticket built and merged by a fake engineer. */
async function merged(dir: string, t: any) {
  const e = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await status(e.id)) === 'working')
  const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, `${t.key}.txt`), 'x'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', t.title)
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: t.title }); await hq.mcp(e.id, 'open_pr', { title: t.title, body: `${t.title}\n\n## Deviations from approved plan\nNone` })
  assert.equal((await hq.api(`tickets/${t.id}/merge`, {})).status, 200)
}

test('Bug 52: the TPM box starts the project\'s TPM; it makes features itself, stays when one is done, and takes the next request', async () => {
  const dir = hq.repo('box'); fs.rmSync(path.join(dir, 'server.js')); sh(dir, 'commit', '-qam', 'almost empty') // a non-empty repo
  const repo = (await hq.api('repos', { path: dir })).json
  assert.equal(repo.tpm_agent_id, null) // nothing runs until the user writes
  const first = await hq.api(`repos/${repo.id}/message`, { body: 'I want a page that says hello' }); assert.equal(first.status, 200, JSON.stringify(first.json))
  const tpm = first.json.agent.id
  assert.equal(await tpmOf(repo.id), tpm); await waitFor('the TPM', async () => (await status(tpm)) === 'working')
  assert.match(prompt(tpm), /^You are the TPM of project "box"/)
  assert.match(prompt(tpm), /The user's new message, verbatim:\n"""\nI want a page that says hello\n"""\n\nAct on it\. New work: start_feature/)
  assert.ok((await state()).messages.some((m: any) => m.id === first.json.message.id && m.delivered_at && m.repo_id === repo.id)) // shown in the chat

  // The TPM makes the feature and its tickets
  const sf = await hq.mcp(tpm, 'start_feature', { title: 'Hello page', request: 'I want a page that says hello' })
  assert.equal(sf.text, 'Started F-1 "Hello page". Add its tickets with create_ticket(feature: "F-1").')
  assert.equal((await hq.mcp(tpm, 'create_ticket', { title: 'Say hello', size: 'S', spec: 'hello' })).text, 'Created T-01 in F-1: Say hello') // the only open feature
  assert.match((await hq.mcp(tpm, 'create_ticket', { feature: 'F-9', title: 'x', size: 'S', spec: 'x' })).text, /There's no feature F-9/)
  const t1 = (await state()).tickets.find((t: any) => t.key === 'T-01')
  await merged(dir, t1)
  await hq.hook(tpm, { hook_event_name: 'Stop', last_assistant_message: 'All set.' })
  await new Promise((r) => setTimeout(r, 4000)) // longer than the old done-TPM idle stop (HQ_DONE_TPM_IDLE_S=2)
  assert.equal(await status(tpm), 'idle') // the feature is done; the project's TPM stays
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'workspaces', `repo-${repo.id}`, 'tpm', 'PROJECT.md'), 'utf8'), /## Built so far\n\n- F-1 Hello page: T-01 Say hello/)

  // The next request: a message to the running TPM, a second feature, keys counting on
  const next = await hq.api(`repos/${repo.id}/message`, { body: 'now add a dark mode switch' })
  assert.equal(next.json.agent.id, tpm); assert.equal(next.json.message.delivered_at, null) // the mod delivers it
  assert.equal((await hq.mcp(tpm, 'start_feature', { title: 'Dark mode', request: 'now add a dark mode switch' })).text.slice(0, 10), 'Started F-')
  assert.equal((await hq.mcp(tpm, 'create_ticket', { feature: 'F-2', title: 'Switch', size: 'S', spec: 'x' })).text, 'Created T-02 in F-2: Switch')
  assert.match((await hq.mcp(tpm, 'create_ticket', { title: 'Which?', size: 'S', spec: 'x' })).text, /Created T-03 in F-2/) // F-1 is done: F-2 is the only open one
  const listed = JSON.parse((await hq.mcp(tpm, 'list_tickets', {})).text)
  assert.deepEqual(listed.map((f: any) => [f.feature, f.done, f.tickets.map((t: any) => t.key)]), [['F-1', true, ['T-01']], ['F-2', false, ['T-02', 'T-03']]])

  // A stopped TPM comes back from its note when the user writes again
  await hq.api(`agents/${tpm}/stop`, {}); await waitFor('it to stop', async () => (await status(tpm)) === 'exited')
  const back = await hq.api(`repos/${repo.id}/message`, { body: 'how is it going?' }); assert.equal(back.status, 200, JSON.stringify(back.json))
  const tpm2 = back.json.agent.id; assert.notEqual(tpm2, tpm)
  assert.match(prompt(tpm2), /^You are taking over as the TPM of project "box"/)
  assert.match(prompt(tpm2), /On the board now:\n- F-2 Dark mode\n  - T-02 \(S\) Switch: ready to start/)
  assert.match(prompt(tpm2), /The user's new message, verbatim:\n"""\nhow is it going\?\n"""/)
  assert.match(prompt(tpm2), /Last messages between the user and the TPM, oldest first:\n- User: I want a page that says hello\n- TPM: All set\./) // what was said
  assert.equal((await state()).messages.find((m: any) => m.id === next.json.message.id).to_id, tpm2) // what never reached the old one waits for the new one
})

test('Bug 52: a new project\'s first message becomes its CONTEXT.md; an empty message is refused', async () => {
  const dir = path.join(hq.root, 'repos', 'fresh'); fs.mkdirSync(dir, { recursive: true }); sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'commit', '-q', '--allow-empty', '-m', 'start')
  const repo = (await hq.api('repos', { path: dir })).json
  assert.equal((await hq.api(`repos/${repo.id}/message`, { body: '   ' })).status, 409)
  const r = await hq.api(`repos/${repo.id}/message`, { body: 'An order tracker for my team' }); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'projects', repo.id, 'CONTEXT.md'), 'utf8'), /An order tracker for my team/)
  assert.match(prompt(r.json.agent.id), /CONTEXT\.md in your workspace is what the user asked for when this project started/)
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'workspaces', `repo-${repo.id}`, 'tpm', 'CONTEXT.md'), 'utf8'), /An order tracker for my team/)
})
