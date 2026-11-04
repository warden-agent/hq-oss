// A GitHub repo HQ can't push to (an open-source one, say) is worked on locally, with no network: the same url.insteadOf +
// fake gh setup as github-conflicts.test.ts, with the fake saying HQ has no push access. The user hears so once; a finished
// ticket waits for Merge into main (nothing pushed, no PR); the merge lands in local main only; the next ticket builds on it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq, bin: string, state: string
before(async () => {
  bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-lo-'))); state = path.join(bin, 'gh-state.json')
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dirname, 'fake-gh.mjs'))} "$@"\n`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state } })
})
after(async () => { await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

test("local-only: a GitHub repo HQ can't push to gets Merge into main, nothing pushed, and the next ticket builds on local main", async () => {
  fs.writeFileSync(state, JSON.stringify({ prs: {}, next: 1, push: false }))
  const dir = hq.repo('oss'), bare = path.join(hq.root, 'bare', 'oss.git')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/oss.git') // the ssh form: insteadOf only rewrites the https URL HQ fetches
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/oss.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json
  assert.deepEqual([repo.kind, repo.sync_ok, repo.can_push], ['github', 1, 0], JSON.stringify(repo))
  const notices = async () => (await hq.state()).attention.filter((a: any) => a.kind === `repo_local:${repo.id}`)
  assert.match((await notices())[0]?.detail ?? '', /^HQ can't push to oss, so work there stays on this Mac/)
  await hq.api(`repos/${repo.id}/sync`, {}); assert.equal((await notices()).length, 1) // told once
  const f = (await hq.api('features', { repoId: repo.id, title: 'oss', request: 'Build oss' })).json
  const ticket = async (title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
  const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
  const eng = (t: any) => waitFor(`an engineer on ${t.key}`, async () =>
    (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = (t: any) => path.join(dir, '.claude', 'worktrees', t.key)
  const t1 = await ticket('Orders'), t2 = await ticket('Invoices')
  await hq.api(`tickets/${t1.id}/launch`, {}); const e1 = await eng(t1)
  fs.writeFileSync(path.join(wt(t1), 'orders.txt'), 'orders\n'); sh(wt(t1), 'add', '.'); sh(wt(t1), 'commit', '-qm', 'orders')
  await hq.mcp(e1.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const done = await hq.mcp(e1.id, 'open_pr', { title: 'Orders', body: 'Adds orders.\n\n## Deviations from approved plan\nNone' })
  assert.match(done.text, /^Done\. The user merges hq\/oss\/T-01-orders into main from HQ\./, done.text)
  assert.deepEqual([(await tk(t1)).status, (await tk(t1)).pr_state], ['pr_ready', 'local'])
  const log = fs.readFileSync(`${state}.log`, 'utf8')
  assert.ok(!/"POST"|"pr","list"/.test(log), log) // no PR opened or looked up
  assert.equal(sh(bare, 'branch', '--list', 'hq/*'), '') // nothing pushed
  const bareMain = sh(bare, 'rev-parse', 'main')
  const m = await hq.api(`tickets/${t1.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json))
  await waitFor('T-01 merged', async () => (await tk(t1)).status === 'merged')
  assert.equal(sh(dir, 'show', 'main:orders.txt'), 'orders')
  assert.equal(sh(bare, 'rev-parse', 'main'), bareMain) // GitHub's main untouched
  await hq.api(`tickets/${t2.id}/launch`, {}); await eng(t2)
  assert.equal(fs.readFileSync(path.join(wt(t2), 'orders.txt'), 'utf8'), 'orders\n') // built on local main, not origin/main
})
