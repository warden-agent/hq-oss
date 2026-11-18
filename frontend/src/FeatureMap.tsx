// The feature map on screen (backend mapstore.ts, firstmap.ts): a "Map" button in the top bar and the box it opens, which shows the project's map (what is
// on each screen of the app, in a user's words), who changed it last, the changes waiting on unmerged tickets, and, for a project with no map yet, the
// button that has HQ write the first one by clicking through the running app.
import { useEffect, useState } from 'react'
import { api, errText, type MapView, type State } from './api'
import { runnable, useBusy } from './board'
import { Backdrop, Elapsed, Md } from './ui'

const CAP = 5000 // featuremap.ts MAP_CAP
const when = (at: number): string => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function MapBtn({ all, repo }: { all: State; repo: any }) {
  const [open, setOpen] = useState(false), m = (all.maps ?? []).find((x) => x.id === repo.id)
  const writing = m?.first?.running
  return <>
    <button className={`btn whitespace-nowrap ${writing ? 'border-sky-500/60! text-sky-300!' : ''}`} onClick={() => setOpen(true)}
      title="The feature map: what is on each screen of the app and what each control does, in a user's words. It's all HQ's tester knows of the app.">
      {writing ? 'Map: writing…' : 'Map'}</button>
    {open && <MapDialog all={all} repo={repo} m={m ?? null} onClose={() => setOpen(false)} />}
  </>
}

function MapDialog({ all, repo, m, onClose }: { all: State; repo: any; m: MapView | null; onClose: () => void }) {
  const [busy, go] = useBusy(), [err, setErr] = useState('')
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) })
  const text = m?.text ?? '', first = m?.first ?? null, running = first?.running === true
  const canStart = runnable((all.previews ?? []).find((p) => p.id === repo.id))
  const start = () => go(async () => { setErr(''); await api(`repos/${repo.id}/first-map`, {}).catch((e: Error) => setErr(errText(e))) })
  return <Backdrop onClose={onClose} z="z-[80]">
    <div role="dialog" aria-modal="true" aria-label={`Feature map of ${repo.name}`}
      className="flex max-h-[90vh] w-[620px] max-w-full flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-300 shadow-xl">
      <div className="break-words text-sm font-medium text-zinc-100">Feature map of {repo.name}</div>
      <div className="break-words text-zinc-400">What is on each screen of the app and what each control does, in a user's words. HQ's tester never sees the code: this is
        its picture of the app. Engineers change it as they finish a ticket, and HQ puts each change in when the ticket merges.</div>
      {text ? <>
        <div className="break-words text-zinc-500">{m?.by ? `Last changed ${when(m.by.at)}: ${m.by.by}. ` : ''}{text.length.toLocaleString()} of {CAP.toLocaleString()} characters.</div>
        <div className="break-words rounded-md border border-zinc-800 bg-zinc-950/50 p-3"><Md text={text} /></div>
      </> : running ? null : <div className="break-words rounded-md border border-zinc-800 p-3">
        <div className="mb-2">No map yet. A new project's map starts with the first ticket that changes a screen. For an app that already exists, HQ can write the first map:
          one session clicks through the running app (in a throwaway copy, with no internet and none of your logins) and writes down what it finds, in a minute or two.</div>
        {first && !first.running && !first.ok && <div role="alert" className="mb-2 break-words rounded-md border border-rose-500/40 bg-rose-950/30 p-2 text-rose-200">
          The last try ({when(first.at)}) didn't work: {first.why}</div>}
        <button className="btn btn-primary" disabled={busy || !canStart} onClick={start}
          title={canStart ? 'Start the app in a throwaway copy and have one session click through it and write the map' : 'HQ doesn\'t know how to start this app yet: press Launch app once first'}>
          {busy ? 'Starting…' : first && !first.running && !first.ok ? 'Try again' : 'Write the first map'}</button>
        {!canStart && <span className="ml-2 text-zinc-500">HQ doesn't know how to start this app yet: press Launch app once first.</span>}
      </div>}
      {running && <div role="status" className="break-words rounded-md border border-sky-500/40 bg-sky-950/30 p-2 text-sky-200">
        HQ is clicking through the app to write its first map (<Elapsed since={first.since} />). The map shows here when it's done.</div>}
      {!!m?.pending.length && <div className="break-words">
        <div className="mb-1 text-zinc-400">Waiting to merge</div>
        <ul className="list-disc pl-5">{m.pending.map((p) => <li key={p.ticket}>{p.key}: {p.unchanged ? 'changes nothing a user sees' : `changes ${p.screens}`}</li>)}</ul>
      </div>}
      {err && <div role="alert" className="break-words rounded-md border border-rose-500/40 bg-rose-950/30 p-2 text-rose-200">{err}</div>}
      <div className="flex justify-end"><button className="btn btn-primary" autoFocus onClick={onClose}>Close</button></div>
    </div>
  </Backdrop>
}
