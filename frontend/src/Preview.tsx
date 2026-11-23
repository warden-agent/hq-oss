import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, type State } from './api'
import { helperOn, isOn, portConfirm, recipeSummary, runnable, stopOthers, useBusy } from './board'
import { DOCK_FOR, PHONE, rightWidth, type Device, type Prefs } from './previewPrefs'
import { AgentTerminal } from './Terminal'
import { ActBtn, Md, Menu } from './ui'

const DOT: Record<string, string> = { running: 'bg-emerald-400', starting: 'bg-amber-400', crashed: 'bg-rose-500', stopped: 'bg-zinc-600',
  stopping: 'bg-amber-400', restarting: 'bg-amber-400' }
/** Bug 235: the run's state in one word. HQ marks the row before it ends a run (Bug 215), so "stopping" comes from the row, not from a request that a
 *  backend going away cuts short; a Stop or restart HQ was in the middle of finishes once it's back. */
const statusWord = (p: any): string => p?.status === 'stopped' ? 'stopped' : p?.stopping === 'stop' ? 'stopping' : p?.stopping === 'restart' ? 'restarting' : p?.status ?? 'stopped'
export const Dot = ({ status }: { status: string }) => <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[status] ?? DOT.stopped}`} />

// Repos whose top-bar Launch request is still in flight: until it answers, the pane doesn't offer a second way to ask Claude
// (Bug 41: two Launch helpers started 2 s apart). The backend queues a second request anyway; this just hides the button.
const launching = new Set<string>(), watchers = new Set<() => void>()
const setLaunching = (id: string, on: boolean) => { if (on) launching.add(id); else launching.delete(id); watchers.forEach((w) => w()) }
const useLaunching = (id: string): boolean => useSyncExternalStore((w) => { watchers.add(w); return () => { watchers.delete(w) } }, () => launching.has(id))

/** One app at a time (PR #25): every button that starts this repo's app (Launch, OK its steps, free its port) first stops the other repos'
 *  apps, after HQ's dialog in Launch's words. False when the user cancels. Bug 277: "OK, run these" used to skip it and leave both running. */
const launchOnly = (all: State, repo: any): Promise<boolean> => stopOthers(all, repo.id, { title: `Launch ${repo.name}?`, go: 'Launch' })

/** The top bar's preview button: Launch <repo> starts the app and shows it (a repo HQ can't start yet asks Claude to work it
 *  out first: Bug 37); once it's on, or Claude is on it, or its steps wait for an OK, the button shows or hides the pane. */
export function LaunchBtn({ all, repo, p, open, setOpen }: { all: State; repo: any; p: any; open: boolean; setOpen: (open: boolean) => void }) {
  const [busy, go] = useBusy()
  const label = (text: string) => <span className="max-w-56 truncate">{text}</span>
  const waiting = p?.helper_state === 'needs_ok' && !!p.draft_recipe
  if (isOn(p) || helperOn(p) || waiting) return <button className={`btn flex items-center gap-1.5 ${open || waiting ? 'btn-primary' : ''}`}
    title={`Show or hide the live preview of ${repo.name}${p ? ` (${statusWord(p)})` : ''}`} onClick={() => setOpen(waiting ? true : !open)}>
    <Dot status={isOn(p) ? statusWord(p) : 'starting'} />{label(waiting ? 'OK start steps' : isOn(p) ? `${open ? 'Hide' : 'Show'} app` : 'Claude is setting up…')}</button>
  const launch = async () => {
    setOpen(true); setLaunching(repo.id, true)
    try { await api(`previews/${repo.id}/start`, {}) } finally { setLaunching(repo.id, false) }
  }
  return <button className="btn btn-primary flex items-center gap-1.5" disabled={busy || !!repo.clearing_at}
    title={repo.clearing_at ? `${repo.name} is being cleared` : runnable(p) ? `Start ${repo.name}'s app (${p.command ?? recipeSummary(p.recipe)}) and show it here`
      : `Claude works out how to start ${repo.name} (you OK its steps once), then HQ starts it`} onClick={() => go(launch, () => launchOnly(all, repo))}>
    <Dot status={p?.status ?? 'stopped'} />{label(busy ? 'Launching…' : 'Launch app')}</button>
}

