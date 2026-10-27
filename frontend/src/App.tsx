import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, connectWs, errText, jsonList, showError, waitingFor, FINISHED, type Agent, type State, type WsMsg } from './api'
import { AgentTerminal } from './Terminal'
import { Graph, type Focus } from './Graph'
import { AttentionList, MergeAct, ReviewPanel } from './Nodes'
import { BoardCtx, buildBoard, liveEngineer, mergeActs, ticketLabel, useBoard, type Board, type Pop, type PopKind } from './board'
import { ErrorBar, Menu, Pill } from './ui'
import { Dot, PreviewPane } from './Preview'
import { clampH, clampW, rightWidth, usePreviewPrefs } from './previewPrefs'

type Tab = 'agent' | 'ticket' | 'messages' | 'events'
type Sel = { node: string | null; agentId: string | null; ticketId: string | null }

/** The screen: a thin top bar (repo, parallel limit, agents, preview, ⚠), the graph, and a resizable panel on the right for the
 *  clicked box's terminal or ticket, messages and events. Everything about one feature or ticket lives on its box in the graph.
 *  The live preview of the picked repo's app shares the graph's cell: below it (Desktop) or to its right (Phone). */
export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [ws, setWs] = useState<WebSocket | null>(null)
  const [events, setEvents] = useState<any[]>([])
  const [sel, setSel] = useState<Sel>({ node: null, agentId: null, ticketId: null })
  const [repoId, setRepoId] = useState<string | null>(null)
  const [pop, setPop] = useState<Pop>(null)
  const [focusReq, setFocusReq] = useState<Focus>(null)
  const [panel, setPanel] = useState<{ open: boolean; tab: Tab }>(() => ({ open: readOpen(), tab: 'messages' }))
  const [panelW, setPanelW] = useState(() => { try { return clampPanel(Number(localStorage.getItem(PANEL_KEY)) || PANEL_DEFAULT) } catch { return PANEL_DEFAULT } })
  useEffect(() => { const r = () => setPanelW((w) => clampPanel(w)); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r) }, [])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null) }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [])
  const [now, setNow] = useState(() => Date.now()) // the board's clock: "held · until 14:12" expires without a state change
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t) }, [])
  const [conn, setConn] = useState<'connecting' | 'open' | 'token' | 'down'>('connecting')
  const feeds = useRef(new Map<string, (d: string) => void>())
  useEffect(() => {
    let sock: WebSocket | null = null, retry = 0, delay = 1500, stopped = false
    // Patches and events are applied together, at most ~10 times a second: every hook patches its agent, and each state
    // change rebuilds the whole graph. A snapshot replaces whatever was still waiting.
    const queue: WsMsg[] = []; let flushAt = 0
    const flush = () => {
      flushAt = 0; const batch = queue.splice(0)
      const patches = batch.filter((m) => m.type === 'patch'), evs = batch.flatMap((m) => m.type === 'event' ? [m.event] : [])
      if (patches.length) setState((s) => s ? patches.reduce(applyPatch, s) : s)
      if (evs.length) setEvents((e) => [...evs.reverse(), ...e].slice(0, 300))
    }
    const open = () => {
      let opened = false
      sock = connectWs((m: WsMsg) => {
        if (m.type === 'snapshot') { queue.length = 0; clearTimeout(flushAt); flushAt = 0; setState(m.data) }
        else if (m.type === 'patch' || m.type === 'event') { queue.push(m); flushAt ||= window.setTimeout(flush, 100) }
        else if (m.type === 'term') feeds.current.get(m.agentId)?.(m.data)
      }, (w) => { opened = true; delay = 1500; setConn('open'); setWs(w) })
      sock.onclose = () => {
        if (stopped) return
        // Why: a page whose token HQ doesn't accept gets 401 from the API; otherwise the backend is away (or restarting).
        fetch('/api/state').then((r) => setConn(r.status === 401 ? 'token' : opened ? 'connecting' : 'down'), () => setConn('down'))
        retry = window.setTimeout(open, delay); delay = Math.min(delay * 2, 10_000)
      }
    }
    open(); return () => { stopped = true; clearTimeout(retry); clearTimeout(flushAt); sock?.close() }
  }, [])
  const board = useMemo(() => state ? buildBoard(state, now) : null, [state, now])
  const feed = useCallback((agentId: string, cb: (d: string) => void) => { feeds.current.set(agentId, cb); return () => { feeds.current.delete(agentId) } }, [])
  const repoNow = state ? state.repos.find((r) => r.id === repoId) ?? state.repos[state.repos.length - 1] ?? null : null
  const [prefs, setPrefs] = usePreviewPrefs(repoNow?.id ?? null)
  const pv = repoNow ? (state?.previews ?? []).find((x) => x.id === repoNow.id) ?? null : null
  const pvMissing = !!repoNow && !pv // a repo added since the snapshot: fetch its preview row
  useEffect(() => { if (pvMissing && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'snapshot' })) }, [pvMissing, ws])
  const connText = conn === 'token' ? "HQ didn't accept this page's token. Open the URL the backend printed (it carries the token)." : conn === 'down' ? "Can't reach the HQ backend. Retrying…" : conn === 'connecting' && state ? 'Reconnecting to HQ…' : ''
  if (!state || !board) return <div className={`p-8 ${conn === 'token' || conn === 'down' ? 'text-rose-300' : 'text-zinc-400'}`}>{connText || 'Connecting to HQ…'}</div>
  const repo = repoNow
  const selAgent = state.agents.find((a) => a.id === sel.agentId) ?? null, selTicket = state.tickets.find((t) => t.id === sel.ticketId) ?? null
  const showPanel = (open: boolean, tab?: Tab) => { setPanel((p) => ({ open, tab: tab ?? p.tab })); saveOpen(open) }
  const focus = (node: string, kind?: PopKind) => { setFocusReq({ node, n: Date.now() }); setPop(kind ? { node, kind } : null) }
  /** A feature box opens its TPM; a ticket box opens its running engineer, or the ticket itself when nobody is on it. */
  const selectNode = (id: string) => {
    if (id.startsWith('f:')) { const f = state.features.find((x) => x.id === id.slice(2)); if (f?.tpm_agent_id) { setSel({ node: id, agentId: f.tpm_agent_id, ticketId: null }); showPanel(true, 'agent') } }
    else if (id.startsWith('t:')) { const t = state.tickets.find((x) => x.id === id.slice(2)); if (!t) return; const eng = liveEngineer(t, state); setSel({ node: id, agentId: eng?.id ?? t.assignee_agent_id ?? null, ticketId: t.id }); showPanel(true, eng ? 'agent' : 'ticket') }
  }
  const pickAgent = (a: Agent) => { setSel({ node: board.agentNode(a.id), agentId: a.id, ticketId: a.ticket_id ?? null }); showPanel(true, 'agent') }
  const pvOpen = !!repo && !!pv && prefs.open, pvBelow = prefs.dock === 'bottom'
  const tabLabel: Record<Tab, string> = { agent: `Agent${selAgent ? `: ${selAgent.display_name ?? selAgent.id}` : ''}`, ticket: `Ticket${selTicket ? `: ${selTicket.key}` : ''}`, messages: 'Messages', events: 'Events' }
  return <BoardCtx.Provider value={{ state, repo, pop, setPop, focus, selected: sel.node }}>
    <ErrorBar />
    <div className="grid h-screen grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 px-3 py-1.5 text-xs">
        <h1 className="font-semibold tracking-wide text-zinc-400">HQ <span className="text-zinc-600">· {state.agents.filter((a) => a.status !== 'exited').length} live</span></h1>
        <RepoBar state={state} repo={repo} onRepo={setRepoId} now={now} />
        {connText && <span className="text-rose-300" role="status">{connText}</span>}
        <ParallelLimit state={state} />
        <span className="grow" />
        <AgentsMenu state={state} selected={sel.agentId} onPick={pickAgent} />
        {repo && <button className={`btn flex items-center gap-1.5 ${prefs.open ? 'btn-primary' : ''}`} title={`Show or hide the live preview of ${repo.name}${pv ? ` (${pv.status})` : ''}`} onClick={() => setPrefs({ open: !prefs.open })}><Dot status={pv?.status ?? 'stopped'} />Preview</button>}
        <button className={`btn ${panel.open ? 'btn-primary' : ''}`} title="Show or hide the panel on the right" onClick={() => showPanel(!panel.open)}>Panel</button>
        <Bell state={state} board={board} />
      </header>
      <div className="grid min-h-0" style={{ gridTemplateColumns: panel.open ? `minmax(0,1fr) 6px ${panelW}px` : 'minmax(0,1fr)' }}>
        <main className="grid min-h-0 min-w-0" style={!pvOpen ? { gridTemplateRows: 'minmax(0,1fr)' } : pvBelow ? { gridTemplateRows: `minmax(0,1fr) 6px ${clampH(prefs.h)}px` } : { gridTemplateColumns: `minmax(0,1fr) 6px ${clampW(prefs.w)}px` }}>
          <div className="min-h-0 min-w-0"><Graph nodes={board.nodes} edges={board.edges} focus={focusReq} onSelect={selectNode} onPane={() => setPop(null)} /></div>
          {pvOpen && <><Splitter dir={pvBelow ? 'row' : 'col'} label="Resize preview" size={pvBelow ? clampH(prefs.h) : clampW(prefs.w)} def={pvBelow ? Math.round(window.innerHeight * 0.45) : rightWidth(prefs.device)}
            set={(n) => { const c = pvBelow ? clampH(n) : clampW(n); setPrefs(pvBelow ? { h: c } : { w: c }, false); return c }} save={(n) => setPrefs(pvBelow ? { h: n } : { w: n })} />
            <PreviewPane p={pv} repo={repo} prefs={prefs} setPrefs={setPrefs} ws={ws} feed={feed} /></>}
        </main>
        {panel.open && <><Splitter dir="col" label="Resize panel" size={panelW} def={PANEL_DEFAULT} set={(w) => { const c = clampPanel(w); setPanelW(c); return c }} save={(w) => { try { localStorage.setItem(PANEL_KEY, String(w)) } catch { /* private window: width just isn't remembered */ } }} />
          <aside className="flex min-h-0 min-w-0 flex-col gap-2 p-2">
            <div className="flex items-center gap-1 text-xs">{(['agent', 'ticket', 'messages', 'events'] as Tab[]).map((t) => <button key={t} className={`btn min-w-0 truncate ${panel.tab === t ? 'btn-primary' : ''}`} onClick={() => showPanel(true, t)}>{tabLabel[t]}</button>)}
              <span className="grow" /><button className="btn" title="Close the panel" onClick={() => showPanel(false)}>×</button></div>
            <div className="min-h-0 grow">{panel.tab === 'agent' ? (selAgent ? <AgentPane a={selAgent} ws={ws} feed={feed} /> : <div className="p-4 text-sm text-zinc-500">Click a box on the graph to see its agent here.</div>)
              : panel.tab === 'ticket' ? <TicketInfo t={selTicket} state={state} />
              : panel.tab === 'messages' ? <Messages state={state} />
              : <div className="h-full overflow-y-auto text-[11px] text-zinc-500">{events.map((e, i) => <div key={i} className="truncate"><span className="text-zinc-600">{new Date(e.at).toLocaleTimeString()}</span> <span className="text-zinc-400">{e.agentId ?? '·'}</span> {e.kind}</div>)}</div>}</div>
          </aside></>}
      </div>
    </div>
  </BoardCtx.Provider>
}
function applyPatch(s: State, m: { entity: string; id: string; patch: Record<string, any> | null }): State {
  const key = ({ agent: 'agents', ticket: 'tickets', feature: 'features', message: 'messages', review: 'reviews', attention: 'attention', repo: 'repos', preview: 'previews' } as Record<string, keyof State>)[m.entity]
  if (!key) return s
  const list = (s[key] as any[]) ?? []; const i = list.findIndex((x) => x.id === m.id)
  let next: any[]
  if (m.patch === null) next = list.filter((x) => x.id !== m.id)
  else if (i >= 0) next = list.map((x) => x.id === m.id ? { ...x, ...m.patch } : x)
  else next = [{ id: m.id, ...m.patch }, ...list]
  if (key === 'attention') next = next.filter((x) => !x.resolved_at)
  if (key === 'messages' && next.length > 500) next = next.slice(0, 500) // newest first; the snapshot starts with 300
  return { ...s, [key]: next }
}
const PANEL_KEY = 'hq.panelW', OPEN_KEY = 'hq.panelOpen', PANEL_DEFAULT = 520, PANEL_MIN = 360
const clampPanel = (w: number) => Math.round(Math.max(PANEL_MIN, Math.min(w, window.innerWidth * 0.8)))
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== '0' } catch { return true } }
const saveOpen = (open: boolean) => { try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch { /* private window: just not remembered */ } }
/** Drag strip in front of a pane that sits to its right (`col`) or below it (`row`). Drag, arrow keys (16px; ←/↑ grow the pane)
 *  or double-click (back to `def`). `set` clamps and shows a size and returns it; `save` keeps it, once the drag ends. */
