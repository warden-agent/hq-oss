// One terminal message from the page. Nothing may throw out of here: ws then never reads that socket again, so every later message from
// the tab is lost while its patches still arrive, and the page looks fine (Bug 60). A terminal that can't open says so in its own view.
import { emit } from './events.ts'
import { previewSession } from './preview.ts'
import { openPreviewTerminal, openTerminal, type Term } from './terminal.ts'

type Open = (id: string, cols: number, rows: number, onData: (d: string) => void, onExit: () => void) => Term | null
/** `preview:<repoId>` is the live preview's server output; anything else is an agent id. */
const openAny: Open = (id, cols, rows, onData, onExit) => id.startsWith('preview:')
  ? openPreviewTerminal(previewSession(id.slice('preview:'.length)), cols, rows, onData, onExit) : openTerminal(id, cols, rows, onData, onExit)

export function termMessage(m: Record<string, unknown>, terms: Map<string, Term>, send: (obj: unknown) => void, open: Open = openAny): void {
  const agentId = String(m.agentId ?? '')
  const refused = (why: string) => send({ type: 'term', agentId, data: `\r\n\x1b[31mHQ couldn't open this terminal: ${why}\x1b[0m\r\nWhat runs in it isn't affected.\r\n` })
  try {
    if (m.type === 'term.open') {
      terms.get(agentId)?.kill(); terms.delete(agentId)
      const cols = Number(m.cols ?? 120), rows = Number(m.rows ?? 36), onData = (d: string) => send({ type: 'term', agentId, data: d })
      const onExit = () => { send({ type: 'term.exit', agentId }); if (terms.get(agentId) === t) terms.delete(agentId) } // a replaced view's late exit leaves its successor alone
      const t = open(agentId, cols, rows, onData, onExit)
      if (t) terms.set(agentId, t); else refused('HQ has no such agent.')
    }
    else if (m.type === 'term.input') terms.get(agentId)?.write(String(m.data ?? ''), m.typed === true)
    else if (m.type === 'term.resize') terms.get(agentId)?.resize(Number(m.cols), Number(m.rows))
    else if (m.type === 'term.close') { terms.get(agentId)?.kill(); terms.delete(agentId) }
  } catch (e) {
    emit({ agentId: null, source: 'system', kind: 'backend.error', payload: { server: 'ws', message: String(m.type), error: String(e) } })
    if (m.type === 'term.open') refused((e as Error).message)
  }
}