/** The live preview: the app HQ runs from the repo's checkout (normally main), in a frame, with its server output a tab away. */
export function PreviewPane({ all, p, repo, prefs, setPrefs, ws, feed, onRepo, roomRight, onEvents }: {
  all: State; p: any; repo: any; prefs: Prefs; setPrefs: (p: Partial<Prefs>, save?: boolean) => void; ws: WebSocket | null; feed: (id: string, cb: (d: string) => void) => () => void
  onRepo: (id: string) => void; roomRight: boolean /* false: no room beside the graph, so the pane shows below it whatever its dock (Bug 167) */
  onEvents: (agentId: string) => void /* a helper's history in the side panel's Events tab (Bug 237) */ }) {
  const [picked, setTab] = useState<'app' | 'server' | 'claude'>('app')
  const [reloads, setReloads] = useState(0)
  const can = runnable(p), helper = helperOn(p) ? p.helper_agent_id : null
  const tab = picked === 'claude' && !helper ? 'app' : picked // the Claude tab goes with the helper
  const running = p.status === 'running', stopped = p.status === 'stopped'
  const word = statusWord(p), ending = word === 'stopping', restarting = word === 'restarting'
  const tried = p.ticket_id && !stopped ? all.tickets.find((t) => t.id === p.ticket_id) : null // Try it (Bug 22)
  // Restart keeps a tried ticket; Start (it was stopped) runs main. One app at a time: `others` asks first (the button reads busy after, Bug 315)
  const others = () => stopOthers(all, p.id, { title: `Start ${repo.name}?`, go: 'Start' })
  const start = () => api(`previews/${p.id}/start`, { ticket: stopped ? null : p.ticket_id ?? null })
  const where = p.branch ? `${p.branch}@${p.head}` : null
  const offMain = p.branch && p.branch !== p.default_branch
  const device = (d: Device) => setPrefs({ device: d, dock: DOCK_FOR[d], w: rightWidth(d) })
  // wrap-anywhere: a long project name with no spaces in a banner ("Claude is working out how to start <name>") wraps inside the pane (Bug 270's family)
  return <section className="flex h-full min-h-0 min-w-0 flex-col gap-1.5 p-2 wrap-anywhere">
    {tried && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-600/50 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">
      <span className="min-w-0 grow">Trying <b>{tried.key}</b>: {tried.title}. This is its version with a copy of your data, not main. Nothing you do here changes main.</span>
      <ActBtn label="Back to main" busyLabel="Switching…" run={() => api(`previews/${p.id}/start`, { ticket: null })} /></div>}
    <HelperBanner all={all} p={p} repo={repo} watch={() => setTab('claude')} events={onEvents} />
    <SetupBanner p={p} repo={repo} events={onEvents} />
    <CommandWarning p={p} />
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      <Dot status={word} />
      <span className="shrink-0 font-medium text-zinc-300">{word}</span>
      {!stopped && where && <span className={`shrink-0 font-mono ${offMain ? 'text-amber-300' : 'text-zinc-500'}`}
        title={tried ? `${tried.key}'s branch` : offMain ? `The checkout is on ${p.branch}, not ${p.default_branch}` : `Running ${repo.name} at ${where}`}>{where}</span>}
      {!stopped && p.port && <span className="shrink-0 text-zinc-500">· :{p.url ? new URL(p.url).port : p.port}</span>}
      {p.detail && <span className="min-w-0 truncate text-zinc-500" title={p.detail}>· {p.detail}</span>}
      <span className="grow" />
      <div className="flex">{(helper ? ['app', 'server', 'claude'] as const : ['app', 'server'] as const).map((t) =>
        <button key={t} className={`btn-sm rounded-none first:rounded-l-md last:rounded-r-md ${tab === t ? 'btn-primary' : ''}`}
        title={t === 'claude' ? 'What Claude is doing to work out how to start the app' : undefined} onClick={() => setTab(t)}>{{ app: 'App', server: 'Server', claude: 'Claude' }[t]}</button>)}</div>
      <button className="btn-sm" title="Reload the page" disabled={!running} onClick={() => setReloads((n) => n + 1)}>⟳</button>
      <ActBtn label={stopped ? 'Start' : restarting ? 'Restarting…' : 'Restart'} busyLabel={stopped ? 'Starting…' : 'Restarting…'} primary={stopped && can}
        disabled={(!can && !stopped) || restarting} ask={others} run={start}
        title={can ? `Runs ${p.command ?? recipeSummary(p.recipe)} in ${p.path}` : 'Claude works out how to start it first'} />
      <ActBtn label={ending ? 'Stopping…' : 'Stop'} busyLabel="Stopping…" disabled={stopped || ending} run={() => api(`previews/${p.id}/stop`, {})}
        title={ending ? `HQ is stopping ${repo.name}. If HQ restarts first, it finishes the Stop when it's back.` : undefined} />
      <a className={`btn-sm ${running ? '' : 'pointer-events-none opacity-40'}`} href={p.url ?? undefined} target="_blank" rel="noreferrer" title="Open in your browser">↗</a>
      <div className="flex">{(['desktop', 'phone'] as const).map((d) => <button key={d} className={`btn-sm rounded-none first:rounded-l-md last:rounded-r-md ${prefs.device === d ? 'btn-primary' : ''}`} onClick={() => device(d)}>{d === 'desktop' ? 'Desktop' : 'Phone'}</button>)}</div>
      <button className="btn-sm" disabled={!roomRight} onClick={() => setPrefs({ dock: prefs.dock === 'bottom' ? 'right' : 'bottom' })}
        title={!roomRight ? 'No room beside the graph, so the app shows below it. Widen the window or close the side panel to dock it right.'
          : prefs.dock === 'bottom' ? 'Dock to the right of the graph' : 'Dock below the graph'}>⇵</button>
      <Menu label="⚙" title="How HQ starts this app" className="btn-sm">{(close) => <CommandForm all={all} p={p} repo={repo} close={close} />}</Menu>
    </div>
    <div className="relative min-h-0 grow overflow-hidden rounded-md border border-zinc-800">
      {/* The frame stays mounted behind the Server tab, so switching tabs doesn't reload the app. */}
      <div className={`absolute inset-0 ${tab === 'app' ? '' : 'invisible'}`}>
        {running && p.frameable !== 0 ? <Frame key={`${p.started_at}-${reloads}`} url={p.url} phone={prefs.device === 'phone'} title={`${repo.name} preview`} />
          : <Notice all={all} p={p} repo={repo} can={can} others={others} start={start} toServer={() => setTab('server')} toClaude={() => setTab('claude')} onRepo={onRepo} />}
      </div>
      {tab === 'server' && (stopped ? <div className="p-4 text-sm text-zinc-500">Not running. Start it to see its output here.</div>
        : <AgentTerminal key={p.started_at} agentId={`preview:${p.id}`} ws={ws} feed={feed} minCols={0} />)}
      {tab === 'claude' && helper && <div className="absolute inset-0"><AgentTerminal key={helper} agentId={helper} ws={ws} feed={feed} /></div>}
    </div>
  </section>
}

