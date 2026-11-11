// The graph's boxes: the project's TPM (always on top, with a box to write to it: Bug 52), one per feature, one per ticket. Each
// carries its own buttons; longer things (the plan, attention items, the conversation with the TPM) open in a popover pinned
// under the box (NodeToolbar: it doesn't scale with zoom).
// Opening one goes through focus(), which first pans the box near the top of the pane so the popover isn't cut off.
import { useState } from 'react'
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react'
import { api } from './api'
import { askLabels, askText, cancelConfirm, mergeConfirm, startLabel, startText, turnOn, waitingOn } from './board'
import { actLabel, answerReview, kindLabel, freshBlocker, freshConfirm, freshOffered, localOnly, OPEN_PREVIEW, stopOthers, ticketLabel, useBoard, useBusy, useRevisionCap,
  type Act, type FeatureView, type Line, type TicketView, type TpmView, type Tone } from './board'
import { goodNews, plainNews, type Turn } from './needs.ts'
import { DoRestBtn } from './Auto'
import type { Agent } from './api'
import { ActBtn, Linked, Md, Pill } from './ui'

const tone: Record<Tone, string> = { plain: 'text-zinc-200', muted: 'text-zinc-400', amber: 'text-amber-300', rose: 'text-rose-300', sky: 'text-sky-300', emerald: 'text-emerald-300', indigo: 'text-indigo-300' }
const POP = 'nodrag nopan nowheel' // popovers: the wheel scrolls them and a drag in them doesn't pan the graph
/** Edge anchors. Every box has top in/out and bottom out/in (messages run both ways); tickets add left in / right out for
 *  dependencies. Always rendered (React Flow measures them once) and invisible; nothing can be connected by hand. */
function Anchors({ sides }: { sides?: boolean }) {
  const h = (type: 'source' | 'target', position: Position, id: string) => <Handle type={type} position={position} id={id} isConnectable={false} className="hq-anchor" />
  return <>{h('target', Position.Top, 't')}{h('source', Position.Top, 'ts')}{h('source', Position.Bottom, 'b')}{h('target', Position.Bottom, 'bt')}{sides && <>{h('target', Position.Left, 'in')}{h('source', Position.Right, 'out')}</>}</>
}
/** A box's lines: each one or two rows, as the layout measured (board.ts fitLines); longer text ends in … with the rest on hover. */
const Lines = ({ lines }: { lines: Line[] }) => <>{lines.map((l, i) =>
  <div key={i} className={`${l.rows === 2 ? 'line-clamp-2 h-8 break-words' : 'h-4 truncate'} ${tone[l.tone]}`} title={l.text}>{l.text}</div>)}</>
const Acts = ({ children }: { children: React.ReactNode }) => <div className="mt-1.5 flex flex-wrap gap-1">{children}</div>
/** "Your turn" (Bug 43, on the TPM box since Bug 52): what the project waits on the user for, with the buttons right there: each
 *  question the TPM asked (a button per choice, Answer… to write a reply of their own) and the tickets ready to start. A choice
 *  answers it even while the TPM is stopped: the answer starts it again. Sized by board.ts turnH. */
