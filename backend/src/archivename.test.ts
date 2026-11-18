// The archive Clear and Remove write (clear.ts archive): each feature's heading in SUMMARY.md says where it stood in the board's
// words, not its stored status word, which stays "planning" for a finished feature (Bug 222); the folder is named in the user's
// local time, like the summary's heading (Bug 225, it was UTC), and two archives in one second get a folder each.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TZ = 'America/Chicago' // 6 hours behind UTC in November: a UTC name is plainly wrong here
process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-archivename-'))
const { migrate, run } = await import('./db.ts')
migrate()
const { archive, stamp } = await import('./clear.ts')
const { features, getRepo, tickets } = await import('./records.ts')
const { PATHS } = await import('./config.ts')

const at = Date.UTC(2026, 10, 18, 9, 32, 0) // 03:32 in Chicago
run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('r1', 'garden', '/tmp/garden-none', 'local', ?)", at)
const feature = (id: string, title: string, status = 'planning') =>
  run('INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    id, 'r1', id, title, `I want ${title}.`, status, at, at)
const ticket = (id: string, f: string, key: string, status: string) =>
  run('INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, f, key, key.toLowerCase(), key, status, at, at)
feature('fa', 'Water the plants'); ticket('a1', 'fa', 'T-01', 'merged'); ticket('a2', 'fa', 'T-02', 'merged'); ticket('a3', 'fa', 'T-03', 'cancelled')
feature('fb', 'A chart'); ticket('b1', 'fb', 'T-04', 'merged'); ticket('b2', 'fb', 'T-05', 'implementing')
feature('fc', 'Not planned yet')
feature('fd', 'Dropped', 'cancelled'); ticket('d1', 'fd', 'T-06', 'cancelled')

const write = (how: 'cleared' | 'removed' = 'cleared') => {
  const fs0 = features().filter((f) => f.repo_id === 'r1'), ids = new Set(fs0.map((f) => f.id))
  return archive(getRepo('r1')!, fs0, tickets().filter((t) => ids.has(t.feature_id)), new Map(), how)
}

test('the folder is named in local time, and archives in the same second each get their own folder', () => {
  assert.equal(stamp(at), '20261118-033200')
  mock.timers.enable({ apis: ['Date'], now: at })
  try {
    const one = write(), two = write('removed'), three = write()
    assert.deepEqual([one, two, three].map((d) => path.relative(PATHS.archive, d)),
      ['garden/20261118-033200', 'garden/20261118-033200-2', 'garden/20261118-033200-3'])
    assert.match(fs.readFileSync(path.join(one, 'SUMMARY.md'), 'utf8'), /^# garden: cleared 18\/11\/2026, 03:32:00/) // the same clock as the folder
    assert.match(fs.readFileSync(path.join(two, 'SUMMARY.md'), 'utf8'), /^# garden: removed /) // its own summary: the first one wasn't overwritten
    assert.match(fs.readFileSync(path.join(one, 'SUMMARY.md'), 'utf8'), /^# garden: cleared /)
    // Remove's test and anyone else reading "the newest" sort the names: the later ones still come last
    assert.equal(fs.readdirSync(path.join(PATHS.archive, 'garden')).sort().at(-1), '20261118-033200-3')
  } finally { mock.timers.reset() }
})

test("each feature's heading says where it stood, as its board box did, not its stored status word", () => {
  const sum = fs.readFileSync(path.join(write(), 'SUMMARY.md'), 'utf8')
  assert.match(sum, /^## Water the plants \(✓ done · all 2 merged\): fa-fa\/$/m) // stored "planning"; the cancelled ticket doesn't count
  assert.match(sum, /^## A chart \(1\/2 merged\): fb-fb\/$/m)
  assert.match(sum, /^## Not planned yet \(no tickets yet\): fc-fc\/$/m)
  assert.match(sum, /^## Dropped \(cancelled\): fd-fd\/$/m)
  assert.doesNotMatch(sum, /\(planning\)/)
})
