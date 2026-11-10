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
