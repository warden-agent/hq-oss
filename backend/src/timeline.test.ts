import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildTimeline, diffJson, diffRecords, diffSnapshots, endpointOf, flagCalls, isApi, type Call, type Endpoint } from './timeline.ts'

let n = 0
const call = (o: Partial<Call>): Call => ({ i: ++n, at: 1000 + n, end: 1000 + n + (o.ms ?? 5), ms: 5, method: 'GET', path: '/api/items', status: 200, type: 'application/json', action: 1, ...o })
const kinds = (m: Map<number, { kind: string }[]>, c: Call) => (m.get(c.i) ?? []).map((f) => f.kind)

test('endpoints: a label matches its pattern; with none, id-looking parts become :id', () => {
  const labels: Endpoint[] = [{ method: 'PATCH', path: '/api/items/:id', kind: 'instant' }]
  assert.equal(endpointOf('PATCH', '/api/items/42?x=1', labels).label?.kind, 'instant')
  assert.equal(endpointOf('PATCH', '/api/items/42/eat', labels).label, null)
  assert.equal(endpointOf('DELETE', '/api/items/3f2b1c9e-1a2b-4c3d-8e9f-0123456789ab', []).path, '/api/items/:id')
  assert.equal(endpointOf('GET', '/api/plan/meals', []).path, '/api/plan/meals') // words stay
})

test('isApi: the page and its files are not API calls', () => {
  assert.equal(isApi(call({ path: '/', type: 'text/html' }), []), false)
  assert.equal(isApi(call({ path: '/app.js', type: 'application/javascript' }), []), false)
  assert.equal(isApi(call({ path: '/api/authors', type: null, status: 304 }), []), true)
  assert.equal(isApi(call({ method: 'POST', path: '/submit.php' }), []), true)
})

test('duplicate: the same write twice in one action, and only that', () => {
  const a = call({ method: 'POST', path: '/api/reading/fill', body: 'h1' }), b = call({ method: 'POST', path: '/api/reading/fill', body: 'h1' })
  const other = call({ method: 'POST', path: '/api/reading/fill', body: 'h2' }) // a different body: two different adds
  const later = call({ method: 'POST', path: '/api/reading/fill', body: 'h1', action: 2 }) // the same call in the next action: the user did it twice
  const reads = [call({ path: '/api/authors' }), call({ path: '/api/authors' }), call({ path: '/api/authors' })] // a page reloading its lists: not a flag
  const sse = [call({ path: '/api/events', stream: true, type: 'text/event-stream' }), call({ path: '/api/events', stream: true, type: 'text/event-stream' })]
  const f = flagCalls([a, b, other, later, ...reads, ...sse], [])
  assert.deepEqual(kinds(f, a), []); assert.deepEqual(kinds(f, b), ['duplicate']); assert.equal(f.get(b.i)![0]!.why, '2x in one action')
  for (const c of [other, later, ...reads, ...sse]) assert.deepEqual(kinds(f, c), [], c.path)
})

test('slow: against the endpoint\'s own normal in this run, never its first call; and against its label', () => {
  const first = call({ path: '/api/plan', ms: 400 }) // a cold first call is no flag
  const normal = [call({ path: '/api/plan', ms: 10 }), call({ path: '/api/plan', ms: 12 }), call({ path: '/api/plan', ms: 9 })]
  const slow = call({ path: '/api/plan', ms: 300 }), tiny = call({ path: '/api/x', ms: 1 })
  const tinyMore = [call({ path: '/api/x', ms: 1 }), call({ path: '/api/x', ms: 1 }), call({ path: '/api/x', ms: 9 })] // 9× of 1 ms: too small to matter
  const f = flagCalls([first, ...normal, slow, tiny, ...tinyMore], [])
  assert.deepEqual(kinds(f, first), []); assert.deepEqual(kinds(f, slow), ['slow']); assert.match(f.get(slow.i)![0]!.why, /normal here is 1\dms/)
  for (const c of [...normal, tiny, ...tinyMore]) assert.deepEqual(kinds(f, c), [])
  // too few calls to know a normal: nothing
  assert.deepEqual([...flagCalls([call({ path: '/api/y', ms: 5 }), call({ path: '/api/y', ms: 900 })], []).values()], [])
  // a label: an instant call taking seconds is slow even as the first; a heavy one isn't
  const labels: Endpoint[] = [{ method: 'POST', path: '/api/import', kind: 'heavy' }, { method: 'GET', path: '/api/items', kind: 'instant' }]
  const g = flagCalls([call({ path: '/api/items', ms: 2500 }), call({ method: 'POST', path: '/api/import', ms: 20_000 })], labels)
  assert.deepEqual([...g.values()].flat().map((x) => `${x.kind} ${x.path}`), ['slow /api/items'])
  // a project's own limits
  assert.deepEqual([...flagCalls([call({ path: '/api/items', ms: 2500 })], labels, { label_ms: { instant: 5000 } }).values()], [])
})

