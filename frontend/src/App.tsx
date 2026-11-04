import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, connectWs, errText, jsonList, showError, waitingFor, FINISHED, type Agent, type State, type WsMsg } from './api'
import { AgentTerminal } from './Terminal'
import { Graph, type Focus } from './Graph'
import { AttentionList, FreshBtn, MergeAct, ReviewPanel } from './Nodes'
import { BoardCtx, buildBoard, clearConfirm, ctxLimit, ctxShare, forRepo, freshBlocker, freshConfirm, hasParked, kTok, liveEngineer, localOnly, mergeActs, OPEN_PREVIEW, stopOthers, ticketLabel,
  openSummary, useBoard, type Board, type Pop, type PopKind } from './board'
import { ActBtn, ErrorBar, Md, Menu, NewProjectDialog, Pill, StopDialog } from './ui'
import { LaunchBtn, PreviewPane } from './Preview'
import { clampH, clampW, rightWidth, usePreviewPrefs } from './previewPrefs'
import { useAlerts } from './alerts'
import { AlertsLine } from './AlertsLine'
import { goodNews, keysText, yourTurn, type Need } from './needs.ts'
import { AutoBanner, AutoDialog, AutoSwitch, DoRestBtn, LastRunBtn } from './Auto'

type Tab = 'agent' | 'ticket' | 'messages' | 'events'
type Sel = { node: string | null; agentId: string | null; ticketId: string | null }

/** The screen: a thin top bar (repo, parallel limit, agents, preview, ⚠), the graph, and a resizable panel on the right for the
 *  clicked box's terminal or ticket, messages and events. Everything about one feature or ticket lives on its box in the graph.
 *  The live preview of the picked repo's app shares the graph's cell: below it (Desktop) or to its right (Phone). */
const live = (s: State): number => s.agents.filter((a) => a.status !== 'exited').length

/** Bug 48: the build this tab runs (its hashed script, as the backend names it), null under `vite dev`. */
const OWN_BUILD = document.querySelector('script[type=module][src*="/assets/index-"]')?.getAttribute('src')?.split('/').pop() ?? null
/** HQ was updated since this tab loaded: the backend serves another build. An old tab looks fine but talks to the new backend
 *  with old rules (the Bug 45 merge button opened GitHub instead of merging). */
const outdated = (build: string | null | undefined): boolean => !!build && !!OWN_BUILD && build !== OWN_BUILD
/** At most one automatic reload per build: if the page it brings back still differs (a build HQ hasn't caught up with), the banner
 *  shows instead of a reload loop. */
function reloadOnce(build: string): boolean {
  try { if (sessionStorage.getItem('hq.reloadedFor') === build) return false; sessionStorage.setItem('hq.reloadedFor', build); return true } catch { return false }
}
/** Would a reload lose something: an open dialog, or text typed into a box. */
const busy = (): boolean => !!document.querySelector('[role=dialog]')
  || [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type=text], input:not([type])')].some((el) => el.value.trim() !== '')
