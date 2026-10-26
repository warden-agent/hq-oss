// The graph's model: which boxes exist, what each one shows, where it sits, and which box an attention item belongs to.
// Pure apart from measuring title widths. App builds it once per state change; the graph and the top bar both read it.
import { createContext, useContext, useRef, useState } from 'react'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import { api, errText, jsonList, showError, unmergedDeps, waitingFor, type Agent, type State } from './api'

export type Tone = 'plain' | 'muted' | 'amber' | 'rose' | 'sky' | 'emerald' | 'indigo'
export type Line = { text: string; tone: Tone }
export type Act = { kind: 'launch'; waits: string[] } | { kind: 'read-plan' } | { kind: 'approve' } | { kind: 'merge'; into: string } | { kind: 'link'; label: string; href: string; primary: boolean }
export type FeatureView = { f: any; tpm: Agent | null; repoName: string; lines: Line[]; att: any[]; ready: number; total: number; collapsed: boolean; startReady: boolean; startTpm: boolean; border: string }
export type TicketView = { t: any; eng: Agent | null; review: any | null; titleRows: 1 | 2; lines: Line[]; acts: Act[]; att: any[]; compact: boolean; border: string }
export type Board = { nodes: Node[]; edges: Edge[]; has: (node: string) => boolean; attNode: (a: any) => string | null; agentNode: (agentId: string) => string | null }
export type PopKind = 'review' | 'attention' | 'new-feature'
export type Pop = { node: string; kind: PopKind } | null
/** What the boxes need from App: the state, the repo for "New feature", the open popover (one at a time) and the actions. */
export type Ctx = { state: State; repo: any | null; pop: Pop; setPop: (p: Pop) => void; focus: (node: string, kind?: PopKind) => void; selected: string | null }
export const BoardCtx = createContext<Ctx | null>(null)
export function useBoard(): Ctx { const c = useContext(BoardCtx); if (!c) throw new Error('useBoard outside BoardCtx'); return c }
/** How many times a plan can be sent back before HQ escalates the ticket (setting `revision_cap`). */
export function useRevisionCap(): number { const { state } = useBoard(); return Number(state.settings.revision_cap ?? state.defaults.revision_cap ?? 2) }

/** One job at a time per control: a second click while the first is in flight is ignored (a double-click used to start two engineers). */
export function useBusy(): [boolean, (job: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false); const live = useRef(false)
  const run = (job: () => Promise<unknown>) => { if (live.current) return; live.current = true; setBusy(true); job().catch((e) => showError(errText(e))).finally(() => { live.current = false; setBusy(false) }) }
  return [busy, run]
}
/** Answer a plan review as the user. A stale review comes back as 200 `{ ok: false }`, which is an error here. */
export async function answerReview(r: any, verdict: 'approve' | 'revise', msg = ''): Promise<void> {
  const body = verdict === 'approve' ? { verdict, by: 'user' } : { verdict, message: `Plan not approved (round ${r.round}). Blocking issues: ${msg} Address them, then call ExitPlanMode again.`, by: 'user' }
  const res = await api<{ ok: boolean; error?: string }>(`reviews/${r.id}/answer`, body)
  if (!res.ok) throw new Error(res.error ?? 'review not open')
}

// Box sizes. Heights are computed from each box's rows, so they must match .hq-card (p-2 + 1px border, 16px rows) and .btn-sm (22px) in index.css.
export const W = { user: 220, feature: 260, ticket: 220 }
const ROW = 16, CHROME = 18, ACTS = 28, COL_GAP = 48, ROW_GAP = 16, GROUP_GAP = 72, TIER_GAP = 56
const USER_H = CHROME + ROW + ACTS
const agentColor: Record<string, string> = { working: '#10b981', idle: '#71717a', plan_review: '#f59e0b', blocked: '#f43f5e', paused: '#f43f5e', launching: '#0ea5e9', exited: '#3f3f46' }
const ticketColor: Record<string, string> = { queued: '#3f3f46', planning: '#0ea5e9', plan_review: '#f59e0b', implementing: '#10b981', awaiting_answer: '#f59e0b', escalated: '#f43f5e', pr_ready: '#6366f1', pr_open: '#6366f1', merged: '#065f46' }

