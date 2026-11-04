import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, type State } from './api'
import { helperOn, isOn, portConfirm, recipeSummary, runnable, stopOthers, useBusy } from './board'
import { DOCK_FOR, PHONE, rightWidth, type Device, type Prefs } from './previewPrefs'
import { AgentTerminal } from './Terminal'
import { ActBtn, Menu } from './ui'

const DOT: Record<string, string> = { running: 'bg-emerald-400', starting: 'bg-amber-400', crashed: 'bg-rose-500', stopped: 'bg-zinc-600' }
export const Dot = ({ status }: { status: string }) => <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[status] ?? DOT.stopped}`} />

// Repos whose top-bar Launch request is still in flight: until it answers, the pane doesn't offer a second way to ask Claude
// (Bug 41: two Launch helpers started 2 s apart). The backend queues a second request anyway; this just hides the button.
const launching = new Set<string>(), watchers = new Set<() => void>()
const setLaunching = (id: string, on: boolean) => { if (on) launching.add(id); else launching.delete(id); watchers.forEach((w) => w()) }
const useLaunching = (id: string): boolean => useSyncExternalStore((w) => { watchers.add(w); return () => { watchers.delete(w) } }, () => launching.has(id))

/** The top bar's preview button: Launch <repo> starts the app and shows it (a repo HQ can't start yet asks Claude to work it
 *  out first: Bug 37); once it's on, or Claude is on it, or its steps wait for an OK, the button shows or hides the pane. */
export function LaunchBtn({ all, repo, p, open, setOpen }: { all: State; repo: any; p: any; open: boolean; setOpen: (open: boolean) => void }) {
  const [busy, go] = useBusy()
  const label = (text: string) => <span className="max-w-56 truncate">{text}</span>
  const waiting = p?.helper_state === 'needs_ok' && !!p.draft_recipe
  if (isOn(p) || helperOn(p) || waiting) return <button className={`btn flex items-center gap-1.5 ${open || waiting ? 'btn-primary' : ''}`}
    title={`Show or hide the live preview of ${repo.name}${p ? ` (${p.status})` : ''}`} onClick={() => setOpen(waiting ? true : !open)}>
    <Dot status={isOn(p) ? p.status : 'starting'} />{label(waiting ? 'OK start steps' : isOn(p) ? `${open ? 'Hide' : 'Show'} app` : 'Claude is setting up…')}</button>
  const launch = async () => {
    if (!(await stopOthers(all, repo.id, { title: `Launch ${repo.name}?`, go: 'Launch' }))) return
    setOpen(true); setLaunching(repo.id, true)
    try { await api(`previews/${repo.id}/start`, {}) } finally { setLaunching(repo.id, false) }
  }
  return <button className="btn btn-primary flex items-center gap-1.5" disabled={busy || !!repo.clearing_at}
    title={repo.clearing_at ? `${repo.name} is being cleared` : runnable(p) ? `Start ${repo.name}'s app (${p.command ?? recipeSummary(p.recipe)}) and show it here`
      : `Claude works out how to start ${repo.name} (you OK its steps once), then HQ starts it`} onClick={() => go(launch)}>
    <Dot status={p?.status ?? 'stopped'} />{label(busy ? 'Launching…' : 'Launch app')}</button>
}