/** " from T1's version" when the Launch helper works from a ticket (Try it before any start steps, Bug 46). */
const fromTicket = (p: any): string => p.helper_ticket_key ? ` from ${p.helper_ticket_key}'s version` : ''

/** A project with no files (Bug 67): nothing to start, and no Claude to ask. If it sits inside another repo, that's probably the one that was meant. */
function NoFiles({ repo, onRepo }: { repo: any; onRepo: (id: string) => void }) {
  const [around, setAround] = useState<{ path: string; name: string; repoId: string | null } | null>(null)
  useEffect(() => { let gone = false; api(`repos/${repo.id}/around`, {}).then((r) => { if (!gone) setAround(r.around) }, () => {}); return () => { gone = true } }, [repo.id])
  return <>
    <div>{repo.name} has no files yet, so there's nothing to start.</div>
    {around ? <><div className="text-xs">Its folder is inside {around.name}, which is a repo of its own.</div>
      <ActBtn primary label={around.repoId ? `Open ${around.name}` : `Add ${around.name} to HQ`} busyLabel="Opening…" run={() => api('repos', { path: around.path }).then((r) => onRepo(r.id))} /></>
      : <div className="text-xs text-zinc-500">Tell the TPM what to build. Once something is merged, Launch can start it.</div>}
  </>
}

/** Bug 299: the App tab offers its own ask to Claude: "Ask Claude to work it out" (HQ can't start it) or "Ask Claude to fix it" (it crashed), so the
 *  banner above offers none. Not while a helper is on it, even with its steps waiting for the OK: HQ would find it on and do nothing. */
