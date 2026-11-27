// The graph's model: which boxes exist, what each one shows, where it sits, and which box an attention item belongs to.
// Pure apart from measuring title widths. App builds it once per state change; the graph and the top bar both read it.
import { createContext, useContext, useRef, useState } from 'react'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import { agentPlanWait, agentWord, alertFrom, api, planWait, interrupted, errText, jsonList, keepNewest, liveActivity, noteLine, onDialog, pauseStopped, showError, shownStatus,
  stopWord, unmergedDeps, waitLine, type Agent, type State } from './api'
import { ALERT_KINDS, askedWho, firstLine, goodNews, hqAnswersPlan, keysText, ticketQuestion, turnQuestionText, yourTurn, type Ask, type Question, type Turn } from './needs.ts'
import { featureTestsLine, mergeTestOf, mergeTestWords, runWords } from './testruns.ts'
import { planWaitsWhy } from '../../backend/src/checks.ts'
import { autoRetries, nextMover } from '../../backend/src/mover.ts'
import { boxCriteria, criteriaOf } from '../../backend/src/criteria.ts'
import { checkButton, checkOf, commandGap, fixBack, gapWords, outOfDate, roundOf, unseenCount, unseenOnly, unseenWords } from '../../backend/src/hqcheckrules.ts'
import { archiveName } from '../../backend/src/projectname.ts'
import { fitSets } from './fit.ts'
import { MORE, replyPreview } from './reply.ts'
import { kTok } from './usage.ts'

export type Tone = 'plain' | 'muted' | 'amber' | 'rose' | 'sky' | 'emerald' | 'indigo'
/** `rows`: set by the layout (a long line wraps to two). `since`: something going on right now (Bug 106: HQ's own test run): the line starts with a dot and ends
 *  with how long it has been going, counted by the page (ui.tsx Elapsed), so the board isn't worked out again every second. `dot`: moving, or still while it waits.
 *  `more`: the text leads into more than the box shows (Bug 124); it ends with a link to the rest, which stays in view however the text is cut. */
export type Line = { text: string; tone: Tone; rows?: 1 | 2; since?: number; dot?: 'running' | 'waiting'; more?: boolean
  tip?: string } // tip: the hover text, when not the line itself
export type Act = { kind: 'launch'; waits: string[] } | { kind: 'read-plan' } | { kind: 'read-question' }
  | { kind: 'approve' } | { kind: 'merge'; into: string; github?: boolean; pr?: number; soft?: boolean } | { kind: 'make-pr' } // soft: not the primary (Bug 401)
  | { kind: 'link'; label: string; href: string; primary: boolean } | { kind: 'resume'; parked: boolean }
  // why: its tests' fix stalled (Bug 84), the change to its spec did, or the fix of what HQ saw in the app; unseen: its tests passed and named ones weren't
  // seen running (Bug 373); none: its conflicts
  | { kind: 'fix'; why?: FixWhy }
  | { kind: 'try'; on: boolean } // on: the preview is running this ticket now
  | { kind: 'do-rest' } | { kind: 'auto-retry' } // auto mode: from this stop on, and another go for a parked ticket
  | { kind: 'check'; label: string } // "Have HQ test this" and its results (backend hqcheck.ts): the button's label as it stands, for the box's width
/** A feature: one request of the project's TPM, a branch of the board (Bug 52: it has no TPM of its own). */
export type FeatureView = { f: any; lines: Line[]; att: any[]; total: number; collapsed: boolean; done: boolean; border: string }
/** The project's TPM box (Bug 52), always top-centre: where the user talks to the TPM, with its questions and what's ready to start. */
export type TpmView = { repo: any; tpm: Agent | null; live: boolean; lines: Line[]; att: any[]; turn: Turn; border: string; empty: boolean; tpmIds: string[] }
/** `question`: the open question its engineer asked, and `askedWho` whom (Bug 129). */
/** `hqPlan`: its plan waits for HQ's plan check, not for the user (its project is on auto): the box doesn't ask them for it. */
/** `crit`: the line that opens its acceptance criteria ("Criteria: 2 on the screen · 1 behind it"), null with none. */
export type TicketView = { t: any; eng: Agent | null; review: any | null; hqPlan: boolean; clearing: boolean; question: Question | null; askedWho: string
  titleRows: 1 | 2; actRows: number; lines: Line[]; acts: Act[]; att: any[]; compact: boolean; border: string; crit: string | null
  back: boolean } // Bug 401: its engineer finished what the user sent back from HQ's test, for the user to test again (hqcheckrules.ts fixBack)
/** `fits`: which boxes the view tries to show, widest first (Bug 119); Graph.tsx shows the first one that is readable in the pane (fit.ts). */
export type Board = { nodes: Node[]; edges: Edge[]; fits: string[][]; has: (node: string) => boolean; attNode: (a: any) => string | null; agentNode: (agentId: string) => string | null
  /** Boxes whose agent is held up until the user answers: a plan to review, a question (Bug 365: the edge pills say so). */
  holds: string[] }
export type PopKind = 'review' | 'attention' | 'talk' | 'question' | 'criteria' | 'check'
export type Pop = { node: string; kind: PopKind } | null
/** What the boxes need from App: the state, the picked repo (its TPM box), the open popover (one at a time) and the actions. */
export type Ctx = { state: State; repo: any | null; pop: Pop; setPop: (p: Pop) => void; focus: (node: string, kind?: PopKind) => void; selected: string | null }
export const BoardCtx = createContext<Ctx | null>(null)
export function useBoard(): Ctx { const c = useContext(BoardCtx); if (!c) throw new Error('useBoard outside BoardCtx'); return c }
/** How many times a plan can be sent back before HQ escalates the ticket (setting `revision_cap`). */
export function useRevisionCap(): number { const { state } = useBoard(); return Number(state.settings.revision_cap ?? state.defaults.revision_cap ?? 2) }

/** One job at a time per control: a second click while the first is in flight is ignored (a double-click used to start two engineers).
 *  `ask`: HQ's dialog first; the control reads busy only once the user says yes (Bug 315: "Stopping…" while nothing had stopped yet). */
