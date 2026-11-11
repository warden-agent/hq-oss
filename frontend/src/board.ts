// The graph's model: which boxes exist, what each one shows, where it sits, and which box an attention item belongs to.
// Pure apart from measuring title widths. App builds it once per state change; the graph and the top bar both read it.
import { createContext, useContext, useRef, useState } from 'react'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import { api, errText, jsonList, keepNewest, showError, unmergedDeps, waitingFor, type Agent, type State } from './api'
import { goodNews, keysText, yourTurn, type Ask, type Turn } from './needs.ts'

export type Tone = 'plain' | 'muted' | 'amber' | 'rose' | 'sky' | 'emerald' | 'indigo'
export type Line = { text: string; tone: Tone; rows?: 1 | 2 } // rows: set by the layout (a long line wraps to two)
export type Act = { kind: 'launch'; waits: string[] } | { kind: 'read-plan' } | { kind: 'approve' } | { kind: 'merge'; into: string; github?: boolean; pr?: number } | { kind: 'make-pr' }
  | { kind: 'link'; label: string; href: string; primary: boolean } | { kind: 'resume'; parked: boolean }
  | { kind: 'fix'; why?: 'tests' | 'change' } // why: its tests' fix stalled (Bug 84), or the change to its spec did; none: its conflicts
  | { kind: 'try'; on: boolean } // on: the preview is running this ticket now
  | { kind: 'do-rest' } | { kind: 'auto-retry' } // auto mode: from this stop on, and another go for a parked ticket
/** A feature: one request of the project's TPM, a branch of the board (Bug 52: it has no TPM of its own). */
export type FeatureView = { f: any; lines: Line[]; att: any[]; total: number; collapsed: boolean; done: boolean; border: string }
/** The project's TPM box (Bug 52), always top-centre: where the user talks to the TPM, with its questions and what's ready to start. */
export type TpmView = { repo: any; tpm: Agent | null; live: boolean; lines: Line[]; att: any[]; turn: Turn; border: string; empty: boolean; tpmIds: string[] }
export type TicketView = { t: any; eng: Agent | null; review: any | null; titleRows: 1 | 2; actRows: number; lines: Line[]; acts: Act[]; att: any[]; compact: boolean; border: string }
export type Board = { nodes: Node[]; edges: Edge[]; active: string[]; has: (node: string) => boolean; attNode: (a: any) => string | null; agentNode: (agentId: string) => string | null }
export type PopKind = 'review' | 'attention' | 'talk'
export type Pop = { node: string; kind: PopKind } | null
/** What the boxes need from App: the state, the picked repo (its TPM box), the open popover (one at a time) and the actions. */
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
  // The engineer gets the change in a sentence it can't miss; the TPM gets the user's own words (note), so it knows what they asked
  const body = verdict === 'approve' ? { verdict, by: 'user' } : { verdict, note: msg, by: 'user',
    message: `Plan not approved (round ${r.round}). Blocking issues: ${msg} Address them, update the "In plain words" summary so it says what changed, then call ExitPlanMode again.` }
  const res = await api<{ ok: boolean; error?: string }>(`reviews/${r.id}/answer`, body)
  if (!res.ok) throw new Error(res.error ?? 'review not open')
}

// Box sizes. Heights are computed from each box's rows, so they must match .hq-card (p-2 + 1px border, 16px rows) and .btn-sm (22px) in index.css.
// Widths start at W and grow to fit their header and buttons, up to MAX; past that a long line wraps to two rows and buttons wrap.
export const W = { tpm: 340, feature: 240, ticket: 220 }
const MAX = { tpm: 440, feature: 380, ticket: 320 }
const ROW = 16, CHROME = 18, COL_GAP = 48, ROW_GAP = 16, GROUP_GAP = 72, TIER_GAP = 56, BTN = 14, GAP = 4
const actsH = (rows: number) => rows ? 6 + rows * 22 + (rows - 1) * GAP : 0 // mt-1.5 + rows of .btn-sm + gap-1
const INPUT_H = 6 + 44 + GAP + 22 // the TPM box's message box (mt-1.5, h-11) and its buttons (Nodes.tsx TpmNode)
const agentColor: Record<string, string> = { working: '#10b981', idle: '#71717a', plan_review: '#f59e0b', blocked: '#f43f5e', paused: '#f43f5e', launching: '#0ea5e9', exited: '#3f3f46' }
const ticketColor: Record<string, string> = { queued: '#3f3f46', planning: '#0ea5e9', plan_review: '#f59e0b', implementing: '#10b981', awaiting_answer: '#f59e0b', escalated: '#f43f5e', pr_ready: '#6366f1', pr_open: '#6366f1',
  resolving: '#f59e0b', merged: '#065f46' }

export { forRepo } from './needs.ts'

/** A GitHub repo HQ can't push to (an open-source one, say): its work stays local and finished tickets get Merge into main. */
export const localOnly = (repo: any): boolean => repo?.kind === 'github' && repo.can_push === 0

/** A finished ticket the preview can run before the merge: waiting for it, nothing to fix, its worktree still there (the
 *  backend's trydata.ts tryable, which also checks the folder exists). */
