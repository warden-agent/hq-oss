// Bug 264: the "merged" notice told the user to press "Start ready", a button the UI doesn't have. Its words name the buttons the board really shows,
// and this test reads the frontend so a renamed button breaks it here, not in front of the user.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-mw-'))
const { startWords } = await import('./mergewatch.ts')
const front = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'frontend', 'src', f), 'utf8')

test('startWords: one ticket or several; Resume only while auto mode is on but stopped; the parallel limit when no slot is free', () => {
  assert.equal(startWords(1, false), 'Start it with Start under Your turn, or Launch engineer on its box.')
  assert.equal(startWords(2, false), 'Start them with Start under Your turn, or Launch engineer on each box.')
  assert.equal(startWords(2, true), 'Start them with Start under Your turn, or Launch engineer on each box. Or press Resume on the "Auto mode stopped" bar and HQ starts them.')
  assert.equal(startWords(1, false, true),
    'Start it with Start under Your turn, or Launch engineer on its box. The parallel limit is reached now, so that waits until an engineer finishes.')
  assert.doesNotMatch(startWords(3, true), /Start ready/)
})

test('the buttons startWords names are the ones the frontend shows', () => {
  const nodes = front('Nodes.tsx'), app = front('App.tsx'), board = front('board.ts'), auto = front('Auto.tsx')
  assert.match(nodes, />Your turn</, 'the TPM box\'s Your turn'); assert.match(app, />Your turn</, 'the ⚠ menu\'s Your turn')
  assert.match(board, /startLabel = .*`Start \$\{keys\.join/, 'its Start button on the TPM box ("Start T-02")')
  assert.match(app, /label="Start" busyLabel="Starting…" run=\{\(\) => api\(`repos\/\$\{repo\.id\}\/start-ready`/)
  assert.match(board, /'launch' \? 'Launch engineer'/, 'a ready ticket\'s box')
  assert.match(auto, /`Auto mode stopped: \$\{repo\.auto_stopped_why\}`/); assert.match(auto, /auto-resume`, \{\}\)\)\}>Resume</)
})