export function useBusy(): [boolean, (job: () => Promise<unknown>, ask?: () => Promise<boolean>) => void] {
  const [busy, setBusy] = useState(false); const live = useRef(false)
  const run = (job: () => Promise<unknown>, ask?: () => Promise<boolean>) => {
    if (live.current) return; live.current = true
    const all = async () => { if (ask && !(await ask())) return; setBusy(true); await job() }
    all().catch((e) => showError(e)).finally(() => { live.current = false; setBusy(false) })
  }
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
/** A box waits on the user, so the view goes to its feature (Bug 119), by the ⚠ count's rules (needs.ts needsYou): a plan to review, finished
 *  work to merge or fix, an alerting notice. Good news doesn't count, and a ticket ready to start is on the TPM's Your turn. */
const waitsOnYou = (v: { review?: any; question?: Question | null; att: any[]; acts?: Act[] }) => !!v.review || v.question?.to_target === 'user'
  || v.att.some((a) => ALERT_KINDS.has(a.kind))
  || !!v.acts?.some((a) => a.kind === 'merge' || a.kind === 'make-pr' || a.kind === 'fix')
/** Of those, a box whose agent can't go on until the user answers (a plan to review, a question to them); finished work to merge holds
 *  no one up. When not all the boxes waiting on the user fit, the view shows these first (Bug 365). */
const holdsUp = (v: { review?: any; question?: Question | null; att: any[] }) => !!v.review || v.question?.to_target === 'user'
export const W = { tpm: 340, feature: 240, ticket: 220 }
const MAX = { tpm: 440, feature: 380, ticket: 320 }
const ROW = 16, CHROME = 18, COL_GAP = 48, ROW_GAP = 16, GROUP_GAP = 72, TIER_GAP = 56, BTN = 14, GAP = 4
const actsH = (rows: number) => rows ? 6 + rows * 22 + (rows - 1) * GAP : 0 // mt-1.5 + rows of .btn-sm + gap-1
const DOT = 10 // a going line's dot (ui.tsx LiveDot: 6px and its gap)
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
/** Opens the box that holds a project's test command (Auto.tsx AutoDialog): "Turn on auto mode?" while it's off, "How HQ tests …" while it's on. */
export const OPEN_AUTO = 'hq-open-auto'
export const openAuto = (repoId: string): void => { window.dispatchEvent(new CustomEvent(OPEN_AUTO, { detail: repoId })) }
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

/** Bug 339: whether switching away from `a`'s project parks it: it can write a note now, or it is writing one already (a fresh start's,
 *  which then waits for the user to come back too: freshstart.ts parkRepo). A Clear's note request stays a Clear's. */
export const parksOnSwitch = (a: Agent, all: State): boolean => !freshBlocker(a, all) || (live(a) && !!a.fresh_start_at && a.fresh_start_then !== 'clear')
/** Only the picked repo's app runs, and only its agents. Before switching to or starting `keepId`, every other repo's app that
 *  is on is stopped, after HQ's dialog. `leaving`: the repo being switched away from; its TPMs and engineers each save a handoff
 *  note and stop (parked), and pick up from it when the user comes back. False when the user cancels. Bug 362: it returns once those apps have
 *  stopped, so a start that follows never finds the port of an app the user just agreed to stop still taken (two projects can hard-wire one port). */
export async function stopOthers(all: State, keepId: string, doing: { title: string; go: string }, leaving: string | null = null): Promise<boolean> {
  const name = (id: string) => all.repos.find((r) => r.id === id)?.name ?? id
  const apps = all.previews.filter((p) => p.id !== keepId && isOn(p))
  const stays = !!all.repos.find((r) => r.id === leaving)?.auto_mode // a project on auto keeps running while the user looks elsewhere
  const agents = all.agents.filter((a) => live(a) && (a.role === 'tpm' || a.role === 'engineer') && !!leaving && !stays && leaving !== keepId && repoOfAgent(all, a) === leaving)
  if (!apps.length && !agents.length) return true
  const parks = agents.filter((a) => parksOnSwitch(a, all)), left = agents.filter((a) => !parksOnSwitch(a, all))
  const go = await ask({ ...doing, leaving: leaving && name(leaving), parks: parks.map((a) => about(all, a)), stays: left.map((a) => `${about(all, a)}: ${freshBlocker(a, all)}`),
    apps: apps.map((p) => `${name(p.id)}'s app${p.port ? ` (on :${p.url ? new URL(p.url).port : p.port})` : ''}`) })
  if (!go) return false
  const stops = apps.map((p) => api(`previews/${p.id}/stop`, {}).catch((e) => showError(`Couldn't stop ${name(p.id)}'s app: ${errText(e)}`)))
  if (parks.length && leaving) api(`repos/${leaving}/park`, {}).catch((e) => showError(`Couldn't park ${name(leaving)}'s agents: ${errText(e)}`))
  await Promise.all(stops)
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
/** What the merge's are-you-sure says about testing: HQ runs nothing as it merges, but the user may have had it tested (backend hqcheck.ts). */
export function checkWords(t: any): string {
  const c = checkOf(t)
  if (c?.state === 'running') return 'HQ is still testing it (Have HQ test this): merging now stops that test.'
  if (c && !outOfDate(t, c)) return c.state === 'pass' ? "HQ's test of this version passed (View results on the box)."
    : commandGap(c) ? `HQ's test of this version passed its tests, but ${gapWords(c)} (View results on the box).` // Bug 411: the command's gap
    : unseenOnly(c) ? `HQ's test of this version passed its tests, but ${unseenWords(unseenCount(c))} (View results on the box).` // Bug 373: nothing failed
    : c.state === 'fail' ? "HQ's test of this version found a problem (View results on the box)." : "HQ's test of this version didn't finish."
  if (fixBack(t, c)) return "HQ runs no tests as it merges, and hasn't tested its engineer's fix of what you sent back: to have it tested first, press Fix is back · test again." // Bug 401
  return 'HQ runs no tests as it merges: to have it tested first, press Have HQ test this.'
}
export function mergeConfirm(t: any, a: { into: string; github?: boolean; pr?: number }, account: string): Promise<boolean> {
  const how = a.github ? `HQ ${a.pr ? `merges PR #${a.pr}` : 'opens a pull request for it and merges it'} on GitHub right away, as ${account}.`
    : `HQ merges ${t.branch} into ${a.into} in your checkout.`
  return ask({ title: `Merge ${t.key} into ${a.into}?`, go: 'Merge', danger: true, leaving: null, apps: [], parks: [], stays: [],
    body: `${t.key} · ${t.title}. ${how} ${checkWords(t)} ${a.into} gets its changes for good; HQ can't undo a merge.`
      + ' Tried it? Try it on the box runs this version first.' })
}
/** HQ's are-you-sure before removing a ticket or cancelling a feature (Bug 50), in place of the browser's own box. */
export function cancelConfirm(title: string, body: string, go: string): Promise<boolean> {
  return ask({ title, go, danger: true, leaving: null, apps: [], parks: [], stays: [], body })
}
/** Open tickets that wait on `t` (Bug 50): they can't start once it's removed, until the TPM rewires them. */
export const waitingOn = (s: State, t: any): string[] => s.tickets.filter((x) => x.feature_id === t.feature_id && x.status !== 'merged' && x.status !== 'cancelled'
  && jsonList(x.deps).includes(t.key)).map((x) => x.key)
/** What removing a ticket does (Bug 50), for HQ's dialog. */
export const removeText = (t: any, eng: Agent | null, waiting: string[]): string => `${t.key} · ${t.title}.${eng ? ` Its engineer (${eng.display_name ?? eng.id}) stops.` : ''}`
  + ` It leaves the board for good; its branch is kept.`
  + (waiting.length ? ` ${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'} on it: ask the TPM to rewire ${waiting.length === 1 ? 'it' : 'them'}.` : '')
/** What cancelling a feature does, for HQ's dialog: "1 engineer stops", "2 engineers stop" (Bug 282). */
export const featureCancelText = (v: FeatureView, s: State): string => {
  const open = s.tickets.filter((t) => t.feature_id === v.f.id && t.status !== 'merged' && t.status !== 'cancelled')
  const engs = open.filter((t) => s.agents.some((a) => a.id === t.assignee_agent_id && a.status !== 'exited')).length
  return `${open.length ? `Its ${open.length} unmerged ticket${open.length === 1 ? ' is' : 's are'} cancelled${engs ? ` and ${engs} engineer${engs === 1 ? ' stops' : 's stop'}` : ''}. ` : ''}`
    + "Merged work stays, and the project's TPM keeps going."
}
/** Where Clear and Remove put the project's notes (Bug 224): HQ's own archive, which follows HQ_HOME, and the folder name HQ gives it. */
const archiveOf = (all: State, repo: any): string => `${all.archive ?? '~/.hq/archive'}/${archiveName(repo.name)}/`
/** HQ's confirm before Remove from HQ (Bug 66): what stops, what HQ forgets, and that the folder isn't touched. */
export function removeConfirm(all: State, repo: any): Promise<boolean> {
  const fids = new Set(all.features.filter((f) => f.repo_id === repo.id).map((f) => f.id))
  const nf = fids.size, nt = all.tickets.filter((t) => fids.has(t.feature_id)).length, p = all.previews.find((x) => x.id === repo.id)
  const agents = all.agents.filter((a) => live(a) && a.role !== 'launcher' && repoOfAgent(all, a) === repo.id)
  return ask({ title: `Remove ${repo.name} from HQ?`, go: 'Remove from HQ', danger: true, leaving: null, staysHead: 'These stop straight away, with no handoff note:',
    body: `HQ forgets ${repo.name}: ${nf} feature${nf === 1 ? '' : 's'}, ${nt} ticket${nt === 1 ? '' : 's'}, their messages and notices${repo.auto_mode ? ', and its auto mode' : ''}. `
      + `Its folder isn't touched: worktrees, branches and uncommitted work stay where they are, but HQ won't know about them any more. GitHub is left alone. `
      + `HQ's notes go to ${archiveOf(all, repo)}. You can add the folder again later, as a new project.`,
    apps: [...(isOn(p) ? [`${repo.name}'s app`] : []), ...(helperOn(p) ? ["the Launch helper"] : [])], parks: [], stays: agents.map((a) => about(all, a)) })
}
/** The running agents a Clear of `repo` stops (not a Launch helper: it goes with the app). */
const clearedBy = (all: State, repo: any): Agent[] => all.agents.filter((a) => live(a) && a.role !== 'launcher' && repoOfAgent(all, a) === repo.id)
/** Who writes a handoff note in a Clear of `repo`: those already writing one, and each TPM or engineer free to (clear.ts askForNotes). During the
 *  clear it is the "N notes to go" (Bug 313): HQ asks them one at a time, so one not asked yet counts from the start, and each drops out as it stops. */
export const noteTakers = (all: State, repo: any): Agent[] =>
  clearedBy(all, repo).filter((a) => a.fresh_start_at || ((a.role === 'tpm' || a.role === 'engineer') && !freshBlocker(a, all)))
/** HQ's confirm before Clear project: what goes (the board, the app), who saves a handoff note first, and who stops at once. */
export function clearConfirm(all: State, repo: any): Promise<boolean> {
  const fids = new Set(all.features.filter((f) => f.repo_id === repo.id).map((f) => f.id))
  const nf = fids.size, nt = all.tickets.filter((t) => fids.has(t.feature_id)).length
  const agents = clearedBy(all, repo), notes = noteTakers(all, repo)
  const p = all.previews.find((x) => x.id === repo.id)
  return ask({ title: `Clear ${repo.name}?`, go: 'Clear project', danger: true, leaving: null, staysHead: 'These stop at once (HQ writes a note from its records for any with none yet):',
    body: `Deletes ${repo.name}'s board from HQ: ${nf} feature${nf === 1 ? '' : 's'}, ${nt} ticket${nt === 1 ? '' : 's'}, their messages, notes and notices. `
      + "Code that isn't committed yet is saved as a WIP commit on its branch; branches, GitHub and PRs are left alone. "
      + `The feature files, handoff notes and a summary go to ${archiveOf(all, repo)}. The TPM stays: it remembers what was built, not the old tickets.`
      // Bug 314: the Launch helper isn't part of the board, so it goes on; since Bugs 300/329 it can't start the stopped app by itself
      + (p?.helper_agent_id ? ` Claude keeps working out how to start ${repo.name}'s app (start steps aren't part of the board); the app doesn't start again without your OK.` : ''),
    apps: isOn(p) ? [`${repo.name}'s app`] : [], parks: notes.map((a) => about(all, a)),
    stays: agents.filter((a) => !notes.includes(a)).map((a) => `${about(all, a)}: ${freshBlocker(a, all, true) ?? 'not a TPM or engineer'}`) })
}
/** Every ticket of the feature (at least one, cancelled ones aside) is merged. */
export const featureDone = (s: State, fid: string): boolean => {
  const all = s.tickets.filter((t) => t.feature_id === fid && t.status !== 'cancelled'); return all.length > 0 && all.every((t) => t.status === 'merged')
}
// Fresh start: an agent writes a handoff note and a new session takes over. The rules match the backend's (freshstart.ts).
const RESUMABLE = ['planning', 'implementing', 'awaiting_answer', 'resolving']
/** The context size past which HQ suggests a fresh start: the user's pick for the TPM, about two-thirds of it for engineers. */
export function ctxLimit(s: State, role: string): number | null {
  const pick = Number(s.settings.context_limit ?? s.defaults.context_limit ?? 150_000)
  return role === 'tpm' ? pick : role === 'engineer' ? Number(s.defaults.engineer_limit?.[pick] ?? Math.round(pick * 2 / 3)) : null
}
export { kTok } // lives in usage.ts (the Agent tab's header, unit-tested), shared here
/** How full an agent's context is, as a share of its limit (1 = at the limit), or null when HQ hasn't measured it. */
export function ctxShare(a: Agent, s: State): number | null { const l = ctxLimit(s, a.role); return l && a.context_tokens ? a.context_tokens / l : null }
/** Why `a` can't have a fresh start now, or null. `clear`: the reason as Clear's dialog gives it (Bug 220: the clear stops HQ's plan check). */
export function freshBlocker(a: Agent, s: State, clear = false): string | null {
  if (!live(a) || (a.role !== 'tpm' && a.role !== 'engineer')) return 'It isn\'t running.'
  if (a.fresh_start_at) return 'It is writing its handoff note.'
  if (onDialog(a)) return 'It is waiting on a dialog in its terminal. Answer it first.'
  if (a.role === 'tpm') return null
  const t = s.tickets.find((x) => x.id === a.ticket_id); if (!t) return 'It has no ticket.'
  if (t.status === 'plan_review') { // on auto HQ's plan check answers it, not the user (Bug 220)
    const r = s.reviews.find((x) => x.ticket_id === t.id && x.status === 'open'); return planWaitsWhy(t.key, !!r && hqAnswersPlan(s, r), clear)
  }
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

/** The box's link to GitHub's own "open a pull request" form; HQ's words for a refused PR name it (mergewatch.ts makePr). */
export const CREATE_PR = 'Create PR ↗'
/** What the user can do with a finished ticket: HQ's Merge into main (local repos) or the PR on GitHub; Fix conflicts instead of
 *  Merge when it conflicts with main (on GitHub the PR link stays, second), or when its fix stalled (the engineer stopped, or went
 *  idle without finishing: pressing it again re-sends HQ's instructions; Fix tests when auto mode sent it back for its tests, Bug 84;
 *  Build the change when the TPM changed its spec after it was finished). `eng`: the ticket's live engineer, if any. */
export type FixWhy = 'tests' | 'unseen' | 'change' | 'look' | 'review'
/** What a sent-back ticket's fix button is for, from why it went back (tickets.fixing); undefined: its conflicts. */
export const fixWhy = (t: any): FixWhy | undefined => t?.fixing === 'changes' ? 'change' : t?.fixing === 'look' ? 'look' : t?.fixing === 'review' ? 'review'
  : t?.fixing === 'tests_unseen' ? 'unseen' : t?.fixing ? 'tests' : undefined
export function mergeActs(t: any, base: string, eng: Agent | null): Act[] {
  const why = fixWhy(t)
  // Bug 195: an engineer HQ stopped for a pause hasn't stalled: Resume is what gets it going, not the instructions again
  if (t.status === 'resolving') return !eng || (eng.status === 'idle' && !pauseStopped(eng)) ? [{ kind: 'fix', why }] : []
  const conflict = t.conflict_files != null && (t.status === 'pr_ready' || t.status === 'pr_open')
  if (t.status === 'pr_ready' && t.pr_state === 'local') return [conflict ? { kind: 'fix' } : { kind: 'merge', into: base }]
  const fix: Act[] = conflict ? [{ kind: 'fix' }] : []
  // GitHub (Bug 45): the user tries it, then merges from HQ (HQ opens and merges the PR) or makes a PR to look at on GitHub first.
  // Once GitHub refused to open it (`not_opened`), Make PR gives way to GitHub's own pre-filled form, as the refusal says (Bug 244);
  // HQ's watcher still tries again by itself every 2 min.
  if (t.status === 'pr_ready' && (t.pr_state === 'waiting' || t.pr_state === 'not_opened')) {
    const form: Act[] = t.pr_url ? [{ kind: 'link', label: CREATE_PR, href: t.pr_url, primary: false }] : []
    return conflict ? [...fix, ...form]
      : [{ kind: 'merge', into: base, github: true }, ...(t.pr_state === 'not_opened' && form.length ? form : [{ kind: 'make-pr' } as Act])]
  }
  // Bug 301: its PR was closed on GitHub without merging, so it has none open: Merge opens a new PR and merges it (mergeOnGithub, as auto mode does) and
  // Make PR opens a new one to look at. The closed PR stays a link, second, to read why it was closed (never under Create PR's name).
  if ((t.status === 'pr_ready' || t.status === 'pr_open') && t.pr_state === 'closed') {
    const old: Act[] = t.pr_url && t.pr_number ? [{ kind: 'link', label: `PR #${t.pr_number} ↗`, href: t.pr_url, primary: false }] : []
    return conflict ? [...fix, ...old] : [{ kind: 'merge', into: base, github: true }, { kind: 'make-pr' }, ...old]
  }
  if (t.status === 'pr_ready' && t.pr_url) return [...fix, { kind: 'link', label: CREATE_PR, href: t.pr_url, primary: !conflict }]
  if (t.status === 'pr_open' && t.pr_url && t.pr_number && t.pr_state !== 'closed') {
    const link: Act = { kind: 'link', label: `PR #${t.pr_number} ↗`, href: t.pr_url, primary: false }
    return conflict ? [...fix, link] : [{ kind: 'merge', into: base, github: true, pr: t.pr_number }, link]
  }
  return fix
}
export const DO_REST = 'Do the rest automatically'
/** A notice's kind in words (the ⚠ menu and box lines); unknown kinds lose their underscores. */
export const kindLabel = (k: string): string => k.startsWith('auto_stopped:') ? 'Auto mode stopped' : k.startsWith('auto_finished:') ? 'Auto mode finished' :
  k.startsWith('test_cmd_proposed:') ? 'New test command, for your OK' :
  k.startsWith('map_failed:') ? 'First map not written' : k.startsWith('test_cmd_refused:') ? "Engineers can't run the test command" :
  ({ auto_parked: 'Parked by auto mode', merged: 'Merged', stuck: 'Looks stuck', engineer_exited: 'Engineer stopped', agent_exited: 'Agent stopped',
  message_for_user: 'Message for you', blocked: 'Blocked', dialog: 'Waiting on a dialog', usage_limit: 'Usage limit', merge_conflict: 'Merge conflict', fix_stalled: 'Fix stalled',
  look_stalled: 'Fix stalled', review_stalled: 'Fix stalled',
  change_stalled: 'Change stalled', merged_part: 'Partly merged', // Bug 212
  conflicts_fixed: 'Conflicts fixed', delivery_failed: 'Message not delivered', dm_refused: 'Message not sent', context_high: 'Memory filling up', fresh_start_failed: "Fresh start didn't finish",
  tpm_rotate: 'TPM memory full', api_error: 'API error', rate_limit: 'Usage limit', backend_error: 'HQ error', user_override: 'Approved in the terminal',
  cap_reached: 'Sent back too often', tpm_away: 'TPM not running', pr_failed: "Couldn't open the PR", pr_closed: 'PR closed', mod_missing: 'Agent not connected',
  leftovers_stuck: "Leftover programs won't stop", leftovers_cant_check: "Can't check for leftovers", bg_stalled: 'Run frozen',
  model_fallback: 'Paused by HQ', // Bug 195: its words say whose model switched
  engineer_idle: 'Engineer idle', claude_unchecked: 'Claude Code not checked', claude_newer: 'Newer Claude Code installed',
  download_refused: 'Download refused' } as Record<string, string>)[k] // Bugs 412, 415
  ?? projectLabel(k) ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
/** Notices about a whole project (`repo_<what>:<repo id>`) say what about it (Bug 251: not a bare red "Repo" over good news). */
const projectLabel = (k: string): string | null => !k.startsWith('repo_') ? null : ({ repo_cleared: 'Project cleared',
  repo_cleared_left: 'Cleared, worktrees left', repo_clear_tpm: "TPM didn't start after Clear", repo_clear_failed: "Clear didn't finish",
  repo_sync: "Couldn't sync", repo_local: 'Pushing to GitHub', repo_launch: 'Starting the app', repo_testsetup: 'Test setup problem',
  repo_testsetup_ok: 'Test setup ready', repo_teststeps: 'Test steps problem', repo_teststeps_ok: 'Test steps ready' } as Record<string, string>)[k.split(':')[0]!]
  ?? 'Project'
const steps = (a: Agent) => a.steps_total ? ` · step ${a.steps_done}/${a.steps_total}` : ''
// "Your turn" on the TPM box (Bug 43, Bug 52): the TPM's questions with a button per choice, and the tickets ready to start.
export const askText = (a: Ask): string => `The TPM asked: ${a.question}`
/** The buttons under a question: its choices and Answer… (a reply of the user's own, in the TPM box). A choice answers it even
 *  with the TPM stopped: the answer starts it again (Bug 52). One HQ acts on itself (Bug 50: "Remove it" / "Keep it") has only its choices. */
export const askLabels = (a: Ask): string[] => a.action ? a.choices : [...a.choices, 'Answer…']
/** With a question still open, it says to answer first: the answer may change those tickets (seen with a real TPM). */
export const startText = (keys: string[], asking = false): string => `${keysText(keys)} ${keys.length > 1 ? 'are' : 'is'} ready to start.${asking ? ' Answer the TPM first: it may change them.' : ''}`
export const startLabel = (keys: string[]): string => keys.length <= 3 ? `Start ${keys.join(', ')}` : `Start ${keys.length} ready`
export const turnOn = (turn: Turn): boolean => turn.asks.length > 0 || turn.start.length > 0 || !!turn.questions?.length
/** Bug 349: a parked ticket's Ticket tab says why auto mode parked it, as its box does ("parked: …"; with an engineer at work, "parked by auto mode: …",
 *  Bug 336), and what comes next, in the words of the box's hover. Null for a ticket that isn't parked. Bug 364: what comes next depends on the mode:
 *  Try again hands it back only while auto mode is on (mover.ts autoRetries); once auto mode is off the ticket is the user's, as any other. */
export const PARK_NEXT = "It won't test or merge it: you do, or Try again hands it back to auto mode."
export const PARK_STOPPED = "It won't test or merge it: you do, or Try again hands it back to auto mode, which goes on once you resume it."
export const PARK_OFF = "Auto mode is off now, so it's yours like any other ticket. To hand it back, turn auto mode on, then Try again."
type ParkRepo = { auto_mode: number | boolean | null; auto_stopped_why?: string | null }
export const parkNext = (repo: ParkRepo | null | undefined): string => !repo?.auto_mode ? PARK_OFF : repo.auto_stopped_why ? PARK_STOPPED : PARK_NEXT
export const parkWords = (t: { auto_parked_why?: string | null }, repo: ParkRepo | null | undefined): { why: string; next: string } | null =>
  t.auto_parked_why ? { why: t.auto_parked_why, next: parkNext(repo) } : null
/** Bug 437: statuses whose pill says what its engineer is doing ("planning", "building", "fixing tests"). */
const AT_WORK = ['planning', 'implementing', 'resolving']
/** Bug 437: the pill's word while the ticket's engineer sits at its prompt after its turn was cut short (Escape, the pause), as its box says; else null. */
const stoppedPill = (t: any, eng: Agent | null | undefined): string | null => eng && AT_WORK.includes(t.status) ? stopWord(eng) : null
/** A ticket's status in words where the stored one would mislead (a local branch has no PR; a finished one may conflict; one sent
 *  back is fixing its conflicts or, on auto, its tests, or building a change to its spec; its engineer was interrupted or stopped by the pause, Bug 437).
 *  `back`: its engineer's fix of what the user sent back from HQ's test is back (TicketView.back), not "ready to merge" as if it had never gone (Bug 401).
 *  `eng`: its running engineer (liveEngineer). */
export const ticketLabel = (t: any, hqPlan = false, clearing = false, back = false, eng: Agent | null = null): string => stoppedPill(t, eng)
  ?? ((t.status === 'pr_ready' || t.status === 'pr_open') && t.conflict_files != null ? 'conflicts'
  : (t.status === 'pr_ready' || t.status === 'pr_open') && t.pr_state === 'closed' ? 'PR closed' // Bug 301: not "PR open" or "ready to merge"
  : (t.status === 'pr_ready' || t.status === 'pr_open') && back ? 'fix is back'
  : t.status === 'plan_review' && clearing ? 'plan unanswered' // Bug 231: a Clear stopped its engineer, and HQ takes no answer now
  : t.status === 'plan_review' && hqPlan ? 'plan check'
  : t.status === 'resolving' && t.fixing === 'changes' ? 'changing it' : t.status === 'resolving' && t.fixing === 'look' ? 'fixing the app'
  : t.status === 'resolving' && t.fixing === 'review' ? 'fixing findings'
  : t.status === 'resolving' && t.fixing === 'tests_unseen' ? 'tests not seen' // Bug 373: nothing failed, so not "fixing tests"
  : t.status === 'resolving' && t.fixing ? 'fixing tests'
  : t.status === 'pr_ready' && clearing ? 'not merged' // Bug 335: HQ refuses a merge during a Clear (its first line says so, Bug 311)
  : t.status === 'pr_ready' ? 'ready to merge' : ({ queued: 'not started', planning: 'planning', plan_review: 'plan for you',
    implementing: 'building', awaiting_answer: 'has a question', escalated: 'needs you', pr_open: 'PR open', resolving: 'fixing conflicts', merged: 'merged',
    cancelled: 'cancelled' } as Record<string, string>)[t.status] ?? t.status)
/** Bug 437: the status a ticket's pill is coloured by: its engineer's idle grey while its turn is cut short, not the green of "building". */
export const ticketTone = (t: any, eng: Agent | null = null): string => stoppedPill(t, eng) ? 'idle' : t.status
/** Bug 301: after "PR #N was closed without merging" on a finished ticket's box, what happens next: its conflicts first (Fix conflicts is its button),
 *  else who opens a new PR (auto mode merges it through one, as the user's Merge does). `auto`: HQ does the next step itself. */
const closedNext = (t: any, auto: boolean, base: string): string => t.status !== 'pr_ready' && t.status !== 'pr_open' ? ''
  : conflictText(t, base) ? ` · ${conflictText(t, base)}` : auto ? ' · HQ opens a new PR and merges it' : ' · Merge or Make PR opens a new one'
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
  for (const x of turn.questions ?? []) h += GAP + Math.min(3, wrapRows(turnQuestionText(x), si)) * ROW + GAP + 22 // its text (3 rows at most) and Read question
  if (turn.start.length) h += GAP + wrapRows(startText(turn.start, turn.asks.length > 0), si) * ROW + GAP + 22
  if (!turn.auto) h += GAP + 22 // Do the rest automatically
  return h
}
/** Rows `text` needs in `inner` px: 1, or 2 (longer is clamped with an ellipsis; the full text is on hover). */
const rowsIn = (text: string, inner: number, bold = false): 1 | 2 => textW(text, bold) <= inner ? 1 : 2
/** The label a box's button shows (measured for layout, shown by Nodes.tsx). */
export function actLabel(a: Act): string {
  return a.kind === 'launch' ? 'Launch engineer' : a.kind === 'read-plan' ? 'Read plan'
    : a.kind === 'read-question' ? 'Read question' : a.kind === 'approve' ? 'Approve' : a.kind === 'merge' ? `Merge into ${a.into}`
    : a.kind === 'make-pr' ? 'Make PR' : a.kind === 'do-rest' ? DO_REST : a.kind === 'auto-retry' ? 'Try again'
    : a.kind === 'link' ? a.label : a.kind === 'fix' ? (a.why === 'change' ? 'Build the change' : a.why === 'tests' ? 'Fix tests' : 'Fix conflicts')
    : a.kind === 'try' ? (a.on ? 'Back to main' : 'Try it') : a.kind === 'check' ? a.label : 'Resume'
}
const rowW = (labels: string[]) => labels.reduce((sum, l, i) => sum + textW(l) + BTN + (i ? GAP : 0), 0)
/** Rows a wrapping row of buttons needs in `inner` px. */
function actRows(labels: string[], inner: number): number {
  let rows = 0, x = 0
  for (const l of labels) { const w = textW(l) + BTN; if (!rows || x + GAP + w > inner) { rows++; x = w } else x += GAP + w }
  return rows
}
const clamp = (n: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, n)))
/** Sets each line's rows in `inner` px; returns their total. A going line is measured with its dot and its clock (room for 59:59), a line
 *  with more to it in what is left beside its link (Nodes.tsx Lines). */