export const tryable = (t: any): boolean => (t.status === 'pr_ready' || t.status === 'pr_open') && t.conflict_files == null && !!t.worktree_path
/** Asks App to show the preview pane (a box's Try it opens it). */
export const OPEN_PREVIEW = 'hq-open-preview'
/** Shows a project's latest auto run summary. Everything opens it this way: one dialog (AutoBanner's), one rule for its alert. */
export const OPEN_SUMMARY = 'hq-open-summary'
export const openSummary = (repoId: string): void => { window.dispatchEvent(new CustomEvent(OPEN_SUMMARY, { detail: repoId })) }
/** A repo's preview app is on (or coming up). */
export const isOn = (p: any) => p?.status === 'starting' || p?.status === 'running'
/** What HQ can run for this repo: the user's own ⚙ command or the start steps they OK'd. */
export const runnable = (p: any): boolean => !!(p?.command || p?.recipe)
/** The Launch helper (Claude working out how to start the app) is on it. */
export const helperOn = (p: any): boolean => !!p?.helper_agent_id && (p.helper_state === 'working' || p.helper_state === 'trying')
/** One line for a recipe: what runs. */
export const recipeSummary = (r: any): string => r.parts.map((x: any) => r.parts.length > 1 ? `${x.name}: ${x.run}` : x.run).join(' · ')
/** What HQ's dialog asks: `title` ("Switch to demo?"), `go` (its button), the apps that stop, the agents that save a handoff
 *  note and stop (`parks`), the ones that stay (`stays`, with why), and for a plain confirm, `body`. `danger`: a red button that
 *  Enter doesn't press (Clear project); `staysHead` replaces "These keep running:". */
export type StopAsk = { title: string; go: string; apps: string[]; parks: string[]; stays: string[]; leaving: string | null; body?: string; danger?: boolean; staysHead?: string }
let asker: ((q: StopAsk) => Promise<boolean>) | null = null
export const onAsk = (fn: typeof asker): void => { asker = fn }
const ask = (q: StopAsk): Promise<boolean> => asker ? asker(q) : Promise.resolve(window.confirm([q.title, q.body, ...q.apps, ...q.parks].filter(Boolean).join('\n')))
/** The repo an agent works in (older rows have only a feature). */
export const repoOfAgent = (s: State, a: Agent): string | null => a.repo_id ?? s.features.find((f) => f.id === a.feature_id)?.repo_id ?? null
const about = (all: State, a: Agent) => a.role === 'tpm' ? `TPM · ${all.repos.find((r) => r.id === repoOfAgent(all, a))?.name ?? 'project'}`
  : `${a.role === 'engineer' ? 'Engineer' : a.role} · ${all.tickets.find((t) => t.id === a.ticket_id)?.key ?? a.display_name ?? a.id}`

/** Only the picked repo's app runs, and only its agents. Before switching to or starting `keepId`, every other repo's app that
 *  is on is stopped, after HQ's dialog. `leaving`: the repo being switched away from; its TPMs and engineers each save a handoff
 *  note and stop (parked), and pick up from it when the user comes back. False when the user cancels. */
export async function stopOthers(all: State, keepId: string, doing: { title: string; go: string }, leaving: string | null = null): Promise<boolean> {
  const name = (id: string) => all.repos.find((r) => r.id === id)?.name ?? id
  const apps = all.previews.filter((p) => p.id !== keepId && isOn(p))
  const stays = !!all.repos.find((r) => r.id === leaving)?.auto_mode // a project on auto keeps running while the user looks elsewhere
  const agents = all.agents.filter((a) => live(a) && (a.role === 'tpm' || a.role === 'engineer') && !!leaving && !stays && leaving !== keepId && repoOfAgent(all, a) === leaving)
  if (!apps.length && !agents.length) return true
  const parks = agents.filter((a) => !freshBlocker(a, all)), left = agents.filter((a) => freshBlocker(a, all))
  const go = await ask({ ...doing, leaving: leaving && name(leaving), parks: parks.map((a) => about(all, a)), stays: left.map((a) => `${about(all, a)}: ${freshBlocker(a, all)}`),
    apps: apps.map((p) => `${name(p.id)}'s app${p.port ? ` (on :${p.url ? new URL(p.url).port : p.port})` : ''}`) })
  if (!go) return false
  for (const p of apps) api(`previews/${p.id}/stop`, {}).catch((e) => showError(`Couldn't stop ${name(p.id)}'s app: ${errText(e)}`))
  if (parks.length && leaving) api(`repos/${leaving}/park`, {}).catch((e) => showError(`Couldn't park ${name(leaving)}'s agents: ${errText(e)}`))
  return true
}
/** HQ's confirm before stopping a program on a port the app needs (Bug 42), when HQ didn't start it: whose it is, and each
 *  process with its folder. HQ's own leftovers (`hq`) are stopped without asking. */
export function portConfirm(repo: any, holders: any[]): Promise<boolean> {
  const h = holders.find((x) => x.kind !== 'hq') ?? holders[0]
  const whose = h.kind === 'repo' ? `It belongs to ${h.name}, another project.` : h.kind === 'project' ? `It runs from inside ${repo.name}, but HQ didn't start it (your own server, maybe).`
    : "HQ didn't start it."
  return ask({ title: `Stop ${h.cmd} on port ${h.port}?`, go: 'Stop it and Launch', danger: true, leaving: null, parks: [], stays: [],
    body: `${whose} Whatever started it (a watcher, npm run, uv run) stops with it. Then HQ launches ${repo.name}.`,
    apps: holders.map((x) => `${x.cmd} (pid ${x.pid}) in ${x.cwd ?? 'an unknown folder'}, on port ${x.port}`) })
}
/** The are-you-sure before undoing an auto mode run. */
export const undoConfirm = (name: string): Promise<boolean> => ask({ title: `Undo this run in ${name}?`, go: 'Undo this run', danger: true, leaving: null, apps: [], parks: [], stays: [],
  body: "One new commit puts main back where the run started, so nothing is rewritten. The work stays on its branches. Any change the run made to your app's saved data isn't undone." })
