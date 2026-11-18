// The feature map (featuremap.ts, mapstore.ts) end to end, against a real backend with fake agents (harness.ts): an engineer whose ticket has screen
// criteria says what changed on the map before open_pr, HQ refuses code words, and the change goes into the map when the ticket merges, not before.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

async function setup(name: string): Promise<{ dir: string; repo: any; f: any }> {
  const dir = hq.repo(name)
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: name, request: `Build ${name}` })).json
  return { dir, repo, f }
}
const UI = [{ kind: 'ui', text: 'The list shows each item with its quantity.' }]
const ticket = async (f: any, title: string, criteria: unknown[]) => (await hq.api('tickets', { featureId: f.id, title, size: 'S', spec: `${title}.`, criteria })).json
const engineer = async (t: any) => {
  assert.equal((await hq.api(`tickets/${t.id}/launch`, {})).status, 200)
  return waitFor(`an engineer on ${t.key}`, async () => (await hq.state()).agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t.id && a.status === 'working'))
}
const TEST = (name: string) => `require('node:test').test('${name}',()=>{})\n`
/** An engineer's work: a test for its one criterion, a commit, the before_pr handoff. Then open_pr with that test named. */
async function build(dir: string, t: any, e: any, file: string): Promise<void> {
  const wt = path.join(dir, '.claude', 'worktrees', t.key); fs.mkdirSync(path.join(wt, 'test'), { recursive: true })
  fs.writeFileSync(path.join(wt, file), `${file}\n`); fs.writeFileSync(path.join(wt, 'test', `${t.key}.test.js`), TEST(`shows ${t.key}`))
  sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', t.title)
  assert.equal((await hq.mcp(e.id, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
}
const openPr = (t: any, e: any, more: Record<string, unknown> = {}) => hq.mcp(e.id, 'open_pr', { title: 'Done', body: 'Done.\n\n## Deviations from approved plan\nNone',
  tests: [{ criterion: 'A1', file: `test/${t.key}.test.js`, name: `shows ${t.key}` }], ...more })
const mapOf = async (repo: any) => (await hq.state()).maps.find((m: any) => m.id === repo.id)
const merge = async (t: any) => { const r = await hq.api(`tickets/${t.id}/merge`, {}); assert.equal(r.status, 200, JSON.stringify(r.json)) }

test('a ticket with screen criteria says what changed on the map; HQ refuses code words; the change goes in when it merges, not before', async () => {
  const { dir, repo, f } = await setup('fmap')
  const t1 = await ticket(f, 'Book list', UI), e1 = await engineer(t1)
  assert.match((await hq.mcp(e1.id, 'get_ticket')).text, /## Feature map\n[^\n]+update_feature_map[^\n]+The map now:\n\n\(No map yet/)
  await build(dir, t1, e1, 'list.js')
  const asked = await openPr(t1, e1); assert.equal(asked.isError, true); assert.match(asked.text, /screen criteria[^]+update_feature_map[^]+feature_map_unchanged: true/)
  const code = await hq.mcp(e1.id, 'update_feature_map', { screens: [{ screen: 'Books (tab)', add: ['"Add" button: calls addItem and writes data/books.json'] }] })
  assert.equal(code.isError, true); assert.match(code.text, /"data\/books\.json", "addItem" are code, not what a user sees[^]+Nothing was kept\./)
  const screens = [{ screen: 'Books (tab)', add: ['"Add" box + Add: puts an item on the list', '- Each row: the item and how many'] }]
  const ok = await hq.mcp(e1.id, 'update_feature_map', { screens })
  assert.equal(ok.isError, false, ok.text); assert.match(ok.text, /The map will then read:\n\n## Books \(tab\)\n- "Add" box \+ Add: puts an item on the list\n- Each row: the item and how many\n$/)
  const done = await openPr(t1, e1); assert.equal(done.isError, false, done.text)
  let m = await mapOf(repo); assert.equal(m.text, '', 'not in the map before the merge')
  assert.deepEqual(m.pending.map((p: any) => `${p.key} ${p.screens}`), [`${t1.key} Books (tab)`])
  await merge(t1)
  m = await waitFor('the map', async () => { const x = await mapOf(repo); return x.text ? x : null })
  assert.equal(m.text, '## Books (tab)\n- "Add" box + Add: puts an item on the list\n- Each row: the item and how many\n')
  assert.match(m.by.by, new RegExp(`^${t1.key} merged \\(Books \\(tab\\)\\)$`)); assert.deepEqual(m.pending, [])
  const md = fs.readFileSync(path.join(hq.hqHome, 'workspaces', `repo-${repo.id}`, 'tpm', 'FEATURE-MAP.md'), 'utf8'); assert.match(md, /## Books \(tab\)\n- "Add" box/)

  // Two tickets change the same screen at once: both changes land, whichever merges first.
  const t2 = await ticket(f, 'Search', UI), t3 = await ticket(f, 'Read', UI), e2 = await engineer(t2), e3 = await engineer(t3)
  assert.match((await hq.mcp(e2.id, 'get_ticket')).text, /## Feature map\n[^]+## Books \(tab\)\n- "Add" box/)
  await build(dir, t2, e2, 'search.js'); await build(dir, t3, e3, 'read.js')
  assert.equal((await hq.mcp(e2.id, 'update_feature_map', { screens: [{ screen: 'Books (tab)', add: ['Search box: filters the list'] }] })).isError, false)
  const typo = await hq.mcp(e3.id, 'update_feature_map', { screens: [{ screen: 'books (tab)', remove: ['Each row: the item'], add: ['Each row: the item, how many, and ✓'] }] })
  assert.equal(typo.isError, true)
  assert.match(typo.text, /Books \(tab\) has no line "Each row: the item"[^]+It has:\n- "Add" box \+ Add: puts an item on the list\n- Each row: the item and how many\nNothing was kept\.$/)
  assert.equal((await hq.mcp(e3.id, 'update_feature_map', { screens: [{ screen: 'books (tab)', remove: ['Each row: the item and how many'],
    add: ['Each row: the item, how many, and ✓ to mark it read'] }] })).isError, false)
  assert.equal((await openPr(t2, e2)).isError, false); assert.equal((await openPr(t3, e3)).isError, false)
  await merge(t3); await merge(t2)
  m = await waitFor('both changes', async () => { const x = await mapOf(repo); return /Search box/.test(x.text) && /✓/.test(x.text) ? x : null })
  assert.equal(m.text, '## Books (tab)\n- "Add" box + Add: puts an item on the list\n- Each row: the item, how many, and ✓ to mark it read\n- Search box: filters the list\n')

  // Nothing a user sees changed: said once at open_pr, and the map stays as it is. A ticket with no screen criteria isn't asked.
  const t4 = await ticket(f, 'Faster list', UI), e4 = await engineer(t4); await build(dir, t4, e4, 'fast.js')
  assert.equal((await openPr(t4, e4, { feature_map_unchanged: true })).isError, false)
  assert.deepEqual((await mapOf(repo)).pending.map((p: any) => `${p.key} ${p.unchanged}`), [`${t4.key} true`])
  const t5 = await ticket(f, 'Store', [{ kind: 'backend', text: 'Saving twice keeps one record.' }]), e5 = await engineer(t5); await build(dir, t5, e5, 'store.js')
  assert.equal((await openPr(t5, e5)).isError, false)
  await merge(t4); await merge(t5)
  await waitFor('both merged', async () => (await hq.state()).tickets.filter((t: any) => [t4.id, t5.id].includes(t.id) && t.status === 'merged').length === 2)
  assert.equal((await mapOf(repo)).text, m.text)
  const again = await hq.api(`repos/${repo.id}/first-map`, {}); assert.equal(again.status, 409); assert.match(again.json.error, /has a feature map already/)
})

test('the first map: refused, and said why, when HQ has no way to start the app', async () => {
  const { repo } = await setup('fmap-first')
  const r = await hq.api(`repos/${repo.id}/first-map`, {}); assert.equal(r.status, 409); assert.match(r.json.error, /press Launch app once/)
  assert.equal((await mapOf(repo)).first, null)
})
