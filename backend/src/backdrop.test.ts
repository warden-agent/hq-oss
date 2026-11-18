// Bug 252: a double click on a button that opens one of HQ's dialogs opened it and closed it again, as the second press landed on the dialog's backdrop.
// The rule ui.tsx's Backdrop uses (frontend/src/backdrop.ts); real double clicks were checked in a headless browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKDROP_QUIET_MS, backdropCloses } from '../../frontend/src/backdrop.ts'

test('Bug 252: the second press of the double click that opened a dialog does not close it', () => {
  const opened = 10_000
  for (const after of [0, 1, 90, 200, 499]) assert.equal(backdropCloses(opened, opened + after), false, `${after} ms`)
})

test('Bug 252: what it must not catch: a click outside a moment later still closes the dialog', () => {
  const opened = 10_000
  assert.equal(BACKDROP_QUIET_MS, 500)
  for (const after of [500, 501, 800, 60_000]) assert.equal(backdropCloses(opened, opened + after), true, `${after} ms`)
})
