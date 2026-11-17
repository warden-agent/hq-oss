import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
/** Claude Code shows an edit's diff only in a terminal at least this wide; narrower, it prints "Resize your terminal…" (Bug 123). */
export const AGENT_MIN_COLS = 110
type Props = { agentId: string; ws: WebSocket | null; feed: (agentId: string, cb: (d: string) => void) => () => void; minCols?: number }
/** `minCols`: the terminal is never narrower, whatever the pane's width; a narrower pane scrolls sideways. The app's server
 *  output passes 0: it only prints lines, so it just fits the pane. */
export function AgentTerminal({ agentId, ws, feed, minCols = AGENT_MIN_COLS }: Props) {
  const paneRef = useRef<HTMLDivElement>(null), hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const pane = paneRef.current, host = hostRef.current
    if (!pane || !host || !ws) return
    const term = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: { background: '#09090b' }, scrollback: 5000 })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host)
    // Fit the pane; if that gives fewer than minCols, widen the terminal's box to minCols (the pane then scrolls sideways) and
    // fit again, so the rows are counted above the sideways scroll bar and it never covers Claude Code's input line.
    const size = () => {
      host.style.width = ''
      const d = fit.proposeDimensions(), screen = term.element?.querySelector('.xterm-screen')
      if (d && screen && d.cols < minCols) {
        const cell = screen.getBoundingClientRect().width / term.cols, bar = term.options.overviewRuler?.width || 14 // as FitAddon counts xterm's own scroll bar
        if (cell > 0) host.style.width = `${Math.ceil(cell * minCols) + bar + 1}px`
      }
      fit.fit()
    }
    size()
    // xterm takes every wheel event over the terminal, so a sideways swipe (or Shift + wheel) would never reach the pane:
    // the pane takes those first, while there is something to scroll to. Up and down still go to xterm, as before.
    const sideways = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (!dx || pane.scrollWidth <= pane.clientWidth) return
      pane.scrollLeft += dx; e.preventDefault(); e.stopPropagation()
    }
    pane.addEventListener('wheel', sideways, { capture: true, passive: false })
    const send =(obj: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj))
    send({ type: 'term.open', agentId, cols: term.cols, rows: term.rows })
    const off = feed(agentId, (d) => term.write(d))
    let lastUserInput = 0 // real keystrokes and paste; terminal auto-replies (tmux queries, focus, mouse) don't count as typing
    term.attachCustomKeyEventHandler((e) => { if (e.type === 'keydown') lastUserInput = Date.now(); return true })
    term.textarea?.addEventListener('paste', () => { lastUserInput = Date.now() })
    const sub = term.onData((d) => send({ type: 'term.input', agentId, data: d, typed: Date.now() - lastUserInput < 1000 }))
    let sent = `${term.cols}x${term.rows}` // a sidebar drag fires every frame; only tell tmux when the grid size really changes
    const ro = new ResizeObserver(() => {
      size(); const now = `${term.cols}x${term.rows}`
      if (now !== sent) { sent = now; send({ type: 'term.resize', agentId, cols: term.cols, rows: term.rows }) }
    }); ro.observe(pane)
    return () => { sub.dispose(); off(); ro.disconnect(); pane.removeEventListener('wheel', sideways, { capture: true });send({ type: 'term.close', agentId }); term.dispose() }
  }, [agentId, ws, feed, minCols]) // feed is stable (App's useCallback)
  return <div ref={paneRef} className="h-full w-full overflow-x-auto overflow-y-hidden"><div ref={hostRef} className="h-full" /></div>
}
