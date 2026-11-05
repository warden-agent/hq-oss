import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { onAsk, useBusy, type StopAsk } from './board'
import { api, errText, onError } from './api'
import { projectSlug } from '../../backend/src/projectname.ts'

const statusColor: Record<string, string> = { working: 'bg-emerald-500/20 text-emerald-300', idle: 'bg-zinc-700/50 text-zinc-300', plan_review: 'bg-amber-500/20 text-amber-300', blocked: 'bg-rose-500/20 text-rose-300', paused: 'bg-rose-500/20 text-rose-300', launching: 'bg-sky-500/20 text-sky-300', exited: 'bg-zinc-800 text-zinc-500',
  planning: 'bg-sky-500/20 text-sky-300', implementing: 'bg-emerald-500/20 text-emerald-300', awaiting_answer: 'bg-amber-500/20 text-amber-300', pr_ready: 'bg-indigo-500/20 text-indigo-300', pr_open: 'bg-indigo-500/20 text-indigo-300', resolving: 'bg-amber-500/20 text-amber-300', merged: 'bg-emerald-500/30 text-emerald-200' }
export const Pill = ({ s, label, className = '' }: { s: string; label?: string; className?: string }) => <span className={`pill shrink-0 whitespace-nowrap ${statusColor[s] ?? 'bg-zinc-800 text-zinc-300'} ${className}`}>{label ?? s}</span>
/** An agent's message as it means it: **bold** and `code` shown as such, and "## Heading" lines in bold (not raw markdown). */
export function Md({ text }: { text: string }) {
  const inline = (line: string) => line.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((p, i) => p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong>
    : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i} className="rounded bg-zinc-950/60 px-0.5 text-[0.95em]">{p.slice(1, -1)}</code> : p)
  return <div className="whitespace-pre-wrap break-words">{String(text).split('\n').map((l, i) => { const h = /^#{1,4}\s+(.*)$/.exec(l)
    return <div key={i} className={h ? 'font-semibold' : ''}>{h ? inline(h[1]!) : l ? inline(l) : '\u00a0'}</div> })}</div>
}
/** Text with its URLs turned into short links (attention items carry "Create PR" links that are too long to show). */
export const Linked = ({ text }: { text: string }) => <>{String(text).split(/(https?:\/\/\S+)/).map((p, i) => /^https?:\/\//.test(p) ? <a key={i} className="text-indigo-300 underline" href={p} target="_blank" rel="noreferrer">open ↗</a> : p)}</>
/** A small action button: disabled while its request runs, so a double-click sends one request; errors are shown. */
export function ActBtn({ label, busyLabel, run, primary, disabled, title }: { label: string; busyLabel?: string; run: () => Promise<unknown>; primary?: boolean; disabled?: boolean; title?: string }) {
  const [busy, go] = useBusy()
  return <button className={`btn-sm nopan ${primary ? 'btn-primary' : ''}`} disabled={disabled || busy} title={title} onClick={() => go(run)}>{busy ? busyLabel ?? label : label}</button>
}
/** A button with a dropdown under it. Closes on a click elsewhere (pointerdown: the graph swallows mousedown) or Escape. */
export function Menu({ label, title, className = 'btn', align = 'right', children }: { label: React.ReactNode; title?: string; className?: string; align?: 'left' | 'right'; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null), pop = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { // keep the menu inside the window: a button near the edge (a wrapped header) would push it off screen
    const el = pop.current; if (!open || !el) return
    el.style.transform = ''; const r = el.getBoundingClientRect()
    const dx = r.right > innerWidth - 8 ? innerWidth - 8 - r.right : r.left < 8 ? 8 - r.left : 0; if (dx) el.style.transform = `translateX(${dx}px)`
  }, [open])
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key) }
  }, [open])
  return <div ref={ref} className="relative">
    <button className={className} title={title} aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
    {open && <div ref={pop} className={`absolute top-full z-50 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}>{children(() => setOpen(false))}</div>}
  </div>
}
/** Errors from actions (showError), newest last, each with ×; at most three at a time. Replaces alert(). */
export function ErrorBar() {
  const [msgs, setMsgs] = useState<{ id: number; text: string }[]>([]); const n = useRef(0)
  useEffect(() => { onError((text) => setMsgs((m) => [...m.slice(-2), { id: ++n.current, text }])); return () => onError(null) }, [])
  if (!msgs.length) return null
  return <div className="fixed left-1/2 top-10 z-[100] flex w-[640px] max-w-[90vw] -translate-x-1/2 flex-col gap-1" role="alert">{msgs.map((m) =>
    <div key={m.id} className="flex items-start gap-2 rounded-md border border-rose-500/50 bg-rose-950 px-3 py-2 text-xs text-rose-200 shadow-xl">
      <span className="min-w-0 grow whitespace-pre-wrap break-words">{m.text}</span><button className="btn-sm shrink-0" title="Dismiss" onClick={() => setMsgs((x) => x.filter((y) => y.id !== m.id))}>×</button></div>)}</div>
}
/** HQ's dialog (stopOthers, freshConfirm and clearConfirm in board.ts): what a switch or start stops, which agents save a handoff
 *  note and stop (and which stay, and why), or a plain question. Enter confirms, Escape or a click outside cancels; on a `danger`
 *  question (Clear project) Cancel has the focus, so only a click on the red button goes ahead. */
export function StopDialog() {
  const [q, setQ] = useState<(StopAsk & { resolve: (go: boolean) => void }) | null>(null)
  useEffect(() => { onAsk((x) => new Promise((resolve) => setQ({ ...x, resolve }))); return () => onAsk(null) }, [])
  const done = (go: boolean) => { q?.resolve(go); setQ(null) }
  useEffect(() => {
    if (!q) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') done(false) }
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k)
  })
  if (!q) return null
  const list = (xs: string[]) => <ul className="ml-4 list-disc break-words text-zinc-300">{xs.map((x) => <li key={x}>{x}</li>)}</ul>
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => { if (e.target === e.currentTarget) done(false) }}>
    <div role="dialog" aria-modal="true" aria-label={q.title}
      className="flex max-h-[90vh] w-[480px] max-w-full flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-400 shadow-xl">
      <div className="break-words text-sm font-medium text-zinc-100">{q.title}</div>
      {q.body && <div className="text-zinc-300">{q.body}</div>}
      {q.apps.length > 0 && <div className="flex flex-col gap-1"><div>This stops:</div>{list(q.apps)}</div>}
      {q.parks.length > 0 && <div className="flex flex-col gap-1.5 rounded-md border border-sky-500/30 bg-sky-950/30 p-2">
        <div className="text-sky-200">{q.leaving ? `These save a handoff note and stop. They pick up from it when you come back to ${q.leaving}:` : q.danger ? 'These save a handoff note, then stop:' : 'These agents:'}</div>{list(q.parks)}</div>}
      {q.stays.length > 0 && <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/30 bg-amber-950/30 p-2">
        <div className="text-amber-200">{q.staysHead ?? 'These keep running:'}</div>{list(q.stays)}</div>}
      <div className="flex flex-wrap justify-end gap-1.5"><button className="btn" autoFocus={!!q.danger} onClick={() => done(false)}>Cancel</button>
        <button className={`btn ${q.danger ? 'border-rose-500/60! bg-rose-950/40! text-rose-200!' : 'btn-primary'}`} autoFocus={!q.danger} onClick={() => done(true)}>{q.go}</button></div>
    </div>
  </div>
}

/** New project…: a name, where it goes, and GitHub or not. HQ makes the folder and repo itself (backend newproject.ts). */
export function NewProjectDialog({ onClose, onMade }: { onClose: () => void; onMade: (repoId: string) => void }) {
  const [setup, setSetup] = useState<{ parent: string; account: string; githubReady: boolean } | null>(null)
  const [name, setName] = useState(''), [parent, setParent] = useState(''), [github, setGithub] = useState(false)
  const [busy, setBusy] = useState<null | 'pick' | 'make'>(null), [err, setErr] = useState('')
  const [away, setAway] = useState(false)
  // Bug 51: HQ may be restarting as the box opens, so keep asking until it answers
  useEffect(() => {
    let timer = 0, gone = false
    const check = () => api('repos/new-setup', {}).then((x) => {
      if (gone) return
      setAway(false); setSetup(x); setParent((p) => p || x.parent)
    }, (e) => {
      if (gone) return
      if (e instanceof TypeError) { setAway(true); timer = window.setTimeout(check, 1500) } // nothing answered
      else { setAway(false); setErr(errText(e)) } // HQ refused: asking again won't help
    })
    void check()
    return () => { gone = true; clearTimeout(timer) }
  }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && busy !== 'make') onClose() }
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k)
  })
  const slug = projectSlug(name), ok = !!slug && !!parent.trim() && !busy
  const choose = () => {
    if (busy) return; setBusy('pick')
    api('repos/pick-folder', { start: parent }).then((r) => { if (r.path) setParent(r.path) }).catch((e) => setErr(errText(e))).finally(() => setBusy(null))
  }
  const make = () => { if (!ok) return; setErr(''); setBusy('make'); api('repos/new', { name, parent, github }).then((r) => onMade(r.id), (e) => { setErr(errText(e)); setBusy(null) }) }
  const opt = (on: boolean, label: string, off = false) => <label className={`flex items-start gap-2 ${off ? 'text-zinc-600' : 'cursor-pointer text-zinc-200'}`}>
    <input type="radio" name="np-where" className="mt-0.5" checked={github === on} disabled={off || busy === 'make'} onChange={() => setGithub(on)} />
    <span className="min-w-0 break-words">{label}</span></label>
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => { if (e.target === e.currentTarget && busy !== 'make') onClose() }}>
    <form role="dialog" aria-modal="true" aria-label="New project" onSubmit={(e) => { e.preventDefault(); make() }}
      className="flex max-h-[90vh] w-[480px] max-w-full flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-400 shadow-xl">
      <div className="text-sm font-medium text-zinc-100">New project</div>
      <label className="flex flex-col gap-1">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Budget tracker" /></label>
      <div className="flex flex-col gap-1">Where
        <div className="flex gap-1.5"><input className="input min-w-0" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="Folder the project goes in" />
          <button type="button" className="btn shrink-0" onClick={choose} disabled={!!busy}>{busy === 'pick' ? 'Choosing…' : 'Choose…'}</button></div>
        {slug && parent.trim() && <div className="break-all text-zinc-500">Makes {parent.trim().replace(/\/+$/, '')}/{slug}</div>}</div>
      <div className="flex flex-col gap-1.5">Put it on GitHub?
        {opt(false, 'No, just this Mac')}
        {opt(true, `Yes, a private repo on ${setup?.account ?? 'GitHub'}`, !setup?.githubReady)}
        {setup && !setup.githubReady && <div className="text-amber-300/80">HQ isn't logged in to GitHub as {setup.account}, so it can only make local projects.</div>}</div>
      {away && <div role="status" className="text-amber-300/80">Can't reach HQ. It may be restarting. Trying again…</div>}
      {err && <div role="alert" className="break-words rounded-md border border-rose-500/40 bg-rose-950/30 p-2 text-rose-200">{err}</div>}
      <div className="flex flex-wrap justify-end gap-1.5"><button type="button" className="btn" onClick={onClose} disabled={busy === 'make'}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!ok}>{busy === 'make' ? (github ? 'Making it on GitHub…' : 'Making it…') : 'Create'}</button></div>
    </form>
  </div>
}
