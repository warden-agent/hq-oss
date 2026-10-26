// The graph's boxes: one for the user, one per feature, one per ticket. Each carries its own buttons; longer things (the plan,
// attention items, the new-feature form) open in a popover pinned under the box (NodeToolbar: it doesn't scale with zoom).
// Opening one goes through focus(), which first pans the box near the top of the pane so the popover isn't cut off.
import { useState } from 'react'
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react'
import { api } from './api'
import { answerReview, ticketLabel, useBoard, useBusy, useRevisionCap, type Act, type FeatureView, type Line, type TicketView, type Tone } from './board'
import { ActBtn, Linked, Pill } from './ui'

const tone: Record<Tone, string> = { plain: 'text-zinc-200', muted: 'text-zinc-400', amber: 'text-amber-300', rose: 'text-rose-300', sky: 'text-sky-300', emerald: 'text-emerald-300', indigo: 'text-indigo-300' }
const POP = 'nodrag nopan nowheel' // popovers: the wheel scrolls them and a drag in them doesn't pan the graph
/** Edge anchors. Every box has top in/out and bottom out/in (messages run both ways); tickets add left in / right out for
 *  dependencies. Always rendered (React Flow measures them once) and invisible; nothing can be connected by hand. */
function Anchors({ sides }: { sides?: boolean }) {
  const h = (type: 'source' | 'target', position: Position, id: string) => <Handle type={type} position={position} id={id} isConnectable={false} className="hq-anchor" />
  return <>{h('target', Position.Top, 't')}{h('source', Position.Top, 'ts')}{h('source', Position.Bottom, 'b')}{h('target', Position.Bottom, 'bt')}{sides && <>{h('target', Position.Left, 'in')}{h('source', Position.Right, 'out')}</>}</>
}
const Lines = ({ lines }: { lines: Line[] }) => <>{lines.map((l, i) => <div key={i} className={`h-4 truncate ${tone[l.tone]}`} title={l.text}>{l.text}</div>)}</>
function Card({ id, border, ring = '', className = '', children }: { id: string; border: string; ring?: string; className?: string; children: React.ReactNode }) {
  const b = useBoard()
  return <div className={`hq-card ${ring} ${b.selected === id ? 'outline-2 outline-offset-2 outline-indigo-400/80' : ''} ${className}`} style={{ borderColor: border }}>{children}</div>
}
/** ✕ in a box's header: cancel the ticket or feature, after a confirm that says what stops. */
function CancelBtn({ what, confirmText, path }: { what: string; confirmText: string; path: string }) {
  const [busy, run] = useBusy()
  return <button className="nopan shrink-0 rounded px-1 text-[10px] leading-4 text-zinc-500 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-40" disabled={busy} title={`Cancel ${what}…`}
    onClick={() => { if (window.confirm(confirmText)) run(() => api(path, {})) }}>✕</button>
}
function AttChip({ id, n }: { id: string; n: number }) {
  const b = useBoard(); if (!n) return null
  const open = b.pop?.node === id && b.pop.kind === 'attention'
  return <button className="nopan shrink-0 rounded bg-rose-500/20 px-1 text-[10px] leading-4 text-rose-300 hover:bg-rose-500/30" title="Needs you: click for details" onClick={() => open ? b.setPop(null) : b.focus(id, 'attention')}>⚠ {n}</button>
}
/** Attention items with ✓ (and Show, in the top-bar menu). */
export function AttentionList({ items, show }: { items: any[]; show?: (a: any) => (() => void) | null }) {
  return <div className="flex flex-col gap-1">{items.map((a) => { const go = show?.(a); return <div key={a.id} className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-xs">
    <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words font-medium text-rose-300">{a.kind}</span><span className="flex shrink-0 gap-1">{go && <button className="btn-sm" onClick={go}>Show</button>}<ActBtn label="✓" title="Done: hide it" run={() => api(`attention/${a.id}/resolve`, {})} /></span></div>
    <div className="mt-1 break-words text-zinc-400"><Linked text={a.detail} /></div></div> })}</div>
}
/** The plan under review with Approve / Revise. On a box it closes with × or Esc; in the top-bar menu it has no ×. */
export function ReviewPanel({ r, label, onDone }: { r: any; label: string; onDone?: () => void }) {
  const [msg, setMsg] = useState(''); const [busy, run] = useBusy(); const cap = useRevisionCap()
  const answer = (verdict: 'approve' | 'revise') => run(() => answerReview(r, verdict, msg).then(() => onDone?.()))
  const capped = (r.revises_used ?? 0) >= cap
  const reviseTitle = capped ? `Sent back ${r.revises_used} times already: approve it or cancel the ticket`
    : msg.trim() ? 'Send the blocking issues back to the engineer' : 'Write the blocking issues first'
  return <div className="hq-pop w-[520px] max-w-[70vw] border-amber-500/40!">
    <div className="flex items-center gap-2"><span className="min-w-0 grow truncate font-medium text-amber-300" title={label}>{label}</span>{onDone && <button className="btn" title="Close (Esc)" onClick={onDone}>×</button>}</div>
    <pre className="mt-2 max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[11px] text-zinc-300">{r.plan_text}</pre>
    {capped ? <div className="mt-2 text-xs text-rose-300">Sent back {r.revises_used} times already, the limit. Approve it, or cancel the ticket with ✕.</div>
      : <textarea className="input mt-2 h-16 text-xs!" placeholder="Blocking issues for revise…" value={msg} onChange={(e) => setMsg(e.target.value)} />}
    <div className="mt-2 flex gap-1"><button className="btn btn-primary" disabled={busy} onClick={() => answer('approve')}>Approve</button>
      <button className="btn" disabled={busy || capped || !msg.trim()} title={reviseTitle} onClick={() => answer('revise')}>Revise</button></div>
  </div>
}

