// What needs the user, across every repo (Bug 24): the tab title counts it, and new items pop up a browser notification while
// HQ's tab is in the background. Pure and self-contained, so the backend's test runner unit-tests it (src/needs.test.ts).

import { FINISHED, readyTickets } from '../../backend/src/readiness.ts'
import { nextMover } from '../../backend/src/mover.ts'

type S = { repos: any[]; features: any[]; tickets: any[]; agents: any[]; reviews: any[]; attention: any[]; asks?: any[]; questions?: Question[]; settings?: Record<string, any>
  defaults?: Record<string, any>
  working?: number; testRuns?: { repo_id: string }[] }
/** Whether an open plan review waits for HQ's plan check and not for the user: its project is on auto (also while auto is stopped: running engineers finish,
 *  and HQ still answers their plans). Such a plan is never "your turn", and nothing pops up for it. */
export function hqAnswersPlan(s: Pick<S, 'repos' | 'features' | 'tickets'>, review: { ticket_id: string }): boolean { return !!reviewRepo(s, review)?.auto_mode }
/** Bug 231: an open plan nobody may answer now: its project is being cleared (the clear stopped its engineer, and HQ refuses an answer). It is still
 *  readable, but it is nobody's turn. */
export const clearingPlan = (s: Pick<S, 'repos' | 'features' | 'tickets'>, review: { ticket_id: string }): boolean => !!reviewRepo(s, review)?.clearing_at
function reviewRepo(s: Pick<S, 'repos' | 'features' | 'tickets'>, review: { ticket_id: string }): any {
  const t = s.tickets.find((x) => x.id === review.ticket_id), f = t && s.features.find((x) => x.id === t.feature_id)
  return f ? s.repos.find((r) => r.id === f.repo_id) : undefined
}
/** The project a notice's kind names (repo_sync:<id>, auto_stopped:<id>, test_cmd_proposed:<id>, test_cmd_refused:<id>): those notices have no ticket or agent to go by. */
const kindRepo = (k: string): string | null => /^[a-z_]+:(.+)$/.exec(k)?.[1] ?? null
/** Only the picked repo's work: its features, their tickets, agents, messages and reviews, and the notices about them or about the
 *  repo itself. Notices about nothing in particular (the usage limit, an HQ error) stay. Each repo is a slate of its own; the others'
 *  work is still in HQ, and the chip beside ⚠ says what it needs (Bug 63). */
/** The default branch of a ticket's project: what HQ tests it on and merges it into (Bug 210: not always main). */
export function ticketBase(s: Pick<S, 'repos' | 'features' | 'tickets'>, ticketId: string | null | undefined): string {
  const t = s.tickets.find((x) => x.id === ticketId), f = s.features.find((x) => x.id === t?.feature_id)
  return s.repos.find((r) => r.id === f?.repo_id)?.default_branch ?? 'main'
}
export function forRepo<T extends S & { messages: any[] }>(s: T, repoId: string | null): T {
  const fids = new Set(s.features.filter((f) => f.repo_id === repoId).map((f) => f.id))
  const tickets = s.tickets.filter((t) => fids.has(t.feature_id)), tids = new Set(tickets.map((t) => t.id))
  const agents = s.agents.filter((a) => a.repo_id ? a.repo_id === repoId : !a.feature_id || fids.has(a.feature_id)), aids = new Set(agents.map((a) => a.id))
  const mine = (x: { agent_id?: string | null; ticket_id?: string | null }) => x.ticket_id ? tids.has(x.ticket_id) : x.agent_id ? aids.has(x.agent_id) : true
  const about = (a: any) => { const r = kindRepo(a.kind); return r ? r === repoId : mine(a) }
  return { ...s, features: s.features.filter((f) => fids.has(f.id)), tickets, agents, reviews: s.reviews.filter(mine), attention: s.attention.filter(about),
    asks: (s.asks ?? []).filter((a) => a.repo_id === repoId), working: workingEngineers(s), questions: (s.questions ?? []).filter((x) => tids.has(x.ticket_id ?? '')),
    ...(s.testRuns ? { testRuns: s.testRuns.filter((r) => r.repo_id === repoId) } : {}), // HQ's own test runs (Bug 106)
    messages: s.messages.filter((m) => m.repo_id ? m.repo_id === repoId : m.feature_id ? fids.has(m.feature_id) : [m.from_id, m.to_id].every((x) => !x || x === 'user' || x === 'hq' || aids.has(x))) }
}
/** Engineers using a parallel slot (finished ones don't). */
export const workingEngineers = (s: { agents: any[]; tickets: any[] }): number =>
  s.agents.filter((a) => a.role === 'engineer' && a.status !== 'exited' && !FINISHED.includes(s.tickets.find((t) => t.id === a.ticket_id)?.status ?? '')).length
