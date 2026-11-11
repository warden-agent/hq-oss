// What needs the user, across every repo (Bug 24): the tab title counts it, and new items pop up a browser notification while
// HQ's tab is in the background. Pure and self-contained, so the backend's test runner unit-tests it (src/needs.test.ts).

import { FINISHED, readyTickets } from '../../backend/src/readiness.ts'

type S = { repos: any[]; features: any[]; tickets: any[]; agents: any[]; reviews: any[]; attention: any[]; asks?: any[]; settings?: Record<string, any>; defaults?: Record<string, any>
  working?: number }
/** The project a notice's kind names (repo_sync:<id>, auto_stopped:<id>, test_cmd_proposed:<id>): those notices have no ticket or agent to go by. */
const kindRepo = (k: string): string | null => /^[a-z_]+:(.+)$/.exec(k)?.[1] ?? null
/** Only the picked repo's work: its features, their tickets, agents, messages and reviews, and the notices about them or about the
 *  repo itself. Notices about nothing in particular (the usage limit, an HQ error) stay. Each repo is a slate of its own; the others'
 *  work is still in HQ, and the chip beside ⚠ says what it needs (Bug 63). */
export function forRepo<T extends S & { messages: any[] }>(s: T, repoId: string | null): T {
  const fids = new Set(s.features.filter((f) => f.repo_id === repoId).map((f) => f.id))
  const tickets = s.tickets.filter((t) => fids.has(t.feature_id)), tids = new Set(tickets.map((t) => t.id))
  const agents = s.agents.filter((a) => a.repo_id ? a.repo_id === repoId : !a.feature_id || fids.has(a.feature_id)), aids = new Set(agents.map((a) => a.id))
  const mine = (x: { agent_id?: string | null; ticket_id?: string | null }) => x.ticket_id ? tids.has(x.ticket_id) : x.agent_id ? aids.has(x.agent_id) : true
  const about = (a: any) => { const r = kindRepo(a.kind); return r ? r === repoId : mine(a) }
  return { ...s, features: s.features.filter((f) => fids.has(f.id)), tickets, agents, reviews: s.reviews.filter(mine), attention: s.attention.filter(about),
    asks: (s.asks ?? []).filter((a) => a.repo_id === repoId), working: workingEngineers(s),
    messages: s.messages.filter((m) => m.repo_id ? m.repo_id === repoId : m.feature_id ? fids.has(m.feature_id) : [m.from_id, m.to_id].every((x) => !x || x === 'user' || x === 'hq' || aids.has(x))) }
}
/** Engineers using a parallel slot (finished ones don't). */
export const workingEngineers = (s: { agents: any[]; tickets: any[] }): number =>
  s.agents.filter((a) => a.role === 'engineer' && a.status !== 'exited' && !FINISHED.includes(s.tickets.find((t) => t.id === a.ticket_id)?.status ?? '')).length
/** A question the TPM asked with ask_user, its choices as a list. */
export type Ask = { id: string; question: string; choices: string[]; action?: boolean }
/** What the project waits on the user for (Bug 43, on the TPM box since Bug 52): the TPM's open questions, and the ready
 *  tickets of every feature (each in its merge order) when an engineer slot is free. A full parallel limit doesn't nag: those
 *  tickets start as engineers finish. */