test('error: any 4xx/5xx, but not HQ\'s own 503 while it resets the app', () => {
  const bad = call({ method: 'POST', status: 400 }), reset = call({ status: 503, resetting: true })
  const f = flagCalls([bad, reset], [])
  assert.deepEqual(f.get(bad.i)?.map((x) => [x.kind, x.status]), [['error', 400]]); assert.equal(f.get(reset.i), undefined)
})

test('record diffs: by id, with what changed; without ids by value', () => {
  const a = [{ id: 1, name: 'Dune', quantity: 1, updatedAt: 'x' }, { id: 2, name: 'bread' }]
  const b = [{ id: 1, name: 'Dune', quantity: 2, updatedAt: 'y' }, { id: 3, name: 'Emma' }, { id: 4, name: 'Emma' }]
  assert.deepEqual(diffRecords(a, b), ['~Dune (quantity: 1→2)', '+Emma', '+Emma', '-bread'])
  assert.deepEqual(diffRecords(['a', 'b'], ['a', 'b', 'b']), ['+b'])
  assert.deepEqual(diffJson({ shelf: { top: ['x'] }, goal: 10 }, { shelf: { top: ['x', 'y'] }, goal: 12 }), ['shelf.top: +y', 'goal: 10→12'])
})

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hq-timeline-'))
test('snapshot diffs: JSON files, SQLite tables, other files by lines, files that come and go', () => {
  const a = tmp(), b = tmp()
  fs.mkdirSync(path.join(a, 'data')); fs.mkdirSync(path.join(b, 'data'))
  fs.writeFileSync(path.join(a, 'data', 'reading.json'), '[]'); fs.writeFileSync(path.join(b, 'data', 'reading.json'), JSON.stringify([{ id: 'x', name: 'Emma' }, { id: 'y', name: 'Emma' }]))
  fs.writeFileSync(path.join(a, 'data', 'notes.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(b, 'data', 'notes.txt'), 'one\nthree\n')
  fs.writeFileSync(path.join(b, 'data', 'wishlist.json'), '[]')
  for (const [dir, rows] of [[a, [['Dune']]], [b, [['Dune'], ['Ulysses']]]] as const) {
    const db = new DatabaseSync(path.join(dir, 'app.db')); db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)')
    for (const [nm] of rows) db.prepare('INSERT INTO items(name) VALUES (?)').run(nm); db.close()
  }
  assert.deepEqual(diffSnapshots(a, b), ['items: +Ulysses', 'notes: +1 -1 lines', 'reading: +Emma, +Emma'])
  assert.deepEqual(diffSnapshots(b, a), ['items: -Ulysses', 'notes: +1 -1 lines', 'reading: -Emma, -Emma', 'wishlist: file removed'])
  assert.deepEqual(diffSnapshots(a, a), [])
})

/** A recording folder as the recorder writes it. */
function recording(): string {
  const dir = tmp(), w = (f: string, rows: unknown[]) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const snap = (nn: number, items: unknown[]) => {
    const d = path.join(dir, 'snapshots', String(nn).padStart(4, '0'), 'data'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'reading.json'), JSON.stringify(items))
  }
  const t = Date.UTC(2026, 10, 17, 14, 2, 3, 400)
  w('actions.jsonl', [{ at: t, phase: 'start', label: 'click "Plan" on Omelette again', action: 1 }, { at: t + 2000, phase: 'end', label: 'click "Plan" on Omelette again', action: 1, ok: true },
    { at: t + 2100, phase: 'start', label: 'click "Nope"', action: 2 }, { at: t + 6100, phase: 'end', label: 'click "Nope"', action: 2, ok: false, why: 'no such element on the page' }])
  w('api.jsonl', [{ i: 1, at: t + 1610, end: t + 1622, ms: 12, method: 'POST', path: '/api/reading/fill', status: 200, type: 'application/json', body: 'aa', action: 1 },
    { i: 2, at: t + 1611, end: t + 1623, ms: 12, method: 'POST', path: '/api/reading/fill', status: 200, type: 'application/json', body: 'aa', action: 1 },
    { i: 3, at: t + 1630, end: t + 1631, ms: 1, method: 'GET', path: '/api/reading', status: 200, type: 'application/json', action: 1 },
    { i: 4, at: t + 1632, end: t + 1633, ms: 1, method: 'GET', path: '/app.js', status: 200, type: 'application/javascript', action: 1 }])
  w('snaps.jsonl', [{ n: 0, at: t - 100, label: 'start', changed: true, hash: 'h0', action: null },
    { n: 1, at: t + 1620, label: 'click "Plan" on Omelette again', changed: true, hash: 'h1', action: 1 },
    { n: 2, at: t + 6100, label: 'click "Nope"', changed: false, hash: 'h1', action: 2 }])
  w('browser.jsonl', [{ at: t + 5, kind: 'outside', host: 'fonts.googleapis.com', action: 1 }, { at: t + 6, kind: 'outside', host: 'fonts.googleapis.com', action: 1 }])
  snap(0, []); snap(1, [{ id: 'a', name: 'Emma' }, { id: 'b', name: 'Emma' }])
  fs.writeFileSync(path.join(dir, 'server.log'), `${t + 1625}\tapp\tGET /api/reading 200\n${t + 1626}\tapp\tError: double fill\n`)
  return dir
}
test('buildTimeline: one clock, diffs only, flags inline, the page\'s files left out; timeline.md and data.jsonl written', () => {
  const dir = recording(), t = buildTimeline(dir, { name: 'plan twice' })
  const lines = t.rows.map((r) => `${r.source} | ${r.text}`)
  assert.deepEqual(lines, [
    'tester | click "Plan" on Omelette again', 'browser | couldn\'t reach fonts.googleapis.com (no internet in HQ\'s test: not the app\'s fault)',
    'api | POST /api/reading/fill → 200 (12ms)', 'api | POST /api/reading/fill → 200 (12ms) ⚠ 2x', 'data | reading: +Emma, +Emma', 'server | app: Error: double fill',
    'api | 1 read: /api/reading', 'tester | ✗ click "Nope" (no such element on the page)'])
  assert.deepEqual(t.flags.map((f) => [f.kind, f.method, f.path]), [['duplicate', 'POST', '/api/reading/fill']])
  assert.equal(t.clean, false); assert.match(t.summary, /^plan twice: 2 steps, 1 couldn't be done, 3 API calls, data changed in 1 step, flags: 1 duplicate/)
  assert.match(fs.readFileSync(path.join(dir, 'timeline.md'), 'utf8'), /\| \d\d:\d\d:\d\d\.\d{3} \| api \| POST \/api\/reading\/fill → 200 \(12ms\) ⚠ 2x \|/)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'data.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).changes), [['reading: +Emma, +Emma']])
})
test('buildTimeline: a clean scenario is one line', () => {
  const dir = tmp(), marks = [{ at: 1, phase: 'start', label: 'open /', action: 1 }, { at: 900, phase: 'end', label: 'open /', action: 1, ok: true }]
  fs.writeFileSync(path.join(dir, 'actions.jsonl'), marks.map((m) => `${JSON.stringify(m)}\n`).join(''))
  const t = buildTimeline(dir, { name: 'look' })
  assert.equal(t.clean, true); assert.equal(t.summary, 'look: 1 step OK, 0 API calls, data changed in 0 steps, no flags (0.9 s)')
})