/** The live preview: the app HQ runs from the repo's checkout (normally main), in a frame, with its server output a tab away. */
export function PreviewPane({ all, p, repo, prefs, setPrefs, ws, feed }: {
  all: State; p: any; repo: any; prefs: Prefs; setPrefs: (p: Partial<Prefs>, save?: boolean) => void; ws: WebSocket | null; feed: (id: string, cb: (d: string) => void) => () => void }) {
  const [picked, setTab] = useState<'app' | 'server' | 'claude'>('app')
  const [reloads, setReloads] = useState(0)
  const can = runnable(p), helper = helperOn(p) ? p.helper_agent_id : null
  const tab = picked === 'claude' && !helper ? 'app' : picked // the Claude tab goes with the helper
  const running = p.status === 'running', stopped = p.status === 'stopped'
  const tried = p.ticket_id && !stopped ? all.tickets.find((t) => t.id === p.ticket_id) : null // Try it (Bug 22)
  // Restart keeps a tried ticket; Start (it was stopped) runs main
  const start = async () => { if (await stopOthers(all, p.id, { title: `Start ${repo.name}?`, go: 'Start' })) await api(`previews/${p.id}/start`, { ticket: stopped ? null : p.ticket_id ?? null }) }
  const where = p.branch ? `${p.branch}@${p.head}` : null
  const offMain = p.branch && p.branch !== p.default_branch
  const device = (d: Device) => setPrefs({ device: d, dock: DOCK_FOR[d], w: rightWidth(d) })
  return <section className="flex h-full min-h-0 min-w-0 flex-col gap-1.5 p-2">
    {tried && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-600/50 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">
      <span className="min-w-0 grow">Trying <b>{tried.key}</b>: {tried.title}. This is its version with a copy of your data, not main. Nothing you do here changes main.</span>
      <ActBtn label="Back to main" busyLabel="Switching…" run={() => api(`previews/${p.id}/start`, { ticket: null })} /></div>}
    <HelperBanner p={p} repo={repo} watch={() => setTab('claude')} />
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      <Dot status={p.status} />
      <span className="shrink-0 font-medium text-zinc-300">{p.status}</span>
      {!stopped && where && <span className={`shrink-0 font-mono ${offMain ? 'text-amber-300' : 'text-zinc-500'}`}
        title={tried ? `${tried.key}'s branch` : offMain ? `The checkout is on ${p.branch}, not ${p.default_branch}` : `Running ${repo.name} at ${where}`}>{where}</span>}
      {!stopped && p.port && <span className="shrink-0 text-zinc-500">· :{p.url ? new URL(p.url).port : p.port}</span>}
      {p.detail && <span className="min-w-0 truncate text-zinc-500" title={p.detail}>· {p.detail}</span>}
      <span className="grow" />
      <div className="flex">{(helper ? ['app', 'server', 'claude'] as const : ['app', 'server'] as const).map((t) =>
        <button key={t} className={`btn-sm rounded-none first:rounded-l-md last:rounded-r-md ${tab === t ? 'btn-primary' : ''}`}
        title={t === 'claude' ? 'What Claude is doing to work out how to start the app' : undefined} onClick={() => setTab(t)}>{{ app: 'App', server: 'Server', claude: 'Claude' }[t]}</button>)}</div>
      <button className="btn-sm" title="Reload the page" disabled={!running} onClick={() => setReloads((n) => n + 1)}>⟳</button>
      <ActBtn label={stopped ? 'Start' : 'Restart'} busyLabel={stopped ? 'Starting…' : 'Restarting…'} primary={stopped && can} disabled={!can && !stopped}
        title={can ? `Runs ${p.command ?? recipeSummary(p.recipe)} in ${p.path}` : 'Claude works out how to start it first'} run={start} />
      <ActBtn label="Stop" busyLabel="Stopping…" disabled={stopped} run={() => api(`previews/${p.id}/stop`, {})} />
      <a className={`btn-sm ${running ? '' : 'pointer-events-none opacity-40'}`} href={p.url ?? undefined} target="_blank" rel="noreferrer" title="Open in your browser">↗</a>
      <div className="flex">{(['desktop', 'phone'] as const).map((d) => <button key={d} className={`btn-sm rounded-none first:rounded-l-md last:rounded-r-md ${prefs.device === d ? 'btn-primary' : ''}`} onClick={() => device(d)}>{d === 'desktop' ? 'Desktop' : 'Phone'}</button>)}</div>
      <button className="btn-sm" title={prefs.dock === 'bottom' ? 'Dock to the right of the graph' : 'Dock below the graph'} onClick={() => setPrefs({ dock: prefs.dock === 'bottom' ? 'right' : 'bottom' })}>⇵</button>
      <Menu label="⚙" title="How HQ starts this app" className="btn-sm">{(close) => <CommandForm p={p} close={close} />}</Menu>
    </div>
    <div className="relative min-h-0 grow overflow-hidden rounded-md border border-zinc-800">
      {/* The frame stays mounted behind the Server tab, so switching tabs doesn't reload the app. */}
      <div className={`absolute inset-0 ${tab === 'app' ? '' : 'invisible'}`}>
        {running && p.frameable !== 0 ? <Frame key={`${p.started_at}-${reloads}`} url={p.url} phone={prefs.device === 'phone'} title={`${repo.name} preview`} />
          : <Notice p={p} repo={repo} can={can} start={start} toServer={() => setTab('server')} toClaude={() => setTab('claude')} />}
      </div>
      {tab === 'server' && (stopped ? <div className="p-4 text-sm text-zinc-500">Not running. Start it to see its output here.</div>
        : <AgentTerminal key={p.started_at} agentId={`preview:${p.id}`} ws={ws} feed={feed} />)}
      {tab === 'claude' && helper && <div className="absolute inset-0"><AgentTerminal key={helper} agentId={helper} ws={ws} feed={feed} /></div>}
    </div>
  </section>
}

