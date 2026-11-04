// Bug 45: on a GitHub repo, a finished ticket waits for the user's choice (no PR yet). Merge opens a PR and merges it on
// GitHub, then it's handled like any merge (engineer stops, what's ready now, local main fast-forwards); Merge also works on
// an open PR; Make PR only opens one; GitHub's refusal and a conflict with main leave the ticket as it was. No network: the
// fake gh (fake-gh.mjs) answers and makes the merge commit in a local bare repo that git's url.insteadOf points github.com at.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq, bin: string, state: string
before(async () => {
  bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-ghm-'))); state = path.join(bin, 'gh-state.json')
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dirname, 'fake-gh.mjs'))} "$@"\n`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state } })
})
after(async () => { await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

const gh = { read: () => JSON.parse(fs.readFileSync(state, 'utf8')), write: (s: unknown) => fs.writeFileSync(state, JSON.stringify(s)) }
const calls = () => fs.readFileSync(`${state}.log`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])

test('Bug 45: Merge from HQ opens and merges the PR on GitHub; Make PR only opens one; refusals change nothing', async () => {
  const dir = hq.repo('ghm'), bare = path.join(hq.root, 'bare', 'ghm.git')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  gh.write({ prs: {}, next: 1, bares: { 'e2e/ghm': bare } })
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/ghm.git')
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/ghm.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json; assert.equal(repo.kind, 'github')
  const f = (await hq.api('features', { repoId: repo.id, title: 'ghm', request: 'Build ghm' })).json
  const ticket = async (title: string, deps: string[] = []) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.`, depends_on: deps })).json
  const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
  const wt = (t: any) => path.join(dir, '.claude', 'worktrees', t.key)
  const finish = async (t: any, file: string) => {
    await hq.api(`tickets/${t.id}/launch`, {})
    const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
    fs.writeFileSync(path.join(wt(t), file), `${t.key}\n`); sh(wt(t), 'add', '.'); sh(wt(t), 'commit', '-qm', t.title)
    await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
    const r = await hq.mcp(e.id, 'open_pr', { title: t.title, body: `${t.title}.\n\n## Deviations from approved plan\nNone` }); assert.equal(r.isError, false, r.text)
    return e
  }
  const t1 = await ticket('Orders'), t2 = await ticket('Invoices'), t3 = await ticket('Billing', ['T-01'])

  // Finished: pushed, no PR, waiting for the user's choice
  const e1 = await finish(t1, 'orders.txt'), e2 = await finish(t2, 'orders.txt') // both add orders.txt: T-02 conflicts once T-01 is in
  assert.ok(e2)
  let x = await tk(t1); assert.deepEqual([x.status, x.pr_state, x.pr_number], ['pr_ready', 'waiting', null])
  assert.ok(!calls().some((c) => c.includes('POST')), 'no PR opened on finish')
  assert.equal(sh(bare, 'rev-parse', `refs/heads/${x.branch}`), sh(dir, 'rev-parse', `refs/heads/${x.branch}`)) // pushed

  // Make PR only opens one (nothing is merged)
  let r = await hq.api(`tickets/${t2.id}/make-pr`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual([(await tk(t2)).status, (await tk(t2)).pr_number, gh.read().merged], ['pr_open', 1, undefined])

  // GitHub refuses the merge: the reason comes back and the ticket isn't merged (its new PR stays open)
  gh.write({ ...gh.read(), refuseMerge: 'Required status check "ci" is expected' })
  r = await hq.api(`tickets/${t1.id}/merge`, {}); assert.equal(r.status, 409)
  assert.match(r.json.error, /GitHub won't merge PR #2: Required status check "ci" is expected\. A required check, a review rule or a conflict is in the way/)
  x = await tk(t1); assert.deepEqual([x.status, x.pr_number], ['pr_open', 2])

  // Merge: the open PR is merged on GitHub; the engineer stops, T-03 is ready, local main has the merge
  gh.write({ ...gh.read(), refuseMerge: undefined })
  r = await hq.api(`tickets/${t1.id}/merge`, {}); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(gh.read().merged, [2]); assert.equal(calls().filter((c) => c.includes('POST')).length, 2, 'T-01\'s PR opened once, not again')
  x = await tk(t1); assert.deepEqual([x.status, x.pr_state, x.pr_number], ['merged', 'merged', 2])
  await waitFor('the engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id)?.status === 'exited')
  assert.ok((await hq.state()).attention.some((a: any) => a.kind === 'merged' && /Ready now: T-03/.test(a.detail)))
  await waitFor('local main to have the merge', () => sh(dir, 'rev-parse', 'refs/heads/main') === sh(bare, 'rev-parse', 'refs/heads/main'))
  assert.ok(fs.existsSync(path.join(dir, 'orders.txt')))

  // A ticket that conflicts with GitHub's main now is refused and flagged (by Merge itself, or already by the watcher)
  r = await hq.api(`tickets/${t2.id}/merge`, {}); assert.equal(r.status, 409); assert.match(r.json.error, /T-02 conflicts with (origin\/)?main/)
  x = await tk(t2); assert.deepEqual([x.status, x.conflict_files, gh.read().merged], ['pr_open', '["orders.txt"]', [2]])
  assert.equal((await hq.api(`tickets/${t2.id}/make-pr`, {})).status, 409) // it has a PR already
})
