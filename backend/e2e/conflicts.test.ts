// Bug 9 end to end (local repos): a finished ticket that conflicts with main is flagged before anyone presses Merge, a refused
// merge says who merged first, and Fix conflicts gets the work merged with main by its engineer (alive, or a fresh one) without
// ever leaving the ticket stuck. The tests act as the engineers (fake Claude Code); see harness.ts.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, lockOf, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ dir: string; repo: any; f: any }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f }
}
const ticket = async (f: any, title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
const launch = (t: any) => hq.api(`tickets/${t.id}/launch`, {})
const engineers = async (t: any) => (await hq.state()).agents.filter((a: any) => a.role === 'engineer' && a.ticket_id === t.id)
const liveEngineer = (t: any, not?: string) => waitFor(`an engineer on ${t.key}`, async () => (await engineers(t)).find((a: any) => a.status === 'working' && a.id !== not))
const wtOf = (dir: string, t: any) => path.join(dir, '.claude', 'worktrees', t.key)
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const notices = async (t: any, kind: string) => (await hq.state()).attention.filter((a: any) => a.ticket_id === t.id && a.kind === kind)
const fix = (t: any) => hq.api(`tickets/${t.id}/fix-conflicts`, {})
const merge = (t: any) => hq.api(`tickets/${t.id}/merge`, {})
const fromHq = async (to: string) => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === to)
/** The engineer's last steps: commit `text` as version.txt (every ticket here adds a line under v1: they all conflict). */
async function commit(wt: string, text: string): Promise<void> {
  fs.writeFileSync(path.join(wt, 'version.txt'), text); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', `version: ${text.trim().split('\n').at(-1)}`)
}
async function openPr(eng: any): Promise<{ text: string; isError: boolean }> {
  assert.equal((await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
  return hq.mcp(eng.id, 'open_pr', { title: 'Add a line', body: 'Adds a line.\n\n## Deviations from approved plan\nNone' })
}
async function finish(eng: any, wt: string, text: string): Promise<void> { await commit(wt, text); const r = await openPr(eng); assert.equal(r.isError, false, r.text) }
/** What the engineer does with HQ's message: merge main, keep both sides, commit. */
function mergeMain(wt: string, resolved: string): void {
  try { sh(wt, 'merge', '--no-edit', 'main'); assert.fail('expected a conflict') } catch (e) { if ((e as Error).name === 'AssertionError') throw e }
  fs.writeFileSync(path.join(wt, 'version.txt'), resolved); sh(wt, 'add', 'version.txt'); sh(wt, 'commit', '--no-edit', '-q')
}

test('Bug 9: the early warning, a refusal that names who merged first, and Fix conflicts through the live engineer', async () => {
  const { dir, f } = await setup('c1')
  const t1 = await ticket(f, 'Recipes'), t2 = await ticket(f, 'Shopping')
  await launch(t1); await launch(t2); const e1 = await liveEngineer(t1), e2 = await liveEngineer(t2)
  await finish(e1, wtOf(dir, t1), 'v1\nrecipes\n'); await finish(e2, wtOf(dir, t2), 'v1\nshopping\n')
  assert.equal((await tk(t2)).conflict_files, null) // nothing has merged yet: both merge cleanly
  assert.equal((await merge(t1)).status, 200)
  // The early warning: T-02 is flagged as soon as T-01 lands, before anyone presses Merge.
  await waitFor('T-02 flagged', async () => (await tk(t2)).conflict_files === '["version.txt"]')
  assert.equal((await tk(t2)).conflict_with, '["T-01"]')
  let n = await notices(t2, 'merge_conflict'); assert.equal(n.length, 1)
  assert.equal(n[0].detail, 'T-02 conflicts with main in version.txt (T-01 merged first). Press Fix conflicts and its engineer merges main in.')
  // Merge is still refused, now with who merged first and the way out; still one notice.
  const head = sh(dir, 'rev-parse', 'HEAD'); const r = await merge(t2)
  assert.equal(r.status, 409); assert.equal(sh(dir, 'rev-parse', 'HEAD'), head)
  assert.equal(r.json.error, 'T-02 conflicts with main in version.txt (T-01 merged first). Nothing was changed.'
    + ' Press Fix conflicts to have its engineer merge main in, or merge it by hand; HQ notices within 2 minutes.')
  assert.equal((await notices(t2, 'merge_conflict')).length, 1)
  // Ticked off, it stays off: neither the watcher nor another refusal brings it back (the box keeps Fix conflicts).
  await hq.api(`attention/${n[0].id}/resolve`, {})
  await hq.api(`repos/${(await hq.state()).features.find((x: any) => x.id === f.id).repo_id}/sync`, {}); assert.equal((await merge(t2)).status, 409)
  await new Promise((res) => setTimeout(res, 300)); assert.equal((await notices(t2, 'merge_conflict')).length, 0)
  assert.equal((await tk(t2)).conflict_files, '["version.txt"]')
  // Fix conflicts, clicked twice at once: one message to the engineer that's still there, nothing launched.
  const both = await Promise.all([fix(t2), fix(t2)])
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409], JSON.stringify(both.map((x) => x.json)))
  assert.deepEqual(both.find((x) => x.status === 200)!.json, { key: 'T-02', clean: false, via: 'message', engineer: e2.id })
  assert.match(both.find((x) => x.status === 409)!.json.error, /already being fixed/)
  const msgs = await fromHq(e2.id); assert.equal(msgs.length, 1)
  assert.match(msgs[0].body, /^HQ: main has moved on since you finished T-02\. T-01 merged first, and now hq\/c1\/T-02-shopping conflicts with main in version\.txt\./)
  assert.match(msgs[0].body, /\. Fix it now, in your worktree:\n1\. git merge --no-edit main \(merge, never rebase, never push\)\./)
  assert.match(msgs[0].body, /\n6\. Call open_pr again with the same title and body/)
  assert.equal((await tk(t2)).status, 'resolving'); assert.equal((await engineers(t2)).length, 1)
  assert.equal((await notices(t2, 'merge_conflict')).length, 0) // being handled; a later conflict gets a fresh notice
  assert.match((await fix(t2)).json.error, new RegExp(`already fixing its conflicts`))
  // Its engineer goes idle before the instructions reach it: nothing is sent twice. Once they did and it stopped anyway, pressing
  // Fix conflicts again re-sends them.
  await hq.hook(e2.id, { hook_event_name: 'Stop', last_assistant_message: 'done' })
  assert.match((await fix(t2)).json.error, /HQ's instructions to .* haven't been delivered yet/)
  assert.match((await hq.mcp(e2.id, 'read_inbox')).text, /main has moved on/) // now it has them
  const resent = await fix(t2); assert.equal(resent.status, 200, JSON.stringify(resent.json)); assert.equal(resent.json.via, 'message')
  assert.equal((await fromHq(e2.id)).length, 2)
  assert.match((await merge(t2)).json.error, /^T-02's engineer is fixing its conflicts with main; merge it once that's done\.$/)
  // The engineer finishing too early is told what's left; the ticket stays resolving.
  let pr = await openPr(e2); assert.equal(pr.isError, true)
  assert.match(pr.text, /^hq\/c1\/T-02-shopping conflicts with main in version\.txt: main has moved on\. Merge it in \(git merge --no-edit main; merge, never rebase\)/)
  try { sh(wtOf(dir, t2), 'merge', '--no-edit', 'main') } catch { /* the conflict */ }
  pr = await openPr(e2); assert.equal(pr.isError, true); assert.match(pr.text, /^A merge is in progress in your worktree/)
  fs.writeFileSync(path.join(wtOf(dir, t2), 'version.txt'), 'v1\nrecipes\nshopping\n'); sh(wtOf(dir, t2), 'add', 'version.txt'); sh(wtOf(dir, t2), 'commit', '--no-edit', '-q')
  pr = await openPr(e2); assert.equal(pr.isError, false, pr.text); assert.match(pr.text, /^Done\./)
  const done = await tk(t2); assert.deepEqual([done.status, done.pr_state, done.conflict_files, done.conflict_with], ['pr_ready', 'local', null, null])
  assert.equal((await notices(t2, 'merge_conflict')).length, 0)
  assert.equal((await notices(t2, 'conflicts_fixed'))[0]?.detail, 'T-02: conflicts fixed (main merged in). Ready to merge again.')
  assert.ok((await hq.state()).messages.some((m: any) => m.to_id === f.tpm_agent_id && /T-02's conflicts with main are fixed/.test(m.body)))
  // Not auto-merged (the user's call): the user presses Merge.
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head)
  assert.equal((await merge(t2)).status, 200)
  assert.equal(fs.readFileSync(path.join(dir, 'version.txt'), 'utf8'), 'v1\nrecipes\nshopping\n')
  assert.equal((await notices(t2, 'conflicts_fixed')).length, 0) // merged: moot
})

test('Bug 9: a stopped engineer is replaced (over the limit, no plan gate), survives an HQ restart, and a merge by hand ends it', async () => {
  const { dir, repo, f } = await setup('c2')
  await hq.api('settings', { key: 'concurrency_cap', value: 10 })
  const t1 = await ticket(f, 'Recipes'), t2 = (await hq.api('tickets', { featureId: f.id, title: 'Shopping', size: 'L', spec: 'Shopping.' })).json // L: opusplan
  const t3 = await ticket(f, 'Planner')
  await launch(t1); await launch(t2); await launch(t3)
  const e1 = await liveEngineer(t1), e2 = await liveEngineer(t2), e3 = await liveEngineer(t3)
  await finish(e1, wtOf(dir, t1), 'v1\nrecipes\n'); await finish(e2, wtOf(dir, t2), 'v1\nshopping\n')
  assert.equal((await merge(t1)).status, 200)
  await waitFor('T-02 flagged', async () => (await tk(t2)).conflict_files)
  await hq.api(`agents/${e2.id}/stop`, {})
  await hq.api('settings', { key: 'concurrency_cap', value: 1 }) // full: T-03's engineer is still working
  const r = await fix(t2); assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.via, 'launch'); assert.notEqual(r.json.engineer, e2.id)
  const e2b = await liveEngineer(t2, e2.id); assert.equal(e2b.id, r.json.engineer)
  const t = await tk(t2); assert.deepEqual([t.status, t.assignee_agent_id, t.worktree_path, t.branch], ['resolving', e2b.id, wtOf(dir, t2), 'hq/c2/T-02-shopping'])
  assert.equal(e2b.in_plan_mode, 0); assert.deepEqual([e2.model_alias, e2b.model_alias], ['opusplan', 'sonnet']) // a fix runs on the S model
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'agents', e2b.id, 'launch.sh'), 'utf8'), /'--permission-mode' 'acceptEdits'/)
  assert.match(e2b.launch_prompt, /^You are the engineer for ticket T-02 \(L\): Shopping\. Its work is already finished and committed on branch hq\/c2\/T-02-shopping/)
  assert.match(e2b.launch_prompt, /HQ: main has moved on since you finished T-02\. T-01 merged first/)
  assert.match(lockOf(dir, wtOf(dir, t2)) ?? '', /^claude session T-02 /) // the same worktree, now held by the new session
  assert.equal((await hq.state()).reviews.filter((x: any) => x.ticket_id === t2.id).length, 0) // no plan, no review
  // HQ restarts while the new engineer is gone: the ticket stays resolving, the notice comes back, Fix conflicts starts another.
  hq.tmux('kill-session', '-t', `hq-${e2b.id}`)
  await hq.restart()
  await waitFor('the stopped-engineer notice', async () => (await notices(t2, 'merge_conflict')).find((a: any) => /its engineer stopped before the conflicts with main were fixed/.test(a.detail)))
  assert.equal((await tk(t2)).status, 'resolving')
  const again = await fix(t2); assert.equal(again.status, 200, JSON.stringify(again.json)); assert.equal(again.json.via, 'launch')
  const e2c = await liveEngineer(t2, e2b.id); assert.equal(e2c.id, again.json.engineer)
  // Merged by hand while its engineer works on it: HQ notices, the engineer stops, the ticket is merged.
  try { sh(dir, 'merge', '--no-edit', 'hq/c2/T-02-shopping') } catch { /* the conflict */ }
  fs.writeFileSync(path.join(dir, 'version.txt'), 'v1\nrecipes\nshopping\n'); sh(dir, 'add', 'version.txt'); sh(dir, 'commit', '--no-edit', '-q')
  await hq.api(`repos/${repo.id}/sync`, {}) // a sync re-checks merges (as the 2-minute watcher would)
  await waitFor('T-02 merged', async () => (await tk(t2)).status === 'merged')
  await waitFor('its engineer stopped', async () => (await engineers(t2)).every((a: any) => a.status === 'exited'))
  assert.deepEqual([(await tk(t2)).conflict_files, (await notices(t2, 'merge_conflict')).length], [null, 0])
  // A ticket finishing after main moved under it is told to merge main first, before it ever reaches the user.
  await commit(wtOf(dir, t3), 'v1\nplanner\n')
  const pr = await openPr(e3); assert.equal(pr.isError, true); assert.match(pr.text, /^hq\/c2\/T-03-planner conflicts with main in version\.txt: main has moved on/)
  assert.notEqual((await tk(t3)).status, 'pr_ready')
  await hq.api('settings', { key: 'concurrency_cap', value: 10 })
})