export function UserNode({ id }: NodeProps) {
  const b = useBoard(); const open = b.pop?.node === id && b.pop.kind === 'new-feature'
  const [draft, setDraft] = useState({ title: '', req: '' }) // kept while the form is closed, so a stray click doesn't lose a long request
  return <Card id={id} border="#3f3f46" className="cursor-default!"><Anchors />
    <div className="h-4 font-semibold">You</div>
    <div className="mt-1.5 flex h-[22px]"><button className="btn-sm btn-primary nopan min-w-0 truncate" disabled={!b.repo} title={b.repo ? `Start a TPM on a new request in ${b.repo.name}` : 'Add a repo first (top bar)'}
      onClick={() => open ? b.setPop(null) : b.focus(id, 'new-feature')}>+ New feature{b.repo ? ` in ${b.repo.name}` : ''}</button></div>
    <NodeToolbar isVisible={open && !!b.repo} position={Position.Bottom} className={POP}>{b.repo && <NewFeatureForm repo={b.repo} draft={draft} setDraft={setDraft} onDone={() => b.setPop(null)} />}</NodeToolbar>
  </Card>
}
function NewFeatureForm({ repo, draft, setDraft, onDone }: { repo: any; draft: { title: string; req: string }; setDraft: (d: { title: string; req: string }) => void; onDone: () => void }) {
  const [busy, run] = useBusy(); const ok = !!draft.title.trim() && !!draft.req.trim()
  const start = () => { if (ok) run(() => api('features', { repoId: repo.id, title: draft.title, request: draft.req }).then(() => { setDraft({ title: '', req: '' }); onDone() })) }
  return <div className="hq-pop w-[440px] max-w-[80vw]">
    <div className="mb-1 text-zinc-400">New feature in <span className="text-zinc-200">{repo.name}</span></div>
    <input className="input" placeholder="Title" autoFocus value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
    <textarea className="input mt-1 h-32" placeholder="Describe the feature (verbatim request)" value={draft.req} onChange={(e) => setDraft({ ...draft, req: e.target.value })} />
    <div className="mt-1 flex gap-1"><button className="btn btn-primary" disabled={!ok || busy} onClick={start}>{busy ? 'Starting…' : 'Start TPM'}</button><button className="btn" onClick={onDone}>Cancel</button></div>
  </div>
}

export function FeatureNode({ id, data }: NodeProps<Node<{ view: FeatureView }>>) {
  const b = useBoard(); const v = data.view, f = v.f
  return <Card id={id} border={v.border}><Anchors />
    <div className="flex h-4 items-center gap-1"><span className="min-w-0 truncate font-semibold" title={f.title}>{f.title}</span><span className="shrink-0 text-zinc-500">· {v.repoName}</span><span className="grow" /><AttChip id={id} n={v.att.length} />
      {f.status !== 'cancelled' && <CancelBtn what="this feature" path={`features/${f.id}/cancel`} confirmText={featureCancelText(v, b.state)} />}</div>
    <Lines lines={v.lines} />
    {(v.startReady || v.startTpm) && <div className="mt-1.5 flex h-[22px] gap-1">
      {v.startReady && <ActBtn primary label={`Start ${v.ready} ready`} busyLabel="Starting…" disabled={!v.ready} run={() => api(`features/${f.id}/start-ready`, {})}
        title="Start every ticket whose dependencies are merged, up to the parallel limit; the rest start as engineers finish" />}
      {v.startTpm && <ActBtn label={v.tpm ? 'Start TPM again' : 'Start TPM'} busyLabel="Starting…" run={() => api(`features/${f.id}/restart-tpm`, {})}
        title="Start a fresh TPM for this feature. It's briefed from HQ's records (the request, tickets, specs, decisions, recent messages), and messages waiting for the old TPM go to it." />}
    </div>}
    <NodeToolbar isVisible={b.pop?.node === id && b.pop.kind === 'attention'} position={Position.Bottom} className={POP}><div className="hq-pop w-[380px] max-w-[70vw]"><AttentionList items={v.att} /></div></NodeToolbar>
  </Card>
}

