// Bug 407: what Escape closes. The page has layers that open on top of each other: a box's popover (App's `pop`), a menu, HQ's dialogs
// (ui.tsx Backdrop: the confirm, New project, Turn on auto, the run summary, the feature map). Each one listened for Escape itself, so
// one press closed a confirm and the popover it came from. Now each open layer joins one stack, and one listener closes only the top one,
// the one opened last. A top layer that can't close now (busy: an undo running) keeps the press, so nothing under it closes either.
// The stack is plain code, so the backend's test runner unit-tests it (src/layers.test.ts). useEscape is how a component joins.
import { useEffect, useLayoutEffect, useRef } from 'react'

export type Layer = { close: () => void; canClose: () => boolean }
const stack: Layer[] = []
let listening = false

/** Puts `layer` on top; the function returned takes it off again (wherever it is in the stack by then). */
export function openLayer(layer: Layer): () => void {
  stack.push(layer)
  if (!listening && typeof document !== 'undefined') {
    listening = true
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.isComposing) escapeTop() })
  }
  return () => { const i = stack.lastIndexOf(layer); if (i >= 0) stack.splice(i, 1) }
}
/** One Escape: the top layer closes if it can. True when there was a layer to take the press. */
export function escapeTop(): boolean {
  const top = stack.at(-1); if (!top) return false
  if (top.canClose()) top.close()
  return true
}
/** How many layers are open (for tests). */
export const openLayers = (): number => stack.length
/** Bug 407: Escape closes this, but only while it is the top layer: one press closes a confirm, not the popover it came from too.
 *  It joins the stack when `open` turns true, so the layer opened last is on top; `canClose` false (busy) keeps the press, and nothing under it closes. */
export function useEscape(close: () => void, open = true, canClose = true) {
  const now = useRef({ close, canClose })
  useLayoutEffect(() => { now.current = { close, canClose } })
  useEffect(() => open ? openLayer({ close: () => now.current.close(), canClose: () => now.current.canClose }) : undefined, [open])
}
