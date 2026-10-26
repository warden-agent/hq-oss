// HQ bugs 4–8 end to end, against a real backend with fake agents (see harness.ts). Each test uses its own repo and feature.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, pendingAfter, lockOf, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

/** A local repo in HQ with one feature (its TPM is a fake agent). */
async function setup(name: string): Promise<{ dir: string; repo: any; f: any }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f }
}
const ticket = async (f: any, title: string, depends_on: string[] = []) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.`, depends_on })).json
const launch = (t: any) => hq.api(`tickets/${t.id}/launch`, {})
const engineers = async (t: any) => (await hq.state()).agents.filter((a: any) => a.role === 'engineer' && a.ticket_id === t.id)
const liveEngineer = (t: any) => waitFor(`an engineer on ${t.key}`, async () => (await engineers(t)).find((a: any) => a.status === 'working'))
const wtOf = (dir: string, t: any) => path.join(dir, '.claude', 'worktrees', t.key)
/** The engineer's part of finishing a ticket: commit in its worktree, write the before_pr handoff, call open_pr. */
async function finish(eng: any, wt: string, file: string, text = `${file}\n`): Promise<string> {
  fs.writeFileSync(path.join(wt, file), text); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', `add ${file}`)
  assert.equal((await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: `added ${file}` })).isError, false)
  const r = await hq.mcp(eng.id, 'open_pr', { title: `Add ${file}`, body: `Adds ${file}.\n\n## Deviations from approved plan\nNone` })
  assert.equal(r.isError, false, r.text); return r.text
}

test('Bug 4: one engineer per ticket, whoever asks and however fast', async () => {
  const { dir, f } = await setup('bug4')
  const t1 = await ticket(f, 'One'), t2 = await ticket(f, 'Two')
  // Two launches of one ticket at once: one starts, the other is refused while the first is still under way.
  const both = await Promise.all([launch(t1), launch(t1)])
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]); assert.match(both.find((r) => r.status === 409)!.json.error, /already (starting an engineer|has an engineer)/)
  const e1 = await liveEngineer(t1)
  assert.equal((await engineers(t1)).length, 1); assert.equal(hq.tmux('ls').split('\n').filter((l) => l.startsWith('hq-eng-')).length, 1)
  // Launch engineer racing Start ready on the same ticket: still one engineer, and no false "could not start" alert.
  await Promise.all([launch(t2), hq.api(`features/${f.id}/start-ready`, {})])
  await liveEngineer(t2); await new Promise((r) => setTimeout(r, 300))
  assert.equal((await engineers(t2)).length, 1)
  assert.equal((await hq.state()).attention.filter((a: any) => a.kind === 'launch_failed').length, 0)
  // Room for exactly one more engineer, two different tickets launched together: the limit counts the launch under way.
  const t3 = await ticket(f, 'Three'), t4 = await ticket(f, 'Four')
  assert.equal((await hq.api('settings', { key: 'concurrency_cap', value: 3 })).status, 200)
  const pair = await Promise.all([launch(t3), launch(t4)])
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 409]); assert.match(pair.find((r) => r.status === 409)!.json.error, /^Parallel limit reached \(3\/3\)$/)
  await hq.api('settings', { key: 'concurrency_cap', value: 10 })
  // A finished ticket can't get another engineer: not while its engineer runs, nor after.
  await finish(e1, wtOf(dir, t1), 'one.txt')
  assert.equal((await launch(t1)).json.error, `${t1.key} already has an engineer (${e1.id})`)
  await hq.api(`agents/${e1.id}/stop`, {})
  const again = await launch(t1); assert.equal(again.status, 409); assert.equal(again.json.error, `${t1.key} is already finished (pr_ready)`)
})