/** " from T1's version" when the Launch helper works from a ticket (Try it before any start steps, Bug 46). */
const fromTicket = (p: any): string => p.helper_ticket_key ? ` from ${p.helper_ticket_key}'s version` : ''

/** What the App tab says when there's no page to show. */
function Notice({ p, repo, can, start, toServer, toClaude }: { p: any; repo: any; can: boolean; start: () => Promise<unknown>; toServer: () => void; toClaude: () => void }) {
  const asking = useLaunching(repo.id)
  const server = <button className="text-indigo-300 underline" onClick={toServer}>Server output</button>
  const fix = <ActBtn label="Ask Claude to fix it" busyLabel="Asking…" run={() => api(`previews/${p.id}/setup`, { why: 'fix' })}
    title="Claude reads the output, works out what changed and suggests new start steps for you to OK" />
  if (helperOn(p) && p.status === 'stopped') return <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-zinc-400">
    <div>Claude is working out how to start {repo.name}{fromTicket(p)}.</div>
    <div className="text-xs">It looks at the project and tries it in its sandbox. Watch it in the <button className="text-indigo-300 underline" onClick={toClaude}>Claude</button> tab.</div>
  </div>
  if (p.status === 'stopped' && p.helper_state === 'needs_ok' && p.draft_recipe) return <div className="flex h-full flex-col p-2"><OkCard p={p} repo={repo} /></div>
  return <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-zinc-400">
    {p.status === 'stopped' && (can ? <>
      {!p.port_holders?.length && <ActBtn label={`Start ${repo.name}`} busyLabel="Starting…" primary run={start} />}
      <div className="text-xs text-zinc-500">Runs <code className="break-all text-zinc-300">{p.command ?? recipeSummary(p.recipe)}</code> in {p.path}.</div>
      {p.port_holders?.length ? <PortBox p={p} repo={repo} /> : p.detail && <div className="text-xs text-amber-300">{p.detail}</div>}
    </> : asking ? <div>Getting Claude ready to work out how to start {repo.name}…</div> : <>
      <div>HQ doesn't know how to start {repo.name} yet.</div>
      <ActBtn label="Ask Claude to work it out" busyLabel="Asking…" primary run={() => api(`previews/${p.id}/setup`, {})} />
      <div className="text-xs text-zinc-500">You OK its steps once; HQ runs them every time after. Or set your own command with ⚙.</div>
    </>)}
    {p.status === 'starting' && <div>Starting… {p.detail && p.detail !== 'starting…' ? p.detail : ''}<div className="mt-1 text-xs">Watch it in {server}.</div></div>}
    {p.status === 'crashed' && <><div className="text-rose-300">The app {p.detail ?? 'stopped'}.</div>
      <div className="flex flex-wrap justify-center gap-1.5"><ActBtn label="Restart" busyLabel="Restarting…" primary run={start} />{!helperOn(p) && fix}</div>
      <div className="text-xs">What went wrong is in {server}.</div></>}
    {p.status === 'running' && p.frameable === 0 && <div>{repo.name} doesn't allow being shown inside another page.<br /><a className="text-indigo-300 underline" href={p.url} target="_blank" rel="noreferrer">Open it in your browser ↗</a></div>}
  </div>
}

/** The Launch helper's state above the pane: working (watch or stop it), steps waiting for the user's OK, or why it ended. */
function HelperBanner({ p, repo, watch }: { p: any; repo: any; watch: () => void }) {
  const box = (tone: string, body: React.ReactNode) => <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1 text-xs ${tone}`}>{body}</div>
  const amber = 'border-amber-600/50 bg-amber-950/40 text-amber-200', rose = 'border-rose-700/50 bg-rose-950/40 text-rose-200'
  const again = (label: string) => <ActBtn label={label} busyLabel="Asking…" run={() => api(`previews/${p.id}/setup`, { why: p.recipe || p.command ? 'fix' : 'first' })} />
  if (p.helper_state === 'needs_ok' && p.draft_recipe) return p.status === 'stopped' ? null : <OkCard p={p} repo={repo} /> // stopped: it fills the App tab
  if (helperOn(p)) return box(amber, <>
    <span className="min-w-0 grow">{p.helper_state === 'trying'
      ? `Running Claude's steps on ${p.helper_ticket_key ? `${p.helper_ticket_key}'s version` : 'your checkout'}; Claude checks the result.`
      : `Claude is working out how to start ${repo.name}${fromTicket(p)}.`}</span>
    <button className="btn-sm" onClick={watch}>Watch</button>
    <ActBtn label="Stop Claude" busyLabel="Stopping…" run={() => api(`previews/${p.id}/dismiss`, {})} /></>)
  if (p.helper_state === 'cant_start') return box(rose, <><span className="min-w-0 grow">Claude can't start {repo.name}: {p.helper_note}</span>{again('Try again')}</>)
  if (p.helper_state === 'failed') return box(rose, <><span className="min-w-0 grow">{p.helper_note ?? 'Claude couldn\'t work out how to start it.'}</span>{again('Ask Claude again')}</>)
  if (p.helper_state === 'port_taken' && p.status === 'stopped') return box(amber, <span className="min-w-0 grow">
    {p.port_holders?.length ? `Claude's steps are saved, but a port they need is busy. Free it below.` : p.helper_note}</span>)
  return null
}

