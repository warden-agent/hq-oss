// Auto mode on a GitHub repo (no network: see github-merge.test.ts): a finished ticket is tested on origin/main, merged through a PR
// as HQ's account, and a merge GitHub refuses stops the project with GitHub's reason.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq, bin: string, state: string
before(async () => {
  bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-agh-'))); state = path.join(bin, 'gh-state.json')
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dirname, 'fake-gh.mjs'))} "$@"\n`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, HQ_AUTO_SOON_MS: '100', HQ_AUTO_TICK_MS: '500' } })
})
after(async () => { await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })
const gh = { read: () => JSON.parse(fs.readFileSync(state, 'utf8')), write: (s: unknown) => fs.writeFileSync(state, JSON.stringify(s)) }

test('GitHub: tested on origin/main, merged through a PR; a refused merge stops the project until Resume', async () => {
  const dir = hq.repo('agh'), bare = path.join(hq.root, 'bare', 'agh.git')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agh', private: true, scripts: { test: 'node --test' } }))
  fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), "require('node:test').test('ok',()=>{})\n"); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  gh.write({ prs: {}, next: 1, bares: { 'e2e/agh': bare } })
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/agh.git')
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/agh.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json; assert.equal(repo.kind, 'github')
  const f = (await hq.api('features', { repoId: repo.id, title: 'agh', request: 'Build' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  await hq.api(`repos/${repo.id}/auto`, { on: true })
  const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
  const finish = async (title: string) => {
    const t = (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
    await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
    await hq.hook(tpm.id, { hook_event_name: 'UserPromptSubmit', prompt: 'more to come' }) // the TPM is busy, so the merge doesn't end the run: both tickets are one run, whatever the timing
    await hq.hook(e.id, exitPlanMode('Plan'))
    const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, `${title}.txt`), 'x\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', title)
    await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
    const r = await hq.mcp(e.id, 'open_pr', { title, body: `${title}.\n\n## Deviations from approved plan\nNone` }); assert.equal(r.isError, false, r.text)
    return t
  }
  const t1 = await finish('one')
  await waitFor('the merge', async () => (await tk(t1))?.status === 'merged', 15_000)
  assert.equal((await tk(t1)).pr_state, 'merged'); assert.ok(sh(bare, 'ls-tree', '--name-only', 'main').includes('one.txt'))
  assert.deepEqual(gh.read().mergeShas, [(await tk(t1)).finished_sha], 'GitHub merges only the commit HQ tested (Bug 143)')

  gh.write({ ...gh.read(), refuseMerge: 'Required status check "ci" is expected' })
  const t2 = await finish('two')
  const why = await waitFor('the stop', async () => (await hq.state()).repos.find((r: any) => r.id === repo.id).auto_stopped_why, 15_000)
  assert.match(why, /Required status check/); assert.notEqual((await tk(t2)).status, 'merged')
  gh.write({ ...gh.read(), refuseMerge: undefined })
  await hq.api(`repos/${repo.id}/auto-resume`, {})
  await waitFor('the merge after Resume', async () => (await tk(t2))?.status === 'merged', 15_000)

  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
  const run = await waitFor('the run to finish', async () => (await hq.state()).autoRuns.find((r: any) => r.status === 'finished'), 15_000)
  const undone = await hq.api(`auto-runs/${run.id}/undo`, {}); assert.equal(undone.status, 200, JSON.stringify(undone.json))
  const files = sh(bare, 'ls-tree', '--name-only', 'main'); assert.ok(!files.includes('one.txt') && !files.includes('two.txt'), files)
})