function TurnBox({ turn, repoId, answer }: { turn: Turn; repoId: string; answer: () => void }) {
  return <div className="nopan mt-1.5 flex cursor-auto flex-col gap-1 rounded-md border border-amber-500/60 bg-amber-950/40 p-1.5 text-amber-100">
    <div className="text-[10px] font-semibold tracking-wide text-amber-300 uppercase">Your turn</div>
    {turn.asks.map((a) => <div key={a.id} className="contents">
      <div className="break-words">{askText(a)}</div>
      <div className="flex flex-wrap gap-1">{askLabels(a).map((l) => l === 'Answer…'
        ? <button key={l} className="btn-sm" title="Write your own answer in the box below" onClick={answer}>{l}</button>
        : <ActBtn key={l} primary label={l} busyLabel="Sending…" title={`Answer "${l}"`} run={() => api(`asks/${a.id}/answer`, { answer: l })} />)}</div>
    </div>)}
    {turn.start.length > 0 && <>
      <div className="break-words">{startText(turn.start, turn.asks.length > 0)}</div>
      <div className="flex"><ActBtn primary={!turn.asks.length} label={startLabel(turn.start)} busyLabel="Starting…" run={() => api(`repos/${repoId}/start-ready`, {})}
        title="Start an engineer on each ready ticket, up to the parallel limit" /></div></>}
    {!turn.auto && <div className="flex"><DoRestBtn repoId={repoId} /></div>}
  </div>
}
function Card({ id, border, ring = '', className = '', children }: { id: string; border: string; ring?: string; className?: string; children: React.ReactNode }) {
  const b = useBoard()
  return <div className={`hq-card ${ring} ${b.selected === id ? 'outline-2 outline-offset-2 outline-indigo-400/80' : ''} ${className}`} style={{ borderColor: border }}>{children}</div>
}
/** ✕ in a box's header: remove the ticket or cancel the feature, after HQ's dialog says what stops (Bug 50: not the browser's box,
 *  and visible without hovering). The TPM can remove a ticket too (cancel_ticket), after the user's "Remove it". */
function CancelBtn({ tip, title, body, go, path }: { tip: string; title: string; body: string; go: string; path: string }) {
  const [busy, run] = useBusy()
  return <button className="nopan shrink-0 rounded px-1 text-[10px] leading-4 text-zinc-400 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-40" disabled={busy} title={tip}
    aria-label={tip} onClick={() => run(async () => { if (await cancelConfirm(title, body, go)) await api(path, {}) })}>✕</button>
}
/** ⟳ in a box's header: fresh start its running TPM or engineer (it writes a handoff note; a new session takes over). */
export function FreshBtn({ a, label }: { a: Agent | null; label?: string }) {
  const b = useBoard(); const [busy, run] = useBusy()
  if (!a || !freshOffered(a, b.state)) return null
  const why = freshBlocker(a, b.state), name = a.display_name ?? a.id
  const go = () => run(async () => { if (await freshConfirm(b.state, [name])) await api(`agents/${a.id}/fresh-start`, {}) })
  if (label) return <button className="btn-sm nopan" disabled={busy || !!why} title={why ?? `Fresh start ${name}`} onClick={go}>{label}</button>
  return <button className="nopan shrink-0 rounded px-1 text-[10px] leading-4 text-zinc-500 hover:bg-sky-500/20 hover:text-sky-300 disabled:opacity-40" disabled={busy || !!why}
    title={why ?? `Fresh start ${name}: it writes a short handoff note, and a new session takes over with a clean context`} onClick={go}>⟳</button>
}
function AttChip({ id, items }: { id: string; items: any[] }) {
  const b = useBoard(); if (!items.length) return null
  const open = b.pop?.node === id && b.pop.kind === 'attention', ok = items.every((a) => goodNews(a.kind)) // only good news: green, not red
  const look = ok ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30' : 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/30'
  return <button className={`nopan shrink-0 rounded px-1 text-[10px] leading-4 ${look}`}
    title={ok ? 'News: click for details' : 'Needs you: click for details'} onClick={() => open ? b.setPop(null) : b.focus(id, 'attention')}>{ok ? '✓' : '⚠'} {items.length}</button>
}
/** Fix conflicts: HQ checks again, then the ticket's engineer (or a fresh one on the same branch) merges main in. `why` tests: Fix tests,
 *  for one auto mode sent back for its tests whose fix stalled: the same instructions again, with what the tests printed (Bug 84).
 *  `why` change: Build the change, for one whose spec the TPM changed after it was finished and whose engineer stopped before building it. */
