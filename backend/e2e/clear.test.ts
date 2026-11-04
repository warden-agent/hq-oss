// Clear project end to end (see harness.ts): the TPM and an engineer mid-ticket each get the handoff request, write their note
// and stop; nothing new starts in the repo meanwhile; then the board is gone, the half-done code is a WIP commit on the branch,
// the notes are in ~/.hq/archive, and another repo's work is untouched. The project's TPM comes back (Bug 52): a new session from
// its note, without the old tickets, and ticket keys go on counting.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startHq, waitFor, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq({ env: { HQ_FRESH_START_TIMEOUT_S: '30' } }); await hq.api('settings', { key: 'concurrency_cap', value: 20 }) })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ dir: string; repo: any; f: any; tpm: any }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f, tpm }
}
const agent = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
async function building(f: any, title: string): Promise<{ t: any; eng: any }> {
  const t = (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
  const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
  await waitFor('the engineer', async () => (await agent(eng.id))?.status === 'working')
  const b = (await hq.modNext(eng.id)).batch; await hq.modEvent(eng.id, { kind: 'batch_received', id: b.id })
  await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  const held = hq.hook(eng.id, exitPlanMode('Plan: write hello.txt.'))
  const rv = await waitFor('the review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  await hq.api(`reviews/${rv.id}/answer`, { verdict: 'approve' }); await held
  return { t: (await hq.state()).tickets.find((x: any) => x.id === t.id), eng }
}

test('Clear project: notes first, then the board goes; the code is kept on its branch and the notes are archived', async () => {
  const other = await setup('other-app')
  const { dir, repo, f, tpm } = await setup('demo-clear')
  const { t, eng } = await building(f, 'Hello')
  fs.writeFileSync(path.join(t.worktree_path, 'hello.txt'), 'half done\n')

  const r = await hq.api(`repos/${repo.id}/clear`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual([...r.json.noting].sort(), [eng.display_name, tpm.display_name].sort()); assert.equal(r.json.done, false)
  const asks = (await hq.state()).messages.filter((m: any) => m.reason === 'fresh_start' && [eng.id, tpm.id].includes(m.to_id))
  assert.equal(asks.length, 2); for (const m of asks) assert.match(m.body, /clearing this project/)
  assert.ok((await hq.state()).repos.find((x: any) => x.id === repo.id).clearing_at)
  // Meanwhile nothing new starts there, and a second clear is refused
  const nf = await hq.api('features', { repoId: repo.id, title: 'more', request: 'more' }); assert.equal(nf.status, 500); assert.match(nf.json.error, /being cleared/)
  assert.equal((await hq.api(`repos/${repo.id}/clear`, {})).status, 409)

  assert.equal((await hq.mcp(eng.id, 'write_handoff_note', { text: '## Where I stopped\n- hello.txt half written (ENG-NOTE)' })).isError, false)
  assert.equal((await hq.mcp(tpm.id, 'write_handoff_note', { text: '## What the user wants\n- a demo (TPM-NOTE)' })).isError, false)
  await waitFor('the board gone', async () => !(await hq.state()).features.some((x: any) => x.repo_id === repo.id), 30_000)

  const s = await hq.state()
  assert.equal(s.repos.find((x: any) => x.id === repo.id).clearing_at, null)
  assert.ok(!s.agents.some((a: any) => [eng.id, tpm.id].includes(a.id)) && !s.tickets.some((x: any) => x.id === t.id))
  assert.ok(s.features.some((x: any) => x.id === other.f.id) && (await agent(other.tpm.id)).status === 'working') // the other repo goes on
  assert.match(s.attention.find((a: any) => a.kind === `repo_cleared:${repo.id}`).detail, /Cleared demo-clear: 1 feature and 1 ticket/)
  // The code: a WIP commit on the branch, the worktree gone
  assert.ok(!fs.existsSync(t.worktree_path))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  assert.equal(git('log', '-1', '--format=%s', t.branch), 'WIP (HQ clear): T-01 Hello'); assert.equal(git('show', `${t.branch}:hello.txt`), 'half done')
  // The archive
  const base = path.join(hq.hqHome, 'archive', 'demo-clear'), [stamp] = fs.readdirSync(base), arch = path.join(base, stamp!)
  const [folder] = fs.readdirSync(arch).filter((x) => x !== 'SUMMARY.md' && x !== 'tpm')
  assert.match(folder!, /^F-1-demo-clear-/)
  assert.match(fs.readFileSync(path.join(arch, folder!, 'tickets', 'T-01', 'HANDOFF.md'), 'utf8'), /ENG-NOTE/)
  assert.match(fs.readFileSync(path.join(arch, 'tpm', 'HANDOFF.md'), 'utf8'), /TPM-NOTE/)
  assert.match(fs.readFileSync(path.join(arch, folder!, 'FEATURE.md'), 'utf8'), /## Request \(verbatim\)\n\nBuild demo-clear/)
  assert.match(fs.readFileSync(path.join(arch, 'SUMMARY.md'), 'utf8'), /\| T-01 Hello \| implementing \| hq\/demo-clear\/T-01-hello \| [0-9a-f]+ \(WIP commit\) \|/)

  // The TPM comes back: a new session that has its note and knows the board was cleared, with nothing on it
  const next = await waitFor('the TPM back', async () => { const id = (await hq.state()).repos.find((x: any) => x.id === repo.id).tpm_agent_id; return id && id !== tpm.id ? id : null }, 30_000)
  await waitFor('it to run', async () => (await agent(next))?.status === 'working')
  const prompt = fs.readFileSync(path.join(hq.hqHome, 'agents', next, 'prompt.md'), 'utf8')
  assert.match(prompt, /^You are taking over as the TPM of project "demo-clear"/); assert.match(prompt, /The user just cleared the board: every ticket that was on it is gone/)
  assert.match(prompt, /On the board now:\n- nothing/); assert.match(prompt, /TPM-NOTE/); assert.doesNotMatch(prompt, /T-01/)
  // A new request is a new branch on the same TPM, and keys go on counting
  const again = await hq.api('features', { repoId: repo.id, title: 'fresh', request: 'Start over' }); assert.equal(again.status, 200, JSON.stringify(again.json))
  assert.equal(again.json.tpm_agent_id, next); assert.equal(again.json.handle, 'F-2')
  assert.equal((await hq.mcp(next, 'create_ticket', { feature: 'F-2', title: 'Again', size: 'S', spec: 'x' })).text, 'Created T-02 in F-2: Again')
})