/** A program holds a port the app needs (Bug 42): who it is, and a button that stops it and launches. HQ's own leftovers go on
 *  one click; anything else is named in HQ's dialog first. */
function PortBox({ p, repo }: { p: any; repo: any }) {
  const hs: any[] = p.port_holders, ours = hs.every((h) => h.kind === 'hq')
  const go = async () => { if (ours || await portConfirm(repo, hs)) await api(`previews/${p.id}/free-port`, { pids: [...new Set(hs.map((h) => h.pid))] }) }
  return <div className="flex max-w-full flex-col items-center gap-1.5 rounded-md border border-amber-600/50 bg-amber-950/40 px-2.5 py-2 text-xs text-amber-200">
    <div className="break-words">{p.detail}</div>
    <ActBtn label={ours ? 'Stop it and Launch' : 'Stop it…'} busyLabel="Stopping…" primary run={go}
      title={ours ? 'HQ started it and lost track of it: stop it and start the app' : 'See what it is, then stop it and start the app'} />
  </div>
}

/** Claude's start steps, waiting for the user's OK: they'll run on this Mac outside the sandbox, so a person looks at them once. */
function OkCard({ p, repo }: { p: any; repo: any }) {
  return <div className="flex max-h-full min-h-0 flex-col gap-1.5 rounded-md border border-indigo-500/60 bg-indigo-950/40 px-2.5 py-2 text-xs text-zinc-300">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0 grow text-sm text-zinc-100">Claude worked out how to start {repo.name}{fromTicket(p)}. OK these steps?</span>
      <ActBtn label="OK, run these" busyLabel="Starting…" primary run={() => api(`previews/${p.id}/approve`, {})} />
      <ActBtn label="Not now" busyLabel="Stopping…" run={() => api(`previews/${p.id}/dismiss`, {})}
        title={p.helper_agent_id ? 'Claude stops; the steps stay here to OK later' : 'Keep them for later'} />
    </div>
    <div className="text-zinc-400">They run on your Mac, outside the sandbox. You OK them once; HQ runs them on every Launch after, and asks again only if
      they change.{p.helper_ticket_key ? ` OK tries ${p.helper_ticket_key} first.` : ''}</div>
    <div className="min-h-0 overflow-auto"><RecipeList r={p.draft_recipe} /></div>
  </div>
}

