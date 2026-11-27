// Bug 398 end to end (see harness.ts): the backend went down while it started an engineer for a Launch or a Fix conflicts, after the engineer's session
// began and before the ticket recorded it (startEngineer records it once launchAgent returns). The ticket then named no engineer (or the stopped one) while
// one worked on it: Launch was refused for it ("already has an engineer"), Start skipped it, its ports stayed under the launch's name, the TPM never heard
// of it, and Fix conflicts sent the instructions it was started with a second time. The same click now takes that session over. Each test makes that
// moment exactly: it lets the start finish, stops the backend, and puts the ticket and its ports back as the last backend left them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, exitPlanMode, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq(); await hq.api('settings', { key: 'concurrency_cap', value: 10 }) })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ dir: string; repo: any; f: any; tpm: string }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { dir, repo, f, tpm: f.tpm_agent_id }
}
const ticket = async (f: any, title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
const tk = async (t: any) => (await hq.state()).tickets.find((x: any) => x.id === t.id)
const agent = async (id: string) => (await hq.state()).agents.find((a: any) => a.id === id)
const liveOn = async (t: any) => (await hq.state()).agents.filter((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status !== 'exited').map((a: any) => a.id)
const working = (id: string) => waitFor(`${id} working`, async () => (await agent(id))?.status === 'working')
const fromHq = async (to: string) => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === to)
/** Whether HQ told `tpm` something starting with `start` since `seen` (the ids of what it had been told). */
const toldSince = async (tpm: string, seen: Set<string>, start: string) => (await fromHq(tpm)).some((m: any) => !seen.has(m.id) && m.body.startsWith(start))
const ids = async (tpm: string) => new Set<string>((await fromHq(tpm)).map((m: any) => m.id))
/** Who holds the engineer ports the launch of `t` took: the engineer, or still the launch's own name. */
function slotHolders(t: any, eng: string): string[] {
  const db = hq.db({ readOnly: true })
  try { return (db.prepare('SELECT agent_id FROM worker_slots WHERE agent_id IN (?, ?)').all(eng, `pending-${t.id}`) as any[]).map((r) => r.agent_id) } finally { db.close() }
}
/** The backend goes down with `t` as it was before the start recorded `eng` (`was`: the ticket's fields then), the ports still under the launch's name. */
async function downBeforeRecorded(t: any, eng: string, was: Record<string, unknown>): Promise<void> {
  await hq.down()
  const db = hq.db()
  try {
    const keys = Object.keys(was)
    db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => was[k] as any), t.id)
    db.prepare('UPDATE worker_slots SET agent_id = ? WHERE agent_id = ?').run(`pending-${t.id}`, eng)
  } finally { db.close() }
  await hq.up()
}