const featureCancelText = (v: FeatureView, s: any): string => {
  const open = s.tickets.filter((t: any) => t.feature_id === v.f.id && t.status !== 'merged' && t.status !== 'cancelled')
  const engs = open.filter((t: any) => s.agents.some((a: any) => a.id === t.assignee_agent_id && a.status !== 'exited')).length
  return `Cancel "${v.f.title}"? ${open.length ? `Its ${open.length} unmerged ticket${open.length === 1 ? ' is' : 's are'} cancelled${engs ? ` and ${engs} engineer${engs === 1 ? '' : 's'} stop` : ''}, and its` : 'Its'} TPM stops. Merged work stays.`
}
export function TicketNode({ id, data }: NodeProps<Node<{ view: TicketView }>>) {
  const b = useBoard(); const v = data.view, t = v.t
  const pop = b.pop?.node === id ? b.pop.kind : null
  const attPop = <NodeToolbar isVisible={pop === 'attention'} position={Position.Bottom} className={POP}><div className="hq-pop w-[380px] max-w-[70vw]"><AttentionList items={v.att} /></div></NodeToolbar>
  if (v.compact) return <Card id={id} border={v.border}><Anchors sides />
    <div className="flex h-4 items-center gap-1"><span className="min-w-0 truncate text-emerald-300" title={`${t.key}: ${t.title}`}>✓ {t.key}</span><span className="shrink-0 text-zinc-500">· merged</span><span className="grow" />
      {t.pr_url && t.pr_number ? <a className="nopan shrink-0 text-indigo-300 underline" href={t.pr_url} target="_blank" rel="noreferrer">PR #{t.pr_number} ↗</a> : null}<AttChip id={id} n={v.att.length} /></div>
    {attPop}
  </Card>
  const eng = v.eng ?? b.state.agents.find((a) => a.id === v.review?.agent_id)
  return <Card id={id} border={v.border} ring={v.review ? 'ring-2 ring-amber-400/60' : ''}><Anchors sides />
    <div className="flex h-4 items-center gap-1"><span className="min-w-0 truncate font-semibold" title={t.key}>{t.key}</span><span className="shrink-0 text-zinc-500">{t.size}</span><span className="grow" /><AttChip id={id} n={v.att.length} />
      {t.status !== 'merged' && t.status !== 'cancelled' && <CancelBtn what={t.key} path={`tickets/${t.id}/cancel`} confirmText={`Cancel ${t.key} (${t.title})?${v.eng ? ` Its engineer (${v.eng.display_name ?? v.eng.id}) stops.` : ''} It can't be started again; its branch is kept.`} />}<Pill s={t.status} label={ticketLabel(t)} className="py-0! text-[10px]! leading-4!" /></div>
    <div className={v.titleRows === 2 ? 'line-clamp-2 h-8' : 'h-4 truncate'} title={t.title}>{t.title}</div>
    <Lines lines={v.lines} />
    {v.acts.length > 0 && <div className="mt-1.5 flex h-[22px] gap-1">{v.acts.map((a, i) => <TicketAct key={i} a={a} v={v} id={id} />)}</div>}
    <NodeToolbar isVisible={pop === 'review' && !!v.review} position={Position.Bottom} className={POP}>{v.review && <ReviewPanel r={v.review} onDone={() => b.setPop(null)}
      label={`Plan R-${v.review.round} · ${t.key}${eng ? ` · ${eng.display_name ?? eng.id}` : ''}`} />}</NodeToolbar>
    {attPop}
  </Card>
}
function TicketAct({ a, v, id }: { a: Act; v: TicketView; id: string }) {
  const b = useBoard()
  if (a.kind === 'launch') return <ActBtn label="Launch engineer" busyLabel="Launching…" disabled={a.waits.length > 0} title={a.waits.length ? `Waits on ${a.waits.join(', ')}` : 'Start an engineer on this ticket'} run={() => api(`tickets/${v.t.id}/launch`, {})} />
  if (a.kind === 'read-plan') { const open = b.pop?.node === id && b.pop.kind === 'review'; return <button className="btn-sm nopan" onClick={() => open ? b.setPop(null) : b.focus(id, 'review')}>{open ? 'Hide plan' : 'Read plan'}</button> }
  if (a.kind === 'approve') return <ActBtn primary label="Approve" busyLabel="Approving…" title="Approve the plan without opening it" run={() => answerReview(v.review, 'approve')} />
  return <MergeAct a={a} t={v.t} />
}
/** Merge into main (local repos: HQ merges, or refuses and says why) or the PR link (GitHub). On the box and in the ⚠ menu. */
export function MergeAct({ a, t }: { a: Act; t: any }) {
  if (a.kind === 'merge') return <ActBtn primary label={`Merge into ${a.into}`} busyLabel="Merging…" title={`HQ merges ${t.branch} into ${a.into} in your checkout. If that isn't safe it changes nothing and tells you why.`} run={() => api(`tickets/${t.id}/merge`, {})} />
  if (a.kind === 'link') return <a className={`btn-sm nopan ${a.primary ? 'btn-primary' : ''}`} href={a.href} target="_blank" rel="noreferrer">{a.label}</a>
  return null
}