/** The are-you-sure before a merge (Bug 45): on GitHub HQ opens a PR if there's none and merges it at once, as its own account. */
export function mergeConfirm(t: any, a: { into: string; github?: boolean; pr?: number }, account: string): Promise<boolean> {
  const how = a.github ? `HQ ${a.pr ? `merges PR #${a.pr}` : 'opens a pull request for it and merges it'} on GitHub right away, as ${account}.`
    : `HQ merges ${t.branch} into ${a.into} in your checkout.`
  return ask({ title: `Merge ${t.key} into ${a.into}?`, go: 'Merge', danger: true, leaving: null, apps: [], parks: [], stays: [],
    body: `${t.key} · ${t.title}. ${how} ${a.into} gets its changes for good; HQ can't undo a merge. Tried it? Try it on the box runs this version first.` })
}
/** HQ's are-you-sure before removing a ticket or cancelling a feature (Bug 50), in place of the browser's own box. */
export function cancelConfirm(title: string, body: string, go: string): Promise<boolean> {
  return ask({ title, go, danger: true, leaving: null, apps: [], parks: [], stays: [], body })
}
/** Open tickets that wait on `t` (Bug 50): they can't start once it's removed, until the TPM rewires them. */
export const waitingOn = (s: State, t: any): string[] => s.tickets.filter((x) => x.feature_id === t.feature_id && x.status !== 'merged' && x.status !== 'cancelled'
  && jsonList(x.deps).includes(t.key)).map((x) => x.key)
/** HQ's confirm before Remove from HQ (Bug 66): what stops, what HQ forgets, and that the folder isn't touched. */
export function removeConfirm(all: State, repo: any): Promise<boolean> {
  const fids = new Set(all.features.filter((f) => f.repo_id === repo.id).map((f) => f.id))
  const nf = fids.size, nt = all.tickets.filter((t) => fids.has(t.feature_id)).length, p = all.previews.find((x) => x.id === repo.id)
  const agents = all.agents.filter((a) => live(a) && a.role !== 'launcher' && repoOfAgent(all, a) === repo.id)
  return ask({ title: `Remove ${repo.name} from HQ?`, go: 'Remove from HQ', danger: true, leaving: null, staysHead: 'These stop straight away, with no handoff note:',
    body: `HQ forgets ${repo.name}: ${nf} feature${nf === 1 ? '' : 's'}, ${nt} ticket${nt === 1 ? '' : 's'}, their messages and notices${repo.auto_mode ? ', and its auto mode' : ''}. `
      + `Its folder isn't touched: worktrees, branches and uncommitted work stay where they are, but HQ won't know about them any more. GitHub is left alone. `
      + `HQ's notes go to ~/.hq/archive/${repo.name}/. You can add the folder again later, as a new project.`,
    apps: [...(isOn(p) ? [`${repo.name}'s app`] : []), ...(helperOn(p) ? ["the Launch helper"] : [])], parks: [], stays: agents.map((a) => about(all, a)) })
}
/** HQ's confirm before Clear project: what goes (the board, the app), who saves a handoff note first, and who stops at once. */
export function clearConfirm(all: State, repo: any): Promise<boolean> {
  const fids = new Set(all.features.filter((f) => f.repo_id === repo.id).map((f) => f.id))
  const nf = fids.size, nt = all.tickets.filter((t) => fids.has(t.feature_id)).length
  const agents = all.agents.filter((a) => live(a) && a.role !== 'launcher' && repoOfAgent(all, a) === repo.id)
  const notes = agents.filter((a) => a.fresh_start_at || ((a.role === 'tpm' || a.role === 'engineer') && !freshBlocker(a, all)))
  const p = all.previews.find((x) => x.id === repo.id)
  return ask({ title: `Clear ${repo.name}?`, go: 'Clear project', danger: true, leaving: null, staysHead: 'These stop at once (HQ writes their note from its records):',
    body: `Deletes ${repo.name}'s board from HQ: ${nf} feature${nf === 1 ? '' : 's'}, ${nt} ticket${nt === 1 ? '' : 's'}, their messages, notes and notices. `
      + "Code that isn't committed yet is saved as a WIP commit on its branch; branches, GitHub and PRs are left alone. "
      + `The feature files, handoff notes and a summary go to ~/.hq/archive/${repo.name}/. The TPM stays: it remembers what was built, not the old tickets.`,
    apps: isOn(p) ? [`${repo.name}'s app`] : [], parks: notes.map((a) => about(all, a)),
    stays: agents.filter((a) => !notes.includes(a)).map((a) => `${about(all, a)}: ${freshBlocker(a, all) ?? 'not a TPM or engineer'}`) })
}
/** Every ticket of the feature (at least one, cancelled ones aside) is merged. */
export const featureDone = (s: State, fid: string): boolean => {
  const all = s.tickets.filter((t) => t.feature_id === fid && t.status !== 'cancelled'); return all.length > 0 && all.every((t) => t.status === 'merged')
}
/** Whether a repo has work parked by a fresh start (a TPM or ticket waiting for Resume). */
export const hasParked = (all: State, repoId: string): boolean => {
  const fids = new Set(all.features.filter((f) => f.repo_id === repoId && f.status !== 'cancelled').map((f) => f.id))
  return !!all.repos.find((r) => r.id === repoId)?.tpm_parked_at || all.tickets.some((t) => fids.has(t.feature_id) && t.parked_at && RESUMABLE.includes(t.status))
}

// Fresh start: an agent writes a handoff note and a new session takes over. The rules match the backend's (freshstart.ts).
const RESUMABLE = ['planning', 'implementing', 'awaiting_answer', 'resolving']
/** The context size past which HQ suggests a fresh start: the user's pick for the TPM, about two-thirds of it for engineers. */
export function ctxLimit(s: State, role: string): number | null {
  const pick = Number(s.settings.context_limit ?? s.defaults.context_limit ?? 150_000)
  return role === 'tpm' ? pick : role === 'engineer' ? Number(s.defaults.engineer_limit?.[pick] ?? Math.round(pick * 2 / 3)) : null
}
export const kTok = (n: number): string => `${Math.round(n / 1000)}k`
/** How full an agent's context is, as a share of its limit (1 = at the limit), or null when HQ hasn't measured it. */
export function ctxShare(a: Agent, s: State): number | null { const l = ctxLimit(s, a.role); return l && a.context_tokens ? a.context_tokens / l : null }
/** Why `a` can't have a fresh start now, or null. */
export function freshBlocker(a: Agent, s: State): string | null {
  if (!live(a) || (a.role !== 'tpm' && a.role !== 'engineer')) return 'It isn\'t running.'
  if (a.fresh_start_at) return 'It is writing its handoff note.'
  if (a.status === 'blocked' || a.status === 'paused') return 'It is waiting on a dialog in its terminal. Answer it first.'
  if (a.role === 'tpm') return null
  const t = s.tickets.find((x) => x.id === a.ticket_id); if (!t) return 'It has no ticket.'
  if (t.status === 'plan_review') return `${t.key}'s plan is waiting for your review. Answer it first.`
  return RESUMABLE.includes(t.status) ? null : `${t.key} is finished: nothing to hand over.`
}
/** Whether a box offers Fresh start for `a` at all: a running TPM, or an engineer on unfinished work (while its plan waits for
 *  review the button shows, disabled with the reason). */