function UpdatedBar() {
  return <div role="status" className={'fixed bottom-3 left-1/2 z-[100] flex w-[520px] max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-md '
    + 'border border-indigo-500/50 bg-indigo-950 px-3 py-2 text-xs text-indigo-100 shadow-xl'}>
    <span className="min-w-0 grow">HQ was updated. Reload to use the new version (finish what you're typing first).</span>
    <button className="btn-sm shrink-0" onClick={() => location.reload()}>Reload</button></div>
}

export default function App() {
  const [all, setState] = useState<State | null>(null) // everything HQ sends; `state` below is the picked repo's share
  const [ws, setWs] = useState<WebSocket | null>(null)
  const [events, setEvents] = useState<any[]>([])
  const [sel, setSel] = useState<Sel>({ node: null, agentId: null, ticketId: null })
  const [repoId, setRepoId] = useState<string | null>(() => { try { return localStorage.getItem(REPO_KEY) } catch { return null } })
  const [pop, setPop] = useState<Pop>(null)
  const [focusReq, setFocusReq] = useState<Focus>(null)
  const [panel, setPanel] = useState<{ open: boolean; tab: Tab }>(() => ({ open: readOpen(), tab: 'messages' }))
  const [panelW, setPanelW] = useState(() => { try { return clampPanel(Number(localStorage.getItem(PANEL_KEY)) || PANEL_DEFAULT) } catch { return PANEL_DEFAULT } })
  useEffect(() => { const r = () => setPanelW((w) => clampPanel(w)); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r) }, [])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null) }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [])
  const [now, setNow] = useState(() => Date.now()) // the board's clock: "held · until 14:12" expires without a state change
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t) }, [])
  const [conn, setConn] = useState<'connecting' | 'open' | 'token' | 'down'>('connecting')
  const [updated, setUpdated] = useState(false) // HQ now serves a newer UI, but reloading would lose an open dialog or a draft
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
        if (m.type === 'snapshot') {
          queue.length = 0; clearTimeout(flushAt); flushAt = 0; setState(m.data)
          if (outdated(m.data.build)) { if (busy() || !reloadOnce(m.data.build!)) setUpdated(true); else location.reload() }
        }
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
  const feed = useCallback((agentId: string, cb: (d: string) => void) => { feeds.current.set(agentId, cb); return () => { feeds.current.delete(agentId) } }, [])
  const repoNow = all ? all.repos.find((r) => r.id === repoId) ?? all.repos[all.repos.length - 1] ?? null : null
  const state = useMemo(() => all && forRepo(all, repoNow?.id ?? null), [all, repoNow?.id]) // each repo is its own slate
  const board = useMemo(() => state ? buildBoard(state, now, state.repos.find((r) => r.id === repoNow?.id) ?? null) : null, [state, now, repoNow?.id])
  const showNeed = useRef<(n: Need) => void>(() => {}) // set below, once the board is known
  useAlerts(all, (n) => showNeed.current(n))
  // A clicked notification opens its box when it's in the repo on screen; another repo's is only named (switching parks agents).
  useEffect(() => {
    showNeed.current = (n: Need) => {
      if (!all || !board || (n.repoId && n.repoId !== repoNow?.id)) return
      const r = 'review' in n.ref ? all.reviews.find((x) => x.id === (n.ref as { review: string }).review) : null
      const a = 'attention' in n.ref ? all.attention.find((x) => x.id === (n.ref as { attention: string }).attention) : null
      if (a?.kind === `auto_finished:${repoNow?.id}`) return openSummary(repoNow!.id) // it has no box: what it's about is the summary
      const node = r ? `t:${r.ticket_id}` : 'ticket' in n.ref ? `t:${n.ref.ticket}` : 'tpm' in n.ref ? 'tpm' : a ? board.attNode(a) : null
      if (!node || !board.has(node)) return
      const kind = r ? 'review' : a ? 'attention' : null
      setFocusReq({ node, n: Date.now() }); setPop(kind ? { node, kind } : null)
    }
  })
  const [prefs, setPrefs] = usePreviewPrefs(repoNow?.id ?? null)
  // A box's Try it shows the preview pane
  useEffect(() => { const show = () => setPrefs({ open: true }); window.addEventListener(OPEN_PREVIEW, show); return () => window.removeEventListener(OPEN_PREVIEW, show) })
  const pv = repoNow ? (state?.previews ?? []).find((x) => x.id === repoNow.id) ?? null : null
  const pvMissing = !!repoNow && !pv // a repo added since the snapshot: fetch its preview row
  useEffect(() => { if (pvMissing && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'snapshot' })) }, [pvMissing, ws])
  const connText = conn === 'token' ? "HQ didn't accept this page's token. Open the URL the backend printed (it carries the token)." : conn === 'down' ? "Can't reach the HQ backend. Retrying…" : conn === 'connecting' && state ? 'Reconnecting to HQ…' : ''
  if (!state || !board) return <div className={`p-8 ${conn === 'token' || conn === 'down' ? 'text-rose-300' : 'text-zinc-400'}`}>{connText || 'Connecting to HQ…'}</div>
  const repo = repoNow
  /** Picking another repo stops the other repos' apps (after HQ's stop dialog, which can stop the old repo's agents too) and is
   *  remembered across reloads. */
  const switchRepo = async (id: string) => {
    if (id === repo?.id || !(await stopOthers(all!, id, { title: `Switch to ${all!.repos.find((r) => r.id === id)?.name ?? 'that repo'}?`, go: 'Switch' }, repo?.id ?? null))) return
    setRepoId(id); try { localStorage.setItem(REPO_KEY, id) } catch { /* private window: the pick just isn't remembered */ }
    // Coming back: work parked when the user left picks up from its handoff notes, unless they chose to press Resume themselves.
    const clearing = !!all!.repos.find((r) => r.id === id)?.clearing_at // its work is being archived, not picked up
    if (hasParked(all!, id) && !clearing && (all!.settings.after_fresh_start ?? all!.defaults.after_fresh_start) !== 'wait') api(`repos/${id}/resume`, {}).catch((e) => showError(errText(e)))
  }
  const selAgent = state.agents.find((a) => a.id === sel.agentId) ?? null, selTicket = state.tickets.find((t) => t.id === sel.ticketId) ?? null
  const showPanel = (open: boolean, tab?: Tab) => { setPanel((p) => ({ open, tab: tab ?? p.tab })); saveOpen(open) }
  const focus = (node: string, kind?: PopKind) => { setFocusReq({ node, n: Date.now() }); setPop(kind ? { node, kind } : null) }
  /** A feature box opens its TPM; a ticket box opens its running engineer, or the ticket itself when nobody is on it. */
  const selectNode = (id: string) => {
    if (id === 'tpm') { const t = repo?.tpm_agent_id ? state.agents.find((a) => a.id === repo.tpm_agent_id) : undefined // its terminal, else the conversation
      setSel({ node: id, agentId: t?.id ?? null, ticketId: null }); showPanel(true, t && t.status !== 'exited' ? 'agent' : 'messages') }
    else if (id.startsWith('f:')) { setSel({ node: id, agentId: null, ticketId: null }); showPanel(true, 'messages') } // the feature's messages
    else if (id.startsWith('t:')) { const t = state.tickets.find((x) => x.id === id.slice(2)); if (!t) return; const eng = liveEngineer(t, state); setSel({ node: id, agentId: eng?.id ?? t.assignee_agent_id ?? null, ticketId: t.id }); showPanel(true, eng ? 'agent' : 'ticket') }
  }
  const pickAgent = (a: Agent) => { setSel({ node: board.agentNode(a.id), agentId: a.id, ticketId: a.ticket_id ?? null }); showPanel(true, 'agent') }
  const pvOpen = !!repo && !!pv && prefs.open, pvBelow = prefs.dock === 'bottom'
  const tabLabel: Record<Tab, string> = { agent: `Agent${selAgent ? `: ${selAgent.display_name ?? selAgent.id}` : ''}`, ticket: `Ticket${selTicket ? `: ${selTicket.key}` : ''}`, messages: 'Messages', events: 'Events' }
  return <BoardCtx.Provider value={{ state, repo, pop, setPop, focus, selected: sel.node }}>
    <ErrorBar />
    {updated && <UpdatedBar />}
    <StopDialog />
    <AutoDialog all={all!} />
    <div className="grid h-screen grid-rows-[auto_minmax(0,1fr)]">
      <div>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 px-3 py-1.5 text-xs">
        <h1 className="font-semibold tracking-wide text-zinc-400">HQ <span className="text-zinc-600">· {live(state)} live
          {live(all!) > live(state) ? ` (+${live(all!) - live(state)} in other repos)` : ''}</span></h1>
        <RepoBar state={state} all={all!} repo={repo} onRepo={switchRepo} now={now} />
        {connText && <span className="text-rose-300" role="status">{connText}</span>}
        <ParallelLimit state={all!} /* the limit counts engineers in every repo */ />
        {repo && <AutoSwitch all={all!} repo={repo} />}
        {repo && <LastRunBtn all={all!} repo={repo} />}
        <Sessions state={state} repo={repo} />
        <span className="grow" />
        <AgentsMenu state={state} selected={sel.agentId} onPick={pickAgent} />
        {repo && <LaunchBtn all={all!} repo={repo} p={pv} open={prefs.open} setOpen={(open) => setPrefs({ open })} />}
        <button className={`btn ${panel.open ? 'btn-primary' : ''}`} title="Show or hide the panel on the right" onClick={() => showPanel(!panel.open)}>Panel</button>
        <Bell state={state} board={board} />
      </header>
      {repo && <AutoBanner all={all!} repo={repo} />}
      </div>
      <div className="grid min-h-0" style={{ gridTemplateColumns: panel.open ? `minmax(0,1fr) 6px ${panelW}px` : 'minmax(0,1fr)' }}>
        <main className="grid min-h-0 min-w-0" style={!pvOpen ? { gridTemplateRows: 'minmax(0,1fr)' } : pvBelow ? { gridTemplateRows: `minmax(0,1fr) 6px ${clampH(prefs.h)}px` } : { gridTemplateColumns: `minmax(0,1fr) 6px ${clampW(prefs.w)}px` }}>
          <div className="min-h-0 min-w-0"><Graph nodes={board.nodes} edges={board.edges} fit={board.active} focus={focusReq} onSelect={selectNode} onPane={() => setPop(null)} /></div>
          {pvOpen && <><Splitter dir={pvBelow ? 'row' : 'col'} label="Resize preview" size={pvBelow ? clampH(prefs.h) : clampW(prefs.w)} def={pvBelow ? Math.round(window.innerHeight * 0.45) : rightWidth(prefs.device)}
            set={(n) => { const c = pvBelow ? clampH(n) : clampW(n); setPrefs(pvBelow ? { h: c } : { w: c }, false); return c }} save={(n) => setPrefs(pvBelow ? { h: n } : { w: n })} />
            <PreviewPane all={all!} p={pv} repo={repo} prefs={prefs} setPrefs={setPrefs} ws={ws} feed={feed} /></>}
        </main>
        {panel.open && <><Splitter dir="col" label="Resize panel" size={panelW} def={PANEL_DEFAULT} set={(w) => { const c = clampPanel(w); setPanelW(c); return c }} save={(w) => { try { localStorage.setItem(PANEL_KEY, String(w)) } catch { /* private window: width just isn't remembered */ } }} />
          <aside className="flex min-h-0 min-w-0 flex-col gap-2 p-2">
            <div className="flex items-center gap-1 text-xs">{(['agent', 'ticket', 'messages', 'events'] as Tab[]).map((t) => <button key={t} className={`btn min-w-0 truncate ${panel.tab === t ? 'btn-primary' : ''}`} onClick={() => showPanel(true, t)}>{tabLabel[t]}</button>)}
              <span className="grow" /><button className="btn" title="Close the panel" onClick={() => showPanel(false)}>×</button></div>
            <div className="min-h-0 grow">{panel.tab === 'agent' ? (selAgent ? <AgentPane a={selAgent} ws={ws} feed={feed} /> : <div className="p-4 text-sm text-zinc-500">Click a box on the graph to see its agent here.</div>)
              : panel.tab === 'ticket' ? <TicketInfo t={selTicket} state={state} />
              : panel.tab === 'messages' ? <Messages state={state} featureId={sel.node?.startsWith('f:') ? sel.node.slice(2) : selTicket?.feature_id ?? null} />
              : <div className="h-full overflow-y-auto text-[11px] text-zinc-500">{events.map((e, i) => <div key={i} className="truncate"><span className="text-zinc-600">{new Date(e.at).toLocaleTimeString()}</span> <span className="text-zinc-400">{e.agentId ?? '·'}</span> {e.kind}</div>)}</div>}</div>
          </aside></>}
      </div>
    </div>
  </BoardCtx.Provider>
}
function applyPatch(s: State, m: { entity: string; id: string; patch: Record<string, any> | null }): State {
  if (m.entity === 'setting') return { ...s, settings: { ...s.settings, [m.id]: m.patch?.value } }
  const key = ({ agent: 'agents', ticket: 'tickets', feature: 'features', message: 'messages', review: 'reviews', attention: 'attention', repo: 'repos', preview: 'previews',
    ask: 'asks', auto_run: 'autoRuns' } as Record<string, keyof State>)[m.entity]
  if (!key) return s
  const list = (s[key] as any[]) ?? []; const i = list.findIndex((x) => x.id === m.id)
  let next: any[]
  if (m.patch === null) next = list.filter((x) => x.id !== m.id)
  else if (i >= 0) next = list.map((x) => x.id === m.id ? { ...x, ...m.patch } : x)
  else next = [{ id: m.id, ...m.patch }, ...list]
  if (key === 'attention') next = next.filter((x) => !x.resolved_at)
  if (key === 'asks') next = next.filter((x) => !x.answered_at)
  if (key === 'messages' && next.length > 500) next = next.slice(0, 500) // newest first; the snapshot starts with 300
  return { ...s, [key]: next }
}
const REPO_KEY = 'hq.repo', PANEL_KEY = 'hq.panelW', OPEN_KEY = 'hq.panelOpen', PANEL_DEFAULT = 520, PANEL_MIN = 360
/** The panel's width: what the user dragged it to, but on a narrow window it gives way so the graph keeps at least ~420px. */
const clampPanel = (w: number) => Math.round(Math.max(Math.min(PANEL_MIN, window.innerWidth * 0.45), Math.min(w, window.innerWidth * 0.8, window.innerWidth - 420)))
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
/** Repo picker, sync status, Sync, Clear… and + Project (New project…, Add repo…). */
function RepoBar({ state, all, repo, onRepo, now }: { state: State; all: State; repo: any | null; onRepo: (id: string) => void; now: number }) {
  const [busy, setBusy] = useState<null | 'pick' | 'add' | 'sync' | 'clear'>(null), [making, setMaking] = useState(false)
  const [choices, setChoices] = useState<{ in: string; repos: { path: string; name: string; github: string | null }[] } | null>(null) // a picked folder held several repos
  const account = state.defaults.github_account ?? 'warden-agent'
  const addRepo = () => { if (busy) return; setBusy('pick'); setChoices(null); api('repos/pick', {}).then((r) => { if (r.choose) setChoices({ in: r.in, repos: r.choose }); else if (!r.cancelled) onRepo(r.id) }).catch((e) => showError(errText(e))).finally(() => setBusy(null)) }
  const choose = (p: string) => { if (busy) return; setBusy('add'); setChoices(null); api('repos', { path: p }).then((r) => onRepo(r.id)).catch((e) => showError(errText(e))).finally(() => setBusy(null)) }
  const sync = () => { if (!repo || busy) return; setBusy('sync'); api(`repos/${repo.id}/sync`, {}).catch((e) => showError(errText(e))).finally(() => setBusy(null)) }
  const clear = async () => {
    if (!repo || busy || !(await clearConfirm(all, repo))) return
    setBusy('clear'); await api(`repos/${repo.id}/clear`, {}).catch((e) => showError(errText(e))).finally(() => setBusy(null))
  }
  const noting = repo?.clearing_at ? state.agents.filter((a) => a.status !== 'exited' && a.fresh_start_at).length : 0
  const ago = (t: number) => { const m = Math.round((now - t) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago` }
  const failed = repo?.kind === 'github' && !repo.sync_ok
  const status = !repo ? '' : busy === 'sync' ? 'Syncing…' : !repo.kind ? 'Not synced yet' : repo.kind === 'local' ? 'Local only · nothing to pull' : failed ? 'GitHub · sync failed' : localOnly(repo) ? `GitHub (read only) · ${repo.sync_detail.replace(/local (\S+) has commits not on GitHub, not pulled$/, 'local $1 has your merges')}` : `GitHub · ${account} · ${repo.sync_detail}`
  const when = repo?.synced_at && busy !== 'sync' ? ` · ${ago(repo.synced_at)}` : ''
  return <div className="flex min-w-0 items-center gap-1.5">
    {state.repos.length > 0 && <select className="input w-auto! max-w-48 py-0.5! text-xs!" value={repo?.id} title={repo?.path} onChange={(e) => onRepo(e.target.value)}>{state.repos.map((r) => <option key={r.id} value={r.id} title={r.path}>{r.name}</option>)}</select>}
    {repo && (failed && busy !== 'sync' ? <Menu label={`${status}${when}`} align="left" className="btn border-rose-500/50! text-rose-300!">{() => <div className="w-80 text-xs text-rose-200">{repo.sync_detail}</div>}</Menu>
      : <span className="max-w-52 truncate text-zinc-500" title={`${status}${when}`}>{status}{when}</span>)}
    {localOnly(repo) && <Menu label="Local edits only" align="left" className="btn border-indigo-500/50! text-indigo-300!">{() => <div className="w-80 text-xs text-indigo-200">
      {account} can't push to {repo.name}, so HQ works on it locally: finished tickets get Merge into main, into your local {repo.default_branch}. Nothing is pushed and no PRs are opened.</div>}</Menu>}
    {repo && <button className="btn" onClick={sync} disabled={!!busy}>Sync</button>}
    {repo && (repo.clearing_at || busy === 'clear'
      ? <span className="max-w-52 truncate text-rose-300" role="status" title="Each agent that was mid-work writes a handoff note (up to 3 minutes); then the board is archived and deleted.">
        Clearing…{noting ? ` ${noting} note${noting === 1 ? '' : 's'} to go` : ''}</span>
      : <button className="btn" onClick={() => void clear()} disabled={!!busy} title={`Clear ${repo.name}: archive and delete its board, and start fresh`}>Clear…</button>)}
    {making && <NewProjectDialog onClose={() => setMaking(false)} onMade={(id) => { setMaking(false); onRepo(id) }} />}
    <div className="relative">{busy === 'pick' || busy === 'add' ? <button className="btn" disabled>{busy === 'pick' ? 'Choose a folder…' : 'Adding…'}</button>
      : <Menu label="+ Project" align="left" title="Start a new project, or add a repo you already have">{(close) => <div className="flex w-64 flex-col gap-1 text-xs">
        <button className="btn text-left" disabled={!!busy} onClick={() => { close(); setMaking(true) }}>
          New project…<div className="text-zinc-500">A new folder and repo, on this Mac or on GitHub too</div></button>
        <button className="btn text-left" disabled={!!busy} onClick={() => { close(); addRepo() }}>
          Add repo…<div className="text-zinc-500">A folder that's already a git repo</div></button></div>}</Menu>}
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
  return <div className="flex items-center gap-1.5 text-zinc-400" title="How many engineers may work at the same time">Engineers at once <input type="number" min={1} max={10} className="input w-14! py-0.5! text-xs!" value={cap} onChange={(e) => set(Number(e.target.value))} /><span className="text-zinc-600" title={`${working} of ${cap} engineers are working`}>{working}/{cap} busy</span></div>
}
/** Every agent, including ones with no box on the graph (exited, architects, engineers on cancelled tickets). */
function AgentsMenu({ state, selected, onPick }: { state: State; selected: string | null; onPick: (a: Agent) => void }) {
  const running = state.agents.filter((a) => a.status !== 'exited').length
  return <Menu label={`Agents · ${running} running`} title="Every agent, including stopped ones and ones with no box on the graph">{(close) => <div className="flex max-h-[75vh] w-80 flex-col gap-1 overflow-y-auto">
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
  const onAuto = !!b.repo?.auto_mode && !b.repo.auto_stopped_why
  const merges = state.tickets.flatMap((t) => { const f = base(t), acts = f.cancelled || (onAuto && !t.auto_parked_why) ? [] : mergeActs(t, f.branch, liveEngineer(t, state));
    return acts.length ? [{ t, acts }] : [] })
  const repo = b.repo, turn = repo ? yourTurn(state, repo.id) : { asks: [], start: [] } // Bug 43, on the project's TPM since Bug 52
  const n = turn.asks.length + (turn.start.length ? 1 : 0) + reviews.length + merges.length + state.attention.length
  const good = n > 0 && state.attention.filter((a) => goodNews(a.kind)).length === n // only good news: green, not red
  const showT = (close: () => void) => <button className="btn-sm shrink-0" onClick={() => { b.focus('tpm'); close() }}>Show</button>
  /** Where a notice's Show goes: this project's finished run has its summary, anything else its box. */
  const showAtt = (a: any, close: () => void) => {
    if (repo && a.kind === `auto_finished:${repo.id}`) return () => { openSummary(repo.id); close() }
    const node = board.attNode(a); return node ? () => { b.focus(node, 'attention'); close() } : null
  }
  const tone = good ? 'border-emerald-500/50! text-emerald-300!' : n ? 'border-rose-500/50! text-rose-300!' : ''
  return <Menu label={`${good ? '✓' : '⚠'} ${n}`} title="Plan reviews and things that need you" className={`btn ${tone}`}>{(close) => <div className="flex max-h-[75vh] w-[440px] max-w-[90vw] flex-col gap-2 overflow-y-auto text-xs">
    <AlertsLine />
    {!n && <div className="p-1 text-zinc-500">Nothing needs you right now.</div>}
    {repo && !repo.auto_mode && (turn.asks.length > 0 || turn.start.length > 0 || reviews.length > 0 || merges.length > 0) && <div className="flex justify-end"><DoRestBtn repoId={repo.id} /></div>}
    {(turn.asks.length > 0 || turn.start.length > 0) && <div className="font-semibold text-zinc-400">Your turn</div>}
    {(turn.asks.length > 0 || turn.start.length > 0) && <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 p-2">
      {turn.asks.map((a) => <div key={a.id} className="flex flex-col gap-1">
        <div className="flex items-start gap-2"><span className="min-w-0 grow break-words text-amber-200">The TPM asked: {a.question}</span>{showT(close)}</div>
        {a.choices.length > 0 && <div className="flex flex-wrap gap-1">
          {a.choices.map((c) => <ActBtn key={c} primary label={c} busyLabel="Sending…" run={() => api(`asks/${a.id}/answer`, { answer: c })} />)}</div>}</div>)}
      {turn.start.length > 0 && <div className="flex items-center gap-2">
        <span className="min-w-0 grow break-words text-amber-200">{keysText(turn.start)} {turn.start.length > 1 ? 'are' : 'is'} ready to start</span>
        <ActBtn primary label="Start" busyLabel="Starting…" run={() => api(`repos/${repo.id}/start-ready`, {})} />{showT(close)}</div>}
    </div>}
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
    <AttentionList items={state.attention} show={(a) => showAtt(a, close)} />
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
    <HandoffNote scope={`resume:ticket:${t.id}`} stamp={`${t.parked_at}:${t.assignee_agent_id}`} />
  </div>
}
function AgentPane({ a, ws, feed }: { a: any; ws: WebSocket | null; feed: (id: string, cb: (d: string) => void) => () => void }) {
  const [text, setText] = useState(''); const { state } = useBoard()
  const lim = ctxLimit(state, a.role), ctx = a.context_tokens ? `${kTok(a.context_tokens)}${lim ? ` / ${kTok(lim)}` : ''}` : ''
  return <div className="flex h-full flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2 text-xs"><span className="shrink-0 whitespace-nowrap font-semibold">{a.display_name ?? a.id}</span><Pill s={a.status} />
      <span className="min-w-0 truncate text-zinc-500">{a.role} · {a.model_live ?? a.model_alias}{ctx ? ` · context ${ctx}` : ''} · 5h {a.five_hour_pct ?? '?'}%</span>
      <span className="grow" /><FreshBtn a={a} label="Fresh start" /><button className="btn" onClick={() => api(`agents/${a.id}/stop`, {})}>Stop</button></div>
    <div className="min-h-0 grow overflow-hidden rounded-md border border-zinc-800">{a.status !== 'exited' ? <AgentTerminal agentId={a.id} ws={ws} feed={feed} /> : <div className="p-4 text-zinc-500">Exited.</div>}</div>
    <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; api(`agents/${a.id}/message`, { body: text, reason: 'fyi' }); setText('') }}>
      <input className="input" placeholder={`Message ${a.display_name ?? a.id} (delivered when idle)`} value={text} onChange={(e) => setText(e.target.value)} /><button className="btn btn-primary">Send</button>
      <button type="button" className="btn" onClick={() => { if (text.trim()) { api(`agents/${a.id}/message`, { body: text, urgent: true }); setText('') } }}>Urgent</button></form>
  </div>
}
/** Messages, newest first. "Yours" (the default): what you sent and what agents said to you (the TPM's replies included); "Everything"
 *  adds HQ's notices and the agents' messages to each other. With a feature's box picked, only that feature's. */
function Messages({ state, featureId }: { state: State; featureId: string | null }) {
  const [all, setAll] = useState(false)
  const msgs = useMemo(() => [...state.messages].filter((m) => (!featureId || m.feature_id === featureId) && (all || m.from_id === 'user' || m.to_id === 'user'))
    .sort((a, b) => b.created_at - a.created_at).slice(0, 80), [state.messages, all, featureId])
  const name = (id: string) => id === 'user' ? 'You' : id === 'hq' ? 'HQ' : (state.agents.find((a) => a.id === id)?.display_name ?? id)
  const what = featureId ? state.features.find((f) => f.id === featureId)?.title : null
  return <div className="flex h-full flex-col gap-2 text-xs">
    <div className="flex flex-wrap items-center gap-1"><button className={`btn ${!all ? 'btn-primary' : ''}`} onClick={() => setAll(false)}>Yours</button>
      <button className={`btn ${all ? 'btn-primary' : ''}`} onClick={() => setAll(true)} title="Also HQ's notices and the agents' messages to each other">Everything</button>
      {what && <span className="min-w-0 truncate text-zinc-500" title={what}>· {what}</span>}</div>
    <div className="min-h-0 grow overflow-y-auto">{!msgs.length && <div className="p-4 text-sm text-zinc-500">No messages yet.</div>}
      {msgs.map((m) => <div key={m.id} className="mb-2"><div className="text-zinc-500">{name(m.from_id)} → {m.to_id ? name(m.to_id) : 'everyone'}{all ? ` [${m.reason}]` : ''}
        {m.ack_at ? ' ✓' : m.delivered_at ? ' ·' : ' ⏳'} · {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        <div className="text-zinc-300"><Md text={m.body} /></div></div>)}</div>
  </div>
}
/** The handoff note the last engineer left for the next one (fresh start), read-only; refetched when the ticket's engineer changes. */
function HandoffNote({ scope, stamp }: { scope: string; stamp: string }) {
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { let on = true; api<any[]>(`docs?scope=${encodeURIComponent(scope)}`).then((r) => { if (on) setNote(r[0]?.text ?? null) }, () => {}); return () => { on = false } }, [scope, stamp])
  if (!note) return null
  return <><div className="mt-3 font-semibold text-zinc-400">Handoff note <span className="font-normal text-zinc-600">(left at its last fresh start)</span></div>
    <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-zinc-300">{note}</pre></>
}
const CTX_PICKS = [100_000, 150_000, 200_000]
const shareTone = (share: number | null, [over, near, calm]: [string, string, string]) => share !== null && share >= 1 ? over : share !== null && share >= 0.8 ? near : calm
/** Sessions: how full each agent's context is, the limit (a preset, never typed), what happens at it, what follows a Fresh
 *  start, and Fresh start one or all. The label warns when an agent is near or past its limit. */
function Sessions({ state, repo }: { state: State; repo: any | null }) {
  const set = (key: string, value: unknown) => api('settings', { key, value }).catch((e) => showError(errText(e)))
  const setting = (key: string, def: unknown) => state.settings[key] ?? state.defaults[key] ?? def
  const pick = Number(setting('context_limit', 150_000)), action = setting('context_action', 'warn'), after = setting('after_fresh_start', 'continue')
  const agents = state.agents.filter((a) => a.status !== 'exited' && (a.role === 'tpm' || a.role === 'engineer'))
    .map((a) => ({ a, share: ctxShare(a, state) })).sort((x, y) => (y.share ?? -1) - (x.share ?? -1))
  const near = agents.filter((x) => (x.share ?? 0) >= 0.8).length, worst = agents[0]?.share ?? null
  const can = agents.filter((x) => !freshBlocker(x.a, state)), names = can.map((x) => x.a.display_name ?? x.a.id)
  const all = async () => {
    if (repo && can.length && await freshConfirm(state, names)) await api(`repos/${repo.id}/fresh-start-all`, {}).catch((e) => showError(errText(e)))
  }
  const radio = (key: string, cur: string, opts: [string, string][]) => <div className="flex flex-col gap-1">{opts.map(([v, label]) =>
    <label key={v} className="flex cursor-pointer items-start gap-2 text-zinc-300">
      <input type="radio" className="mt-0.5" checked={cur === v} onChange={() => set(key, v)} /><span>{label}</span></label>)}</div>
  const head = (text: string) => <div className="font-semibold text-zinc-300">{text}</div>
  const labelTone = shareTone(near ? worst : null, ['border-rose-500/50! text-rose-300!', 'border-amber-500/50! text-amber-300!', ''])
  return <Menu label={`Sessions${near ? ` · ${near} near limit` : ''}`} title="How full each agent's memory is, and fresh starts" className={`btn ${labelTone}`}>{(close) =>
    <div className="flex max-h-[75vh] w-[400px] max-w-[90vw] flex-col gap-3 overflow-y-auto text-xs text-zinc-400">
      <div>Agents get slower and sloppier as their memory (context) fills up. A <span className="text-zinc-200">fresh start</span> has one write
        a short handoff note and hand over to a new session with a clean memory.</div>
      <div className="flex flex-col gap-1.5">{head('Limit')}
        <div className="flex flex-wrap gap-1">{CTX_PICKS.map((n) =>
          <button key={n} className={`btn ${pick === n ? 'btn-primary' : ''}`} onClick={() => set('context_limit', n)}>{kTok(n)}</button>)}</div>
        <div className="text-zinc-500">TPM {kTok(pick)} · engineers {kTok(ctxLimit(state, 'engineer') ?? pick)} (set for you: their memory fills with old code and test output)</div></div>
      <div className="flex flex-col gap-1.5">{head('When an agent reaches its limit')}
        {radio('context_action', action, [['warn', 'Warn me (a ⚠ notice; I press Fresh start)'], ['auto', 'Fresh start it automatically, once its current step is done']])}</div>
      <div className="flex flex-col gap-1.5">{head('After I press Fresh start')}
        {radio('after_fresh_start', after, [['continue', 'A new session picks up right away'], ['wait', 'Wait until I press Resume']])}</div>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-zinc-300">Running in {repo?.name ?? 'this repo'}</span><span className="grow" />
          <button className="btn" disabled={!can.length} onClick={() => { close(); void all() }}
            title={can.length ? 'Fresh start every TPM and engineer here that can have one now' : 'Nothing here can have a fresh start right now'}>Fresh start all</button></div>
        {!agents.length && <div className="text-zinc-500">No TPM or engineer is running here.</div>}
        {agents.map(({ a, share }) => <SessionRow key={a.id} a={a} share={share} limit={ctxLimit(state, a.role)!} />)}</div>
    </div>}</Menu>
}
function SessionRow({ a, share, limit }: { a: Agent; share: number | null; limit: number }) {
  const text = a.fresh_start_at ? 'writing its note…' : a.context_tokens ? `${kTok(a.context_tokens)} / ${kTok(limit)}` : 'not measured yet'
  return <div className="flex flex-col gap-1 rounded-md border border-zinc-800 p-2">
    <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 grow break-words text-zinc-200">{a.display_name ?? a.id}</span>
      <span className={share === null ? 'text-zinc-600' : shareTone(share, ['text-rose-300', 'text-amber-300', 'text-zinc-400'])}>{text}</span>
      <FreshBtn a={a} label="Fresh start" /></div>
    <div className="h-1 overflow-hidden rounded bg-zinc-800">
      <div className={`h-full ${shareTone(share, ['bg-rose-500', 'bg-amber-500', 'bg-zinc-500'])}`} style={{ width: `${Math.min(100, Math.round((share ?? 0) * 100))}%` }} /></div>
  </div>
}