test('Bug 398: a Launch the backend went down in the middle of is taken over by the next Launch or Start: no second engineer, nothing refused', async () => {
  const { f, repo, tpm } = await setup('b398l')
  const t1 = await ticket(f, 'Orders'), t2 = await ticket(f, 'Invoices')
  const e1 = (await hq.api(`tickets/${t1.id}/launch`, {})).json.id, e2 = (await hq.api(`tickets/${t2.id}/launch`, {})).json.id
  await working(e1); await working(e2)
  const before = { b1: (await tk(t1)).branch, w1: (await tk(t1)).worktree_path }
  for (const [t, e] of [[t1, e1], [t2, e2]]) {
    await downBeforeRecorded(t, e, { status: 'queued', assignee_agent_id: null, branch: null, worktree_path: null })
  }
  // as the last backend left them: queued, nobody on them, while their engineers work
  for (const t of [t1, t2]) assert.deepEqual([(await tk(t)).status, (await tk(t)).assignee_agent_id], ['queued', null])
  assert.equal((await agent(e1)).status, 'working')

  const seen = await ids(tpm)
  // Launch again: it takes over the engineer that runs (it was refused for it, "T-01 already has an engineer")
  const r = await hq.api(`tickets/${t1.id}/launch`, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.id, e1)
  const a1 = await tk(t1)
  assert.deepEqual([a1.status, a1.assignee_agent_id, a1.branch, a1.worktree_path], ['planning', e1, before.b1, before.w1])
  assert.deepEqual(await liveOn(t1), [e1]); assert.deepEqual(slotHolders(t1, e1), [e1])
  await waitFor('the TPM told', () => toldSince(tpm, seen, `HQ: engineer ${e1} started on T-01 (branch ${before.b1})`))
  assert.equal((await hq.api(`tickets/${t1.id}/launch`, {})).status, 409) // and now it has one, as usual

  // Start's fill (what the TPM box's Start and auto mode use) does the same for the other one; it was skipped, with a "could not start" notice
  const seen2 = await ids(tpm), s = await hq.api(`repos/${repo.id}/start-ready`, {}); assert.equal(s.status, 200, JSON.stringify(s.json)); assert.deepEqual(s.json.started, ['T-02'])
  assert.deepEqual([(await tk(t2)).status, (await tk(t2)).assignee_agent_id], ['planning', e2]); assert.deepEqual(await liveOn(t2), [e2])
  assert.deepEqual(slotHolders(t2, e2), [e2])
  assert.equal((await hq.state()).attention.filter((a: any) => a.kind === 'launch_failed' && a.ticket_id === t2.id).length, 0)
  await waitFor('the TPM told once', () => toldSince(tpm, seen2, `HQ: engineer ${e2} started on T-02`))

  // the engineer it took over goes on as any other: its plan comes to the user for review
  const b = (await hq.modNext(e1)).batch; await hq.modEvent(e1, { kind: 'batch_received', id: b.id }) // the launch prompt
  await hq.hook(e1, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
  const held = hq.hook(e1, exitPlanMode('Plan: write orders.txt.'))
  const rv = await waitFor('the review', async () => (await hq.state()).reviews.find((x: any) => x.ticket_id === t1.id && x.status === 'open'))
  assert.equal((await tk(t1)).status, 'plan_review')
  await hq.api(`reviews/${rv.id}/answer`, { verdict: 'approve' }); await held
  await waitFor('implementing', async () => (await tk(t1)).status === 'implementing')
})

test('Bug 398, what it must not catch: an engineer still recorded refuses Launch; one that ended is not taken over: Launch starts a new one', async () => {
  const { f } = await setup('b398n')
  const t1 = await ticket(f, 'Orders'), t2 = await ticket(f, 'Invoices')
  const e1 = (await hq.api(`tickets/${t1.id}/launch`, {})).json.id; await working(e1)
  await hq.restart() // nothing under way: the ticket keeps its engineer
  const r = await hq.api(`tickets/${t1.id}/launch`, {}); assert.equal(r.status, 409); assert.match(r.json.error, /already has an engineer/)
  assert.equal((await tk(t1)).assignee_agent_id, e1)
  // half-started, then stopped before anyone pressed Launch again: a fresh engineer starts
  const e2 = (await hq.api(`tickets/${t2.id}/launch`, {})).json.id; await working(e2)
  await downBeforeRecorded(t2, e2, { status: 'queued', assignee_agent_id: null, branch: null, worktree_path: null })
  await hq.api(`agents/${e2}/stop`, {}); await waitFor('stopped', async () => (await agent(e2)).status === 'exited')
  const again = await hq.api(`tickets/${t2.id}/launch`, {}); assert.equal(again.status, 200, JSON.stringify(again.json)); assert.notEqual(again.json.id, e2)
  await working(again.json.id); assert.deepEqual(await liveOn(t2), [again.json.id]); assert.equal((await tk(t2)).assignee_agent_id, again.json.id)
})

test('Bug 398: a Fix conflicts the backend went down in the middle of is taken over by the next Fix conflicts: its instructions are not sent again', async () => {
  const { dir, repo, f, tpm } = await setup('b398c')
  const t1 = await ticket(f, 'Orders'), t2 = await ticket(f, 'Invoices')
  const e1 = (await hq.api(`tickets/${t1.id}/launch`, {})).json.id, e2 = (await hq.api(`tickets/${t2.id}/launch`, {})).json.id
  for (const [e, t, text] of [[e1, t1, 'v1\norders\n'], [e2, t2, 'v1\ninvoices\n']]) { // both finish with a line under v1: they conflict
    await working(e); const wt = (await tk(t)).worktree_path
    fs.writeFileSync(path.join(wt, 'version.txt'), text); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'version')
    assert.equal((await hq.mcp(e, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
    const pr = await hq.mcp(e, 'open_pr', { title: 'Add a line', body: 'Adds a line.\n\n## Deviations from approved plan\nNone' }); assert.equal(pr.isError, false, pr.text)
  }
  assert.equal((await hq.api(`tickets/${t1.id}/merge`, {})).status, 200)
  await waitFor('T-02 flagged', async () => (await tk(t2)).conflict_files)
  await hq.api(`agents/${e2}/stop`, {})
  const r = await hq.api(`tickets/${t2.id}/fix-conflicts`, {}); assert.equal(r.json.via, 'launch', JSON.stringify(r.json))
  const eb = r.json.engineer; await working(eb)
  await downBeforeRecorded(t2, eb, { status: 'pr_ready', assignee_agent_id: e2 })
  const seen = await ids(tpm)

  const again = await hq.api(`tickets/${t2.id}/fix-conflicts`, {}); assert.equal(again.status, 200, JSON.stringify(again.json))
  assert.deepEqual(again.json, { key: 'T-02', clean: false, via: 'launch', engineer: eb }) // it was sent the instructions again, as a message
  assert.deepEqual([(await tk(t2)).status, (await tk(t2)).assignee_agent_id], ['resolving', eb])
  assert.deepEqual(await fromHq(eb), []); assert.deepEqual(await liveOn(t2), [eb]); assert.deepEqual(slotHolders(t2, eb), [eb])
  await waitFor('the TPM told', () => toldSince(tpm, seen, `HQ: engineer ${eb} started on T-02 to merge main in and fix its conflicts`))
  // HQ's next look at merges doesn't take it for a fix whose engineer stopped (the ticket named the stopped one)
  const looked = await hq.beat('merges'); await hq.api(`repos/${repo.id}/sync`, {}); await hq.api(`repos/${repo.id}/sync`, {}); await hq.beats('merges', 2, { from: looked })
  assert.deepEqual((await hq.state()).attention.filter((a: any) => a.ticket_id === t2.id && !a.resolved_at).map((a: any) => a.kind), [])
  assert.match(fs.readFileSync(path.join(hq.hqHome, 'agents', eb, 'prompt.md'), 'utf8'), /HQ: main has moved on since you finished T-02/)
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'worktrees', 'T-02')))
})