export const freshOffered = (a: Agent, s: State): boolean => live(a) && (a.role === 'tpm'
  || (a.role === 'engineer' && [...RESUMABLE, 'plan_review'].includes(s.tickets.find((t) => t.id === a.ticket_id)?.status)))
/** HQ's confirm before a fresh start of `who`, saying what happens next (the user's "After Fresh start" setting). */
export function freshConfirm(s: State, who: string[]): Promise<boolean> {
  const wait = (s.settings.after_fresh_start ?? s.defaults.after_fresh_start) === 'wait', many = who.length > 1
  return ask({ title: `Fresh start ${many ? `${who.length} agents` : who[0]}?`, go: 'Fresh start', apps: [], parks: many ? who : [], stays: [], leaving: null,
    body: `${many ? 'Each one stops' : 'It stops'} what ${many ? 'it is' : 'it\'s'} doing now, writes a short handoff note, and its session ends. `
      + (wait ? 'The work then waits until you press Resume.' : 'A new session picks up from the note right away, with a clean context.') })
}

/** What the user can do with a finished ticket: HQ's Merge into main (local repos) or the PR on GitHub; Fix conflicts instead of
 *  Merge when it conflicts with main (on GitHub the PR link stays, second), or when its fix stalled (the engineer stopped, or went
 *  idle without finishing: pressing it again re-sends HQ's instructions; Fix tests when auto mode sent it back for its tests, Bug 84;
 *  Build the change when the TPM changed its spec after it was finished). `eng`: the ticket's live engineer, if any. */
export function mergeActs(t: any, base: string, eng: Agent | null): Act[] {
  if (t.status === 'resolving') return !eng || eng.status === 'idle' ? [{ kind: 'fix', why: t.fixing === 'changes' ? 'change' : t.fixing ? 'tests' : undefined }] : []
  const conflict = t.conflict_files != null && (t.status === 'pr_ready' || t.status === 'pr_open')
  if (t.status === 'pr_ready' && t.pr_state === 'local') return [conflict ? { kind: 'fix' } : { kind: 'merge', into: base }]
  const fix: Act[] = conflict ? [{ kind: 'fix' }] : []
  // GitHub (Bug 45): the user tries it, then merges from HQ (HQ opens and merges the PR) or makes a PR to look at on GitHub first
  if (t.status === 'pr_ready' && (t.pr_state === 'waiting' || t.pr_state === 'not_opened')) {
    return conflict ? [...fix, ...(t.pr_url ? [{ kind: 'link', label: 'Create PR ↗', href: t.pr_url, primary: false } as Act] : [])]
      : [{ kind: 'merge', into: base, github: true }, { kind: 'make-pr' }]
  }
  if (t.status === 'pr_ready' && t.pr_url) return [...fix, { kind: 'link', label: 'Create PR ↗', href: t.pr_url, primary: !conflict }]
  if (t.status === 'pr_open' && t.pr_url && t.pr_number && t.pr_state !== 'closed') {
    const link: Act = { kind: 'link', label: `PR #${t.pr_number} ↗`, href: t.pr_url, primary: false }
    return conflict ? [...fix, link] : [{ kind: 'merge', into: base, github: true, pr: t.pr_number }, link]
  }
  return fix
}
/** What an agent is doing, in words. */
export const agentWord = (a: Agent): string => ({ working: 'working', idle: 'idle', plan_review: 'waiting for your review', blocked: 'waiting on a dialog', paused: 'paused',
  launching: 'starting', exited: 'stopped' } as Record<string, string>)[a.status] ?? a.status
export const DO_REST = 'Do the rest automatically'
/** A notice's kind in words (the ⚠ menu and box lines); unknown kinds lose their underscores. */
export const kindLabel = (k: string): string => k.startsWith('auto_stopped:') ? 'Auto mode stopped' : k.startsWith('auto_finished:') ? 'Auto mode finished' :
  k.startsWith('test_cmd_proposed:') ? 'New test command, for your OK' :
  ({ auto_parked: 'Parked by auto mode', merged: 'Merged', stuck: 'Looks stuck', engineer_exited: 'Engineer stopped', agent_exited: 'Agent stopped',
  message_for_user: 'Message for you', blocked: 'Blocked', dialog: 'Waiting on a dialog', usage_limit: 'Usage limit', merge_conflict: 'Merge conflict', fix_stalled: 'Fix stalled',
  change_stalled: 'Change stalled',
  conflicts_fixed: 'Conflicts fixed', delivery_failed: 'Message not delivered', dm_refused: 'Message not sent', context_high: 'Memory filling up', fresh_start_failed: "Fresh start didn't finish",
  tpm_rotate: 'TPM memory full', api_error: 'API error', rate_limit: 'Usage limit', backend_error: 'HQ error', user_override: 'Approved in the terminal',
  cap_reached: 'Sent back too often', tpm_away: 'TPM not running', pr_failed: "Couldn't open the PR", mod_missing: 'Agent not connected',
  leftovers_stuck: "Leftover programs won't stop", leftovers_cant_check: "Can't check for leftovers", bg_stalled: 'Run frozen',
  engineer_idle: 'Engineer idle', claude_unchecked: 'Claude Code not checked', claude_newer: 'Newer Claude Code installed' } as Record<string, string>)[k]
  ?? (k.startsWith('repo_') ? 'Repo' : k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()))