export function FixAct({ t, why }: { t: any; why?: 'tests' | 'change' }) {
  if (why === 'change') return <ActBtn primary label="Build the change" busyLabel="Starting…" run={() => api(`tickets/${t.id}/fix-conflicts`, {})}
    title={'Its spec changed after it was finished, and its engineer stopped before building the change. HQ sends the instructions again;'
      + ' if that engineer has stopped, a new one starts on the same branch.'} />
  if (why === 'tests') return <ActBtn primary label="Fix tests" busyLabel="Starting…" run={() => api(`tickets/${t.id}/fix-conflicts`, {})}
    title={"Its tests failed or never finished on main, and its engineer stopped before fixing them. HQ sends it what the tests printed again;"
      + ' if that engineer has stopped, a new one starts on the same branch.'} />
  return <ActBtn primary label="Fix conflicts" busyLabel="Starting…" run={() => api(`tickets/${t.id}/fix-conflicts`, {})}
    title={'HQ checks the branch against main again. If it still conflicts, its engineer merges main in, keeps both sides, runs the tests and commits;'
      + ' if that engineer has stopped, a new one starts on the same branch. You merge it afterwards.'} />
}
/** A run the agent waits on in the background that has done nothing for minutes (Bug 96): HQ stops it and tells the agent what to run instead. */
const StopRunAct = ({ agentId }: { agentId: string }) => <ActBtn primary label="Stop it and tell the engineer" busyLabel="Stopping…"
  run={() => api(`agents/${agentId}/stop-frozen-runs`, {})}
  title="HQ stops the frozen run (the agent is woken when it ends) and tells the agent to run only its own tests, with a time limit: HQ runs the full suite at merge." />
/** Attention items with ✓ (and Show, in the top-bar menu). A merge conflict also gets Fix conflicts, a frozen run Stop it. */
/** A stop or a question that stays until it's answered: ticking it away would hide a project that's still stopped (Bug 63). Resume, Turn off or Use it clear it. */
const answerOnly = (kind: string): boolean => /^(auto_stopped|test_cmd_proposed):/.test(kind)
const FIX_KINDS = new Set(['merge_conflict', 'fix_stalled', 'change_stalled']) // notices with the ticket's fix button
export function AttentionList({ items, show }: { items: any[]; show?: (a: any) => (() => void) | null }) {
  return <div className="flex flex-col gap-1">{items.map((a) => { const go = show?.(a); return <div key={a.id} className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-xs">
    <div className="flex items-start justify-between gap-2"><span className={`min-w-0 break-words font-medium ${goodNews(a.kind) ? 'text-emerald-300' : plainNews(a.kind) ? 'text-sky-300' : 'text-rose-300'}`}>{kindLabel(a.kind)}</span><span className="flex shrink-0 gap-1">
      {FIX_KINDS.has(a.kind) && a.ticket_id && <FixAct t={{ id: a.ticket_id }} why={a.kind === 'fix_stalled' ? 'tests' : a.kind === 'change_stalled' ? 'change' : undefined} />}{a.kind === 'bg_stalled' && a.agent_id && <StopRunAct agentId={a.agent_id} />}{go && <button className="btn-sm" onClick={go}>Show</button>}{!answerOnly(a.kind) && <ActBtn label="✓" title="Done: hide it" run={() => api(`attention/${a.id}/resolve`, {})} />}</span></div>
    <div className="mt-1 break-words text-zinc-400"><Linked text={a.detail} /></div></div> })}</div>
}
/** A box's notices, under it. Only while it has some: a reply can clear the last one, and an empty popover has no chip to close it. */
function AttPop({ open, items }: { open: boolean; items: any[] }) {
  return <NodeToolbar isVisible={open && items.length > 0} position={Position.Bottom} className={POP}>
    <div className="hq-pop w-[380px] max-w-[70vw]"><AttentionList items={items} /></div></NodeToolbar>
}
/** A plan's "In plain words" section (engineers start their plans with one, for the user) and everything else. */
function splitPlan(text: string): { plain: string; rest: string } {
  const m = /^#{1,3}\s*in plain words\s*$/im.exec(text); if (!m) return { plain: '', rest: text }
  const after = text.slice(m.index + m[0].length), next = /^#{1,3}\s/m.exec(after)
  const plain = (next ? after.slice(0, next.index) : after).trim()
  return { plain, rest: (text.slice(0, m.index) + (next ? after.slice(next.index) : '')).trim() }
}
/** The plan under review with Approve / Revise. On a box it closes with × or Esc; in the top-bar menu it has no ×. */
export function ReviewPanel({ r, label, onDone }: { r: any; label: string; onDone?: () => void }) {
  const [msg, setMsg] = useState(''); const [busy, run] = useBusy(); const cap = useRevisionCap(); const b = useBoard()
  const repoId = b.state.features.find((f) => f.id === b.state.tickets.find((t) => t.id === r.ticket_id)?.feature_id)?.repo_id, autoIsOn = !!b.state.repos.find((x) => x.id === repoId)?.auto_mode
  const answer = (verdict: 'approve' | 'revise') => run(() => answerReview(r, verdict, msg).then(() => onDone?.()))
  const capped = (r.revises_used ?? 0) >= cap
  const { plain, rest } = splitPlan(String(r.plan_text ?? ''))
  const reviseTitle = capped ? `Sent back ${r.revises_used} times already: approve it or cancel the ticket`
    : msg.trim() ? 'Send the blocking issues back to the engineer' : 'Write the blocking issues first'
  return <div className="hq-pop w-[520px] max-w-[70vw] border-amber-500/40!">
    <div className="flex items-center gap-2"><span className="min-w-0 grow truncate font-medium text-amber-300" title={label}>{label}</span>{onDone && <button className="btn" title="Close (Esc)" onClick={onDone}>×</button>}</div>
    {plain && <div className="mt-2 whitespace-pre-wrap break-words rounded-md bg-zinc-800/60 p-2 text-[13px] leading-5 text-zinc-100">{plain}</div>}
    <details className="mt-2" open={!plain}><summary className="cursor-pointer text-zinc-400">{plain ? 'Technical details' : 'The plan'}</summary>
      <pre className="mt-1 max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[11px] text-zinc-300">{rest}</pre></details>
    {capped ? <div className="mt-2 text-xs text-rose-300">Sent back {r.revises_used} times already, the limit. Approve it, or cancel the ticket with ✕.</div>
      : <textarea className="input mt-2 h-16 text-xs!" placeholder="What should change? In your own words, e.g. 'keep the old colours' (needed for Revise)" value={msg} onChange={(e) => setMsg(e.target.value)} />}
    <div className="mt-2 flex gap-1"><button className="btn btn-primary" disabled={busy} onClick={() => answer('approve')}>Approve</button>
      <button className="btn" disabled={busy || capped || !msg.trim()} title={reviseTitle} onClick={() => answer('revise')}>Revise</button>
      {repoId && !autoIsOn && <DoRestBtn repoId={repoId} />}</div>
  </div>
}