/** An engineer's open question (Bug 129; the backend's delivery.ts QuestionView). `to_target`: an agent id, 'user' or 'team'. */
export type Question = { id: string; ticket_id: string | null; from_agent_id: string; to_target: string; message_id: string; asked_at: number; answered_at?: number | null; body: string }
/** The question a ticket waits on: the newest open one, and only while the ticket says it has a question. */
export function ticketQuestion(s: { questions?: Question[] }, t: any): Question | null {
  if (t?.status !== 'awaiting_answer') return null
  return (s.questions ?? []).filter((x) => x.ticket_id === t.id && !x.answered_at).sort((a, b) => b.asked_at - a.asked_at || b.id.localeCompare(a.id))[0] ?? null
}
/** Who a question waits on, in words: "you", "the TPM", "the team", or the agent's name. */
export function askedWho(x: Question, agents: any[]): string {
  if (x.to_target === 'user') return 'you'
  if (x.to_target === 'team') return 'the team'
  const a = agents.find((g) => g.id === x.to_target)
  return a?.role === 'tpm' ? 'the TPM' : a ? String(a.display_name ?? a.id) : 'another agent'
}
/** The question's first line with words in it (markdown marks taken off), for a box's one or two rows. */
export const firstLine = (text: string): string => String(text).split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*|`/g, '').trim()).find(Boolean) ?? ''
/** A question for the user in Your turn: the ticket it's about and what its engineer asked. */
export type TurnQuestion = { id: string; ticketId: string; key: string; text: string; agentId: string }
export const turnQuestionText = (x: TurnQuestion): string => `${x.key}'s engineer asked you: ${x.text}`
/** Your turn's questions that ⚠ doesn't count yet: a question for the user is counted by its engineer's "Message for you" notice, and on its own
 *  once that notice is gone (✓ hides it while the question is still open), so it is never counted twice or not at all. */
export const uncountedQuestions = (s: { attention: any[] }, turn: Turn): TurnQuestion[] => (turn.questions ?? [])
  .filter((x) => !s.attention.some((a) => !a.resolved_at && a.kind === 'message_for_user' && a.agent_id === x.agentId))
/** A question the TPM asked with ask_user, its choices as a list. */
export type Ask = { id: string; question: string; choices: string[]; action?: boolean }
/** What the project waits on the user for (Bug 43, on the TPM box since Bug 52): the TPM's open questions, and the ready
 *  tickets of every feature (each in its merge order) when an engineer slot is free. A full parallel limit doesn't nag: those
 *  tickets start as engineers finish. */