const asks = (p: any, repo: any): boolean => !p.helper_agent_id && (p.status === 'crashed' || (p.status === 'stopped' && !runnable(p) && !repo.empty))

/** What the App tab says when there's no page to show. */
function Notice({ all, p, repo, can, others, start, toServer, toClaude, onRepo }: { all: State; p: any; repo: any; can: boolean; others: () => Promise<boolean>
  start: () => Promise<unknown>; toServer: () => void; toClaude: () => void; onRepo: (id: string) => void }) {
  const asking = useLaunching(repo.id)
  const server = <button className="text-indigo-300 underline" onClick={toServer}>Server output</button>
  const fix = <ActBtn label="Ask Claude to fix it" busyLabel="Asking…" run={() => api(`previews/${p.id}/setup`, { why: 'fix' })}
    title="Claude reads the output, works out what changed and suggests new start steps for you to OK" />
  if (helperOn(p) && p.status === 'stopped') return <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-zinc-400">
    {p.helper_note && <div className="text-xs text-amber-300">{p.helper_note}</div>}
    <div>Claude is working out how to start {repo.name}{fromTicket(p)}.</div>
    <div className="text-xs">It looks at the project and tries it in its sandbox. Watch it in the <button className="text-indigo-300 underline" onClick={toClaude}>Claude</button> tab.</div>
  </div>
  if (p.status === 'stopped' && p.helper_state === 'needs_ok' && p.draft_recipe) return <div className="flex h-full flex-col p-2"><OkCard all={all} p={p} repo={repo} /></div>
  return <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-zinc-400">
    {p.status === 'stopped' && (can ? <>
      {!p.port_holders?.length && <ActBtn label={`Start ${repo.name}`} busyLabel="Starting…" primary ask={others} run={start} />}
      <div className="text-xs text-zinc-500">Runs <code className="break-all text-zinc-300">{p.command ?? recipeSummary(p.recipe)}</code> in {p.path}.</div>
      {p.port_holders?.length ? <PortBox all={all} p={p} repo={repo} /> : p.detail && <div className="text-xs text-amber-300">{p.detail}</div>}
    </> : asking ? <div>Getting Claude ready to work out how to start {repo.name}…</div> : repo.empty ? <NoFiles repo={repo} onRepo={onRepo} /> : <>
      <div>HQ doesn't know how to start {repo.name} yet.</div>
      <ActBtn label="Ask Claude to work it out" busyLabel="Asking…" primary run={() => api(`previews/${p.id}/setup`, {})} />
      <div className="text-xs text-zinc-500">You OK its steps once; HQ runs them every time after. Or set your own command with ⚙.</div>
    </>)}
    {p.status === 'starting' && <div>Starting… {p.detail && p.detail !== 'starting…' ? p.detail : ''}<div className="mt-1 text-xs">Watch it in {server}.</div></div>}
    {p.status === 'crashed' && <><div className="text-rose-300">The app {p.detail ?? 'stopped'}.</div>
      <div className="flex flex-wrap justify-center gap-1.5"><ActBtn label="Restart" busyLabel="Restarting…" primary ask={others} run={start} />{asks(p, repo) && fix}</div>
      <div className="text-xs">What went wrong is in {server}.</div></>}
    {p.status === 'running' && p.frameable === 0 && <div>{repo.name} doesn't allow being shown inside another page.<br /><a className="text-indigo-300 underline" href={p.url} target="_blank" rel="noreferrer">Open it in your browser ↗</a></div>}
  </div>
}

/** The Launch helper's state above the pane: working (watch or stop it), steps waiting for the user's OK, or why it ended. */
function HelperBanner({ all, p, repo, watch, events }: { all: State; p: any; repo: any; watch: () => void; events: (agentId: string) => void }) {
  const box = (tone: string, body: React.ReactNode) => <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1 text-xs ${tone}`}>{body}</div>
  const amber = 'border-amber-600/50 bg-amber-950/40 text-amber-200', rose = 'border-rose-700/50 bg-rose-950/40 text-rose-200'
  const again = (label: string) => <ActBtn label={label} busyLabel="Asking…" run={() => api(`previews/${p.id}/setup`, { why: p.recipe || p.command ? 'fix' : 'first' })} />
  if (p.helper_state === 'needs_ok' && p.draft_recipe) return p.status === 'stopped' ? null : <OkCard all={all} p={p} repo={repo} /> // stopped: it fills the App tab
  if (helperOn(p)) return box(amber, <>
    <span className="min-w-0 grow">{p.helper_state === 'trying'
      ? `Running Claude's steps on ${p.helper_ticket_key ? `${p.helper_ticket_key}'s version` : 'your checkout'}; Claude checks the result.`
      : `Claude is working out how to start ${repo.name}${fromTicket(p)}.`}</span>
    <button className="btn-sm" onClick={watch}>Watch</button>
    <EventsBtn id={p.helper_agent_id} events={events} />
    <ActBtn label="Stop Claude" busyLabel="Stopping…" run={() => api(`previews/${p.id}/dismiss`, {})} /></>)
  const once = asks(p, repo) ? null : again // Bug 299: the App tab's own ask is the one to press
  if (p.helper_state === 'cant_start') return box(rose, <><span className="min-w-0 grow">Claude can't start {repo.name}: {p.helper_note}</span>{once?.('Try again')}</>)
  if (p.helper_state === 'failed') return box(rose, <><span className="min-w-0 grow">{p.helper_note ?? 'Claude couldn\'t work out how to start it.'}</span>{once?.('Ask Claude again')}</>)
  if (p.helper_state === 'port_taken' && p.status === 'stopped') return box(amber, <span className="min-w-0 grow">
    {p.port_holders?.length ? `Claude's steps are saved, but a port they need is busy. Free it below.` : p.helper_note}</span>)
  return null
}

