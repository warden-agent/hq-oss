// Bug 252: a double click on a button that opens one of HQ's dialogs opened it and closed it again, as the second press landed on the dialog's backdrop.
// The rule ui.tsx's Backdrop uses (frontend/src/backdrop.ts); real double clicks were checked in a headless browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { BACKDROP_QUIET_MS, backdropCloses, confirmPressCounts } from '../../frontend/src/backdrop.ts'

test('Bug 252: the second press of the double click that opened a dialog does not close it', () => {
  const opened = 10_000
  for (const after of [0, 1, 90, 200, 499]) assert.equal(backdropCloses(opened, opened + after), false, `${after} ms`)
})

test('Bug 252: what it must not catch: a click outside a moment later still closes the dialog', () => {
  const opened = 10_000
  assert.equal(BACKDROP_QUIET_MS, 500)
  for (const after of [500, 501, 800, 60_000]) assert.equal(backdropCloses(opened, opened + after), true, `${after} ms`)
})

// Bug 390: a double click on "Undo this run" undid the run: the confirm opened on the first click and its own "Undo this run" sat where the summary's
// was, so the second click pressed it. Checked with real double clicks in a headless browser on every ask-first button (a throwaway script).
test('Bug 390: the rest of the double click that opened a confirm never presses its buttons', () => {
  for (const detail of [2, 3, 4]) assert.equal(confirmPressCounts(detail), false, `click ${detail} of a multiple click`)
})

test('Bug 390: what it must not catch: the keyboard and a click of its own, at once', () => {
  assert.equal(confirmPressCounts(0), true, 'Enter or Space on the focused button')
  assert.equal(confirmPressCounts(1), true, 'a single click, however soon after the confirm opened')
})

test('Bug 390: both of the confirm\'s buttons go through the rule', () => {
  const ui = fs.readFileSync(new URL('../../frontend/src/ui.tsx', import.meta.url), 'utf8')
  const dialog = ui.slice(ui.indexOf('export function StopDialog('), ui.indexOf('\nexport function NewProjectDialog('))
  assert.match(dialog, /if \(confirmPressCounts\(e\.detail\)\) done\(go\)/)
  const clicks = [...dialog.matchAll(/onClick=\{([^}]*)\}/g)].map((m) => m[1])
  assert.deepEqual(clicks, ['press(false)', 'press(true)'])
})