/** How the user merges a finished ticket: HQ's Merge into main button (local repos), or the PR on GitHub. Null when nothing waits. */
export function mergeAct(t: any, base: string): Act | null {
  if (t.status === 'pr_ready' && t.pr_state === 'local') return { kind: 'merge', into: base }
  if (t.status === 'pr_ready' && t.pr_url) return { kind: 'link', label: 'Create PR ↗', href: t.pr_url, primary: true }
  if (t.status === 'pr_open' && t.pr_url && t.pr_number && t.pr_state !== 'closed') return { kind: 'link', label: `Merge PR #${t.pr_number} ↗`, href: t.pr_url, primary: true }
  return null
}
/** A ticket's status in words where the stored one would mislead (a local branch has no PR). */
export const ticketLabel = (t: any): string => t.status === 'pr_ready' && t.pr_state === 'local' ? 'ready to merge' : t.status
const live = (a: Agent | null | undefined): a is Agent => !!a && a.status !== 'exited'
/** The engineer running a ticket right now, if any. */
export const liveEngineer = (t: any, s: State): Agent | null => { const a = s.agents.find((x) => x.id === t.assignee_agent_id); return live(a) ? a : s.agents.find((x) => x.role === 'engineer' && x.ticket_id === t.id && live(x)) ?? null }
const noLinks = (s: string) => String(s).replace(/https?:\/\/\S+/g, '↗')
/** Dependencies of `t` that aren't merged yet (the backend's own rule); `all` is the feature's non-cancelled tickets. */
const unmerged = (t: any, all: any[]) => unmergedDeps(t, all)

let ctx2d: CanvasRenderingContext2D | null = null
const rowsOf = new Map<string, 1 | 2>() // measured once per title: the board is rebuilt on every patch
/** Rows a ticket title needs in its card: 1, or 2 (longer titles are clamped with an ellipsis; the full text is on hover). */
function titleRows(text: string): 1 | 2 {
  const known = rowsOf.get(text); if (known) return known
  if (!ctx2d) { ctx2d = document.createElement('canvas').getContext('2d'); if (!ctx2d) return 2; ctx2d.font = `11px ${getComputedStyle(document.body).fontFamily}` }
  const r = ctx2d.measureText(text).width <= W.ticket - CHROME ? 1 : 2; rowsOf.set(text, r); return r
}
/** Longest dependency path per ticket key, and the keys caught in a dependency loop (their back edge is ignored for depth). */
function depths(deps: Map<string, string[]>): { depth: Map<string, number>; loop: Set<string> } {
  const depth = new Map<string, number>(), loop = new Set<string>(), stack: string[] = []
  const visit = (k: string): number => {
    const known = depth.get(k); if (known !== undefined) return known
    const at = stack.indexOf(k); if (at >= 0) { for (const x of stack.slice(at)) loop.add(x); return -1 }
    stack.push(k); let d = 0
    for (const dep of deps.get(k) ?? []) { const dd = visit(dep); if (dd >= 0) d = Math.max(d, dd + 1) }
    stack.pop(); depth.set(k, d); return d
  }
  for (const k of deps.keys()) visit(k)
  return { depth, loop }
}

