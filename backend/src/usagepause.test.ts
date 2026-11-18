// Bug 160: the "new launches paused" notice and the launch check name only the usage figures Claude Code sent (the account HQ
// runs on sends only the weekly one), and HQ can tell when no 5-hour figure comes (scheduler.ts), against a real SQLite DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-usagepause-'))
const { migrate, run, setSetting } = await import('./db.ts')
migrate()
const { overPause, canLaunch, noFiveHourFigure } = await import('./scheduler.ts')

const at = { five: 80, seven: 90 }
const sample = (fh: number | null, sd: number | null) =>
  run('INSERT INTO usage_samples(agent_id, at, five_hour_pct, seven_day_pct) VALUES (?,?,?,?)', 'tpm-x', Date.now(), fh, sd)

test('only the weekly figure came: the words name it alone, never "five-hour null%"', () => {
  assert.equal(overPause(null, 91, at), 'Weekly usage at 91%')
  assert.equal(overPause(undefined, 90.4, at), 'Weekly usage at 90%')
})

test('the 5-hour figure alone, both, and neither at its pause', () => {
  assert.equal(overPause(85, null, at), '5-hour usage at 85%')
  assert.equal(overPause(85, 40, at), '5-hour usage at 85%', 'a figure under its pause isn\'t named')
  assert.equal(overPause(85, 95, at), '5-hour usage at 85% and weekly usage at 95%')
  assert.equal(overPause(79, 89, at), null)
  assert.equal(overPause(null, null, at), null)
})

test('a missing figure is not 0%: a pause set to 0 acts only on a figure that came', () => {
  assert.equal(overPause(null, 5, { five: 0, seven: 90 }), null)
  assert.equal(overPause(Number.NaN, null, { five: 0, seven: 0 }), null)
  assert.equal(overPause(0, null, { five: 0, seven: 90 }), '5-hour usage at 0%')
})

test('no 5-hour figure: told only once a report came, and only while the latest report has none', () => {
  assert.equal(noFiveHourFigure(), false, 'no report yet: nothing to say')
  sample(null, null); assert.equal(noFiveHourFigure(), false, 'a context-only report says nothing about limits')
  sample(null, 40); assert.equal(noFiveHourFigure(), true)
  sample(null, null); assert.equal(noFiveHourFigure(), true, 'a later context-only report doesn\'t change it')
  sample(30, 40); assert.equal(noFiveHourFigure(), false)
})

test('launches: the reason names the weekly figure; a 5-hour pause of 0 doesn\'t stop them when no 5-hour figure comes', () => {
  setSetting('pause_five_hour_pct', 0); setSetting('pause_seven_day_pct', 95)
  run('DELETE FROM usage_samples'); sample(null, 91)
  assert.deepEqual(canLaunch(), { ok: true, free: 2 })
  setSetting('pause_seven_day_pct', 90)
  assert.deepEqual(canLaunch(), { ok: false, why: 'Weekly usage at 91%', free: 0 })
})