const drafts = new Map<string, string>() // what the user is writing to each project's TPM, kept while they look at another repo
/** The project's TPM (Bug 52): always on top of the board, even with nothing on it, with a box to write to it. A message to a TPM
 *  that isn't running starts it (or brings it back from its note) with the message; a new project's first one is its description.
 *  ⟳ gives it a fresh session; Chat shows the conversation; Your turn has its questions and what's ready to start. */
export function TpmNode({ id, data }: NodeProps<Node<{ view: TpmView }>>) {
  const b = useBoard(); const v = data.view, repo = v.repo, pop = b.pop?.node === id ? b.pop.kind : null
  const focus = () => (document.getElementById('hq-tpm-input') as HTMLTextAreaElement | null)?.focus()
  return <Card id={id} border={v.border} className="cursor-default!"><Anchors />
    <div className="flex h-4 items-center gap-1"><span className="shrink-0 font-semibold">TPM</span>
      <span className="min-w-0 truncate text-zinc-500" title={repo?.name}>· {repo?.name ?? 'no project'}</span><span className="grow" />
      <AttChip id={id} items={v.att} /><FreshBtn a={v.tpm} /></div>
    <Lines lines={v.lines} />
    {turnOn(v.turn) && repo && <TurnBox turn={v.turn} repoId={repo.id} answer={focus} />}
    <TpmInput key={repo?.id ?? 'none'} v={v} chat={pop === 'talk'} toggleChat={() => pop === 'talk' ? b.setPop(null) : b.focus(id, 'talk')} />
    <AttPop open={pop === 'attention'} items={v.att} />
    <NodeToolbar isVisible={pop === 'talk'} position={Position.Bottom} className={POP}><TalkPanel v={v} onDone={() => b.setPop(null)} /></NodeToolbar>
  </Card>
}

