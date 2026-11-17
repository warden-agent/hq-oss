// Bug 127: one click on Start N ready tells the project's TPM once, after all N engineers have started, with each one's id and
// branch. One notice per engineer woke the TPM after the first start, and it told the user the rest were "still ready to start".
// On its own HQ: the parallel limit is a global setting. The tests act as the TPM (fake Claude Code); see harness.ts.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

async function project(name: string): Promise<{ repo: any; f: any; tpm: string }> {
  const repo = (await hq.api('repos', { path: hq.repo(name) })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  return { repo, f, tpm: f.tpm_agent_id }
}
const ticket = async (f: any, title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
const startedNotices = async (tpm: string) => (await hq.state()).messages.filter((m: any) => m.from_id === 'hq' && m.to_id === tpm && /started/.test(m.body))
const engineerOf = async (t: any) => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status !== 'exited')
/** The parallel limit, as slots free for this test: earlier tests' engineers are still running and count against it. */
const running = async () => (await hq.state()).agents.filter((a: any) => a.role === 'engineer' && a.status !== 'exited').length
const cap = async (free: number) => { const n = (await running()) + free; assert.equal((await hq.api('settings', { key: 'concurrency_cap', value: n })).status, 200) }

test('Start on four ready tickets in two features: the TPM gets one notice naming every engineer, after all four started', async () => {
  await cap(4)
  const { repo, f, tpm } = await project('four')
  const f2 = (await hq.api('features', { repoId: repo.id, title: 'four-b', request: 'Build four-b too' })).json
  assert.equal(f2.tpm_agent_id ?? tpm, tpm, 'one TPM per project')
  const all = [await ticket(f, 'Subqueries'), await ticket(f, 'Strings'), await ticket(f, 'Sessions'), await ticket(f2, 'Compare roles')]
  const r = await hq.api(`repos/${repo.id}/start-ready`, {}) // returns once the fill is over
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.started.length, 4); assert.deepEqual(r.json.queued, [])
  const told = await startedNotices(tpm)
  assert.equal(told.length, 1, told.map((m: any) => m.body).join('\n'))
  assert.match(told[0].body, /^HQ: 4 engineers started, one per ticket: /)
  for (const t of all) {
    const e = await engineerOf(t); assert.ok(e, `an engineer on ${t.key}`)
    const branch = (await hq.state()).tickets.find((x: any) => x.id === t.id).branch
    assert.ok(told[0].body.includes(`${e.id} on ${t.key} (branch ${branch})`), `${t.key} in: ${told[0].body}`)
  }
  assert.doesNotMatch(told[0].body, /go-ahead/) // nothing waits for a slot
})

test('Start with more ready tickets than slots: one notice names the started ones and says the rest start by themselves', async () => {
  await cap(2)
  const { repo, f, tpm } = await project('capped')
  const [a, b, c] = [await ticket(f, 'One'), await ticket(f, 'Two'), await ticket(f, 'Three')]
  const r = await hq.api(`repos/${repo.id}/start-ready`, {})
  assert.deepEqual([r.json.started, r.json.queued], [[a.key, b.key], [c.key]])
  let told = await startedNotices(tpm)
  assert.equal(told.length, 1, told.map((m: any) => m.body).join('\n'))
  assert.match(told[0].body, /^HQ: 2 engineers started, one per ticket: /)
  assert.ok(told[0].body.endsWith(` ${c.key} has the user's go-ahead too and starts by itself when an engineer slot frees up: there is nothing for the user to click.`), told[0].body)
  // The TPM's own look at the board says the same, not just "queued"
  const listed = JSON.parse((await hq.mcp(tpm, 'list_tickets', {})).text).flatMap((x: any) => x.tickets)
  assert.match(listed.find((x: any) => x.key === c.key).go_ahead, /^started: HQ starts an engineer on it as soon as a slot is free/)
  assert.equal(listed.find((x: any) => x.key === a.key).go_ahead, undefined) // only a ticket still waiting carries it

  await cap(1) // a slot frees: the third starts, with the same words as any single start
  const e3 = await waitFor(`an engineer on ${c.key}`, () => engineerOf(c))
  const first = told[0].id
  told = await waitFor('the second notice', async () => { const m = await startedNotices(tpm); return m.length === 2 ? m : null })
  const branch = (await hq.state()).tickets.find((x: any) => x.id === c.id).branch
  assert.equal(told.find((m: any) => m.id !== first).body, `HQ: engineer ${e3.id} started on ${c.key} (branch ${branch}). Address messages for this ticket to id ${e3.id}.`)
})

test('an engineer launched on its own ticket is still announced at once, by itself', async () => {
  await cap(1)
  const { f, tpm } = await project('single')
  const t = await ticket(f, 'Alone')
  const e = (await hq.api(`tickets/${t.id}/launch`, {})).json
  const told = await waitFor('the notice', async () => { const m = await startedNotices(tpm); return m.length ? m : null })
  assert.equal(told.length, 1); assert.match(told[0].body, new RegExp(`^HQ: engineer ${e.id} started on ${t.key} \\(branch `))
})
