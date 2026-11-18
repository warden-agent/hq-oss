// The feature map as HQ keeps it (mapstore.ts), against a real SQLite DB in a temp HQ_HOME: a ticket's change waits for its merge and goes in once,
// a change that would push the map over the cap is refused, "nothing changed" doesn't wipe a change, an undone run takes its changes back out, the TPM's
// FEATURE-MAP.md follows the map, and Remove drops it while other projects keep theirs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-mapstore-'))
const { migrate, run, setSetting } = await import('./db.ts')
migrate()
const { applyMapOnMerge, currentMap, mapForEngineer, mapView, mapWanted, markUnchanged, pendingMapChange, recordChange, saveMap, undoMapChanges } = await import('./mapstore.ts')
const { deleteRepoRows } = await import('./clear.ts')
const { getTicket } = await import('./records.ts')
const { tpmWorkspace } = await import('./projectmd.ts')
const { MAP_CAP } = await import('./featuremap.ts')

const now = Date.now()
run("INSERT INTO repos(id, name, path, kind, remote, created_at) VALUES ('r1', 'demo', '/tmp/demo', 'local', NULL, ?), ('r2', 'other', '/tmp/other', 'local', NULL, ?)", now, now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, handle, created_at, updated_at) VALUES ('f1', 'r1', 'list', 'list', 'x', 'planning', 'F-1', ?, ?)", now, now)
const UI = JSON.stringify([{ id: 'A1', kind: 'ui', text: 'The list shows each item.' }]), BACK = JSON.stringify([{ id: 'A1', kind: 'backend', text: 'Saving twice keeps one record.' }])
const tk = (id: string, criteria: string, repairs: string | null = null) => run(
  'INSERT INTO tickets(id, feature_id, key, slug, title, status, deps, criteria, repairs_main, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  id, 'f1', id.toUpperCase(), id, id, 'implementing', '[]', criteria, repairs, now, now)
tk('t1', UI); tk('t2', UI); tk('t3', BACK); tk('t4', UI, 'abc1234'); tk('t5', UI)
const t = (id: string) => getTicket(id)!

test('who is asked about the map: screen criteria, not HQ\'s repair tickets, not with the tester off', () => {
  assert.equal(mapWanted(t('t1')), true); assert.equal(mapWanted(t('t3')), false); assert.equal(mapWanted(t('t4')), false)
  assert.match(mapForEngineer(t('t1'), 'r1'), /## Feature map\n[^]+\(No map yet/); assert.equal(mapForEngineer(t('t3'), 'r1'), '')
  setSetting('tester', 'off'); assert.equal(mapWanted(t('t1')), false); setSetting('tester', 'on')
})
test('a change waits for its merge, goes in once, and an undo takes it back out', () => {
  saveMap('r1', [{ screen: 'Books (tab)', lines: ['Add: puts an item on the list'] }], 'test')
  const before = currentMap('r1')
  const r = recordChange(t('t1'), 'r1', [{ screen: 'Books (tab)', add: ['Search box: filters the list'], remove: [], gone: false }])
  assert.ok('map' in r); assert.match(r.map, /Search box/); assert.equal(currentMap('r1'), before, 'not before the merge')
  assert.deepEqual(mapView('r1').pending, [{ ticket: 't1', key: 'T1', screens: 'Books (tab)', unchanged: false }])
  markUnchanged(t('t1'), 'r1'); assert.equal(pendingMapChange('t1')!.change.length, 1, '"nothing changed" by mistake keeps the change it gave')
  const again = recordChange(t('t1'), 'r1', [{ screen: 'Books (tab)', add: [], remove: ['No such line'], gone: false }])
  assert.ok('error' in again && /has no line "No such line"[^]+It has:\n- Add: puts an item on the list\n- Search box: filters the list/.test(again.error), 'its own earlier edit counts')
  applyMapOnMerge(t('t1'), 'r1'); const after = currentMap('r1'); assert.match(after, /Add: puts an item on the list\n- Search box/)
  saveMap('r1', [{ screen: 'Books (tab)', lines: ['Add: puts an item on the list', 'Search box: filters the list', 'Clear: empties it'] }], 'someone later')
  applyMapOnMerge(t('t1'), 'r1'); assert.match(currentMap('r1'), /Clear: empties it/, 'the watcher and Merge both seeing the merge: applied once')
  assert.match(fs.readFileSync(path.join(tpmWorkspace('r1'), 'FEATURE-MAP.md'), 'utf8'), /Clear: empties it/)
  assert.ok('error' in recordChange(t('t1'), 'r1', [{ screen: 'X', add: ['y'], remove: [], gone: false }]), 'a merged ticket\'s change is in already')
  undoMapChanges('r1', [t('t1'), t('t3')]); assert.equal(currentMap('r1'), before)
  assert.match(mapView('r1').by!.by, /undone/)
})
test('a change that pushes the map over the cap is refused and nothing is kept; one that shortens an over-long map is taken', () => {
  const long = Array.from({ length: 80 }, (_, i) => `Shelf ${i}: shows what is on shelf number ${i} of the library, with how many of each`)
  const r = recordChange(t('t2'), 'r1', [{ screen: 'Shelves (tab)', add: long, remove: [], gone: false }])
  assert.ok('error' in r && /over HQ's limit/.test(r.error)); assert.equal(pendingMapChange('t2'), null)
  saveMap('r1', [{ screen: 'Shelves (tab)', lines: long }], 'too long already'); assert.ok(currentMap('r1').length > MAP_CAP)
  assert.ok('map' in recordChange(t('t5'), 'r1', [{ screen: 'Shelves (tab)', add: [], remove: long.slice(70), gone: false }]))
})
test('Remove drops the project\'s map; the other project keeps its own', () => {
  saveMap('r2', [{ screen: 'Home (page)', lines: ['Start: begins'] }], 'test')
  run("DELETE FROM tickets WHERE feature_id = 'f1'"); run("DELETE FROM features WHERE repo_id = 'r1'") // as Remove does before it
  deleteRepoRows('r1'); assert.equal(currentMap('r1'), ''); assert.match(currentMap('r2'), /Home/)
})