/** The TPM box's message box. Keyed by the project: the same box shows every project's TPM, and each keeps its own draft. */
function TpmInput({ v, chat, toggleChat }: { v: TpmView; chat: boolean; toggleChat: () => void }) {
  const repo = v.repo, [text, setText] = useState(() => drafts.get(repo?.id) ?? ''); const [busy, run] = useBusy()
  const edit = (t: string) => { setText(t); if (repo) drafts.set(repo.id, t) }
  const off = !repo || !!repo.clearing_at
  const send = () => { if (text.trim() && !off) run(() => api(`repos/${repo.id}/message`, { body: text }).then(() => { setText(''); drafts.delete(repo.id) })) }
  return <div className="nodrag nopan nowheel mt-1.5 flex flex-col gap-1">
      <textarea id="hq-tpm-input" className="input h-11 resize-none text-xs!" disabled={off} value={text} onChange={(e) => edit(e.target.value)}
        placeholder={!repo ? 'Add a project first (top bar)' : repo.clearing_at ? `${repo.name} is being cleared` : v.empty ? 'What are you building? Say it in your own words'
          : 'Ask the TPM for something new, or anything else (Enter sends)'}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
      <div className="flex h-[22px] gap-1">
        <button className="btn-sm btn-primary" disabled={off || busy || !text.trim()} onClick={send}
          title={v.live ? 'Send it to the TPM' : 'Starts the TPM with this message'}>{busy ? 'Sending…' : v.live ? 'Send' : 'Send and start'}</button>
        <button className={`btn-sm ${chat ? 'btn-primary' : ''}`} disabled={!repo} onClick={toggleChat}>Chat</button>
        {localOnly(repo) && <span className="min-w-0 truncate self-center text-[10px] text-zinc-500" title="HQ can't push to this repo">local edits only</span>}
      </div>
    </div>
}

/** A feature: one request the TPM is working on, a branch of the board. ✕ cancels its unmerged tickets (the TPM stays). */
export function FeatureNode({ id, data }: NodeProps<Node<{ view: FeatureView }>>) {
  const b = useBoard(); const v = data.view, f = v.f
  const pop = b.pop?.node === id ? b.pop.kind : null
  return <Card id={id} border={v.border}><Anchors />
    <div className="flex h-4 items-center gap-1"><span className={`min-w-0 truncate ${v.done ? 'text-emerald-300' : 'font-semibold'}`} title={`${f.handle ?? ''} ${f.title}`}>
      {v.done ? '✓ ' : ''}{f.title}</span><span className="shrink-0 text-zinc-500">{f.handle}</span><span className="grow" />
      <AttChip id={id} items={v.att} />
      {!v.done && f.status !== 'cancelled' && <CancelBtn tip="Cancel this feature…" title={`Cancel "${f.title}"?`} go="Cancel feature" path={`features/${f.id}/cancel`}
        body={featureCancelText(v, b.state)} />}</div>
    <Lines lines={v.lines} />
    <AttPop open={pop === 'attention'} items={v.att} />
  </Card>
}
/** You and the project's TPM: its replies (taken from the end of each of its turns) and what you sent it, newest last, across its
 *  sessions. Write in the TPM box; its terminal (click the box) has everything else. */