/** Bug 237: helpers have no box on the graph, so their history (Events tab) opens from here. */
const EventsBtn = ({ id, events }: { id: string; events: (agentId: string) => void }) =>
  <button className="btn-sm" title="What Claude did here, step by step, in the panel's Events tab" onClick={() => events(id)}>Events</button>

/** HQ's test setup (Tester & Checker, Part 3): its helper at work, why it ended, or a new setup the user hasn't seen yet (shown once). */
function SetupBanner({ p, repo, events }: { p: any; repo: any; events: (agentId: string) => void }) {
  const t = p.test_setup; if (!t) return null
  const box = (tone: string, body: React.ReactNode) => <div className={`flex flex-col gap-1 rounded-md border px-2 py-1 text-xs ${tone}`}>{body}</div>
  const amber = 'border-amber-600/50 bg-amber-950/40 text-amber-200', rose = 'border-rose-700/50 bg-rose-950/40 text-rose-200', indigo = 'border-indigo-500/60 bg-indigo-950/40 text-zinc-300'
  const row = (body: React.ReactNode) => <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{body}</div>
  const go = (action?: string) => api(`previews/${p.id}/test-setup`, action ? { action } : {})
  if (t.working) return box(amber, row(<><span className="min-w-0 grow">{t.state === 'checking' ? `HQ is trying Claude's test setup for ${repo.name} in its sandbox: seed, start, reset.`
    : `Claude is working out how HQ tests ${repo.name}: a production start, a clean seed, where its data is.`}</span>
    {t.helper_agent_id && <EventsBtn id={t.helper_agent_id} events={events} />}
    <ActBtn label="Stop Claude" busyLabel="Stopping…" run={() => go('dismiss')} /></>))
  if (t.state === 'cant_test' || t.state === 'failed') return box(rose, row(<><span className="min-w-0 grow">{t.state === 'cant_test' ? `HQ can't test ${repo.name}: ${t.note}` : t.note}</span>
    <ActBtn label="Ask Claude again" busyLabel="Asking…" run={() => go()} /><ActBtn label="Dismiss" run={() => go('dismiss')} /></>))
  const who = t.by && /^[A-Z]+-\d+/.test(t.by) ? `${t.by} changed how HQ tests ${repo.name}.` : `Claude worked out how HQ tests ${repo.name}.`
  if (t.setup && !t.seen) return box(indigo, <>{row(<><span className="min-w-0 grow text-zinc-100">{who}
    {t.checked ? (t.checked.ok ? ' HQ tried it: it works.' : ` HQ's check failed: ${t.checked.why?.split('\n')[0]}`) : ' HQ is checking it.'}</span>
    <ActBtn label="Got it" primary run={() => go('dismiss')} /></>)}
    <div className="max-h-48 overflow-auto"><SetupList s={t.setup} /></div></>)
  return null
}