// Bug 184: on GitHub the merge takes a while (a push, the PR, GitHub's merge). A commit that reaches the branch meanwhile can't keep the ticket open, as GitHub
// has merged its PR: HQ names it, to the TPM and the user, instead of leaving it on the branch unsaid.
test('GitHub: a commit that lands while GitHub merges is named to the TPM and the user, not left on the branch unsaid', async () => {
  const dir = hq.repo('agl'), bare = path.join(hq.root, 'bare', 'agl.git')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agl', private: true, scripts: { test: 'node --test' } }))
  fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test', 'ok.test.js'), "require('node:test').test('ok',()=>{})\n"); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'tests')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  gh.write({ prs: {}, next: 1, bares: { 'e2e/agl': bare } })
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/agl.git')
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/agl.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: 'agl', request: 'Build' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  await hq.api(`repos/${repo.id}/auto`, { on: true })
  const t = (await hq.api('tickets', { featureId: f.id, title: 'one', size: 'S', spec: 'one.' })).json
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
  const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  await hq.hook(e.id, exitPlanMode('Plan'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, 'one.txt'), 'x\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'one')
  const first = sh(wt, 'rev-parse', 'HEAD'), q = JSON.stringify
  gh.write({ ...gh.read(), beforeMerge: `cd ${q(wt)} && echo late > late.txt && git add late.txt && git commit -qm 'late fix'` })
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e.id, 'open_pr', { title: 'one', body: 'one.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  const heard = await waitFor('the TPM to hear', async () => (await hq.state()).messages.find((m: any) => m.to_id === tpm.id && /got a commit after that/.test(m.body)), 15_000)
  const late = sh(wt, 'rev-parse', 'HEAD'), tk = (await hq.state()).tickets.find((x: any) => x.id === t.id); assert.notEqual(late, first)
  assert.equal(heard.body, `HQ: ${t.key} merged as HQ tested it, but ${tk.branch} got a commit after that, while it merged, which isn't in main: "${late.slice(0, 7)} late fix". `
    + `If it's still wanted, make a ticket for it: its engineer can bring it in with git cherry-pick ${first.slice(0, 7)}..${late.slice(0, 7)}.`)
  assert.equal(tk.status, 'merged'); assert.deepEqual(gh.read().mergeShas, [first])
  assert.ok(!sh(bare, 'ls-tree', '--name-only', 'main').includes('late.txt'), 'GitHub merged only what HQ tested')
  const att = (await hq.state()).attention.find((a: any) => a.kind === 'left_behind' && a.ticket_id === t.id && !a.resolved_at)
  assert.ok(att, 'the user sees it too'); assert.match(att.detail, /^agl: .+ It is still on its branch\.$/)
  await hq.hook(tpm.id, { hook_event_name: 'Stop', last_assistant_message: 'ok' }) // the run ends: its summary says so too
  const run = await waitFor('the run to finish', async () => (await hq.state()).autoRuns.find((x: any) => x.repo_id === repo.id && x.status === 'finished'), 15_000)
  assert.match(run.summary, new RegExp(`## Worth a look\\n- ${t.key}: a commit made while it merged isn't in main: it is still on ${tk.branch}`))
})

// Bug 209: a PR HQ opens on auto is one HQ tests and merges, so the TPM hears that, not "The user merges it". A ticket finished with auto off, waiting for the user.
const finishedByHand = async (name: string) => {
  const dir = hq.repo(name), bare = path.join(hq.root, 'bare', `${name}.git`)
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  gh.write({ prs: {}, next: 1, bares: { [`e2e/${name}`]: bare } })
  sh(dir, 'remote', 'add', 'origin', `git@github.com:e2e/${name}.git`)
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/${name}.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json, f = (await hq.api('features', { repoId: repo.id, title: name, request: 'Build' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'one', size: 'S', spec: 'one.' })).json
  await hq.api(`tickets/${t.id}/launch`, {})
  const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.writeFileSync(path.join(wt, 'one.txt'), 'x\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'one')
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e.id, 'open_pr', { title: 'one', body: 'one.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  const toTpm = async (): Promise<string[]> => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === tpm.id).map((m: any) => m.body) // newest first
  return { dir, repo, t, toTpm, tk: async () => (await hq.state()).tickets.find((x: any) => x.id === t.id) }
}

// The user's Make PR lands just after auto went on (the box still showed it). HELD keeps HQ's test of the ticket going meanwhile.
test('GitHub on auto: a PR HQ opens for a finished ticket is told to the TPM as one HQ tests and merges', async () => {
  const { dir, repo, t, toTpm, tk } = await finishedByHand('agp'), manual = (await toTpm()).length
  const running = async () => (await hq.state()).testRuns.some((x: any) => x.ticket_id === t.id && x.what === 'ticket' && x.state === 'running')
  assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: 'until [ -f go ]; do sleep 0.1; done' })).status, 200)
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  await waitFor(`HQ's test of ${t.key}`, running, 20_000)
  assert.equal((await hq.api(`tickets/${t.id}/make-pr`, {})).status, 200)
  const x = await tk(); assert.deepEqual([x.status, x.pr_state], ['pr_open', 'open'])
  const told = (await toTpm()).find((b) => b.startsWith(`HQ: PR #${x.pr_number} is open`))
  assert.equal(told, `HQ: PR #${x.pr_number} is open for ${t.key} (${x.branch}). HQ tests it on origin/main and merges it; you'll be told when it merges.`)
  const d = path.join(dir, '.claude', 'worktrees'); fs.writeFileSync(path.join(d, fs.readdirSync(d).find((n) => n.startsWith('hq-test-'))!, 'go'), '')
  await waitFor('the merge', async () => (await tk())?.status === 'merged', 20_000)
  assert.deepEqual([(await tk()).pr_number, gh.read().merged], [x.pr_number, [x.pr_number]], 'HQ merged the PR it opened')
  const onAuto = (await toTpm()).slice(0, -manual) // what HQ said once auto was on
  assert.ok(!onAuto.some((b) => /The user (merges|opens|tries)/.test(b)), onAuto.join('\n'))
})

// What the fix must not catch: auto mode stopped (here at GitHub's refusal of the PR) leaves the merge to the user until Resume, as the board does (Bug 193).
test('GitHub on auto, stopped: the PR the watcher opens after a refusal is the user\'s to merge until Resume', async () => {
  const { repo, t, toTpm, tk } = await finishedByHand('ags')
  gh.write({ ...gh.read(), refuseCreate: 'Resource not accessible by integration' })
  assert.equal((await hq.api(`tickets/${t.id}/make-pr`, {})).status, 409); assert.equal((await tk()).pr_state, 'not_opened')
  assert.equal((await hq.api(`repos/${repo.id}/test-cmd`, { cmd: 'true' })).status, 200)
  assert.equal((await hq.api(`repos/${repo.id}/auto`, { on: true })).status, 200)
  const why = await waitFor('the stop', async () => (await hq.state()).repos.find((r: any) => r.id === repo.id).auto_stopped_why, 15_000)
  assert.match(why, /couldn't open the PR/)
  gh.write({ ...gh.read(), refuseCreate: undefined })
  await hq.api(`repos/${repo.id}/sync`, {}) // repo.synced: the watcher tries the PR again
  const x = await waitFor('the PR', async () => { const y = await tk(); return y?.status === 'pr_open' && y }, 15_000)
  assert.equal((await toTpm()).find((b) => b.startsWith(`HQ: PR #${x.pr_number} is open`)),
    `HQ: PR #${x.pr_number} is open for ${t.key} (${x.branch}). The user merges it; you'll be told when it merges.`)
  assert.equal((await hq.api(`repos/${repo.id}/auto-resume`, {})).status, 200)
  await waitFor('the merge after Resume', async () => (await tk())?.status === 'merged', 20_000)
  assert.deepEqual(gh.read().merged, [x.pr_number])
})