const fitLines = (lines: Line[], inner: number) => lines.reduce((sum, l) =>
  sum + (l.rows = l.since !== undefined ? rowsIn(`${l.text} · 00:00`, inner - DOT) : l.more ? rowsIn(l.text, inner - GAP - textW(MORE)) : rowsIn(l.text, inner)), 0)

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
/** Bug 98: the boxes and lines that came out of buildBoard the same as last time (same JSON) are last time's objects, and when all of them
 *  did, so are the lists. ReactFlow then redraws only what changed: a hook that moves one engineer's activity line redraws its box alone. */
const shapes = new WeakMap<object, string>()
const shape = (x: object): string => { let k = shapes.get(x); if (k === undefined) { k = JSON.stringify(x); shapes.set(x, k) } return k }
function keep<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const old = new Map(prev.map((x) => [x.id, x]))
  const out = next.map((x) => { const o = old.get(x.id); return o && shape(o) === shape(x) ? o : x })
  return out.length === prev.length && out.every((x, i) => x === prev[i]) ? prev : out
}
export function boardKeeper(): (next: Board) => Board {
  let prev: Board | null = null
  return (next) => prev = prev ? { ...next, nodes: keep(prev.nodes, next.nodes), edges: keep(prev.edges, next.edges) } : next
}
/** `opened`: the done features the user opened (Bug 164, donefold.ts): their tickets stay on the board. */
export function buildBoard(s: State, now = Date.now(), repo: any = s.repos[0] ?? null, opened: ReadonlySet<string> = new Set()): Board {
  const agentById = new Map(s.agents.map((a) => [a.id, a])), ticketById = new Map(s.tickets.map((t) => [t.id, t]))
  // 1. Which boxes exist. Cancelled features stay only while one of their agents runs; a feature whose tickets all merged is done, and
  //    collapses unless the user opened it (Bug 164).
  const groups = s.features.filter((f) => f.status !== 'cancelled' || s.agents.some((a) => a.feature_id === f.id && live(a)))
    .sort((a, b) => a.created_at - b.created_at) // explicit: the backend sends newest first and patches prepend
    .map((f) => { const all = s.tickets.filter((t) => t.feature_id === f.id && t.status !== 'cancelled'), done = all.length > 0 && all.every((t) => t.status === 'merged')
      return { f, all, done, collapsed: done && !opened.has(f.id) } })
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
  /** The box's newest notice, else messages waiting for its agent, else what the agent is doing (`quiet`: not while it waits on the user).
   *  Bug 228: a hold on what HQ sends it shows with a notice too, and with nothing waiting yet: the next message would wait for it. */
  const note = (att: any[], a: Agent | null, quiet = false): Line[] => {
    const w = live(a) ? waitLine(a, s, now) : null, wait: Line | null = w && { text: w.text, tone: w.held ? 'amber' : 'muted' }
    if (att.length) {
      const ok = goodNews(att[0].kind), from = alertFrom(att[0], s, now) // Bug 165: not the running agent's
      const top: Line = { text: `${ok ? '✓' : '⚠'} ${kindLabel(att[0].kind)}${from ? ` (${from.tag})` : ''}: ${noLinks(att[0].detail)}`, tone: ok ? 'emerald' : 'rose' }
      return wait && w!.held ? [top, wait] : [top]
    }
    if (wait) return [wait]
    const doing = !quiet && live(a) ? liveActivity(a) : null // Bug 179: not "Thinking" on a dialog; its first line says it waits on one
    return doing ? [{ text: doing, tone: 'muted' }] : []
  }
  /** How full a running agent's context is; amber from 80% of its limit, rose past it. */
  const ctxLine = (a: Agent | null): Line | null => {
    if (!live(a)) return null
    const n = noteLine(a); if (n) return { text: n, tone: 'sky' } // the Agents card says the same (Bug 287)
    const share = ctxShare(a, s); if (share === null) return null
    return { text: `context ${kTok(a.context_tokens)} / ${kTok(ctxLimit(s, a.role)!)}${share >= 1 ? ' · full' : ''}`, tone: share >= 1 ? 'rose' : share >= 0.8 ? 'amber' : 'muted' }
  }
  const featureView = (g: (typeof groups)[number]): FeatureView => {
    const f = g.f, att = attOf.get(`f:${f.id}`) ?? [], done = g.done // finished: a small box, out of the way
    const merged = g.all.filter((t) => t.status === 'merged').length
    const lines: Line[] = done ? [{ text: `✓ done · all ${g.all.length} merged`, tone: 'emerald' }]
      : [{ text: g.all.length ? `${merged}/${g.all.length} merged` : f.status === 'cancelled' ? 'cancelled' : 'no tickets yet', tone: 'muted' }]
    const tested = done ? featureTestsLine(g.all) : null // its tickets are folded away: what HQ ran on them (Bug 126)
    if (tested) lines.push({ text: tested.text, tone: tested.passed ? 'emerald' : 'amber', tip: tested.tip })
    if (!done) lines.push(...note(att, null))
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
    if (reply) { const p = replyPreview(reply.body); lines.push({ text: `💬 ${p.text}`, tone: 'plain', more: p.more }) }
    lines.push(...note(att, tpm))
    const turn = yourTurn(s, repo?.id ?? null), mine = turnOn(turn)
    return { repo, tpm, live: up, lines, att, turn, tpmIds, empty: !s.features.length && !reply,
      border: mine ? '#f59e0b' : up ? agentColor[tpm.status] ?? '#3f3f46' : '#3f3f46' }
  }
  const ticketView = (t: any, all: any[], base: string, loop: boolean): TicketView => {
    const eng = liveEngineer(t, s), att = attOf.get(`t:${t.id}`) ?? []
    const review = s.reviews.find((r) => r.ticket_id === t.id && r.status === 'open') ?? null // a newer plan closes the older round
    // On auto no person is asked for a plan: HQ's plan check answers it (plancheck.ts), in seconds, or once a usage limit lifts
    const hqPlan = !!review && hqAnswersPlan(s, review), wait = review ? planWait(s, t.id, review) : null // whom its plan waits on; the Agents menu says the same (Bug 216)
    const question = ticketQuestion(s, t), who = question ? askedWho(question, s.agents) : '' // Bug 129: whom it waits on, and what it asked
    const waits = t.status === 'queued' ? unmerged(t, all) : [], dead = waits.filter((k) => !all.some((x) => x.key === k))
    const gone = dead.filter((k) => s.tickets.some((x) => x.feature_id === t.feature_id && x.key === k)), unknown = dead.filter((k) => !gone.includes(k))
    const mover = repo ? nextMover(repo, t) : 'user', auto = mover === 'hq' // HQ does the next step itself (backend mover.ts, as HQ's own words, Bug 292)
    // the clear stopped HQ's plan check: nothing reads the plan before the board goes (Bug 197), and HQ refuses starts and merges meanwhile (Bug 311)
    const clearing = mover === 'nobody'
    // Bug 401: the engineer's fix of what the user sent back from HQ's test is back (its conflicts, if any, come first: Fix conflicts is its button)
    const check0 = checkOf(t), back = mover === 'user' && t.conflict_files == null && fixBack(t, check0)
    // Bug 106: HQ's own test run on this ticket, while it goes. On a finished ticket it takes the place of "HQ tests it, then merges it"; anywhere else (a repair
    // whose engineer waits for HQ's try of its test command, a parked ticket whose run hasn't ended) it is a line of its own.
    const run = (s.testRuns ?? []).find((r) => r.ticket_id === t.id) ?? null, going = run?.state === 'running'
    const testing: Line | null = run ? { text: runWords(run, t.key, base).box, tone: going ? 'emerald' : 'sky', since: run.since, dot: run.state } : null
    const inPlace = !!run && run.what !== 'command' && (t.status === 'pr_ready' || t.status === 'pr_open') && !t.auto_parked_why
    // Bug 336: a parked ticket the user started by hand (Launch, Resume, Start, Fix …): while its engineer works its first line says what that engineer
    // does, as on any ticket, and the park comes under it. Auto mode still leaves the ticket to the user (mover.ts) until Try again, so it stays parked.
    const parkFirst = !!t.auto_parked_why && (!eng || t.status === 'pr_ready' || t.status === 'pr_open') // finished: its engineer is only on its way out
    const parkTip = `Auto mode parked it: ${t.auto_parked_why} ${parkNext(repo)}` // the Ticket tab's words (parkWords), for the mode it's in (Bug 364)
    const parked: Line | null = !t.auto_parked_why || parkFirst ? null : { text: `parked by auto mode: ${t.auto_parked_why}`, tone: 'rose', tip: parkTip }
    const detail: Line | null = inPlace ? testing : parkFirst ? { text: `parked: ${t.auto_parked_why}`, tone: 'rose', tip: parkTip }
      : wait && clearing ? { text: hqPlan ? "HQ won't check its plan: the project is being cleared" // Bug 197
        : 'its plan stays unanswered: the project is being cleared', tone: 'muted' } // Bug 231: HQ refuses an answer now
      : wait ? (wait.since !== null ? { text: wait.text, tone: 'sky', since: wait.since, dot: 'running' } : { text: wait.text, tone: wait.hq ? 'sky' : 'amber' })
      : t.pr_state === 'closed' ? { text: `PR #${t.pr_number} was closed without merging${closedNext(t, auto, base)}`, tone: 'rose' } // Bug 301: what now
      : t.status === 'resolving' ? (!eng ? { text: `${ticketLabel(t)} · its engineer stopped`, tone: 'rose' }
        : eng.status === 'idle' ? { text: `its engineer ${pauseStopped(eng) ? 'was stopped by the pause' : interrupted(eng) ? 'was interrupted' : 'went idle'} before finishing`,
          tone: 'rose' }
        : { text: t.fixing === 'changes' ? 'its spec changed · its engineer is building the change'
          : t.fixing === 'tests_hung' ? `its tests never finished on ${base} · its engineer is finding why`
          : t.fixing === 'review' ? 'a fresh reader of its changes found problems · its engineer is fixing them'
          : t.fixing === 'look' ? 'the app had problems when HQ opened it · its engineer is fixing them'
          : t.fixing === 'tests_unseen' ? "its tests passed, some for its criteria weren't seen · its engineer is on it" // Bug 373: nothing failed
          : t.fixing ? `its tests failed on ${base} · its engineer is fixing them`
          : `its engineer is merging ${base} in`, tone: 'amber' })
      : clearing && (t.status === 'pr_ready' || t.status === 'pr_open') ? { text: 'done · not merged: the project is being cleared', tone: 'muted' } // Bug 311
      : conflictText(t, base) && (t.status === 'pr_ready' || t.status === 'pr_open') ? { text: conflictText(t, base)!, tone: 'rose' }
      : auto && (t.status === 'pr_ready' || t.status === 'pr_open') ? { text: 'done · HQ tests it, then merges it', tone: 'indigo' }
      : back ? { text: `its engineer is back from round ${roundOf(t, check0!)} · test it again`, tone: 'sky', tip: 'You sent what HQ\'s test found to its engineer, and it '
        + 'has finished the ticket again. Fix is back · test again shows what it did; Test again there runs the next round.' }
      : t.status === 'pr_ready' && t.pr_state === 'local' ? { text: 'done · waiting for you to merge it', tone: 'indigo' }
      : t.status === 'pr_ready' && t.pr_state === 'waiting' ? { text: 'done · try it, then merge it or make a PR', tone: 'indigo' }
      : t.status === 'pr_ready' ? { text: `done · GitHub refused its PR: ${t.pr_url ? `open it with ${CREATE_PR}, or Merge to try again` // Bug 280: Merge opens one too
        : 'Merge or Make PR tries again'}`, tone: 'indigo' }
      : t.status === 'pr_open' ? { text: `done · PR #${t.pr_number} is open: merge it here or on GitHub`, tone: 'indigo' }
      : question ? { text: `asked ${who}: ${firstLine(question.body)}`, tone: 'amber' }
      : !eng && t.parked_at && RESUMABLE.includes(t.status) ? { text: 'parked · handoff note saved', tone: 'sky' }
      // its review closed, its status not caught up (Bug 234); writing its handoff note meanwhile, at work on that (Bug 287), as its card says
      // Bug 371: auto off, its spec changed after its plan was handed in: its engineer was asked for a new plan, for the user to approve (backend replan.ts)
      : eng && t.replan_after != null && !repo?.auto_mode && eng.status !== 'plan_review' ? { text: 'spec changed · a new plan comes for you to approve', tone: 'amber',
        tip: 'Its spec changed after its plan was approved. With auto mode off, HQ asked its engineer for a new plan for the change; it builds on once you approve it.' }
      : eng?.status === 'plan_review' ? { text: `engineer · ${agentPlanWait(eng, s).text}`, tone: 'muted' }
      : eng ? { text: `engineer · ${eng.in_plan_mode && eng.status === 'working' && !noteLine(eng) ? 'planning' : agentWord(eng)}${steps(eng)}`, tone: 'muted' }
      : t.status === 'queued' ? (loop ? { text: "dependency loop, can't start", tone: 'rose' }
        : dead.length ? { tone: 'rose', text: `waits on ${[gone.length ? `${gone.join(', ')} (removed)` : '',
          unknown.length ? `${unknown.join(', ')} (no such ticket)` : ''].filter(Boolean).join(', ')}: ask the TPM to rewire it` }
        : waits.length ? { text: `waits on ${waits.join(', ')} (not merged yet)`, tone: 'muted' }
        : clearing ? { text: "won't start: the project is being cleared", tone: 'muted' } // Bug 311: HQ refuses a start now
        : t.go_ahead ? { text: 'starts when an engineer slot frees up', tone: 'sky' } : auto ? { text: 'HQ starts it when the TPM finishes', tone: 'sky' } : { text: 'ready to start',
          tone: 'emerald' })
      : t.status === 'merged' ? null : { text: 'no engineer running', tone: 'muted' }
    const told = question?.to_target === 'user' ? att.filter((a) => a.kind !== 'message_for_user') : att // a question for the user: its first line says it already
    const notes = parkFirst ? [] : note(t.auto_parked_why ? told.filter((a) => a.kind !== 'auto_parked') : told, eng, !!review) // parked: its line says it
    const lines = [detail, inPlace ? null : testing, parked, ctxLine(eng), ...notes].filter((l): l is Line => !!l)
    const acts: Act[] = []
    // HQ refuses another go during a Clear (Bug 335) and with auto mode off (Bug 364): nothing would take it
    if (t.auto_parked_why && repo && autoRetries(repo)) acts.push({ kind: 'auto-retry' })
    const userMoves = mover === 'user' // not on auto (HQ does it), nor during a Clear (HQ refuses it, Bug 311)
    if (t.status === 'queued' && !t.assignee_agent_id && !waits.length && !loop && !t.go_ahead && userMoves) acts.push({ kind: 'launch', waits }) // go-ahead: starts on its own
    // Read plan opens it with every answer; no Approve HQ would race, or HQ refuses during a Clear (Bug 231)
    if (review) acts.push({ kind: 'read-plan' }, ...(hqPlan || clearing ? [] : [{ kind: 'approve' } as const]))
    if (question) acts.push({ kind: 'read-question' })
    if (!eng && RESUMABLE.includes(t.status) && t.branch && !clearing) acts.push({ kind: 'resume', parked: !!t.parked_at })
    const check = checkButton(t, userMoves) // with auto mode off: HQ tests this one ticket on request, and the button shows how that went (hqcheckrules.ts)
    if (check && back) acts.push({ kind: 'check', label: check.label }) // Bug 401: the fix is back: testing it again comes first, and Merge isn't the primary
    const pv = s.previews.find((p) => p.id === s.features.find((f) => f.id === t.feature_id)?.repo_id)
    if (tryable(t) && !clearing) acts.push({ kind: 'try', on: isOn(pv) && pv.ticket_id === t.id }) // look before merging (Bug 22); HQ refuses it during a Clear (Bug 335)
    if (userMoves) acts.push(...mergeActs(t, base, eng).map((a): Act => !back ? a : a.kind === 'merge' ? { ...a, soft: true } : a.kind === 'link' ? { ...a, primary: false } : a))
    if (check && !back) acts.push({ kind: 'check', label: check.label })
    if (!repo?.auto_mode && !clearing && (review || acts.some((a) => a.kind === 'merge'))) acts.push({ kind: 'do-rest' }) // every stop offers it; not a Clear (HQ refuses)
    // HQ at work on it: green, as a working engineer's
    const border = inPlace && going ? agentColor.working! : eng ? agentColor[shownStatus(eng, s)] ?? '#3f3f46' : ticketColor[t.status] ?? '#3f3f46'
    return { t, eng, review, hqPlan, clearing, question, askedWho: who, titleRows: 1, actRows: 0, lines, acts, att, compact: t.status === 'merged', border,
      crit: boxCriteria(criteriaOf(t)), back }
  }
  // 3. Sizes: a box is as wide as its header and its buttons need (within W..MAX; a feature's tickets share one width so its columns
  //    line up); then each line takes one or two rows, the buttons wrap, and the height adds it all up.
  const ticketWant = (v: TicketView) => {
    if (v.compact) { // one row: ✓ key · merged · what HQ ran on it (Bug 126), its PR, its ⚠
      const tested = mergeTestWords(mergeTestOf(v.t)), pr = v.t.pr_url && v.t.pr_number ? textW(`PR #${v.t.pr_number} ↗`) + GAP : 0
      return CHROME + textW(`✓ ${v.t.key}`) + textW('· merged') + (tested ? textW(`· ${tested.box}`) + GAP : 0) + pr + (v.att.length ? 30 : 0) + 3 * GAP + 12
    }
    const t = v.t, icons = (v.att.length ? 30 : 0) + (v.eng ? 16 : 0) + (t.status !== 'merged' && t.status !== 'cancelled' && !v.clearing ? 16 : 0) // ✕, not during a Clear
    return CHROME + Math.max(textW(t.key, true) + textW(t.size) + textW(ticketLabel(t, v.hqPlan, v.clearing, v.back, v.eng)) + 16 + icons + 20, rowW(v.acts.map(actLabel)))
  }
  const ticketFit = (v: TicketView, w: number) => {
    if (v.compact) return CHROME + ROW
    const inner = w - CHROME; v.titleRows = rowsIn(v.t.title, inner); v.actRows = actRows(v.acts.map(actLabel), inner)
    return CHROME + ROW + v.titleRows * ROW + (v.crit ? ROW : 0) + fitLines(v.lines, inner) * ROW + actsH(v.actRows)
  }
  const fviews = groups.map(featureView), tv0 = tpmView()
  const fw = fviews.map((v) => v.done ? W.ticket : clamp(CHROME + textW(v.f.title, true) + 64, W.feature, MAX.feature))
  const fh = fviews.map((v, i) => CHROME + ROW + fitLines(v.lines, fw[i]! - CHROME) * ROW)
  const tw0 = clamp(tv0.turn.asks.length || tv0.turn.questions?.length ? 400 : W.tpm, W.tpm, MAX.tpm), ti = tw0 - CHROME
  const th0 = CHROME + ROW + fitLines(tv0.lines, ti) * ROW + turnH(tv0.turn, ti) + INPUT_H
  // 4. Positions: tiers top to bottom; within a feature, one column per dependency depth, same-depth tickets stacked.
  const FEATURE_Y = th0 + TIER_GAP, TICKET_Y = FEATURE_Y + Math.max(0, ...fh) + TIER_GAP
  const nodes: Node[] = [], edges: Edge[] = []
  const hier = { stroke: '#3f3f46' } // hierarchy edges are right-angled, so stacked first-column tickets hang off one shared line
  let x = 0
  const groupIds: string[][] = [], waiting: string[][] = [], holding: string[][] = [] // each feature's boxes; those waiting on the user, those holding an agent up (Bug 365)
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
    groupIds.push([fid, ...vis.map((t) => `t:${t.id}`)])
    const inOrder: [string, TicketView | FeatureView][] = [[fid, fv], ...cols.flat().map((t): [string, TicketView] => [`t:${t.id}`, tv.get(t.id)!])]
    const pick = (ok: (v: TicketView | FeatureView) => boolean) => fv.done ? [] : inOrder.filter(([, v]) => ok(v)).map(([id]) => id)
    holding.push(pick(holdsUp)); waiting.push([...new Set([...holding.at(-1)!, ...pick(waitsOnYou)])]) // holding first, then board order
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
  const fits = fitSets(nodes.map((n) => n.id), groupIds.map((ids, i) => ({ ids, done: groups[i]!.collapsed, needsYou: !!waiting[i]!.length,
    waiting: waiting[i]!, holding: holding[i]!, opened: groups[i]!.done && !groups[i]!.collapsed,
    working: groups[i]!.all.some((t) => t.status !== 'merged' && !!liveEngineer(t, s)) })),
  turnOn(tv0.turn))
  return { nodes, edges, fits, has, attNode, agentNode, holds: holding.flat() }
}