/** A test setup in plain words: how each part runs for tests, the data HQ copies and resets, the seed, and the API endpoints by kind. */
export function SetupList({ s }: { s: any }) {
  const kinds = ['instant', 'normal', 'heavy'].map((k) => [k, s.endpoints.filter((e: any) => e.kind === k)] as const).filter(([, l]) => l.length)
  return <div className="flex flex-col gap-1">
    {s.start.map((x: any) => <div key={x.part} className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1">
      <div className="text-zinc-200"><b>{x.part}</b> for tests (a production build)</div>
      {x.build && <div className="break-all font-mono text-zinc-400">build: {x.build}</div>}
      <div className="break-all font-mono text-zinc-200">run: {x.run}</div>
    </div>)}
    <div className="text-zinc-400">Its data: <code className="break-all">{s.snapshot.join(', ')}</code>. HQ copies it after every step, and puts the seed back for a reset (stop, seed, start).</div>
    <details className="text-zinc-400"><summary className="cursor-pointer">The seed (a clean set of test data, never yours)</summary>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{s.seed}</pre></details>
    {kinds.length > 0 && <details className="text-zinc-400">
      <summary className="cursor-pointer">{s.endpoints.length} API endpoint{s.endpoints.length === 1 ? '' : 's'}: {kinds.map(([k, l]) => `${l.length} ${k}`).join(', ')}</summary>
      {kinds.map(([k, l]) => <div key={k}><span className="text-zinc-300">{k}:</span>{' '}
        <span className="break-all font-mono text-[11px]">{l.map((e: any) => `${e.method} ${e.path}`).join(' · ')}</span></div>)}</details>}
    {s.notes && <div className="italic text-zinc-400">{s.notes}</div>}
  </div>
}

/** A program holds a port the app needs (Bug 42): who it is, and a button that stops it and launches. HQ's own leftovers go on
 *  one click; anything else is named in HQ's dialog first. */
function PortBox({ all, p, repo }: { all: State; p: any; repo: any }) {
  const hs: any[] = p.port_holders, ours = hs.every((h) => h.kind === 'hq')
  // Both questions before anything stops: the port's holder (asked only), then the other apps (stopped on the user's go)
  const sure = async () => (ours || await portConfirm(repo, hs)) && await launchOnly(all, repo)
  const go = () => api(`previews/${p.id}/free-port`, { pids: [...new Set(hs.map((h) => h.pid))] })
  return <div className="flex max-w-full flex-col items-center gap-1.5 rounded-md border border-amber-600/50 bg-amber-950/40 px-2.5 py-2 text-xs text-amber-200">
    <div className="break-words">{p.detail}</div>
    <ActBtn label={ours ? 'Stop it and Launch' : 'Stop it…'} busyLabel="Stopping…" primary ask={sure} run={go}
      title={ours ? 'HQ started it and lost track of it: stop it and start the app' : 'See what it is, then stop it and start the app'} />
  </div>
}