/** The user on top; one box per feature (oldest on the left) with its tickets below in dependency columns, left to right. */
export function buildBoard(s: State, now = Date.now()): Board {
  const agentById = new Map(s.agents.map((a) => [a.id, a])), ticketById = new Map(s.tickets.map((t) => [t.id, t]))
  // 1. Which boxes exist. Cancelled features stay only while one of their agents runs; a feature whose tickets all merged collapses.
  const groups = s.features.filter((f) => f.status !== 'cancelled' || s.agents.some((a) => a.feature_id === f.id && live(a)))
    .sort((a, b) => a.created_at - b.created_at) // explicit: the backend sends newest first and patches prepend
    .map((f) => { const all = s.tickets.filter((t) => t.feature_id === f.id && t.status !== 'cancelled'); return { f, all, collapsed: all.length > 0 && all.every((t) => t.status === 'merged') } })
  const ids = new Set<string>(['user'])
  for (const g of groups) { ids.add(`f:${g.f.id}`); if (!g.collapsed) for (const t of g.all) ids.add(`t:${t.id}`) }
  const has = (n: string) => ids.has(n)
  const featureBox = (fid: unknown) => fid && has(`f:${fid}`) ? `f:${fid}` : null
  const ticketBox = (tid: unknown): string | null => !tid ? null : has(`t:${tid}`) ? `t:${tid}` : featureBox(ticketById.get(String(tid))?.feature_id)
  const agentNode = (aid: string): string | null => { if (aid === 'user') return 'user'; const a = agentById.get(aid); return a ? ticketBox(a.ticket_id) ?? featureBox(a.feature_id) : null }
  // 2. Attention lands on the ticket's box, else the box of the agent's ticket, else the feature box; the rest only in the ⚠ menu.
  const attNode = (x: any): string | null => ticketBox(x.ticket_id) ?? (x.agent_id ? agentNode(x.agent_id) : null)
  const attOf = new Map<string, any[]>()
  for (const x of [...s.attention].sort((a, b) => b.created_at - a.created_at)) { const n = attNode(x); if (n) attOf.set(n, [...(attOf.get(n) ?? []), x]) }
  const note = (att: any[], a: Agent | null): Line | null => {
    if (att.length) return { text: `⚠ ${att[0].kind}: ${noLinks(att[0].detail)}`, tone: 'rose' }
    const w = live(a) ? waitingFor(a, s, now) : null
    if (w) return { text: `✉ ${w.count} waiting · ${w.why}`, tone: w.held ? 'amber' : 'muted' }
    return live(a) && a.activity ? { text: String(a.activity), tone: 'muted' } : null
  }
  const featureView = (g: (typeof groups)[number]): FeatureView => {
    const f = g.f, tpm = agentById.get(f.tpm_agent_id) ?? null, att = attOf.get(`f:${f.id}`) ?? []
    const lines: Line[] = [{ text: !tpm ? 'no TPM' : !live(tpm) ? 'TPM exited' : `TPM · ${tpm.model_live ?? tpm.model_alias} · ${tpm.status}`, tone: 'muted' }]
    if (g.collapsed) lines.push({ text: `✓ all ${g.all.length} merged`, tone: 'emerald' })
    else if (!g.all.length) lines.push({ text: 'no tickets yet', tone: 'muted' })
    const n = note(att, tpm); if (n) lines.push(n)
    const ready = g.all.filter((t) => t.status === 'queued' && !t.assignee_agent_id && !unmerged(t, g.all).length).length
    return { f, tpm, repoName: s.repos.find((r) => r.id === f.repo_id)?.name ?? '', lines, att, ready, total: g.all.length, collapsed: g.collapsed,
      startReady: g.all.length > 0 && !g.collapsed, startTpm: f.status !== 'cancelled' && !live(tpm), border: live(tpm) ? agentColor[tpm.status] ?? '#3f3f46' : '#3f3f46' }
  }
  const ticketView = (t: any, all: any[], base: string, loop: boolean): TicketView => {
    const eng = liveEngineer(t, s), att = attOf.get(`t:${t.id}`) ?? []
    const review = s.reviews.find((r) => r.ticket_id === t.id && r.status === 'open') ?? null // a newer plan closes the older round
    const waits = t.status === 'queued' ? unmerged(t, all) : [], dead = waits.filter((k) => !all.some((x) => x.key === k))
    const detail: Line | null = review ? { text: `Plan R-${review.round} waiting for you`, tone: 'amber' }
      : t.pr_state === 'closed' ? { text: `PR #${t.pr_number} was closed without merging`, tone: 'rose' }
      : t.status === 'pr_ready' && t.pr_state === 'local' ? { text: 'done · waiting for you to merge it', tone: 'indigo' }
      : t.status === 'pr_ready' ? { text: "HQ couldn't open the PR: open it yourself", tone: 'indigo' }
      : t.status === 'pr_open' ? { text: `PR #${t.pr_number} is open: merge it on GitHub`, tone: 'indigo' }
      : eng ? { text: `${eng.model_live ?? eng.model_alias} · ${eng.status}${eng.in_plan_mode ? ' · plan' : ''}${eng.steps_total ? ` · step ${eng.steps_done}/${eng.steps_total}` : ''}`, tone: 'muted' }
      : t.status === 'queued' ? (loop ? { text: "dependency loop, can't start", tone: 'rose' }
        : dead.length ? { text: `waits on ${dead.join(', ')} (cancelled, can't start)`, tone: 'rose' }
        : waits.length ? { text: `waits on ${waits.join(', ')} (not merged yet)`, tone: 'muted' }
        : t.go_ahead ? { text: 'starts when an engineer slot frees up', tone: 'sky' } : { text: 'ready to start', tone: 'emerald' })
      : t.status === 'merged' ? null : { text: 'no engineer running', tone: 'muted' }
    const lines = [detail, note(att, eng)].filter((l): l is Line => !!l)
    const acts: Act[] = []
    if (t.status === 'queued' && !t.assignee_agent_id) acts.push({ kind: 'launch', waits })
    if (review) acts.push({ kind: 'read-plan' }, { kind: 'approve' })
    const merge = mergeAct(t, base); if (merge) acts.push(merge)
    return { t, eng, review, titleRows: titleRows(t.title), lines, acts, att, compact: t.status === 'merged', border: eng ? agentColor[eng.status] ?? '#3f3f46' : ticketColor[t.status] ?? '#3f3f46' }
  }
  const ticketH = (v: TicketView) => v.compact ? CHROME + ROW : CHROME + ROW + v.titleRows * ROW + v.lines.length * ROW + (v.acts.length ? ACTS : 0)
  const featureH = (v: FeatureView) => CHROME + ROW + v.lines.length * ROW + (v.startReady || v.startTpm ? ACTS : 0)
  // 3. Positions: tiers top to bottom; within a feature, one column per dependency depth, same-depth tickets stacked.
  const fviews = groups.map(featureView)
  const FEATURE_Y = USER_H + TIER_GAP, TICKET_Y = FEATURE_Y + Math.max(0, ...fviews.map(featureH)) + TIER_GAP
  const nodes: Node[] = [], edges: Edge[] = []
  const hier = { stroke: '#3f3f46' } // hierarchy edges are right-angled, so stacked first-column tickets hang off one shared line
  let x = 0
  groups.forEach((g, i) => {
    const fv = fviews[i]!, fid = `f:${g.f.id}`
    const vis = g.collapsed ? [] : g.all, byKey = new Map(vis.map((t) => [t.key, t]))
    const deps = new Map(vis.map((t) => [t.key, jsonList(t.deps).filter((k) => k !== t.key && byKey.has(k))]))
    const { depth, loop } = depths(deps)
    const order = jsonList(g.f.merge_order), rank = (k: string) => { const r = order.indexOf(k); return r < 0 ? Number.MAX_SAFE_INTEGER : r }
    const cols: any[][] = []
    for (const t of [...vis].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key, undefined, { numeric: true }))) (cols[depth.get(t.key) ?? 0] ??= []).push(t)
    const colsW = cols.length ? cols.length * W.ticket + (cols.length - 1) * COL_GAP : 0, groupW = Math.max(W.feature, colsW)
    nodes.push({ id: fid, type: 'feature', position: { x: x + (groupW - W.feature) / 2, y: FEATURE_Y }, data: { view: fv }, style: { width: W.feature, height: featureH(fv) }, className: 'nopan' })
    edges.push({ id: `h-${g.f.id}`, type: 'smoothstep', source: 'user', sourceHandle: 'b', target: fid, targetHandle: 't', style: hier })
    const base = s.repos.find((r) => r.id === g.f.repo_id)?.default_branch ?? 'main'
    cols.forEach((col, d) => {
      let y = TICKET_Y
      for (const t of col) {
        const v = ticketView(t, g.all, base, loop.has(t.key)), h = ticketH(v)
        nodes.push({ id: `t:${t.id}`, type: 'ticket', position: { x: x + (groupW - colsW) / 2 + d * (W.ticket + COL_GAP), y }, data: { view: v }, style: { width: W.ticket, height: h }, className: v.compact ? 'nopan opacity-70' : 'nopan' })
        if (d === 0) edges.push({ id: `r-${t.id}`, type: 'smoothstep', source: fid, sourceHandle: 'b', target: `t:${t.id}`, targetHandle: 'in', style: hier }) // into the left side, so stacked roots don't hide it
        y += h + ROW_GAP
      }
    })
    for (const t of vis) for (const k of deps.get(t.key) ?? []) {
      const dep = byKey.get(k)!, bad = loop.has(t.key) && loop.has(k), c = bad ? '#f43f5e' : '#6366f1'
      edges.push({ id: `d-${dep.id}-${t.id}`, source: `t:${dep.id}`, sourceHandle: 'out', target: `t:${t.id}`, targetHandle: 'in', markerEnd: { type: MarkerType.ArrowClosed, color: c }, style: { stroke: c, strokeDasharray: '4 2' } })
    }
    x += groupW + GROUP_GAP
  })
  nodes.unshift({ id: 'user', type: 'user', position: { x: (Math.max(0, x - GROUP_GAP) - W.user) / 2, y: 0 }, data: {}, style: { width: W.user, height: USER_H }, className: 'nopan' })
  // 4. Messages from the last 2 minutes animate between the boxes of their sender and recipient (upwards ones use the upper anchors).
  const y = new Map(nodes.map((n) => [n.id, n.position.y])), cutoff = now - 120_000
  for (const m of s.messages) {
    if (m.created_at <= cutoff || !m.to_id) continue
    const a = agentNode(m.from_id), b = agentNode(m.to_id); if (!a || !b || a === b) continue
    const up = (y.get(a) ?? 0) > (y.get(b) ?? 0)
    edges.push({ id: `m-${m.id}`, source: a, sourceHandle: up ? 'ts' : 'b', target: b, targetHandle: up ? 'bt' : 't', animated: true, style: { stroke: '#22d3ee' } })
  }
  return { nodes, edges, has, attNode, agentNode }
}