test('Bug 398: a spec change on a finished ticket the backend went down in the middle of starting: the next change goes to that engineer, now the ticket\'s', async () => {
  const { f, tpm } = await setup('b398s')
  const t = await ticket(f, 'Orders'), e = (await hq.api(`tickets/${t.id}/launch`, {})).json.id
  await working(e); const wt = (await tk(t)).worktree_path
  fs.writeFileSync(path.join(wt, 'orders.txt'), 'orders\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'orders')
  assert.equal((await hq.mcp(e, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
  assert.equal((await hq.mcp(e, 'open_pr', { title: 'Orders', body: 'Orders.\n\n## Deviations from approved plan\nNone' })).isError, false)
  await hq.api(`agents/${e}/stop`, {}); await waitFor('stopped', async () => (await agent(e)).status === 'exited')
  const change = (spec: string) => hq.mcp(tpm, 'update_ticket_spec', { key: t.key, spec, user_asked: true })
  const first = await change('Orders, sorted.'); assert.equal(first.isError, false, first.text)
  const eb = await waitFor('the engineer for the change', async () => (await liveOn(t)).find((id: string) => id !== e)); await working(eb)
  await downBeforeRecorded(t, eb, { status: 'pr_ready', assignee_agent_id: e })
  const second = await change('Orders, sorted by date.'); assert.equal(second.isError, false, second.text)
  assert.deepEqual([(await tk(t)).status, (await tk(t)).assignee_agent_id, (await tk(t)).fixing], ['resolving', eb, 'changes'])
  assert.deepEqual(await liveOn(t), [eb]); assert.deepEqual(slotHolders(t, eb), [eb])
  assert.equal((await fromHq(eb)).length, 1) // the second change, told to the engineer that runs
})

/** Every engineer port block HQ has recorded: who holds it (null: free) and its first port. */
function blocks(): { idx: number; agent_id: string | null; base: string }[] {
  const db = hq.db({ readOnly: true })
  try {
    return (db.prepare('SELECT idx, agent_id, env FROM worker_slots ORDER BY idx').all() as any[])
      .map((r) => ({ idx: r.idx, agent_id: r.agent_id, base: JSON.parse(r.env).HQ_PORT_BASE }))
  } finally { db.close() }
}
const baseOf = (id: string) => blocks().find((b) => b.agent_id === id)?.base
const pendingRows = () => blocks().filter((b) => b.agent_id?.startsWith('pending-'))

test('Bug 422: ports a cut-short start held under its own name go with its engineer: freed when it ends, or at start-up when it is gone', async () => {
  const { f } = await setup('b422p')
  const t1 = await ticket(f, 'Orders'), t2 = await ticket(f, 'Invoices'), t3 = await ticket(f, 'Refunds'), t4 = await ticket(f, 'Coupons')
  const e1 = (await hq.api(`tickets/${t1.id}/launch`, {})).json.id; await working(e1)
  const e4 = (await hq.api(`tickets/${t4.id}/launch`, {})).json.id; await working(e4)
  const b1 = baseOf(e1)!, b4 = baseOf(e4)!; assert.ok(b1 && b4)
  // the backend went down after both sessions began and before either start was recorded; e4's terminal ended while it was down. And one start went down
  // before its engineer's session began at all (t3: a row under the launch's name, no engineer)
  await hq.down()
  const db = hq.db()
  try {
    for (const [t, e] of [[t1, e1], [t4, e4]]) {
      db.prepare("UPDATE tickets SET status = 'queued', assignee_agent_id = NULL, branch = NULL, worktree_path = NULL WHERE id = ?").run(t.id)
      db.prepare('UPDATE worker_slots SET agent_id = ? WHERE agent_id = ?').run(`pending-${t.id}`, e)
    }
    db.prepare('INSERT INTO worker_slots(idx, agent_id, env) VALUES (?, ?, ?)').run(90, `pending-${t3.id}`, JSON.stringify({ HQ_PORT_BASE: '1' }))
  } finally { db.close() }
  hq.tmux('kill-session', '-t', `hq-${e4}`)
  await hq.up()
  // the one that runs holds its ports by its own id now; the other two are free
  assert.deepEqual(pendingRows(), [])
  assert.equal(baseOf(e1), b1)
  assert.equal(blocks().find((b) => b.base === b4)?.agent_id ?? null, null); assert.equal(blocks().find((b) => b.idx === 90)?.agent_id, null)
  assert.equal((await agent(e4)).status, 'exited')
  // what it must not catch: while e1 runs, nobody else gets its ports
  const e2 = (await hq.api(`tickets/${t2.id}/launch`, {})).json.id; await working(e2); assert.notEqual(baseOf(e2), b1)
  // e1 ends before anyone took it over: its ports are free again (they stayed under `pending-…`, taken, for good) and the next engineer gets them
  await hq.api(`agents/${e1}/stop`, {}); await waitFor('stopped', async () => (await agent(e1)).status === 'exited')
  await waitFor('e1\'s ports free', () => blocks().find((b) => b.base === b1)?.agent_id === null)
  const e3 = (await hq.api(`tickets/${t3.id}/launch`, {})).json.id; await working(e3)
  assert.ok([b1, b4].includes(baseOf(e3)!), `${baseOf(e3)} is one of the freed blocks ${b1}, ${b4}`)
  // a take-over after a restart still finds the ports by the engineer's id (Bug 398)
  const t5 = await ticket(f, 'Vouchers'), e5 = (await hq.api(`tickets/${t5.id}/launch`, {})).json.id; await working(e5)
  await downBeforeRecorded(t5, e5, { status: 'queued', assignee_agent_id: null, branch: null, worktree_path: null })
  const r = await hq.api(`tickets/${t5.id}/launch`, {}); assert.equal(r.json.id, e5); assert.deepEqual(slotHolders(t5, e5), [e5])
  assert.equal((await tk(t5)).assignee_agent_id, e5)
})
