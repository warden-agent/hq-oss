// Parallel slots end to end (see harness.ts), on its own HQ so no other test's engineers hold slots: an engineer that
// finishes frees its slot at once, and the next go-ahead ticket starts without another click. Then a merge done by hand is
// noticed on the next Sync.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

test('a finished engineer frees its parallel slot at once: the next go-ahead ticket starts without another click', async () => {
  const dir = hq.repo('slots')
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'slots', request: 'Build slots' })).json
  assert.equal((await hq.api('settings', { key: 'concurrency_cap', value: 1 })).status, 200)
  const ticket = async (title: string) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.` })).json
  const engineer = (t: any) => waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
  const t1 = await ticket('One'), t2 = await ticket('Two')
  await hq.api(`features/${f.id}/start-ready`, {}) // One starts; Two gets the go-ahead and waits for the slot
  const e1 = await engineer(t1)
  assert.equal((await hq.state()).agents.filter((a: any) => a.ticket_id === t2.id).length, 0)
  const wt = path.join(dir, '.claude', 'worktrees', t1.key) // the engineer's part: commit, handoff, open_pr
  fs.writeFileSync(path.join(wt, 'one.txt'), 'one\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'add one.txt')
  assert.equal((await hq.mcp(e1.id, 'update_handoff', { kind: 'before_pr', text: 'added one.txt' })).isError, false)
  assert.equal((await hq.mcp(e1.id, 'open_pr', { title: 'Add one.txt', body: 'Adds it.\n\n## Deviations from approved plan\nNone' })).isError, false)
  await engineer(t2) // One is finished, so its slot went to Two

  sh(dir, 'merge', '-q', '--no-ff', '-m', 'merged by hand', `hq/slots/${t1.key}-one`) // The user merges One by hand, then clicks Sync
  assert.equal((await hq.api(`repos/${repo.id}/sync`, {})).status, 200)
  await waitFor('One to show as merged', async () => (await hq.state()).tickets.find((t: any) => t.id === t1.id).status === 'merged' || null)
})
