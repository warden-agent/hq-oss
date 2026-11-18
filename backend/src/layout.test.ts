// How the window's width is shared (frontend/src/layout.ts): the side panel keeps the width the user chose (Bug 154), and the
// graph, an app pane docked right and the side panel never add up to more than the window (Bug 167).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitsRight, GRAPH_MIN, mainWidth, PANEL_DEFAULT, panelWidth, rightWidthIn, RIGHT_MIN, SPLIT } from '../../frontend/src/layout.ts'

test('Bug 154: the panel gives way on a narrow window and is back to the chosen width when the window widens', () => {
  assert.equal(panelWidth(PANEL_DEFAULT, 1440), 520)
  assert.equal(panelWidth(PANEL_DEFAULT, 820), 400) // the graph keeps 420
  assert.equal(panelWidth(PANEL_DEFAULT, 1100), 520)
  assert.equal(panelWidth(PANEL_DEFAULT, 1440), 520) // the choice wasn't overwritten by the 820 px one
  assert.equal(panelWidth(700, 1100), 680)
  assert.equal(panelWidth(700, 1440), 700)
  assert.equal(panelWidth(100, 1440), 360) // never narrower than PANEL_MIN
})

test('Bug 167: the graph, an app pane docked right and the side panel fit the window side by side', () => {
  for (const win of [1440, 1280, 1100, 1024, 820]) for (const open of [true, false]) for (const w of [300, 430, 702, 1000, 5000]) {
    const panel = panelWidth(PANEL_DEFAULT, win), room = mainWidth(win, open ? panel : null)
    if (!fitsRight(room)) continue
    const right = rightWidthIn(w, room), graph = room - SPLIT - right
    assert.ok(graph >= GRAPH_MIN, `${win} px, panel ${open}, pane ${w}: graph ${graph}`)
    assert.ok(right >= RIGHT_MIN && right <= w || w < RIGHT_MIN, `${win} px, pane ${w}: ${right}`)
    assert.ok(graph + SPLIT + right + (open ? SPLIT + panel : 0) <= win, `${win} px: adds up to more than the window`)
  }
})

test('Bug 167: the app pane docks right only where the graph keeps its room, as at 1100 px with the panel open it does not', () => {
  assert.equal(fitsRight(mainWidth(1100, panelWidth(PANEL_DEFAULT, 1100))), false) // 574 px for both
  assert.equal(fitsRight(mainWidth(820, panelWidth(PANEL_DEFAULT, 820))), false)
  assert.equal(fitsRight(mainWidth(1440, panelWidth(PANEL_DEFAULT, 1440))), true) // 914 px
  assert.equal(fitsRight(mainWidth(1100, null)), true)
  assert.equal(fitsRight(mainWidth(820, null)), true)
  assert.equal(rightWidthIn(702, 1100), 702) // the panel closed: as before, at most 70% of the window
  assert.equal(rightWidthIn(1000, 1100), 770)
  assert.equal(rightWidthIn(720, 914), 914 - SPLIT - GRAPH_MIN) // 1440 with the panel open: the graph keeps GRAPH_MIN
})