test('Bug 5: a changed plan closes the old review, which can then not be approved', async () => {
  const { f } = await setup('bug5')
  const t = await ticket(f, 'Page'); await launch(t); const eng = await liveEngineer(t)
  const drop = new AbortController()
  const a = hq.hook(eng.id, exitPlanMode('Plan A'), drop.signal).catch(() => 'dropped')
  const rA = await waitFor('review A', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
  drop.abort(); assert.equal(await a, 'dropped') // the engineer was interrupted; it then sends a changed plan
  const b = hq.hook(eng.id, exitPlanMode('Plan B'))
  assert.equal(await pendingAfter(b, 300), true)
  const s = await hq.state(), mine = s.reviews.filter((r: any) => r.ticket_id === t.id)
  assert.deepEqual(mine.map((r: any) => [r.round, r.status, r.closed_reason]).sort(), [[1, 'abandoned', 'superseded'], [2, 'open', null]])
  assert.deepEqual((await hq.api(`reviews/${rA.id}/answer`, { verdict: 'approve', by: 'user' })).json, { ok: false, held: false, error: 'review not open' })
  assert.equal((await hq.state()).tickets.find((x: any) => x.id === t.id).status, 'plan_review')
  const rB = mine.find((r: any) => r.round === 2)
  assert.equal((await hq.api(`reviews/${rB.id}/answer`, { verdict: 'approve', by: 'user' })).json.ok, true)
  const allow = (await b).hookSpecificOutput.decision; assert.equal(allow.behavior, 'allow'); assert.equal(allow.updatedInput.plan, 'Plan B')
  assert.equal((await hq.state()).tickets.find((x: any) => x.id === t.id).status, 'implementing')
})

test('Worktree locks: a stopped engineer\'s lock is cleared; stale ones at startup too; a live session keeps its lock', async () => {
  const { dir, f } = await setup('locks')
  const t1 = await ticket(f, 'One'), t2 = await ticket(f, 'Two')
  await launch(t1); const e1 = await liveEngineer(t1)
  assert.match(lockOf(dir, wtOf(dir, t1)) ?? '', /^claude session T-01 \(pid \d+ /)
  await hq.api(`agents/${e1.id}/stop`, {})
  await waitFor('the stopped engineer\'s lock to clear', () => lockOf(dir, wtOf(dir, t1)) === null)
  assert.equal(fs.existsSync(wtOf(dir, t1)), true) // unfinished work stays where it is
  // HQ's worktree folder no longer shows up as a change in the repo.
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.claude\/worktrees\/$/m)
  assert.equal(sh(dir, 'status', '--porcelain'), '')
  // A session that died while HQ was down left its lock; another session is still running when HQ starts again.
  await launch(t2); await liveEngineer(t2)
  const old = path.join(dir, '.claude', 'worktrees', 'OLD'); sh(dir, 'worktree', 'add', '-q', '-b', 'hq/locks/OLD', old)
  sh(dir, 'worktree', 'lock', '--reason', 'claude session OLD (pid 999999 start Thu Oct 22 01:38:44 2026)', old)
  const held = lockOf(dir, wtOf(dir, t2))
  await hq.restart()
  await waitFor('the stale lock to clear at startup', () => lockOf(dir, old) === null)
  assert.equal(lockOf(dir, wtOf(dir, t2)), held) // still in use: left alone
})

test('Bug 6: Merge into main for a local repo: refuses with the reason and changes nothing, then merges and moves everything on', async () => {
  const { dir, repo, f } = await setup('bug6')
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  await waitFor('the preview', async () => (await hq.state()).previews.find((p: any) => p.id === repo.id && p.status === 'running'), 20_000)
  const t1 = await ticket(f, 'Api'), t2 = await ticket(f, 'Page', ['T-01'])
  await launch(t1); const e1 = await liveEngineer(t1)
  assert.match(await finish(e1, wtOf(dir, t1), 'api.txt'), /^Done\. The user merges hq\/bug6\/T-01-api into main from HQ\./)
  let s = await hq.state(), tk = s.tickets.find((x: any) => x.id === t1.id)
  assert.deepEqual([tk.status, tk.pr_state], ['pr_ready', 'local'])
  assert.equal(s.attention.filter((a: any) => a.ticket_id === t1.id).length, 0) // waiting for a merge is not an alert to tick away
  const merge = () => hq.api(`tickets/${t1.id}/merge`, {})
  const unchanged = async (why: RegExp) => { const head = sh(dir, 'rev-parse', 'HEAD'); const r = await merge(); assert.equal(r.status, 409); assert.match(r.json.error, why); assert.equal(sh(dir, 'rev-parse', 'HEAD'), head) }
  fs.writeFileSync(path.join(dir, 'version.txt'), 'edited\n'); await unchanged(/^bug6 has uncommitted changes in version\.txt\. Commit or stash them/); sh(dir, 'checkout', '--', 'version.txt')
  sh(dir, 'checkout', '-qb', 'side'); await unchanged(/^bug6 is on branch side, not main/); sh(dir, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(dir, 'api.txt'), 'mine\n'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'mine')
  await unchanged(/^hq\/bug6\/T-01-api conflicts with main in api\.txt\. Nothing was changed\./); sh(dir, 'reset', '-q', '--hard', 'HEAD~1')
  assert.equal(sh(dir, 'status', '--porcelain'), '')
  // Now it's safe: one merge commit, and everything that follows a merge happens at once.
  const r = await merge(); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.already, false)
  assert.equal(sh(dir, 'rev-parse', 'main'), r.json.sha); assert.equal(sh(dir, 'log', '-1', '--format=%s'), 'Merge T-01: Api')
  assert.match(sh(dir, 'log', '-1', '--format=%b'), /## Deviations from approved plan\nNone\n\nHQ ticket T-01 · hq\/bug6\/T-01-api/)
  assert.equal(fs.readFileSync(path.join(dir, 'api.txt'), 'utf8'), 'api.txt\n')
  s = await hq.state()
  assert.equal(s.tickets.find((x: any) => x.id === t1.id).status, 'merged')
  assert.match(s.attention.find((a: any) => a.kind === 'merged' && a.ticket_id === t1.id).detail, /^T-01 merged\. Ready now: T-02\. Start them with "Start ready"\.$/)
  assert.ok(s.messages.some((m: any) => m.to_id === f.tpm_agent_id && /T-01 merged/.test(m.body)))
  await waitFor('the engineer to stop', async () => (await hq.state()).agents.find((a: any) => a.id === e1.id).status === 'exited')
  await waitFor('the merged worktree to go', () => !fs.existsSync(wtOf(dir, t1)))
  assert.match(sh(dir, 'branch', '--list', 'hq/bug6/T-01-api'), /T-01/) // the branch stays
  await waitFor('the preview to restart on the merge', async () => { const p = (await hq.state()).previews.find((x: any) => x.id === repo.id); return p.head && r.json.sha.startsWith(p.head) && p.status === 'running' }, 20_000)
  assert.deepEqual((await merge()).json, { merged: true, sha: '', already: true })
  assert.equal((await launch(t2)).status, 200) // T-02 may start now
})

test('Bug 7: Start TPM again: a fresh TPM briefed from HQ\'s records gets what was waiting for the old one', async () => {
  const { f } = await setup('bug7')
  const oldTpm = f.tpm_agent_id
  const t1 = await ticket(f, 'Api'); await launch(t1); const e1 = await liveEngineer(t1)
  await hq.api(`agents/${oldTpm}/stop`, {})
  await waitFor('the TPM to stop', async () => (await hq.state()).agents.find((a: any) => a.id === oldTpm).status === 'exited')
  await hq.api('settings', { key: 'dm_per_peer_min', value: 0 })
  const asked = await hq.mcp(e1.id, 'send_message', { to: 'tpm', reason: 'question', body: 'Which file should hold the items?' })
  assert.equal(asked.isError, false, asked.text)
  const q = (await hq.state()).messages.find((m: any) => m.body === 'Which file should hold the items?')
  assert.equal(q.to_id, oldTpm); assert.equal(q.delivered_at, null) // nobody will read it
  // Start TPM again, double-clicked: one new TPM.
  const both = await Promise.all([hq.api(`features/${f.id}/restart-tpm`, {}), hq.api(`features/${f.id}/restart-tpm`, {})])
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409])
  const fresh = both.find((r) => r.status === 200)!.json
  assert.match(both.find((r) => r.status === 409)!.json.error, /already (starting|has a TPM running)/)
  await waitFor('the new TPM', async () => (await hq.state()).agents.find((a: any) => a.id === fresh.id && a.status === 'working'))
  const s = await hq.state()
  assert.equal(s.features.find((x: any) => x.id === f.id).tpm_agent_id, fresh.id)
  assert.equal(s.messages.find((m: any) => m.id === q.id).to_id, fresh.id) // the question now waits for the new TPM
  const prompt = fs.readFileSync(path.join(hq.hqHome, 'agents', fresh.id, 'prompt.md'), 'utf8')
  assert.match(prompt, new RegExp(`^You are taking over as TPM for the feature "bug7" in repo "bug7".*The previous TPM session \\(${oldTpm}\\) has ended`))
  assert.match(prompt, /"""\nBuild bug7\n"""/); assert.match(prompt, /- T-01 \(S\) Api: its engineer waits for an answer · branch hq\/bug7\/T-01-api/)
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'workspaces', f.id, 'tpm', 'FEATURE.md'), 'utf8'), /## Ticket specs\n\n### T-01: Api\nApi\./)
  assert.match((await hq.api(`features/${f.id}/restart-tpm`, {})).json.error, new RegExp(`^bug7 already has a TPM running \\(${fresh.id}\\)$`))
  // An engineer that still has the old TPM's id reaches the new one.
  assert.equal((await hq.mcp(e1.id, 'send_message', { to: oldTpm, reason: 'fyi', body: 'Started on the store.' })).isError, false)
  assert.equal((await hq.state()).messages.find((m: any) => m.body === 'Started on the store.').to_id, fresh.id)
})