/** Claude's start steps, waiting for the user's OK: they'll run on this Mac outside the sandbox, so a person looks at them once. */
function OkCard({ all, p, repo }: { all: State; p: any; repo: any }) {
  const ok = () => api(`previews/${p.id}/approve`, {})
  return <div className="flex max-h-full min-h-0 flex-col gap-1.5 rounded-md border border-indigo-500/60 bg-indigo-950/40 px-2.5 py-2 text-xs text-zinc-300">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0 grow text-sm text-zinc-100">Claude worked out how to start {repo.name}{fromTicket(p)}. OK these steps?</span>
      <ActBtn label="OK, run these" busyLabel="Starting…" primary ask={() => launchOnly(all, repo)} run={ok} />
      <ActBtn label="Not now" busyLabel="Stopping…" run={() => api(`previews/${p.id}/dismiss`, {})}
        title={p.helper_agent_id ? 'Claude stops; the steps stay here to OK later' : 'Keep them for later'} />
    </div>
    {p.helper_note && <div className="text-amber-300">{p.helper_note}</div>}
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

/** Bug 316: the user's own ⚙ command would write or rewrite the project's lockfile (Claude's steps are refused for that). A warning, not a
 *  refusal: it's their command, and HQ runs it as they wrote it. It stays while the command does, so changing the command is how it goes. */
function CommandWarning({ p }: { p: any }) {
  if (!p.command || !p.command_warning) return null
  return <div className="rounded-md border border-amber-600/50 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">
    <Md text={`Your own start command (⚙) can change the project's files: ${p.command_warning} HQ runs it as you wrote it.`} /></div>
}

/** ⚙: how HQ starts this app: the steps the user OK'd (Claude can work them out again), or their own one-line command, which wins. */
function CommandForm({ all, p, repo, close }: { all: State; p: any; repo: any; close: () => void }) {
  const [text, setText] = useState(p.command ?? '')
  const save = (command: string | null) => api(`previews/${p.id}/command`, { command }).then(close)
  return <form className="flex max-h-[70vh] w-96 max-w-[85vw] flex-col gap-2 overflow-auto text-xs" onSubmit={(e) => e.preventDefault()}>
    <div className="text-zinc-300">How HQ starts this app</div>
    {p.recipe ? <><div className="text-zinc-400">{p.command ? 'Claude\'s steps (your own command below is used instead):' : 'The steps you OK\'d:'}</div><RecipeList r={p.recipe} /></>
      : <div className="text-zinc-400">No start steps yet. Launch asks Claude to work them out.</div>}
    <div className="flex items-center gap-1.5">
      <ActBtn label={p.recipe ? 'Ask Claude to work them out again' : 'Ask Claude to work them out'} busyLabel="Asking…" disabled={helperOn(p)}
        run={() => api(`previews/${p.id}/setup`, { why: p.recipe ? 'fix' : 'first' }).then(close)} />
      {p.helper_state === 'needs_ok' && p.draft_recipe && <ActBtn label="OK Claude's new steps" primary
        ask={() => launchOnly(all, repo)} run={() => api(`previews/${p.id}/approve`, {}).then(close)} />}
    </div>
    <div className="mt-1 border-t border-zinc-800 pt-2 text-zinc-400">
      Or your own command, run in <span className="break-all text-zinc-300">{p.path}</span> with <code>PORT</code> set to a free port; the page that answers is shown.
    </div>
    <input className="input font-mono text-xs!" value={text} placeholder={p.auto_command ? `e.g. ${p.auto_command}` : 'e.g. npm run dev'} onChange={(e) => setText(e.target.value)} />
    {p.command_warning && text.trim() === p.command && <div className="text-amber-300"><Md text={p.command_warning} /></div>}
    <div className="flex items-center gap-1.5"><span className="grow" />
      <ActBtn label={p.recipe ? "Use Claude's steps" : 'Clear'} disabled={!p.command} run={() => save(null)} />
      <ActBtn label="Save" primary disabled={!text.trim() || text.trim() === p.command} run={() => save(text.trim())} /></div>
    <div className="mt-1 border-t border-zinc-800 pt-2 text-zinc-300">How HQ tests this app</div>
    {p.test_setup?.setup ? <><div className="text-zinc-400">{p.test_setup.by ? `Saved by ${p.test_setup.by}` : 'Saved'}{p.test_setup.checked
      ? (p.test_setup.checked.ok ? '; HQ tried it and it works.' : `; HQ's last check failed: ${p.test_setup.checked.why?.split('\n')[0]}`) : '.'}
      {p.test_setup.pending?.length ? ` Changes waiting on ${p.test_setup.pending.join(', ')}.` : ''}
      {p.test_setup.checking?.length ? ` HQ is checking the changes ${p.test_setup.checking.join(', ')} made.` : ''}</div><SetupList s={p.test_setup.setup} /></>
      : <div className="text-zinc-400">No test setup yet. Claude (Opus) works it out once from the code: a production start, a clean seed, where the data lives. HQ runs it
        in its sandbox, with no internet and none of your files, and uses it for every test after.</div>}
    <div className="flex items-center gap-1.5">
      <ActBtn label={p.test_setup?.setup ? 'Ask Claude to work it out again' : 'Set up testing'} busyLabel="Asking…" disabled={!!p.test_setup?.working || (!p.recipe && !p.command)}
        title={!p.recipe && !p.command ? 'Launch the app once first: testing starts it the same way' : undefined} run={() => api(`previews/${p.id}/test-setup`, {}).then(close)} />
    </div>
  </form>
}
