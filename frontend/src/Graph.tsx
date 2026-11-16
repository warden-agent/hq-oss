import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { ReactFlow, ReactFlowProvider, Background, Controls, ControlButton, useReactFlow, useStore, useStoreApi, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { FeatureNode, TicketNode, TpmNode } from './Nodes'
import { placeView, type Box } from './fit'
const nodeTypes = { tpm: TpmNode, feature: FeatureNode, ticket: TicketNode }
/** A request to bring a box into view (Show in the ⚠ menu, Read plan); `n` makes a repeat request for the same box count. */
export type Focus = { node: string; n: number } | null
type Props = { nodes: Node[]; edges: Edge[]; fits: string[][]; focus: Focus; onSelect: (id: string) => void; onPane: () => void }
/** A click on a box's own controls (buttons, links, inputs, its popover) is theirs; only a click on the box itself selects it.
 *  Needed because React bubbles clicks from a NodeToolbar portal up to the box. */
const ownClick = (t: EventTarget | null) => t instanceof Element && !!t.closest('.react-flow__node-toolbar, button, a, input, textarea, select')
/** A box as the layout placed it: its position and its style size (set exactly by buildBoard), so the view needs no measuring. */
const boxOf = (n: Node): Box => ({ id: n.id, x: n.position.x, y: n.position.y, w: Number(n.style?.width) || 0, h: Number(n.style?.height) || 0 })
/** ReactFlow's ⛶ icon (not exported by @xyflow/react): the button is ours so that it places the view by the same rule as a load. */
const FitIcon = () => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30"><path d={'M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0'
  + 'h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 '
  + '4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z'} /></svg>

export const Graph = (p: Props) => <ReactFlowProvider><Flow {...p} /></ReactFlowProvider>
/** Places the view (fit.ts: everything if it's readable, else less, Bug 119) on first draw, whenever a box appears or goes away, or the
 *  pane changes size (panel opened, closed or dragged; window resized), until the view has been placed by hand; ⛶ places it the same
 *  way and hands it back. Size changes wait 150ms so a panel drag re-fits once, at the end. A focus request pans its box near the top
 *  so its popover fits below. */
function Flow({ nodes, edges, fits, focus, onSelect, onPane }: Props) {
  const rf = useReactFlow(), store = useStoreApi()
  const moved = useRef(false) // The user (or Show / Read plan) placed the view: stop auto-fitting until Fit is pressed
  const size = useStore((s) => `${s.width}x${s.height}`)
  const ids = nodes.map((n) => n.id).join(' '), fitKey = fits.map((f) => f.join(' ')).join('|')
  const latest = useRef({ nodes, fits }) // read at fit time: a box's size changes without a new id
  useLayoutEffect(() => { latest.current = { nodes, fits } }) // layout effects run before the effects below that place the view
  const place = useCallback(() => {
    const { width, height } = store.getState(), { nodes: ns, fits: fs } = latest.current
    const v = placeView(ns.map(boxOf), fs, width, height); if (v) void rf.setViewport(v)
  }, [rf, store])
  useEffect(() => { if (!moved.current) place() }, [ids, fitKey, place])
  const sized = useRef(false) // the first size (the pane's first draw) places the view at once; later ones wait out a drag
  useEffect(() => {
    const now = !sized.current; if (!size.startsWith('0x') && !size.endsWith('x0')) sized.current = true
    const t = setTimeout(() => { if (!moved.current) place() }, now ? 0 : 150); return () => clearTimeout(t)
  }, [size, place])
  useEffect(() => {
    if (!focus) return
    const n = rf.getInternalNode(focus.node); if (!n) return
    moved.current = true
    const zoom = Math.max(rf.getZoom(), 0.75), { x, y } = n.internals.positionAbsolute, w = n.measured.width ?? 0
    void rf.setCenter(x + w / 2, y + (store.getState().height * 0.35) / zoom, { zoom, duration: 300 }) // box top at ~15% of the pane
  }, [focus, rf, store])
  const fitBtn = useMemo(() => <ControlButton className="react-flow__controls-fitview" title="Fit view" aria-label="Fit view"
    onClick={() => { moved.current = false; place() }}><FitIcon /></ControlButton>, [place])
  return <div className="h-full w-full"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} minZoom={0.25}
    nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null} zoomOnDoubleClick={false}
    onNodeClick={(e, n) => { if (!ownClick(e.target)) onSelect(n.id) }} onPaneClick={onPane} onMove={(e) => { if (e) moved.current = true }}
    proOptions={{ hideAttribution: true }} colorMode="dark">
    <Background color="#27272a" />
    <Controls showInteractive={false} showFitView={false} onZoomIn={() => { moved.current = true }} onZoomOut={() => { moved.current = true }}>{fitBtn}</Controls>
  </ReactFlow></div>
}