const steps = (a: Agent) => a.steps_total ? ` · step ${a.steps_done}/${a.steps_total}` : ''
const firstLine = (text: string): string => String(text).split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*|`/g, '').trim()).find(Boolean) ?? ''
// "Your turn" on the TPM box (Bug 43, Bug 52): the TPM's questions with a button per choice, and the tickets ready to start.
export const askText = (a: Ask): string => `The TPM asked: ${a.question}`
/** The buttons under a question: its choices and Answer… (a reply of the user's own, in the TPM box). A choice answers it even
 *  with the TPM stopped: the answer starts it again (Bug 52). One HQ acts on itself (Bug 50: "Remove it" / "Keep it") has only its choices. */
export const askLabels = (a: Ask): string[] => a.action ? a.choices : [...a.choices, 'Answer…']
/** With a question still open, it says to answer first: the answer may change those tickets (seen with a real TPM). */
export const startText = (keys: string[], asking = false): string => `${keysText(keys)} ${keys.length > 1 ? 'are' : 'is'} ready to start.${asking ? ' Answer the TPM first: it may change them.' : ''}`
export const startLabel = (keys: string[]): string => keys.length <= 3 ? `Start ${keys.join(', ')}` : `Start ${keys.length} ready`
export const turnOn = (turn: Turn): boolean => turn.asks.length > 0 || turn.start.length > 0
/** A ticket's status in words where the stored one would mislead (a local branch has no PR; a finished one may conflict; one sent
 *  back is fixing its conflicts or, on auto, its tests, or building a change to its spec). */
export const ticketLabel = (t: any): string => (t.status === 'pr_ready' || t.status === 'pr_open') && t.conflict_files != null ? 'conflicts'
  : t.status === 'resolving' && t.fixing === 'changes' ? 'changing it' : t.status === 'resolving' && t.fixing ? 'fixing tests'
  : t.status === 'pr_ready' ? 'ready to merge' : ({ queued: 'not started', planning: 'planning', plan_review: 'plan for you',
    implementing: 'building', awaiting_answer: 'has a question', escalated: 'needs you', pr_open: 'PR open', resolving: 'fixing conflicts', merged: 'merged',
    cancelled: 'cancelled' } as Record<string, string>)[t.status] ?? t.status
/** "conflicts with main in a, b (T-01 merged first)", or null when the ticket merges cleanly. */
export function conflictText(t: any, base: string): string | null {
  if (t.conflict_files == null) return null
  const files = jsonList(t.conflict_files), first = jsonList(t.conflict_with)
  return `conflicts with ${base}${files.length ? ` in ${files.join(', ')}` : ''}${first.length ? ` (${first.join(', ')} merged first)` : ''}`
}
const live = (a: Agent | null | undefined): a is Agent => !!a && a.status !== 'exited'
/** The engineer running a ticket right now, if any. */
export const liveEngineer = (t: any, s: State): Agent | null => { const a = s.agents.find((x) => x.id === t.assignee_agent_id); return live(a) ? a : s.agents.find((x) => x.role === 'engineer' && x.ticket_id === t.id && live(x)) ?? null }
const noLinks = (s: string) => String(s).replace(/https?:\/\/\S+/g, '↗')
/** Dependencies of `t` that aren't merged yet (the backend's own rule); `all` is the feature's non-cancelled tickets. */
const unmerged = (t: any, all: any[]) => unmergedDeps(t, all)

let ctx2d: CanvasRenderingContext2D | null = null
const widths = new Map<string, number>() // measured once per text: the board is rebuilt on every patch
const WIDTHS_MAX = 3000 // without a limit every line an agent ever showed stays for as long as the tab is open
/** Width in px of `text` in the cards' 11px font (600 weight for titles and keys). */
function textW(text: string, bold = false): number {
  const key = `${bold ? 'b' : 'n'}${text}`, known = widths.get(key); if (known !== undefined) return known
  if (!ctx2d) ctx2d = document.createElement('canvas').getContext('2d')
  if (!ctx2d) return text.length * 7
  ctx2d.font = `${bold ? '600 ' : ''}11px ${getComputedStyle(document.body).fontFamily}`
  return keepNewest(widths, key, ctx2d.measureText(text).width, WIDTHS_MAX)
}
/** Rows `text` needs in `inner` px when it wraps freely (word by word, as the browser does). */
function wrapRows(text: string, inner: number): number {
  let rows = 1, x = 0; const space = textW(' ')
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const ww = textW(w); if (x && x + space + ww > inner) { rows++; x = ww } else x += (x ? space : 0) + ww
    if (ww > inner) { rows += Math.floor(ww / inner); x = ww % inner } // a word longer than the row breaks
  }
  return rows
}
/** Height of the Your turn section (Nodes.tsx TurnBox): mt-1.5 + border + p-1.5, the heading, then each question with its
 *  buttons and the ready line with Start, each child gap-1 apart. 0 when it isn't shown. */
function turnH(turn: Turn, inner: number): number {
  if (!turnOn(turn)) return 0
  const si = inner - 14, btns = (n: number) => n * 22 + (n - 1) * GAP
  let h = 6 + 2 + 12 + ROW
  for (const a of turn.asks) { const l = askLabels(a); h += GAP + wrapRows(askText(a), si) * ROW + GAP + btns(actRows(l, si)) }
  if (turn.start.length) h += GAP + wrapRows(startText(turn.start, turn.asks.length > 0), si) * ROW + GAP + 22
  if (!turn.auto) h += GAP + 22 // Do the rest automatically
  return h
}
/** Rows `text` needs in `inner` px: 1, or 2 (longer is clamped with an ellipsis; the full text is on hover). */
const rowsIn = (text: string, inner: number, bold = false): 1 | 2 => textW(text, bold) <= inner ? 1 : 2
/** The label a box's button shows (measured for layout, shown by Nodes.tsx). */
export function actLabel(a: Act): string {
  return a.kind === 'launch' ? 'Launch engineer' : a.kind === 'read-plan' ? 'Read plan' : a.kind === 'approve' ? 'Approve' : a.kind === 'merge' ? `Merge into ${a.into}`
    : a.kind === 'make-pr' ? 'Make PR' : a.kind === 'do-rest' ? DO_REST : a.kind === 'auto-retry' ? 'Try again'
    : a.kind === 'link' ? a.label : a.kind === 'fix' ? (a.why === 'change' ? 'Build the change' : a.why === 'tests' ? 'Fix tests' : 'Fix conflicts')
    : a.kind === 'try' ? (a.on ? 'Back to main' : 'Try it') : 'Resume'
}
const rowW = (labels: string[]) => labels.reduce((sum, l, i) => sum + textW(l) + BTN + (i ? GAP : 0), 0)
/** Rows a wrapping row of buttons needs in `inner` px. */
function actRows(labels: string[], inner: number): number {
  let rows = 0, x = 0
  for (const l of labels) { const w = textW(l) + BTN; if (!rows || x + GAP + w > inner) { rows++; x = w } else x += GAP + w }
  return rows
}
const clamp = (n: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, n)))
/** Sets each line's rows in `inner` px; returns their total. */
const fitLines = (lines: Line[], inner: number) => lines.reduce((sum, l) => sum + (l.rows = rowsIn(l.text, inner)), 0)

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

/** The project's TPM on top, always (Bug 52); one box per feature (oldest on the left) with its tickets below in dependency
 *  columns, left to right. `repo`: the picked repo (its TPM box shows even with nothing on the board). */
export function buildBoard(s: State, now = Date.now(), repo: any = s.repos[0] ?? null): Board {
  const agentById = new Map(s.agents.map((a) => [a.id, a])), ticketById = new Map(s.tickets.map((t) => [t.id, t]))
  // 1. Which boxes exist. Cancelled features stay only while one of their agents runs; a feature whose tickets all merged collapses.
  const groups = s.features.filter((f) => f.status !== 'cancelled' || s.agents.some((a) => a.feature_id === f.id && live(a)))
    .sort((a, b) => a.created_at - b.created_at) // explicit: the backend sends newest first and patches prepend
    .map((f) => { const all = s.tickets.filter((t) => t.feature_id === f.id && t.status !== 'cancelled'); return { f, all, collapsed: all.length > 0 && all.every((t) => t.status === 'merged') } })
  const ids = new Set<string>(['tpm'])
  for (const g of groups) { ids.add(`f:${g.f.id}`); if (!g.collapsed) for (const t of g.all) ids.add(`t:${t.id}`) }
  const has = (n: string) => ids.has(n)
  const featureBox = (fid: unknown) => fid && has(`f:${fid}`) ? `f:${fid}` : null
  const ticketBox = (tid: unknown): string | null => !tid ? null : has(`t:${tid}`) ? `t:${tid}` : featureBox(ticketById.get(String(tid))?.feature_id)
  const agentNode = (aid: string): string | null => { const a = agentById.get(aid); return !a ? null : a.role === 'tpm' ? 'tpm' : ticketBox(a.ticket_id) ?? featureBox(a.feature_id) }
  // 2. Attention lands on the ticket's box, else the box of the agent's ticket, else the feature box; the rest only in the ⚠ menu.
  const attNode = (x: any): string | null => ticketBox(x.ticket_id) ?? (x.agent_id ? agentNode(x.agent_id) : null)
  const attOf = new Map<string, any[]>()
  for (const x of [...s.attention].sort((a, b) => b.created_at - a.created_at)) { const n = attNode(x); if (n) attOf.set(n, [...(attOf.get(n) ?? []), x]) }
  /** The box's newest notice, else messages waiting for its agent, else what the agent is doing (`quiet`: not while it waits on the user). */
  const note = (att: any[], a: Agent | null, quiet = false): Line | null => {
    if (att.length) { const ok = goodNews(att[0].kind); return { text: `${ok ? '✓' : '⚠'} ${kindLabel(att[0].kind)}: ${noLinks(att[0].detail)}`, tone: ok ? 'emerald' : 'rose' } }
    const w = live(a) ? waitingFor(a, s, now) : null
    if (w) return { text: `✉ ${w.count} waiting · ${w.why}`, tone: w.held ? 'amber' : 'muted' }
    return !quiet && live(a) && a.activity ? { text: String(a.activity), tone: 'muted' } : null
  }
  /** How full a running agent's context is; amber from 80% of its limit, rose past it. */
  const ctxLine = (a: Agent | null): Line | null => {
    if (!live(a)) return null
    if (a.fresh_start_at) return { text: 'fresh start · writing its handoff note…', tone: 'sky' }
    const share = ctxShare(a, s); if (share === null) return null
    return { text: `context ${kTok(a.context_tokens)} / ${kTok(ctxLimit(s, a.role)!)}${share >= 1 ? ' · full' : ''}`, tone: share >= 1 ? 'rose' : share >= 0.8 ? 'amber' : 'muted' }
  }
  const featureView = (g: (typeof groups)[number]): FeatureView => {
    const f = g.f, att = attOf.get(`f:${f.id}`) ?? [], done = g.collapsed // finished: a small box, out of the way
    const merged = g.all.filter((t) => t.status === 'merged').length
    const lines: Line[] = done ? [{ text: `✓ done · all ${g.all.length} merged`, tone: 'emerald' }]
      : [{ text: g.all.length ? `${merged}/${g.all.length} merged` : f.status === 'cancelled' ? 'cancelled' : 'no tickets yet', tone: 'muted' }]
    const n = done ? null : note(att, null); if (n) lines.push(n)
    return { f, lines, att, total: g.all.length, collapsed: g.collapsed, done, border: '#3f3f46' }
  }
  /** The TPM box: what the TPM is doing (or that it starts with the user's message), its last reply, Your turn. */
  const tpmView = (): TpmView => {
    const tpm = (repo?.tpm_agent_id ? agentById.get(repo.tpm_agent_id) : undefined) ?? null, up = live(tpm), att = attOf.get('tpm') ?? []
    const parked = !!repo?.tpm_parked_at && !up, tpmIds = s.agents.filter((a) => a.role === 'tpm').map((a) => a.id)
    const reply = s.messages.filter((m) => m.to_id === 'user' && tpmIds.includes(m.from_id)).sort((a, b) => b.created_at - a.created_at)[0] ?? null
    const lines: Line[] = [up ? { text: `${tpm.status === 'launching' ? 'starting' : agentWord(tpm)}`, tone: tpm.status === 'working' ? 'emerald' : 'muted' }
      : parked ? { text: 'parked · handoff note saved · your message brings it back', tone: 'sky' }
      : { text: tpm ? 'not running · your message starts it again' : 'starts when you send it a message', tone: 'muted' }]
    const c = ctxLine(tpm); if (c) lines.push(c)
    if (reply) lines.push({ text: `💬 ${firstLine(reply.body)}`, tone: 'plain' })
    const n = note(att, tpm); if (n) lines.push(n)
    const turn = yourTurn(s, repo?.id ?? null), mine = turnOn(turn)
    return { repo, tpm, live: up, lines, att, turn, tpmIds, empty: !s.features.length && !reply,
      border: mine ? '#f59e0b' : up ? agentColor[tpm.status] ?? '#3f3f46' : '#3f3f46' }
  }
  const ticketView = (t: any, all: any[], base: string, loop: boolean): TicketView => {
    const eng = liveEngineer(t, s), att = attOf.get(`t:${t.id}`) ?? []
    const review = s.reviews.find((r) => r.ticket_id === t.id && r.status === 'open') ?? null // a newer plan closes the older round
    const waits = t.status === 'queued' ? unmerged(t, all) : [], dead = waits.filter((k) => !all.some((x) => x.key === k))
    const gone = dead.filter((k) => s.tickets.some((x) => x.feature_id === t.feature_id && x.key === k)), unknown = dead.filter((k) => !gone.includes(k))
    const auto = !!repo?.auto_mode && !repo.auto_stopped_why && !t.auto_parked_why // HQ does the next step itself
    const detail: Line | null = t.auto_parked_why ? { text: `parked: ${t.auto_parked_why}`, tone: 'rose' }
      : review ? { text: `Plan R-${review.round} waiting for you`, tone: 'amber' }
      : t.pr_state === 'closed' ? { text: `PR #${t.pr_number} was closed without merging`, tone: 'rose' }
      : t.status === 'resolving' ? (!eng ? { text: `${ticketLabel(t)} · its engineer stopped`, tone: 'rose' }
        : eng.status === 'idle' ? { text: 'its engineer went idle before finishing', tone: 'rose' }
        : { text: t.fixing === 'changes' ? 'its spec changed · its engineer is building the change'
          : t.fixing === 'tests_hung' ? `its tests never finished on ${base} · its engineer is finding why` : t.fixing ? `its tests failed on ${base} · its engineer is fixing them`
          : `its engineer is merging ${base} in`, tone: 'amber' })
      : conflictText(t, base) && (t.status === 'pr_ready' || t.status === 'pr_open') ? { text: conflictText(t, base)!, tone: 'rose' }
      : auto && (t.status === 'pr_ready' || t.status === 'pr_open') ? { text: 'done · HQ tests it, then merges it', tone: 'indigo' }
      : t.status === 'pr_ready' && t.pr_state === 'local' ? { text: 'done · waiting for you to merge it', tone: 'indigo' }
      : t.status === 'pr_ready' && t.pr_state === 'waiting' ? { text: 'done · try it, then merge it or make a PR', tone: 'indigo' }
      : t.status === 'pr_ready' ? { text: "done · HQ couldn't open a PR; Merge still works", tone: 'indigo' }
      : t.status === 'pr_open' ? { text: `done · PR #${t.pr_number} is open: merge it here or on GitHub`, tone: 'indigo' }
      : !eng && t.parked_at && RESUMABLE.includes(t.status) ? { text: 'parked · handoff note saved', tone: 'sky' }
      : eng ? { text: `engineer · ${eng.in_plan_mode && eng.status === 'working' ? 'planning' : agentWord(eng)}${steps(eng)}`, tone: 'muted' }
      : t.status === 'queued' ? (loop ? { text: "dependency loop, can't start", tone: 'rose' }
        : dead.length ? { tone: 'rose', text: `waits on ${[gone.length ? `${gone.join(', ')} (removed)` : '',
          unknown.length ? `${unknown.join(', ')} (no such ticket)` : ''].filter(Boolean).join(', ')}: ask the TPM to rewire it` }
        : waits.length ? { text: `waits on ${waits.join(', ')} (not merged yet)`, tone: 'muted' }
        : t.go_ahead ? { text: 'starts when an engineer slot frees up', tone: 'sky' } : auto ? { text: 'HQ starts it when the TPM finishes', tone: 'sky' } : { text: 'ready to start',
          tone: 'emerald' })
      : t.status === 'merged' ? null : { text: 'no engineer running', tone: 'muted' }
    const lines = [detail, ctxLine(eng), t.auto_parked_why ? null : note(att, eng, !!review)].filter((l): l is Line => !!l) // parked: the first line says it
    const acts: Act[] = []
    if (t.auto_parked_why) acts.push({ kind: 'auto-retry' })
    if (t.status === 'queued' && !t.assignee_agent_id && !waits.length && !loop && !t.go_ahead && !auto) acts.push({ kind: 'launch', waits }) // go-ahead: starts on its own
    if (review) acts.push({ kind: 'read-plan' }, { kind: 'approve' })
    if (!eng && RESUMABLE.includes(t.status) && t.branch) acts.push({ kind: 'resume', parked: !!t.parked_at })
    const pv = s.previews.find((p) => p.id === s.features.find((f) => f.id === t.feature_id)?.repo_id)
    if (tryable(t)) acts.push({ kind: 'try', on: isOn(pv) && pv.ticket_id === t.id }) // look before merging (Bug 22)
    if (!auto) acts.push(...mergeActs(t, base, eng))
    if (!repo?.auto_mode && (review || acts.some((a) => a.kind === 'merge'))) acts.push({ kind: 'do-rest' }) // every stop offers it
    return { t, eng, review, titleRows: 1, actRows: 0, lines, acts, att, compact: t.status === 'merged', border: eng ? agentColor[eng.status] ?? '#3f3f46' : ticketColor[t.status] ?? '#3f3f46' }
  }
  // 3. Sizes: a box is as wide as its header and its buttons need (within W..MAX; a feature's tickets share one width so its columns
  //    line up); then each line takes one or two rows, the buttons wrap, and the height adds it all up.
  const ticketWant = (v: TicketView) => {
    const t = v.t, icons = (v.att.length ? 30 : 0) + (v.eng ? 16 : 0) + (t.status !== 'merged' && t.status !== 'cancelled' ? 16 : 0)
    return CHROME + Math.max(textW(t.key, true) + textW(t.size) + textW(ticketLabel(t)) + 16 + icons + 20, rowW(v.acts.map(actLabel)))
  }
  const ticketFit = (v: TicketView, w: number) => {
    if (v.compact) return CHROME + ROW
    const inner = w - CHROME; v.titleRows = rowsIn(v.t.title, inner); v.actRows = actRows(v.acts.map(actLabel), inner)
    return CHROME + ROW + v.titleRows * ROW + fitLines(v.lines, inner) * ROW + actsH(v.actRows)
  }
  const fviews = groups.map(featureView), tv0 = tpmView()
  const fw = fviews.map((v) => v.done ? W.ticket : clamp(CHROME + textW(v.f.title, true) + 64, W.feature, MAX.feature))
  const fh = fviews.map((v, i) => CHROME + ROW + fitLines(v.lines, fw[i]! - CHROME) * ROW)
  const tw0 = clamp(tv0.turn.asks.length ? 400 : W.tpm, W.tpm, MAX.tpm), ti = tw0 - CHROME
  const th0 = CHROME + ROW + fitLines(tv0.lines, ti) * ROW + turnH(tv0.turn, ti) + INPUT_H
  // 4. Positions: tiers top to bottom; within a feature, one column per dependency depth, same-depth tickets stacked.
  const FEATURE_Y = th0 + TIER_GAP, TICKET_Y = FEATURE_Y + Math.max(0, ...fh) + TIER_GAP
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
    const base = s.repos.find((r) => r.id === g.f.repo_id)?.default_branch ?? 'main'
    const tv = new Map(vis.map((t) => [t.id, ticketView(t, g.all, base, loop.has(t.key))]))
    const tw = clamp(Math.max(0, ...[...tv.values()].map(ticketWant)), W.ticket, MAX.ticket)
    const colsW = cols.length ? cols.length * tw + (cols.length - 1) * COL_GAP : 0, groupW = Math.max(fw[i]!, colsW)
    nodes.push({ id: fid, type: 'feature', position: { x: x + (groupW - fw[i]!) / 2, y: FEATURE_Y }, data: { view: fv }, style: { width: fw[i], height: fh[i] },
      className: fv.done ? 'nopan opacity-70' : 'nopan' })
    edges.push({ id: `h-${g.f.id}`, type: 'smoothstep', source: 'tpm', sourceHandle: 'b', target: fid, targetHandle: 't', style: hier })
    cols.forEach((col, d) => {
      let y = TICKET_Y
      for (const t of col) {
        const v = tv.get(t.id)!, h = ticketFit(v, tw)
        nodes.push({ id: `t:${t.id}`, type: 'ticket', position: { x: x + (groupW - colsW) / 2 + d * (tw + COL_GAP), y }, data: { view: v }, style: { width: tw, height: h },
          className: v.compact ? 'nopan opacity-70' : 'nopan' })
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
  nodes.unshift({ id: 'tpm', type: 'tpm', position: { x: (Math.max(0, x - GROUP_GAP) - tw0) / 2, y: 0 }, data: { view: tv0 }, style: { width: tw0, height: th0 }, className: 'nopan' })
  // 4. Messages from the last 2 minutes animate between the boxes of their sender and recipient (upwards ones use the upper anchors).
  const y = new Map(nodes.map((n) => [n.id, n.position.y])), cutoff = now - 120_000
  for (const m of s.messages) {
    if (m.created_at <= cutoff || !m.to_id) continue
    const a = agentNode(m.from_id), b = agentNode(m.to_id); if (!a || !b || a === b) continue
    const up = (y.get(a) ?? 0) > (y.get(b) ?? 0)
    edges.push({ id: `m-${m.id}`, source: a, sourceHandle: up ? 'ts' : 'b', target: b, targetHandle: up ? 'bt' : 't', animated: true, style: { stroke: '#22d3ee' } })
  }
  // What the view fits on: everything. The TPM sits centred over all the branches, so the view keeps it in the middle (Bug 52);
  // finished features are small boxes, so they cost little room.
  return { nodes, edges, active: nodes.map((n) => n.id), has, attNode, agentNode }
}