test('Bug 8: notices clear themselves: a merge clears what was said about its ticket, and "Ready now" goes once those have started', async () => {
  const { dir, f } = await setup('bug8')
  const t1 = await ticket(f, 'Api'), t2 = await ticket(f, 'Page', ['T-01'])
  await launch(t1); const e1 = await liveEngineer(t1)
  assert.equal((await hq.mcp(e1.id, 'report_blocked', { reason: 'need a hand' })).isError, false)
  await finish(e1, wtOf(dir, t1), 'api.txt')
  const open = async () => (await hq.state()).attention.filter((a: any) => !a.resolved_at)
  assert.ok((await open()).some((a: any) => a.kind === 'blocked' && a.ticket_id === t1.id))
  assert.equal((await hq.api(`tickets/${t1.id}/merge`, {})).status, 200)
  let mine = (await open()).filter((a: any) => a.ticket_id === t1.id)
  assert.deepEqual(mine.map((a: any) => a.kind), ['merged']) // the blocked note is moot now
  assert.match(mine[0].detail, /Ready now: T-02\./)
  assert.equal((await launch(t2)).status, 200); await liveEngineer(t2)
  mine = (await open()).filter((a: any) => a.ticket_id === t1.id)
  assert.deepEqual(mine, []) // nothing left to start: no click needed
})