/** A recipe in plain words: each part's folder, install, command and port; the files Try it copies; Claude's notes. */
export function RecipeList({ r }: { r: any }) {
  return <div className="flex flex-col gap-1">
    {r.parts.map((x: any) => <div key={x.name} className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1">
      <div className="text-zinc-200"><b>{x.name}</b>{r.parts.length > 1 && x.name === r.show ? ' (the page you see)' : ''}
        {' · in '}<code>{x.dir === '.' ? 'the project folder' : `${x.dir}/`}</code> · {x.port === 'auto' ? 'a free port' : `port ${x.port}`}</div>
      {x.install && <div className="break-all font-mono text-zinc-400">install: {x.install}</div>}
      <div className="break-all font-mono text-zinc-200">run: {x.run}</div>
    </div>)}
    {r.worktree_files?.length > 0 && <div className="text-zinc-400">Copied from your checkout when you try a ticket: <code className="break-all">{r.worktree_files.join(', ')}</code></div>}
    {r.notes && <div className="italic text-zinc-400">{r.notes}</div>}
  </div>
}

/** The app itself. Desktop fills the pane; Phone is a 390×844 screen scaled to fit. No `allow-top-navigation`: the app can't
 *  navigate HQ away. */
function Frame({ url, phone, title }: { url: string; phone: boolean; title: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect() }, [])
  const frame = (cls: string, style?: React.CSSProperties) => <iframe src={url} title={title} className={cls} style={style} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
  const s = Math.min(1, (size.w - 24) / PHONE.w, (size.h - 24) / PHONE.h)
  return <div ref={box} className="flex h-full w-full items-center justify-center bg-zinc-950">
    {!phone ? frame('h-full w-full border-0 bg-white')
      : s > 0 && <div className="overflow-hidden rounded-[28px] border-4 border-zinc-700 bg-white" style={{ width: PHONE.w * s + 8, height: PHONE.h * s + 8 }}>
        {frame('border-0 bg-white', { width: PHONE.w, height: PHONE.h, transform: `scale(${s})`, transformOrigin: '0 0' })}
      </div>}
  </div>
}

/** ⚙: how HQ starts this app: the steps the user OK'd (Claude can work them out again), or their own one-line command, which wins. */
function CommandForm({ p, close }: { p: any; close: () => void }) {
  const [text, setText] = useState(p.command ?? '')
  const save = (command: string | null) => api(`previews/${p.id}/command`, { command }).then(close)
  return <form className="flex max-h-[70vh] w-96 max-w-[85vw] flex-col gap-2 overflow-auto text-xs" onSubmit={(e) => e.preventDefault()}>
    <div className="text-zinc-300">How HQ starts this app</div>
    {p.recipe ? <><div className="text-zinc-400">{p.command ? 'Claude\'s steps (your own command below is used instead):' : 'The steps you OK\'d:'}</div><RecipeList r={p.recipe} /></>
      : <div className="text-zinc-400">No start steps yet. Launch asks Claude to work them out.</div>}
    <div className="flex items-center gap-1.5">
      <ActBtn label={p.recipe ? 'Ask Claude to work them out again' : 'Ask Claude to work them out'} busyLabel="Asking…" disabled={helperOn(p)}
        run={() => api(`previews/${p.id}/setup`, { why: p.recipe ? 'fix' : 'first' }).then(close)} />
      {p.helper_state === 'needs_ok' && p.draft_recipe && <ActBtn label="OK Claude's new steps" primary run={() => api(`previews/${p.id}/approve`, {}).then(close)} />}
    </div>
    <div className="mt-1 border-t border-zinc-800 pt-2 text-zinc-400">
      Or your own command, run in <span className="break-all text-zinc-300">{p.path}</span> with <code>PORT</code> set to a free port; the page that answers is shown.
    </div>
    <input className="input font-mono text-xs!" value={text} placeholder={p.auto_command ? `e.g. ${p.auto_command}` : 'e.g. npm run dev'} onChange={(e) => setText(e.target.value)} />
    <div className="flex items-center gap-1.5"><span className="grow" />
      <ActBtn label={p.recipe ? "Use Claude's steps" : 'Clear'} disabled={!p.command} run={() => save(null)} />
      <ActBtn label="Save" primary disabled={!text.trim() || text.trim() === p.command} run={() => save(text.trim())} /></div>
  </form>
}