function Splitter({ dir, size, set, save, def, label }: { dir: 'col' | 'row'; size: number; set: (n: number) => number; save: (n: number) => void; def: number; label: string }) {
  const [dragging, setDragging] = useState(false)
  const from = useRef({ pos: 0, size: 0 }) // where the drag started, so a click without moving leaves the size alone
  const pos = (e: React.PointerEvent) => dir === 'col' ? e.clientX : e.clientY
  const at = (e: React.PointerEvent) => from.current.size + from.current.pos - pos(e)
  // hq-dragging: no text selection, and frames (the preview) don't swallow the pointer mid-drag
  const end = (e: React.PointerEvent) => { if (!dragging) return; setDragging(false); document.body.classList.remove('hq-dragging'); document.body.style.cursor = ''; save(set(at(e))) }
  return <div role="separator" aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'} aria-label={label} aria-valuenow={size} tabIndex={0} title="Drag to resize · double-click to reset"
    className={`group flex justify-center outline-none ${dir === 'col' ? 'cursor-col-resize' : 'cursor-row-resize flex-col'}`}
    onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); from.current = { pos: pos(e), size }; e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); document.body.classList.add('hq-dragging'); document.body.style.cursor = dir === 'col' ? 'col-resize' : 'row-resize' }}
    onPointerMove={(e) => { if (dragging) set(at(e)) }}
    onPointerUp={end} onPointerCancel={end}
    onDoubleClick={() => save(set(def))}
    onKeyDown={(e) => { const d = ['ArrowLeft', 'ArrowUp'].includes(e.key) ? 16 : ['ArrowRight', 'ArrowDown'].includes(e.key) ? -16 : 0; if (d) { e.preventDefault(); save(set(size + d)) } }}>
    <div className={`${dir === 'col' ? 'w-px' : 'h-px'} ${dragging ? 'bg-indigo-500' : 'bg-zinc-800 group-hover:bg-indigo-500/70 group-focus-visible:bg-indigo-500'}`} />
  </div>
}
/** Repo picker, sync status, Sync and Add repo… (moved here from the old sidebar's New feature card). */
function RepoBar({ state, repo, onRepo, now }: { state: State; repo: any | null; onRepo: (id: string) => void; now: number }) {
  const [busy, setBusy] = useState<null | 'pick' | 'add' | 'sync'>(null)
  const [choices, setChoices] = useState<{ in: string; repos: { path: string; name: string; github: string | null }[] } | null>(null) // a picked folder held several repos
  const account = state.defaults.github_account ?? 'warden-agent'
  const addRepo = () => { if (busy) return; setBusy('pick'); setChoices(null); api('repos/pick', {}).then((r) => { if (r.choose) setChoices({ in: r.in, repos: r.choose }); else if (!r.cancelled) onRepo(r.id) }).catch((e) => showError(errText(e))).finally(() => setBusy(null)) }
  const choose = (p: string) => { if (busy) return; setBusy('add'); setChoices(null); api('repos', { path: p }).then((r) => onRepo(r.id)).catch((e) => showError(errText(e))).finally(() => setBusy(null)) }
  const sync = () => { if (!repo || busy) return; setBusy('sync'); api(`repos/${repo.id}/sync`, {}).catch((e) => showError(errText(e))).finally(() => setBusy(null)) }
  const ago = (t: number) => { const m = Math.round((now - t) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago` }
  const failed = repo?.kind === 'github' && !repo.sync_ok
  const status = !repo ? '' : busy === 'sync' ? 'Syncing…' : !repo.kind ? 'Not synced yet' : repo.kind === 'local' ? 'Local only · nothing to pull' : failed ? 'GitHub · sync failed' : `GitHub · ${account} · ${repo.sync_detail}`
  const when = repo?.synced_at && busy !== 'sync' ? ` · ${ago(repo.synced_at)}` : ''
  return <div className="flex min-w-0 items-center gap-1.5">
    {state.repos.length > 0 && <select className="input w-auto! max-w-48 py-0.5! text-xs!" value={repo?.id} title={repo?.path} onChange={(e) => onRepo(e.target.value)}>{state.repos.map((r) => <option key={r.id} value={r.id} title={r.path}>{r.name}</option>)}</select>}
    {repo && (failed && busy !== 'sync' ? <Menu label={`${status}${when}`} align="left" className="btn border-rose-500/50! text-rose-300!">{() => <div className="w-80 text-xs text-rose-200">{repo.sync_detail}</div>}</Menu>
      : <span className="max-w-64 truncate text-zinc-500" title={`${status}${when}`}>{status}{when}</span>)}
    {repo?.kind === 'github' && repo.can_push === 0 && <Menu label="Can't push" align="left" className="btn border-amber-500/50! text-amber-300!">{() => <div className="w-80 text-xs text-amber-200">{account} can read this repo but not push to it. Give it Write access on GitHub so HQ can push finished branches.</div>}</Menu>}
    {repo && <button className="btn" onClick={sync} disabled={!!busy}>Sync</button>}
    <div className="relative"><button className="btn" onClick={addRepo} disabled={!!busy}>{busy === 'pick' ? 'Choose a folder…' : busy === 'add' ? 'Adding…' : 'Add repo…'}</button>
      {choices && <div className="absolute left-0 top-full z-50 mt-1 flex w-72 flex-col gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl"><div className="text-zinc-400">Several repos in {choices.in.split('/').pop()}. Pick one:</div>
        {choices.repos.map((c) => <button key={c.path} className="btn text-left" title={c.path} onClick={() => choose(c.path)}>{c.name} <span className="text-zinc-500">· {c.github ?? 'local'}</span></button>)}
        <button className="btn" onClick={() => setChoices(null)}>Cancel</button></div>}</div>
  </div>
}
function ParallelLimit({ state }: { state: State }) {
  const [draft, setDraft] = useState<number | null>(null) // shown until the next snapshot carries the saved value
  const cap = draft ?? Number(state.settings.concurrency_cap ?? state.defaults.concurrency_cap ?? 2)
  const working = state.agents.filter((a) => a.role === 'engineer' && a.status !== 'exited' && !FINISHED.includes(state.tickets.find((t) => t.id === a.ticket_id)?.status ?? '')).length
  const set = (n: number) => { if (!Number.isInteger(n) || n < 1) return; setDraft(n); api('settings', { key: 'concurrency_cap', value: n }).catch((e) => showError(errText(e))) }
  return <div className="flex items-center gap-1.5 text-zinc-400">Parallel limit <input type="number" min={1} max={10} className="input w-14! py-0.5! text-xs!" value={cap} onChange={(e) => set(Number(e.target.value))} /><span className="text-zinc-600">{working}/{cap} engineers working</span></div>
}
/** Every agent, including ones with no box on the graph (exited, architects, engineers on cancelled tickets). */
function AgentsMenu({ state, selected, onPick }: { state: State; selected: string | null; onPick: (a: Agent) => void }) {
  return <Menu label={`Agents ${state.agents.length}`} title="Every agent, including ones with no box on the graph">{(close) => <div className="flex max-h-[75vh] w-80 flex-col gap-1 overflow-y-auto">
    {!state.agents.length && <div className="p-1 text-xs text-zinc-500">No agents yet.</div>}
    {state.agents.map((a) => { const w = waitingFor(a, state); return <button key={a.id} onClick={() => { onPick(a); close() }} className={`card w-full p-2! text-left text-xs ${selected === a.id ? 'border-indigo-500/60!' : ''}`}>
      <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate font-medium" title={a.display_name ?? a.id}>{a.display_name ?? a.id}</span><Pill s={a.status} /></div>
      <div className="mt-1 text-zinc-500">{a.role} · {a.model_live ?? a.model_alias}{a.in_plan_mode ? ' · plan' : ''}{a.steps_total ? ` · step ${a.steps_done}/${a.steps_total}` : ''}</div>
      {a.activity && <div className="mt-1 truncate text-zinc-400">{a.activity}</div>}
      {w && <div className={`mt-1 ${w.held ? 'text-amber-300' : 'text-zinc-400'}`}>✉ {w.count} waiting · {w.why}</div>}
    </button> })}</div>}</Menu>
}
/** Everything that needs the user: open plan reviews, finished tickets waiting for their merge (shown until they're merged, so
 *  nothing to tick away), then every attention item. Show pans to the box; a review whose ticket has no box gets its form right here. */
function Bell({ state, board }: { state: State; board: Board }) {
  const b = useBoard()
  const reviews = state.reviews.filter((r) => r.status === 'open').sort((x, y) => (y.opened_at ?? 0) - (x.opened_at ?? 0))
  const base = (t: any) => { const f = state.features.find((x) => x.id === t.feature_id); return { cancelled: f?.status === 'cancelled', branch: state.repos.find((r) => r.id === f?.repo_id)?.default_branch ?? 'main' } }
  const merges = state.tickets.flatMap((t) => { const f = base(t), acts = f.cancelled ? [] : mergeActs(t, f.branch, liveEngineer(t, state)); return acts.length ? [{ t, acts }] : [] })
  const n = reviews.length + merges.length + state.attention.length
  return <Menu label={`⚠ ${n}`} title="Plan reviews and things that need you" className={`btn ${n ? 'border-rose-500/50! text-rose-300!' : ''}`}>{(close) => <div className="flex max-h-[75vh] w-[440px] max-w-[90vw] flex-col gap-2 overflow-y-auto text-xs">
    {!n && <div className="p-1 text-zinc-500">Nothing needs you right now.</div>}
    {reviews.length > 0 && <div className="font-semibold text-zinc-400">Plan reviews</div>}
    {reviews.map((r) => {
      const t = state.tickets.find((x) => x.id === r.ticket_id), eng = state.agents.find((a) => a.id === r.agent_id)
      const label = `Plan R-${r.round} · ${t?.key ?? r.ticket_id}${eng ? ` · ${eng.display_name ?? eng.id}` : ''}`, node = `t:${r.ticket_id}`
      return board.has(node) ? <div key={r.id} className="flex items-center gap-2 rounded-md border border-zinc-800 p-2"><span className="min-w-0 grow truncate text-amber-300" title={label}>{label}</span><button className="btn-sm" onClick={() => { b.focus(node, 'review'); close() }}>Show</button></div>
        : <ReviewPanel key={r.id} r={r} label={label} />
    })}
    {merges.length > 0 && <div className="font-semibold text-zinc-400">Waiting for you to merge</div>}
    {merges.map(({ t, acts }) => { const node = `t:${t.id}`; return <div key={t.id} className="flex items-center gap-2 rounded-md border border-zinc-800 p-2"><span className="min-w-0 grow truncate text-indigo-300" title={`${t.key}: ${t.title}`}>{t.key} · {t.title}</span>
      {acts.map((a, i) => <MergeAct key={i} a={a} t={t} />)}{board.has(node) && <button className="btn-sm" onClick={() => { b.focus(node); close() }}>Show</button>}</div> })}
    {state.attention.length > 0 && <div className="font-semibold text-zinc-400">Attention</div>}
    <AttentionList items={state.attention} show={(a) => { const node = board.attNode(a); return node ? () => { b.focus(node, 'attention'); close() } : null }} />
  </div>}</Menu>
}
function TicketInfo({ t, state }: { t: any | null; state: State }) {
  if (!t) return <div className="p-4 text-sm text-zinc-500">Click a ticket box to see its details here.</div>
  const f = state.features.find((x) => x.id === t.feature_id), deps = jsonList(t.deps), files = jsonList(t.expected_files)
  return <div className="h-full overflow-y-auto pr-1 text-xs">
    <div className="flex items-center gap-2"><span className="font-semibold">{t.key}</span><span className="text-zinc-500">{t.size}</span><Pill s={t.status} label={ticketLabel(t)} /></div>
    <div className="mt-1 text-sm text-zinc-200">{t.title}</div>
    <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-zinc-400">
      <dt>Feature</dt><dd className="text-zinc-300">{f?.title ?? '—'}</dd>
      <dt>Depends on</dt><dd className="text-zinc-300">{deps.join(', ') || '—'}</dd>
      <dt>Expected files</dt><dd className="break-all font-mono text-zinc-300">{files.join(', ') || '—'}</dd>
      <dt>Branch</dt><dd className="select-all break-all font-mono text-zinc-300">{t.branch ?? '—'}</dd>
      {t.pr_url && <><dt>PR</dt><dd><a className="text-indigo-300 underline" href={t.pr_url} target="_blank" rel="noreferrer">{t.pr_number ? `#${t.pr_number}` : 'open'} ↗</a></dd></>}
    </dl>
    <div className="mt-3 font-semibold text-zinc-400">Spec</div>
    <pre className="mt-1 whitespace-pre-wrap text-[11px] text-zinc-300">{t.spec || '—'}</pre>
  </div>
}
function AgentPane({ a, ws, feed }: { a: any; ws: WebSocket | null; feed: (id: string, cb: (d: string) => void) => () => void }) {
  const [text, setText] = useState('')
  return <div className="flex h-full flex-col gap-2">
    <div className="flex items-center gap-2 text-xs"><span className="shrink-0 whitespace-nowrap font-semibold">{a.display_name ?? a.id}</span><Pill s={a.status} /><span className="min-w-0 truncate text-zinc-500">{a.role} · live model {a.model_live ?? '?'} · ctx {a.context_tokens ?? '?'} · 5h {a.five_hour_pct ?? '?'}%</span>
      <span className="grow" /><button className="btn" onClick={() => api(`agents/${a.id}/stop`, {})}>Stop</button></div>
    <div className="min-h-0 grow overflow-hidden rounded-md border border-zinc-800">{a.status !== 'exited' ? <AgentTerminal agentId={a.id} ws={ws} feed={feed} /> : <div className="p-4 text-zinc-500">Exited.</div>}</div>
    <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; api(`agents/${a.id}/message`, { body: text, reason: 'fyi' }); setText('') }}>
      <input className="input" placeholder={`Message ${a.display_name ?? a.id} (delivered when idle)`} value={text} onChange={(e) => setText(e.target.value)} /><button className="btn btn-primary">Send</button>
      <button type="button" className="btn" onClick={() => { if (text.trim()) { api(`agents/${a.id}/message`, { body: text, urgent: true }); setText('') } }}>Urgent</button></form>
  </div>
}
function Messages({ state }: { state: State }) {
  const msgs = useMemo(() => [...state.messages].sort((a, b) => b.created_at - a.created_at).slice(0, 60), [state.messages])
  const name = (id: string) => id === 'user' ? 'You' : id === 'hq' ? 'HQ' : (state.agents.find((a) => a.id === id)?.display_name ?? id)
  return <div className="h-full overflow-y-auto text-xs">{!msgs.length && <div className="p-4 text-sm text-zinc-500">No messages yet.</div>}{msgs.map((m) => <div key={m.id} className="mb-1"><span className="text-zinc-500">{name(m.from_id)} → {m.to_id ? name(m.to_id) : '#team'} [{m.reason}]{m.ack_at ? ' ✓' : m.delivered_at ? ' ·' : ' ⏳'}</span> <span className="text-zinc-300">{m.body}</span></div>)}</div>
}
