import { useEffect, useRef, useState } from 'react'
import { useBusy } from './board'
import { onError } from './api'

const statusColor: Record<string, string> = { working: 'bg-emerald-500/20 text-emerald-300', idle: 'bg-zinc-700/50 text-zinc-300', plan_review: 'bg-amber-500/20 text-amber-300', blocked: 'bg-rose-500/20 text-rose-300', paused: 'bg-rose-500/20 text-rose-300', launching: 'bg-sky-500/20 text-sky-300', exited: 'bg-zinc-800 text-zinc-500',
  planning: 'bg-sky-500/20 text-sky-300', implementing: 'bg-emerald-500/20 text-emerald-300', awaiting_answer: 'bg-amber-500/20 text-amber-300', pr_ready: 'bg-indigo-500/20 text-indigo-300', pr_open: 'bg-indigo-500/20 text-indigo-300', merged: 'bg-emerald-500/30 text-emerald-200' }
export const Pill = ({ s, label, className = '' }: { s: string; label?: string; className?: string }) => <span className={`pill shrink-0 whitespace-nowrap ${statusColor[s] ?? 'bg-zinc-800 text-zinc-300'} ${className}`}>{label ?? s}</span>
/** Text with its URLs turned into short links (attention items carry "Create PR" links that are too long to show). */
export const Linked = ({ text }: { text: string }) => <>{String(text).split(/(https?:\/\/\S+)/).map((p, i) => /^https?:\/\//.test(p) ? <a key={i} className="text-indigo-300 underline" href={p} target="_blank" rel="noreferrer">open ↗</a> : p)}</>
/** A small action button: disabled while its request runs, so a double-click sends one request; errors are shown. */
export function ActBtn({ label, busyLabel, run, primary, disabled, title }: { label: string; busyLabel?: string; run: () => Promise<unknown>; primary?: boolean; disabled?: boolean; title?: string }) {
  const [busy, go] = useBusy()
  return <button className={`btn-sm nopan ${primary ? 'btn-primary' : ''}`} disabled={disabled || busy} title={title} onClick={() => go(run)}>{busy ? busyLabel ?? label : label}</button>
}
/** A button with a dropdown under it. Closes on a click elsewhere (pointerdown: the graph swallows mousedown) or Escape. */
export function Menu({ label, title, className = 'btn', align = 'right', children }: { label: React.ReactNode; title?: string; className?: string; align?: 'left' | 'right'; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key) }
  }, [open])
  return <div ref={ref} className="relative">
    <button className={className} title={title} aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
    {open && <div className={`absolute top-full z-50 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}>{children(() => setOpen(false))}</div>}
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
