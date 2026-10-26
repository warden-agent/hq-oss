import { useEffect, useRef } from 'react'
import { ReactFlow, ReactFlowProvider, Background, Controls, useReactFlow, useStore, useStoreApi, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { FeatureNode, UserNode, TicketNode } from './Nodes'
const nodeTypes = { user: UserNode, feature: FeatureNode, ticket: TicketNode }
const FIT = { padding: 0.15, maxZoom: 1 } // maxZoom: a lone node stays its normal size instead of filling the pane
/** A request to bring a box into view (Show in the ⚠ menu, Read plan); `n` makes a repeat request for the same box count. */
export type Focus = { node: string; n: number } | null
type Props = { nodes: Node[]; edges: Edge[]; focus: Focus; onSelect: (id: string) => void; onPane: () => void }
/** A click on a box's own controls (buttons, links, inputs, its popover) is theirs; only a click on the box itself selects it.
 *  Needed because React bubbles clicks from a NodeToolbar portal up to the box. */
const ownClick = (t: EventTarget | null) => t instanceof Element && !!t.closest('.react-flow__node-toolbar, button, a, input, textarea, select')

export const Graph = (p: Props) => <ReactFlowProvider><Flow {...p} /></ReactFlowProvider>
/** Re-fits whenever a box appears or goes away, or the pane changes size (panel opened, closed or dragged; window resized),
 *  until the view has been placed by hand. ReactFlow's own `fitView` prop fits only once, on first draw. Size changes wait
 *  150ms so a panel drag re-fits once, at the end. A focus request pans its box near the top so its popover fits below. */
function Flow({ nodes, edges, focus, onSelect, onPane }: Props) {
  const rf = useReactFlow(), store = useStoreApi()
  const moved = useRef(false) // The user (or Show / Read plan) placed the view: stop auto-fitting until Fit is pressed
  const size = useStore((s) => `${s.width}x${s.height}`)
  const ids = nodes.map((n) => n.id).join(' ')
  useEffect(() => { if (!moved.current) void rf.fitView(FIT) }, [ids, rf]) // queued by ReactFlow until new nodes are measured
  useEffect(() => { const t = setTimeout(() => { if (!moved.current) void rf.fitView(FIT) }, 150); return () => clearTimeout(t) }, [size, rf])
  useEffect(() => {
    if (!focus) return
    const n = rf.getInternalNode(focus.node); if (!n) return
    moved.current = true
    const zoom = Math.max(rf.getZoom(), 0.75), { x, y } = n.internals.positionAbsolute, w = n.measured.width ?? 0
    void rf.setCenter(x + w / 2, y + (store.getState().height * 0.35) / zoom, { zoom, duration: 300 }) // box top at ~15% of the pane
  }, [focus, rf, store])
  return <div className="h-full w-full"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={FIT} minZoom={0.25}
    nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null} zoomOnDoubleClick={false}
    onNodeClick={(e, n) => { if (!ownClick(e.target)) onSelect(n.id) }} onPaneClick={onPane} onMove={(e) => { if (e) moved.current = true }}
    proOptions={{ hideAttribution: true }} colorMode="dark">
    <Background color="#27272a" />
    <Controls showInteractive={false} fitViewOptions={FIT} onFitView={() => { moved.current = false }} onZoomIn={() => { moved.current = true }} onZoomOut={() => { moved.current = true }} />
  </ReactFlow></div>
}