function TalkPanel({ v, onDone }: { v: TpmView; onDone: () => void }) {
  const b = useBoard(); const tpms = new Set(v.tpmIds)
  const talk = b.state.messages.filter((m) => (m.from_id === 'user' && tpms.has(m.to_id)) || (tpms.has(m.from_id) && m.to_id === 'user'))
    .sort((x, y) => x.created_at - y.created_at).slice(-12)
  return <div className="hq-pop flex w-[520px] max-w-[80vw] flex-col gap-2">
    <div className="flex items-center gap-2"><span className="min-w-0 grow truncate font-medium">You and the TPM · {v.repo?.name}</span>
      <button className="btn" title="Close (Esc)" onClick={onDone}>×</button></div>
    <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
      {!talk.length && <div className="text-zinc-500">Nothing yet. Write to the TPM in its box; its answers show up here.</div>}
      {talk.map((m) => <div key={m.id} className={`rounded-md p-2 ${m.from_id === 'user' ? 'ml-8 bg-indigo-950/60 text-indigo-100' : 'mr-8 bg-zinc-800/70 text-zinc-200'}`}>
        <div className="mb-0.5 text-[10px] text-zinc-500">{m.from_id === 'user' ? 'You' : 'TPM'} · {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        <Md text={m.body} /></div>)}
    </div>
  </div>
}

/** What removing a ticket does (Bug 50), for HQ's dialog. */
const removeText = (t: any, eng: Agent | null, waiting: string[]): string => `${t.key} · ${t.title}.${eng ? ` Its engineer (${eng.display_name ?? eng.id}) stops.` : ''}`
  + ` It leaves the board for good; its branch is kept.`
  + (waiting.length ? ` ${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'} on it: ask the TPM to rewire ${waiting.length === 1 ? 'it' : 'them'}.` : '')
const featureCancelText = (v: FeatureView, s: any): string => {
  const open = s.tickets.filter((t: any) => t.feature_id === v.f.id && t.status !== 'merged' && t.status !== 'cancelled')
  const engs = open.filter((t: any) => s.agents.some((a: any) => a.id === t.assignee_agent_id && a.status !== 'exited')).length
  return `${open.length ? `Its ${open.length} unmerged ticket${open.length === 1 ? ' is' : 's are'} cancelled${engs ? ` and ${engs} engineer${engs === 1 ? '' : 's'} stop` : ''}. ` : ''}`
    + "Merged work stays, and the project's TPM keeps going."
}
export function TicketNode({ id, data }: NodeProps<Node<{ view: TicketView }>>) {
  const b = useBoard(); const v = data.view, t = v.t
  const pop = b.pop?.node === id ? b.pop.kind : null
  const attPop = <AttPop open={pop === 'attention'} items={v.att} />
  if (v.compact) return <Card id={id} border={v.border}><Anchors sides />
    <div className="flex h-4 items-center gap-1"><span className="min-w-0 truncate text-emerald-300" title={`${t.key}: ${t.title}`}>✓ {t.key}</span><span className="shrink-0 text-zinc-500">· merged</span><span className="grow" />
      {t.pr_url && t.pr_number ? <a className="nopan shrink-0 text-indigo-300 underline" href={t.pr_url} target="_blank" rel="noreferrer">PR #{t.pr_number} ↗</a> : null}<AttChip id={id} items={v.att} /></div>
    {attPop}
  </Card>
  const eng = v.eng ?? b.state.agents.find((a) => a.id === v.review?.agent_id)
  return <Card id={id} border={v.border} ring={v.review ? 'ring-2 ring-amber-400/60' : ''}><Anchors sides />
    <div className="flex h-4 items-center gap-1"><span className="min-w-0 truncate font-semibold" title={t.key}>{t.key}</span><span className="shrink-0 text-zinc-500">{t.size}</span><span className="grow" />
      <AttChip id={id} items={v.att} /><FreshBtn a={v.eng} />
      {t.status !== 'merged' && t.status !== 'cancelled' && <CancelBtn tip={`Remove ${t.key}…`} title={`Remove ${t.key}?`} go="Remove" path={`tickets/${t.id}/cancel`}
        body={removeText(t, v.eng, waitingOn(b.state, t))} />}<Pill s={t.status} label={ticketLabel(t)} className="py-0! text-[10px]! leading-4!" /></div>
    <div className={v.titleRows === 2 ? 'line-clamp-2 h-8' : 'h-4 truncate'} title={t.title}>{t.title}</div>
    <Lines lines={v.lines} />
    {v.acts.length > 0 && <Acts>{v.acts.map((a, i) => <TicketAct key={i} a={a} v={v} id={id} />)}</Acts>}
    <NodeToolbar isVisible={pop === 'review' && !!v.review} position={Position.Bottom} className={POP}>{v.review && <ReviewPanel r={v.review} onDone={() => b.setPop(null)}
      label={`Plan R-${v.review.round} · ${t.key}${eng ? ` · ${eng.display_name ?? eng.id}` : ''}`} />}</NodeToolbar>
    {attPop}
  </Card>
}
function TicketAct({ a, v, id }: { a: Act; v: TicketView; id: string }) {
  const b = useBoard()
  if (a.kind === 'launch') return <ActBtn label={actLabel(a)} busyLabel="Launching…" title="Start an engineer on this ticket now" run={() => api(`tickets/${v.t.id}/launch`, {})} />
  if (a.kind === 'read-plan') { const open = b.pop?.node === id && b.pop.kind === 'review'; return <button className="btn-sm nopan" onClick={() => open ? b.setPop(null) : b.focus(id, 'review')}>{open ? 'Hide plan' : 'Read plan'}</button> }
  if (a.kind === 'resume') return <ActBtn primary={a.parked} label="Resume" busyLabel="Starting…" run={() => api(`tickets/${v.t.id}/resume`, {})}
    title={a.parked ? 'A new engineer picks up from the handoff note the last one left, on the same branch'
      : 'Its engineer stopped: start a new one on the same branch, briefed with what git shows'} />
  if (a.kind === 'approve') return <ActBtn primary label="Approve" busyLabel="Approving…" title="Approve the plan without opening it" run={() => answerReview(v.review, 'approve')} />
  if (a.kind === 'try') return <TryAct on={a.on} t={v.t} />
  if (a.kind === 'do-rest') return <DoRestBtn repoId={b.repo?.id} />
  if (a.kind === 'auto-retry') return <ActBtn primary label="Try again" busyLabel="Trying…" title="Auto mode gives this ticket another go" run={() => api(`tickets/${v.t.id}/auto-retry`, {})} />
  return <MergeAct a={a} t={v.t} />
}
/** Try it (Bug 22): the preview runs this ticket's version, with a copy of your data, so you can look before merging; Back to main
 *  returns to main. Merging the ticket goes back to main by itself. */
function TryAct({ on, t }: { on: boolean; t: any }) {
  const b = useBoard(), repoId = b.state.features.find((f) => f.id === t.feature_id)?.repo_id
  if (!repoId) return null
  if (on) return <ActBtn label="Back to main" busyLabel="Switching…" title="Show main in the preview again" run={() => api(`previews/${repoId}/start`, { ticket: null })} />
  const go = async () => {
    if (!(await stopOthers(b.state, repoId, { title: `Try ${t.key}?`, go: 'Try it' }))) return
    window.dispatchEvent(new Event(OPEN_PREVIEW)); await api(`previews/${repoId}/start`, { ticket: t.id })
  }
  return <ActBtn label="Try it" busyLabel="Starting…" run={go}
    title={`Run ${t.key}'s version in the preview before you merge it. It uses a copy of your data, so nothing you do while trying changes main.`} />
}
/** Merge into main after an are-you-sure (local repos: HQ merges; GitHub: HQ opens and merges the PR, Bug 45; either refuses and says
 *  why), Make PR, the PR link, or Fix conflicts. On the box and in the ⚠ menu. */
export function MergeAct({ a, t }: { a: Act; t: any }) {
  const { state } = useBoard()
  if (a.kind === 'fix') return <FixAct t={t} why={a.why} />
  if (a.kind === 'merge') {
    const go = async () => { if (await mergeConfirm(t, a, state.defaults.github_account ?? 'the HQ account')) await api(`tickets/${t.id}/merge`, {}) }
    return <ActBtn primary label={`Merge into ${a.into}`} busyLabel="Merging…" run={go} title={a.github
      ? `HQ ${a.pr ? `merges PR #${a.pr}` : 'opens a PR and merges it'} on GitHub. If GitHub won't, or ${t.key} conflicts with ${a.into}, nothing changes and HQ tells you why.`
      : `HQ merges ${t.branch} into ${a.into} in your checkout. If that isn't safe it changes nothing and tells you why.`} />
  }
  if (a.kind === 'make-pr') {
    return <ActBtn label="Make PR" busyLabel="Opening…" title="Open a pull request on GitHub to look at first; nothing is merged" run={() => api(`tickets/${t.id}/make-pr`, {})} />
  }
  if (a.kind === 'link') return <a className={`btn-sm nopan ${a.primary ? 'btn-primary' : ''}`} href={a.href} target="_blank" rel="noreferrer">{a.label}</a>
  return null
}
