// Bug 9 for a GitHub repo, with no network: git's url.insteadOf points github.com at a local bare repo, and a fake gh
// (fake-gh.mjs) answers HQ's PR calls from a JSON file this test edits. A PR whose sibling merged first is flagged
// (GitHub's "conflicting" plus HQ's own check for the files), Fix conflicts names origin/main, the watcher leaves the
// resolving ticket alone, and open_pr pushes the merge onto the same PR.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq, bin: string, state: string
before(async () => {
  bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-gh-'))); state = path.join(bin, 'gh-state.json')
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dirname, 'fake-gh.mjs'))} "$@"\n`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state } })
})
after(async () => { await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

const gh = { read: () => JSON.parse(fs.readFileSync(state, 'utf8')), write: (s: unknown) => fs.writeFileSync(state, JSON.stringify(s)) }
const setPr = (branch: string, p: Record<string, unknown>) => { const s = gh.read(); s.prs[branch] = s.prs[branch].map((x: any) => ({ ...x, ...p })); gh.write(s) }

test('Bug 9 on GitHub: flagged, fixed against origin/main, pushed onto the same PR, and never flipped back to pr_open early', async () => {
  gh.write({ prs: {}, next: 1 })
  const dir = hq.repo('gh9'), bare = path.join(hq.root, 'bare', 'gh9.git')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare)
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/gh9.git') // the ssh form: insteadOf below only rewrites the https URL HQ fetches and pushes
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/gh9.git\n`)
  const repo = (await hq.api('repos', { path: dir })).json
  assert.deepEqual([repo.kind, repo.sync_ok], ['github', 1], JSON.stringify(repo))
  const f = (await hq.api('features', { repoId: repo.id, title: 'gh9', request: 'Build gh9' })).json
  const ticket = async (title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
  const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
  const eng = (t: any) => waitFor(`an engineer on ${t.key}`, async () =>
    (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = (t: any) => path.join(dir, '.claude', 'worktrees', t.key)
  const openPr = async (e: any) => {
    await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
    return hq.mcp(e.id, 'open_pr', { title: 'Add a line', body: 'Adds a line.\n\n## Deviations from approved plan\nNone' })
  }
  const commit = (t: any, text: string) => { fs.writeFileSync(path.join(wt(t), 'version.txt'), text); sh(wt(t), 'add', '.'); sh(wt(t), 'commit', '-qm', 'line') }
  const t1 = await ticket('Recipes'), t2 = await ticket('Shopping')
  await hq.api(`tickets/${t1.id}/launch`, {}); await hq.api(`tickets/${t2.id}/launch`, {})
  const e1 = await eng(t1), e2 = await eng(t2)
  commit(t1, 'v1\nrecipes\n'); assert.match((await openPr(e1)).text, /^Pushed hq\/gh9\/T-01-recipes and opened PR #1\./)
  commit(t2, 'v1\nshopping\n'); assert.match((await openPr(e2)).text, /^Pushed hq\/gh9\/T-02-shopping and opened PR #2\./)
  // T-01 is merged on GitHub; GitHub now calls PR #2 conflicting.
  const gc = path.join(hq.root, 'gh-clone'); sh(hq.root, 'clone', '-q', bare, gc)
  sh(gc, 'merge', '-q', '--no-ff', '--no-edit', 'origin/hq/gh9/T-01-recipes'); sh(gc, 'push', '-q', 'origin', 'main')
  setPr('hq/gh9/T-01-recipes', { state: 'MERGED' }); setPr('hq/gh9/T-02-shopping', { mergeable: 'CONFLICTING' })
  await hq.api(`repos/${repo.id}/sync`, {}) // what the 2-minute watcher would see
  await waitFor('T-01 merged', async () => (await tk(t1)).status === 'merged')
  await waitFor('T-02 flagged', async () => (await tk(t2)).conflict_files === '["version.txt"]')
  assert.equal((await tk(t2)).conflict_with, '["T-01"]')
  const flagged = (await hq.state()).attention.find((a: any) => a.ticket_id === t2.id && a.kind === 'merge_conflict')
  assert.match(flagged?.detail ?? '', /^T-02 conflicts with origin\/main in version\.txt \(T-01 merged first\)\./)
  // Fix conflicts: the engineer is told to merge origin/main (it can't fetch; HQ just did).
  const r = await hq.api(`tickets/${t2.id}/fix-conflicts`, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.via, 'message')
  const msg = (await hq.state()).messages.find((m: any) => m.from_id === 'hq' && m.to_id === e2.id)
  assert.match(msg.body, /conflicts with origin\/main in version\.txt\. Fix it now, in your worktree:\n1\. git merge --no-edit origin\/main /)
  // The watcher sees PR #2 still open while the engineer works: the ticket stays resolving.
  await hq.api(`repos/${repo.id}/sync`, {}); await new Promise((res) => setTimeout(res, 500))
  assert.equal((await tk(t2)).status, 'resolving')
  try { sh(wt(t2), 'merge', '--no-edit', 'origin/main') } catch { /* the conflict */ }
  fs.writeFileSync(path.join(wt(t2), 'version.txt'), 'v1\nrecipes\nshopping\n'); sh(wt(t2), 'add', 'version.txt'); sh(wt(t2), 'commit', '--no-edit', '-q')
  const pr = await openPr(e2); assert.equal(pr.isError, false, pr.text)
  assert.match(pr.text, /^Pushed hq\/gh9\/T-02-shopping and opened PR #2\./) // the same PR: GitHub said one is already open
  const done = await tk(t2); assert.deepEqual([done.status, done.pr_number, done.conflict_files], ['pr_open', 2, null])
  assert.equal(sh(bare, 'rev-parse', 'refs/heads/hq/gh9/T-02-shopping'), sh(dir, 'rev-parse', 'refs/heads/hq/gh9/T-02-shopping')) // pushed, fast-forward
  assert.ok((await hq.state()).attention.some((a: any) => a.ticket_id === t2.id && a.kind === 'conflicts_fixed' && /PR #2 merges cleanly again/.test(a.detail)))
  assert.equal(gh.read().prs['hq/gh9/T-02-shopping'].length, 1)
})