test('Bug 9: fixed by hand before the click starts nothing; cancelling a resolving ticket stops its engineer', async () => {
  const { dir, f } = await setup('c3')
  await hq.api('settings', { key: 'concurrency_cap', value: 10 })
  const t1 = await ticket(f, 'Recipes'), t2 = await ticket(f, 'Shopping'), t3 = await ticket(f, 'Planner')
  await launch(t1); await launch(t2); const e1 = await liveEngineer(t1), e2 = await liveEngineer(t2)
  await launch(t3); const e3 = await liveEngineer(t3)
  await finish(e1, wtOf(dir, t1), 'v1\nrecipes\n'); await finish(e2, wtOf(dir, t2), 'v1\nshopping\n'); await finish(e3, wtOf(dir, t3), 'v1\nplanner\n')
  assert.equal((await merge(t1)).status, 200)
  await waitFor('T-02 and T-03 flagged', async () => (await tk(t2)).conflict_files && (await tk(t3)).conflict_files)
  mergeMain(wtOf(dir, t2), 'v1\nrecipes\nshopping\n') // the user fixed T-02 by hand in its worktree
  const r = await fix(t2); assert.deepEqual(r.json, { key: 'T-02', clean: true })
  const t = await tk(t2); assert.deepEqual([t.status, t.conflict_files], ['pr_ready', null])
  assert.equal((await notices(t2, 'merge_conflict')).length, 0); assert.equal((await fromHq(e2.id)).length, 0); assert.equal((await engineers(t2)).length, 1)
  // T-03: being fixed, then cancelled.
  assert.equal((await fix(t3)).json.via, 'message'); assert.equal((await tk(t3)).status, 'resolving')
  assert.equal((await hq.api(`tickets/${t3.id}/cancel`, {})).status, 200)
  assert.equal((await tk(t3)).status, 'cancelled')
  await waitFor('T-03 engineer stopped', async () => (await engineers(t3)).every((a: any) => a.status === 'exited'))
  assert.equal((await hq.state()).attention.filter((a: any) => a.ticket_id === t3.id).length, 0)
  assert.equal((await fix(t3)).status, 409) // nothing to fix on a cancelled ticket
})