export type Turn = { asks: Ask[]; start: string[]; auto?: boolean }
const list = (v: unknown): string[] => { try { const x = JSON.parse(String(v || '[]')); return Array.isArray(x) ? x.map(String) : [] } catch { return [] } }
export function yourTurn(s: S, repoId: string | null): Turn {
  const open = (s.asks ?? []).filter((a) => a.repo_id === repoId && !a.answered_at)
  const asks = open.map((a) => ({ id: a.id, question: String(a.question), choices: list(a.choices), action: !!a.action }))
  const going = new Set(open.map((a) => { try { return a.action ? String(JSON.parse(a.action).ticket) : '' } catch { return '' } })) // Bug 50: asked to remove it
  const ready = s.features.filter((f) => f.repo_id === repoId && f.status !== 'cancelled').sort((a, b) => a.created_at - b.created_at)
    .flatMap((f) => readyTickets(s.tickets.filter((t) => t.feature_id === f.id && !going.has(t.id)), list(f.merge_order)).map((t) => t.key))
  const cap = Number(s.settings?.concurrency_cap ?? s.defaults?.concurrency_cap ?? 2), r = s.repos?.find((x) => x.id === repoId)
  const auto = !!r?.auto_mode && !r.auto_stopped_why // HQ starts them itself
  return { asks, start: !auto && ready.length && (s.working ?? workingEngineers(s)) < cap ? ready : [], ...(r?.auto_mode ? { auto: true } : {}) }
}
/** "T1", "T1 and T2", "T1, T2 and T3". */
export const keysText = (keys: string[]): string => keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`
/** `ref` says which box to open when the user clicks the notification. */
export type Need = { key: string; text: string; repoId: string | null; ref: { review: string } | { ticket: string } | { attention: string } | { tpm: string } }
/** Notices that alert: an agent is stuck, blocked, asking the user, sent back too often or stopped when it shouldn't have, or
 *  finished work can't go further. Information (merged, memory filling up, model notes) is left to the ⚠ menu. */
export const ALERT_KINDS = new Set(['stuck', 'blocked', 'dialog', 'message_for_user', 'cap_reached', 'engineer_exited', 'agent_exited', 'launch_failed',
  'fresh_start_failed', 'merge_conflict', 'fix_stalled', 'change_stalled', 'delivery_failed', 'dm_refused', 'tpm_away', 'unexpected_prompt', 'usage_limit', 'rate_limit', 'api_error',
  'pr_failed', 'push_failed', 'auto_parked', 'leftovers_stuck', 'leftovers_cant_check', 'bg_stalled', 'engineer_idle',
  'claude_unchecked']) // Bug 97: agents on a Claude Code HQ wasn't checked on. A newer one merely installed (claude_newer) is information
/** Good news: green, not red, because nothing is wrong (Bug 61). */
export const goodNews = (kind: string): boolean => kind === 'merged' || kind === 'conflicts_fixed' || kind.startsWith('auto_finished:') || kind.startsWith('project_removed') // Bug 66's notice
/** Plain information: nothing is wrong and nothing is asked, so neither red nor green (Bug 97: a newer Claude Code is installed, and HQ's agents stay put). */
export const plainNews = (kind: string): boolean => kind === 'claude_newer'
/** Auto mode's own notices that need the user: they name their project in the kind. */
const autoNeeds = (k: string): boolean => /^(auto_stopped|auto_finished|test_cmd_proposed):/.test(k)

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
    const are = turn.start.length > 1 ? 'are' : 'is'
    if (turn.start.length) out.push({ key: `start:${r.id}:${turn.start.join(',')}`, text: `${where(r.id)}${keysText(turn.start)} ${are} ready to start`, repoId: r.id, ref })
  }
  for (const r of s.reviews.filter((x) => x.status === 'open')) {
    const t = s.tickets.find((x) => x.id === r.ticket_id), repo = repoOf(t)
    out.push({ key: `review:${r.id}`, text: `${where(repo)}${t?.key ?? 'a ticket'}'s plan is waiting for you`, repoId: repo, ref: { review: r.id } })
  }
  for (const t of s.tickets) {
    const f = feature(t.feature_id); if (!f || f.status === 'cancelled') continue
    const act = mergeAct(t); if (!act) continue
    out.push({ key: `${act}:${t.id}`, repoId: f.repo_id, ref: { ticket: t.id },
      text: act === 'merge' ? `${where(f.repo_id)}${t.key} is finished and waiting for you to merge it`
        : t.status === 'resolving' && t.fixing === 'changes' ? `${where(f.repo_id)}${t.key}'s change isn't built yet and its engineer stopped: press Build the change`
        : t.status === 'resolving' && t.fixing ? `${where(f.repo_id)}${t.key}'s tests aren't fixed yet and its engineer stopped: press Fix tests`
        : `${where(f.repo_id)}${t.key} clashes with main: press Fix conflicts` })
  }
  for (const a of s.attention.filter((x) => !x.resolved_at && (ALERT_KINDS.has(x.kind) || autoNeeds(x.kind)))) {
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
