import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
export function AgentTerminal({ agentId, ws, feed }: { agentId: string; ws: WebSocket | null; feed: (agentId: string, cb: (d: string) => void) => () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current || !ws) return
    const term = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: { background: '#09090b' }, scrollback: 5000 })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(ref.current); fit.fit()
    const send = (obj: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj))
    send({ type: 'term.open', agentId, cols: term.cols, rows: term.rows })
    const off = feed(agentId, (d) => term.write(d))
    let lastUserInput = 0 // real keystrokes and paste; terminal auto-replies (tmux queries, focus, mouse) don't count as typing
    term.attachCustomKeyEventHandler((e) => { if (e.type === 'keydown') lastUserInput = Date.now(); return true })
    term.textarea?.addEventListener('paste', () => { lastUserInput = Date.now() })
    const sub = term.onData((d) => send({ type: 'term.input', agentId, data: d, typed: Date.now() - lastUserInput < 1000 }))
    let sent = `${term.cols}x${term.rows}` // a sidebar drag fires every frame; only tell tmux when the grid size really changes
    const ro = new ResizeObserver(() => { fit.fit(); const now = `${term.cols}x${term.rows}`; if (now !== sent) { sent = now; send({ type: 'term.resize', agentId, cols: term.cols, rows: term.rows }) } }); ro.observe(ref.current)
    return () => { sub.dispose(); off(); ro.disconnect(); send({ type: 'term.close', agentId }); term.dispose() }
  }, [agentId, ws, feed]) // feed is stable (App's useCallback)
  return <div ref={ref} className="h-full w-full" />
}
