import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { DOCK_FOR, PHONE, rightWidth, type Device, type Prefs } from './previewPrefs'
import { AgentTerminal } from './Terminal'
import { ActBtn, Menu } from './ui'

const DOT: Record<string, string> = { running: 'bg-emerald-400', starting: 'bg-amber-400', crashed: 'bg-rose-500', stopped: 'bg-zinc-600' }
export const Dot = ({ status }: { status: string }) => <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[status] ?? DOT.stopped}`} />

/** The live preview: the app HQ runs from the repo's checkout (normally main), in a frame, with its server output a tab away. */
export function PreviewPane({ p, repo, prefs, setPrefs, ws, feed }: { p: any; repo: any; prefs: Prefs; setPrefs: (p: Partial<Prefs>, save?: boolean) => void; ws: WebSocket | null; feed: (id: string, cb: (d: string) => void) => () => void }) {
  const [tab, setTab] = useState<'app' | 'server'>('app')
  const [reloads, setReloads] = useState(0)
  const command = p.command ?? p.auto_command
  const running = p.status === 'running', stopped = p.status === 'stopped'
  const start = () => api(`previews/${p.id}/start`, {})
  const where = p.branch ? `${p.branch}@${p.head}` : null
  const offMain = p.branch && p.branch !== p.default_branch
  const device = (d: Device) => setPrefs({ device: d, dock: DOCK_FOR[d], w: rightWidth(d) })
  return <section className="flex h-full min-h-0 min-w-0 flex-col gap-1.5 p-2">
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      <Dot status={p.status} />
      <span className="shrink-0 font-medium text-zinc-300">{p.status}</span>
      {!stopped && where && <span className={`shrink-0 font-mono ${offMain ? 'text-amber-300' : 'text-zinc-500'}`} title={offMain ? `The checkout is on ${p.branch}, not ${p.default_branch}` : `Running ${repo.name} at ${where}`}>{where}</span>}
      {!stopped && p.port && <span className="shrink-0 text-zinc-500">· :{p.url ? new URL(p.url).port : p.port}</span>}
      {p.detail && <span className="min-w-0 truncate text-zinc-500" title={p.detail}>· {p.detail}</span>}
      <span className="grow" />
      <div className="flex">{(['app', 'server'] as const).map((t) => <button key={t} className={`btn-sm rounded-none first:rounded-l-md last:rounded-r-md ${tab === t ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>{t === 'app' ? 'App' : 'Server'}</button>)}</div>
      <button className="btn-sm" title="Reload the page" disabled={!running} onClick={() => setReloads((n) => n + 1)}>⟳</button>
      <ActBtn label={stopped ? 'Start' : 'Restart'} busyLabel={stopped ? 'Starting…' : 'Restarting…'} primary={stopped} disabled={!command} title={command ? `Runs ${command} in ${p.path}` : 'Set a start command with ⚙ first'} run={start} />
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
          : <Notice p={p} repo={repo} command={command} start={start} toServer={() => setTab('server')} />}
      </div>
      {tab === 'server' && (stopped ? <div className="p-4 text-sm text-zinc-500">Not running. Start it to see its output here.</div>
        : <AgentTerminal key={p.started_at} agentId={`preview:${p.id}`} ws={ws} feed={feed} />)}
    </div>
  </section>
}

/** What the App tab says when there's no page to show. */
function Notice({ p, repo, command, start, toServer }: { p: any; repo: any; command: string | null; start: () => Promise<unknown>; toServer: () => void }) {
  const server = <button className="text-indigo-300 underline" onClick={toServer}>Server output</button>
  return <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-zinc-400">
    {p.status === 'stopped' && (command ? <>
      <ActBtn label={`Start ${repo.name}`} busyLabel="Starting…" primary run={start} />
      <div className="text-xs text-zinc-500">Runs <code className="text-zinc-300">{command}</code> in {p.path} on port {p.port ?? 3090}{p.command ? '' : ' (HQ\'s pick from package.json)'}.</div>
      {p.detail && <div className="text-xs text-amber-300">{p.detail}</div>}
    </> : <div>HQ can't tell how to start {repo.name}: its package.json has no <code>dev</code> or <code>start</code> script.<br />Set a command with ⚙.</div>)}
    {p.status === 'starting' && <div>Starting… {p.detail && p.detail !== 'starting…' ? p.detail : ''}<div className="mt-1 text-xs">Watch it in {server}.</div></div>}
    {p.status === 'crashed' && <><div className="text-rose-300">The app {p.detail ?? 'stopped'}.</div><ActBtn label="Restart" busyLabel="Restarting…" primary run={start} /><div className="text-xs">What went wrong is in {server}.</div></>}
    {p.status === 'running' && p.frameable === 0 && <div>{repo.name} doesn't allow being shown inside another page.<br /><a className="text-indigo-300 underline" href={p.url} target="_blank" rel="noreferrer">Open it in your browser ↗</a></div>}
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

/** ⚙: The user's own start command for this repo, or HQ's pick. Saving restarts a preview that's on. */
function CommandForm({ p, close }: { p: any; close: () => void }) {
  const [text, setText] = useState(p.command ?? '')
  const save = (command: string | null) => api(`previews/${p.id}/command`, { command }).then(close)
  return <form className="flex w-96 max-w-[85vw] flex-col gap-2 text-xs" onSubmit={(e) => e.preventDefault()}>
    <div className="text-zinc-400">How HQ starts this app. It runs in <span className="break-all text-zinc-300">{p.path}</span> with <code>PORT</code> set; the page that answers is shown.</div>
    <input className="input font-mono text-xs!" value={text} placeholder={p.auto_command ? `auto: ${p.auto_command}` : 'e.g. npm run dev'} onChange={(e) => setText(e.target.value)} />
    <div className="flex items-center gap-1.5"><span className="grow text-zinc-500">{p.auto_command ? `HQ's pick: ${p.auto_command}` : 'No dev or start script found.'}</span>
      <ActBtn label="Use HQ's pick" disabled={!p.command} run={() => save(null)} />
      <ActBtn label="Save" primary disabled={!text.trim() || text.trim() === p.command} run={() => save(text.trim())} /></div>
  </form>
}