export type Turn = { asks: Ask[]; start: string[]; auto?: boolean; questions?: TurnQuestion[] } // questions: engineers' questions for the user (Bug 129)
const list = (v: unknown): string[] => { try { const x = JSON.parse(String(v || '[]')); return Array.isArray(x) ? x.map(String) : [] } catch { return [] } }
export function yourTurn(s: S, repoId: string | null): Turn {
  const open = (s.asks ?? []).filter((a) => a.repo_id === repoId && !a.answered_at)
  const asks = open.map((a) => ({ id: a.id, question: String(a.question), choices: list(a.choices), action: !!a.action }))
  const going = new Set(open.map((a) => { try { return a.action ? String(JSON.parse(a.action).ticket) : '' } catch { return '' } })) // Bug 50: asked to remove it
  const cap = Number(s.settings?.concurrency_cap ?? s.defaults?.concurrency_cap ?? 2), r = s.repos?.find((x) => x.id === repoId)
  // the user's to start (backend mover.ts): not on auto (HQ starts them), nor during a Clear (HQ refuses a start, Bug 311); a parked one is theirs (Bug 292)
  const mine = (t: any): boolean => !r || nextMover(r, t) === 'user'
  const ready = s.features.filter((f) => f.repo_id === repoId && f.status !== 'cancelled').sort((a, b) => a.created_at - b.created_at)
    .flatMap((f) => readyTickets(s.tickets.filter((t) => t.feature_id === f.id && !going.has(t.id)), list(f.merge_order)).filter(mine).map((t) => t.key))
  const fids = new Set(s.features.filter((f) => f.repo_id === repoId).map((f) => f.id))
  const questions = s.tickets.filter((t) => fids.has(t.feature_id)).flatMap((t) => { const x = ticketQuestion(s, t)
    return x && x.to_target === 'user' ? [{ id: x.id, ticketId: t.id, key: String(t.key), text: firstLine(x.body), agentId: x.from_agent_id }] : [] })
  return { asks, start: ready.length && (s.working ?? workingEngineers(s)) < cap ? ready : [], ...(r?.auto_mode ? { auto: true } : {}),
    ...(questions.length ? { questions } : {}) }
}
/** "T1", "T1 and T2", "T1, T2 and T3". */
export const keysText = (keys: string[]): string => keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`
/** `ref` says which box to open when the user clicks the notification. */
export type Need = { key: string; text: string; repoId: string | null; ref: { review: string } | { ticket: string } | { attention: string } | { tpm: string } }
/** Notices that alert: an agent is stuck, blocked, asking the user, sent back too often or stopped when it shouldn't have, or
 *  finished work can't go further. Information (merged, memory filling up, model notes) is left to the ⚠ menu. */
export const ALERT_KINDS = new Set(['stuck', 'blocked', 'dialog', 'message_for_user', 'cap_reached', 'engineer_exited', 'agent_exited', 'launch_failed',
  'fresh_start_failed', 'merge_conflict', 'fix_stalled', 'look_stalled',
  'review_stalled', 'change_stalled', 'delivery_failed', 'dm_refused', 'tpm_away', 'unexpected_prompt', 'usage_limit', 'rate_limit', 'api_error',
  'pr_failed', 'push_failed', 'auto_parked', 'leftovers_stuck', 'leftovers_cant_check', 'bg_stalled', 'engineer_idle',
  'claude_unchecked']) // Bug 97: agents on a Claude Code HQ wasn't checked on. A newer one merely installed (claude_newer) is information
/** Good news: green, not red, because nothing is wrong (Bug 61). */
export const goodNews = (kind: string): boolean => kind === 'merged' || kind === 'conflicts_fixed' || kind.startsWith('auto_finished:') || kind.startsWith('project_removed') // Bug 66's notice
  || kind.startsWith('repo_cleared:') || kind.startsWith('repo_testsetup_ok:') // Bug 251: a clean Clear, a checked test setup (their problems have kinds of their own)
/** Plain information: nothing is wrong and nothing is asked, so neither red nor green (Bug 97: a newer Claude Code is installed, and HQ's agents stay put). */
export const plainNews = (kind: string): boolean => kind === 'claude_newer'
/** Notices about a whole project that need the user: they name their project in the kind. Auto mode's own, a test command engineers can't run (Bug 107),
 *  and a Clear that left worktrees or whose TPM didn't start again (Bug 285; its good news, `repo_cleared:`, is green and doesn't count). */
export const projectNeeds = (k: string): boolean => /^(auto_stopped|auto_finished|test_cmd_proposed|test_cmd_refused|repo_cleared_left|repo_clear_tpm):/.test(k)

/** Everything that needs the user right now, oldest kind first: the TPM's questions and tickets ready to start (Bug 43), plans
 *  waiting for review, finished tickets waiting for their merge (or for Fix conflicts), then alerting notices. `mergeAct` says what a finished ticket waits for (board.ts mergeActs). */
export function needsYou(s: S, mergeAct: (t: any) => 'merge' | 'fix' | null): Need[] {
  const feature = (id: unknown) => s.features.find((f) => f.id === id)
  const repoOf = (t: any): string | null => feature(t?.feature_id)?.repo_id ?? null
  const where = (repoId: string | null) => { const r = s.repos.find((x) => x.id === repoId); return r ? `${r.name}: ` : '' }
  const named = (repoId: string | null, text: string) => text.startsWith(where(repoId)) ? text : `${where(repoId)}${text}` // auto notices already start with it
  const out: Need[] = []
  for (const r of s.repos) {
    const turn = yourTurn(s, r.id), ref = { tpm: r.id }
    for (const a of turn.asks) out.push({ key: `ask:${a.id}`, text: `${where(r.id)}the TPM asked: ${a.question.slice(0, 160)}`, repoId: r.id, ref })
    for (const x of uncountedQuestions(s, turn)) out.push({ key: `question:${x.id}`, text: `${where(r.id)}${turnQuestionText(x).slice(0, 160)}`, repoId: r.id, ref: { ticket: x.ticketId } })
    const are = turn.start.length > 1 ? 'are' : 'is'
    if (turn.start.length) out.push({ key: `start:${r.id}:${turn.start.join(',')}`, text: `${where(r.id)}${keysText(turn.start)} ${are} ready to start`, repoId: r.id, ref })
  }
  for (const r of s.reviews.filter((x) => x.status === 'open')) {
    const t = s.tickets.find((x) => x.id === r.ticket_id), repo = repoOf(t)
    if (hqAnswersPlan(s, r) || clearingPlan(s, r)) continue // on auto its plan waits for HQ's plan check, not for you; during a Clear for nobody
    out.push({ key: `review:${r.id}`, text: `${where(repo)}${t?.key ?? 'a ticket'}'s plan is waiting for you`, repoId: repo, ref: { review: r.id } })
  }
  for (const t of s.tickets) {
    const f = feature(t.feature_id); if (!f || f.status === 'cancelled') continue
    const act = mergeAct(t); if (!act) continue
    out.push({ key: `${act}:${t.id}`, repoId: f.repo_id, ref: { ticket: t.id },
      text: act === 'merge' ? `${where(f.repo_id)}${t.key} is finished and waiting for you to merge it`
        : t.status === 'resolving' && t.fixing === 'changes' ? `${where(f.repo_id)}${t.key}'s change isn't built yet and its engineer stopped: press Build the change`
        : t.status === 'resolving' && t.fixing === 'review' ? `${where(f.repo_id)}what a reader found in ${t.key} isn't fixed yet and its engineer stopped: press Fix what it found`
        : t.status === 'resolving' && t.fixing === 'look' ? `${where(f.repo_id)}${t.key}'s app problems aren't fixed yet and its engineer stopped: press Fix the app`
        : t.status === 'resolving' && t.fixing ? `${where(f.repo_id)}${t.key}'s tests aren't fixed yet and its engineer stopped: press Fix tests`
        : `${where(f.repo_id)}${t.key} clashes with ${ticketBase(s, t.id)}: press Fix conflicts` })
  }
  for (const a of s.attention.filter((x) => !x.resolved_at && (ALERT_KINDS.has(x.kind) || projectNeeds(x.kind)))) {
    const t = s.tickets.find((x) => x.id === a.ticket_id), ag = s.agents.find((x) => x.id === a.agent_id)
    const repo = kindRepo(a.kind) ?? (t ? repoOf(t) : ag?.repo_id ?? feature(ag?.feature_id)?.repo_id ?? null)
    out.push({ key: `attention:${a.id}`, text: named(repo, String(a.detail ?? a.kind).slice(0, 160)), repoId: repo, ref: { attention: a.id } })
  }
  return out
}
/** `here`: what this project's ⚠ counts, which includes what's about no project (the usage limit). `elsewhere`: the chip beside it. Together they're the tab title's count. */
export const splitNeeds = (needs: Need[], repoId: string | null): { here: Need[]; elsewhere: Need[] } =>
  ({ here: needs.filter((n) => !n.repoId || n.repoId === repoId), elsewhere: needs.filter((n) => n.repoId && n.repoId !== repoId) })

