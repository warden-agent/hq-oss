// Bug 407: one Escape closed both a confirm (the results popover's Merge into main) and the popover it came from: App and StopDialog each listened for
// Escape. Now every layer joins one stack (frontend/src/layers.ts) and Escape closes only the top one; checked in a headless browser on an isolated HQ.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { escapeTop, openLayer, openLayers } from '../../frontend/src/layers.ts'

const layer = (log: string[], name: string, can = () => true) => ({ close: () => log.push(name), canClose: can })

test('Bug 407: one Escape closes only the layer opened last, the next one the layer under it', () => {
  const log: string[] = []
  const offPop = openLayer(layer(log, 'popover')), offAsk = openLayer(layer(log, 'confirm'))
  assert.equal(escapeTop(), true); assert.deepEqual(log, ['confirm'])
  offAsk() // the confirm unmounts as it closes
  assert.equal(escapeTop(), true); assert.deepEqual(log, ['confirm', 'popover'])
  offPop(); assert.equal(openLayers(), 0)
})

test('Bug 407: a busy top layer keeps the press: nothing under it closes', () => {
  const log: string[] = []; let busy = true
  const offPop = openLayer(layer(log, 'popover')), offBox = openLayer(layer(log, 'summary', () => !busy))
  assert.equal(escapeTop(), true); assert.deepEqual(log, [], 'the undo is running')
  busy = false; escapeTop(); assert.deepEqual(log, ['summary'])
  offBox(); offPop()
})

test('Bug 407: what it must not catch: with nothing open Escape does nothing; a layer closed out of order leaves the rest in order', () => {
  assert.equal(openLayers(), 0); assert.equal(escapeTop(), false)
  const log: string[] = []
  const offA = openLayer(layer(log, 'a')), offB = openLayer(layer(log, 'b')), offC = openLayer(layer(log, 'c'))
  offB(); offB() // a click elsewhere closed the middle one; a second call is harmless
  escapeTop(); offC(); escapeTop(); offA()
  assert.deepEqual(log, ['c', 'a']); assert.equal(openLayers(), 0)
})

test('Bug 407: no part of the page listens for Escape by itself: every layer goes through layers.ts', () => {
  const dir = fileURLToPath(new URL('../../frontend/src/', import.meta.url))
  const own = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && f !== 'layers.ts' && /['"]Escape['"]/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
  assert.deepEqual(own, [], 'use layers.ts useEscape (or ui.tsx Backdrop, which uses it) instead')
})
