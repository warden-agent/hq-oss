// Bug 212: the user's "Merge into main" (auto off) merged the branch tip read as the merge started, and nothing looked again: a commit that reached the branch
// meanwhile stayed behind on it, the ticket read merged and nobody was told. A `git` in front of the real one on HQ's PATH runs `before-ff` (once) as HQ moves
// main, the moment such a commit has to land in (as Bug 184's tests in auto.test.ts); on GitHub the fake gh's beforeMerge does the same as GitHub merges.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq, bin: string, state: string, hook: string
const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), q = JSON.stringify
before(async () => {
  bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-late-'))); state = path.join(bin, 'gh-state.json'); hook = path.join(bin, 'before-ff')
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" merge --ff-only "*) if [ -f ${q(hook)} ]; then mv ${q(hook)} ${q(`${hook}.ran`)}; `
    + `sh ${q(`${hook}.ran`)}; fi;; esac\nexec ${q(real)} "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${q(process.execPath)} ${q(path.join(import.meta.dirname, 'fake-gh.mjs'))} "$@"\n`, { mode: 0o755 })
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state } })
})
after(async () => { await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

const gh = { read: () => JSON.parse(fs.readFileSync(state, 'utf8')), write: (s: unknown) => fs.writeFileSync(state, JSON.stringify(s)) }
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const wtOf = (dir: string, t: any) => path.join(dir, '.claude', 'worktrees', t.key)
const notices = async (t: any, kind: string) => (await hq.state()).attention.filter((a: any) => a.ticket_id === t.id && a.kind === kind && !a.resolved_at)
const events = (kind: string) => hq.api('events?limit=500').then((r) => (r.json as any[]).filter((e) => e.kind === kind).map((e) => JSON.parse(e.payload)))
/** A project (auto off) with one ticket its engineer has finished: committed `file` and called open_pr. */
async function finished(dir: string, file: string): Promise<{ repo: any; f: any; t: any; e: any; tpm: string }> {
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: path.basename(dir), request: 'Build it' })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'Orders', size: 'S', spec: 'Orders.' })).json; await hq.api(`tickets/${t.id}/launch`, {})
  const e = await waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const wt = wtOf(dir, t); fs.writeFileSync(path.join(wt, file), 'orders\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'orders')
  await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })
  const r = await hq.mcp(e.id, 'open_pr', { title: 'Orders', body: 'Orders.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  return { repo, f, t, e, tpm: f.tpm_agent_id }
}
/** A shell line that commits late.txt in the ticket's worktree, as its engineer (or the user) would while HQ merges. */
const lateCommit = (wt: string, git = real) => `cd ${q(wt)} && echo late > late.txt && ${q(git)} add late.txt && ${q(git)} commit -qm 'late fix'\n`

test('Bug 212: local: a commit that lands during Merge into main is not left behind: main has the branch as it was, the ticket stays ready, Merge again brings it', async () => {
  const dir = hq.repo('latelocal'), { t } = await finished(dir, 'orders.txt'), wt = wtOf(dir, t)
  const first = sh(wt, 'rev-parse', 'HEAD'); fs.writeFileSync(hook, lateCommit(wt))
  const m = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json)); assert.ok(fs.existsSync(`${hook}.ran`), 'the commit landed as HQ merged')
  const late = sh(wt, 'rev-parse', 'HEAD'); assert.notEqual(late, first); assert.equal(m.json.behind, late)
  assert.equal(sh(dir, 'log', '-1', '--format=%P', 'main').split(' ')[1], first, 'main has the branch as it was when Merge was pressed')
  assert.ok(fs.existsSync(path.join(dir, 'orders.txt'))); assert.equal(fs.existsSync(path.join(dir, 'late.txt')), false, 'and nothing after it')
  const x = await tk(t); assert.deepEqual([x.status, x.pr_state], ['pr_ready', 'local'], 'not marked merged with a commit left over')
  assert.equal((await events('ticket.merged')).filter((p) => p.ticket === t.id).length, 0)
  const [n] = await notices(t, 'merged_part'); assert.ok(n, 'the user is told')
  assert.equal(n.detail, `${t.key}: a commit reached its branch while HQ merged it, so it is only partly in main. Press Merge into main again to merge the rest: `
    + `"${late.slice(0, 7)} late fix". (main has ${t.key} as it was when you pressed Merge, ${first.slice(0, 7)}.)`)
  assert.deepEqual((await events('ticket.merged_late')).map((p) => [p.ticket, p.head, p.now, p.commits, p.merged]), [[t.id, first, late, 1, false]])
  // Merge into main again: the rest goes in, the ticket is merged and the notice is gone. Nothing landed this time, so nothing more is said (what it must not catch)
  const again = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(again.status, 200, JSON.stringify(again.json)); assert.equal(again.json.behind, undefined)
  assert.equal((await tk(t)).status, 'merged'); assert.equal(fs.readFileSync(path.join(dir, 'late.txt'), 'utf8'), 'late\n')
  assert.equal(sh(dir, 'log', '-1', '--format=%P', 'main').split(' ')[1], late)
  assert.equal((await notices(t, 'merged_part')).length, 0); assert.equal((await events('ticket.merged_late')).length, 1)
})

test('Bug 212: GitHub: a commit that lands while GitHub merges is named to the user and the TPM; GitHub merges the commit the merge started from', async () => {
  const dir = hq.repo('lategh'), bare = path.join(hq.root, 'bare', 'lategh.git')
  sh(hq.root, 'clone', '-q', '--bare', dir, bare); gh.write({ prs: {}, next: 1, bares: { 'e2e/lategh': bare } })
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:e2e/lategh.git')
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}"]\n\tinsteadOf = https://github.com/e2e/lategh.git\n`)
  const { repo, t, tpm } = await finished(dir, 'orders.txt'), wt = wtOf(dir, t); assert.equal(repo.kind, 'github')
  const first = sh(wt, 'rev-parse', 'HEAD'); gh.write({ ...gh.read(), beforeMerge: lateCommit(wt) })
  const m = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(m.status, 200, JSON.stringify(m.json))
  const late = sh(wt, 'rev-parse', 'HEAD'), x = await tk(t); assert.notEqual(late, first)
  assert.equal(x.status, 'merged'); assert.deepEqual(gh.read().mergeShas, [first], 'GitHub was asked to merge the commit HQ pushed, no other')
  assert.ok(!sh(bare, 'ls-tree', '--name-only', 'main').includes('late.txt'))
  const [n] = await notices(t, 'left_behind'); assert.ok(n, 'the user sees it')
  const what = `${t.key} merged as it was when the user pressed Merge into main (${first.slice(0, 7)}), but ${x.branch} got a commit while HQ merged it, and that commit `
    + `isn't in main: "${late.slice(0, 7)} late fix"`
  assert.equal(n.detail, `lategh: ${what}. It is still on its branch.`)
  const heard = await waitFor('the TPM to hear', async () => (await hq.state()).messages.find((mm: any) => mm.to_id === tpm && mm.from_id === 'hq' && /while HQ merged it/.test(mm.body)))
  assert.equal(heard.body, `HQ: ${what}. If it's still wanted, make a ticket for it: its engineer can bring it in with git cherry-pick ${first.slice(0, 7)}..${late.slice(0, 7)}.`)
  assert.equal(sh(dir, 'rev-parse', `refs/heads/${x.branch}`), late, 'the commit is still on its branch')
  assert.deepEqual((await events('ticket.merged_late')).filter((p) => p.ticket === t.id).map((p) => [p.head, p.now, p.merged]), [[first, late, true]])
})