/** The items in `now` that weren't there before (`seen`, null on the first look: then nothing is new, so loading or reloading the
 *  page never pops anything up). Returns them and the keys to remember next time. */
export function newNeeds(seen: Set<string> | null, now: Need[]): { fresh: Need[]; seen: Set<string> } {
  const keys = new Set(now.map((n) => n.key))
  return { fresh: seen ? now.filter((n) => !seen.has(n.key)) : [], seen: keys }
}

/** Which Claude Code the agents run, in a line for the Agents menu (Bug 97). `warn`: it isn't the version HQ was checked on. */
export function claudeLine(c: { checked: string; runs: string | null; installed: string | null }): { text: string; warn: boolean } {
  if (c.runs !== c.checked) return { warn: true, text: c.runs ? `Agents run Claude Code ${c.runs}. HQ was checked on ${c.checked}.`
    : `HQ can't tell which Claude Code agents run. It was checked on ${c.checked}.` }
  const here = c.installed && c.installed !== c.runs ? ` This computer's own is ${c.installed}.` : ''
  return { warn: false, text: `Agents run Claude Code ${c.runs}, the version HQ was checked on.${here}` }
}
/** The tab title: "(2) HQ" while two things need the user. */
export const titleFor = (n: number): string => n ? `(${n}) HQ` : 'HQ'
