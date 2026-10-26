// Finished tickets: open_pr (push + PR, or wait for "Merge into main"), and noticing merges by themselves.
import { attention, resolveForTicket, resolveKind } from './attention.ts'
import { branchMerged, parseGithubRemote } from './reposync.ts'
import { decidingPr, openOrLink, prsForBranch, pushBranch, type Pr } from './github.ts'
import { FINISHED, readyDependents } from './readiness.ts'
import { one, q, run, now } from './db.ts'
import { bus, emit } from './events.ts'
import { j } from './util.ts'
import { mergeIntoMain } from './localmerge.ts'
import { getAgent, stopAgent, type Agent } from './agents.ts'
import { sendMessage } from './delivery.ts'
import { getFeature, getRepo, getTicket, sweepNotices, setTicket, ticketForAgent, tickets, type Feature, type Repo, type Ticket } from './records.ts'
import { ghOpts, git, syncRepo } from './repos.ts'
import { releaseWorktree } from './slots.ts'

/** open_pr: the engineer is done. GitHub repos: push its branch and open the PR as the HQ account, so the user only merges it
 *  (if GitHub refuses the PR, they get a pre-filled "Create PR" link instead). Local repos: the ticket waits for the user's
 *  "Merge into main" (mergeTicket). Either way HQ notices the merge (checkMerges). Waiting for a merge isn't an alert: the
 *  box and the ⚠ menu show it until it's merged. */
export async function finishTicket(agent: Agent, title: string, body: string): Promise<string> {
  const t = ticketForAgent(agent); if (!t || !t.branch || !t.worktree_path) throw new Error('no ticket bound')
  if (FINISHED.includes(t.status)) return `${t.key} is already ${t.status}; nothing more to do. Stop here.`
  const f = getFeature(t.feature_id)!; const repo = getRepo(f.repo_id)!
  const dirty = await git(t.worktree_path, 'status', '--porcelain')
  if (dirty) throw new Error(`Commit your work first. Uncommitted:\n${dirty.split('\n').slice(0, 15).join('\n')}`)
  const slug = repo.kind === 'github' ? parseGithubRemote(repo.remote ?? '') : null
  const base = slug ? `refs/remotes/origin/${repo.default_branch}` : `refs/heads/${repo.default_branch}`
  const ahead = Number(await git(repo.path, 'rev-list', '--count', `${base}..refs/heads/${t.branch}`).catch(() => '0'))
  if (!ahead) throw new Error(`${t.branch} has no commits beyond ${repo.default_branch}. Commit your work, then call open_pr again.`)
  run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
    `ticket:${t.id}`, 'pr', `# ${title}\n\n${body}`, now())
  if (!slug) {
    setTicket(t.id, { status: 'pr_ready', pr_url: null, pr_state: 'local' })
    emit({ agentId: agent.id, source: 'system', kind: 'ticket.pr_ready', payload: { ticket: t.id, key: t.key, branch: t.branch, pushed: false } })
    tellTpm(f, `HQ: ${t.key} is finished (${t.branch}). The user merges it into ${repo.default_branch} from HQ; you'll be told when it merges.`)
    bus.emit('slot.freed') // its parallel slot is free now (listeners.ts)
    return `Done. The user merges ${t.branch} into ${repo.default_branch} from HQ. You're done: stop now.`
  }
  try { await pushBranch(repo.path, slug, t.branch, ghOpts()) } catch (e) {
    attention('push_failed', `${t.key}: ${(e as Error).message}`, { agentId: agent.id, ticketId: t.id })
    throw new Error(`HQ could not push ${t.branch}: ${(e as Error).message}. The user has been told; stop and wait for a message.`)
  }
  const pr = await openTicketPr({ ...t, assignee_agent_id: agent.id }, repo, slug, title, body)
  bus.emit('slot.freed') // its parallel slot is free now (listeners.ts)
  return pr ? `Pushed ${t.branch} and opened PR #${pr.number}. The user merges it; HQ tells the TPM when it merges. You're done: stop now.`
    : `Pushed ${t.branch}. HQ couldn't open the PR, so the user got a link to open it themselves. You're done: stop now.`
}
/** HQ's own notice to the feature's TPM (from 'hq': the TPM can tell it from the user's words). */
export const tellTpm = (f: Feature, body: string): void => { if (f.tpm_agent_id) sendMessage({ featureId: f.id, channel: 'dm', from: 'hq', to: f.tpm_agent_id, reason: 'fyi', body }) }
/** Open the ticket's PR (branch already pushed). Opened → `pr_open`, the user is told to merge it. GitHub refused → `pr_ready` with a
 *  pre-filled "Create PR" link and the reason; checkMerges retries while nobody has opened a PR. */
async function openTicketPr(t: Ticket, repo: Repo, slug: string, title: string, body: string): Promise<Pr | null> {
  const f = getFeature(t.feature_id)!; const branch = t.branch!
  const r = await openOrLink(slug, repo.default_branch, branch, title, body, ghOpts())
  if ('pr' in r) {
    setTicket(t.id, { status: 'pr_open', pr_number: r.pr.number, pr_url: r.pr.url, pr_state: 'open' })
    emit({ agentId: t.assignee_agent_id, source: 'system', kind: 'ticket.pr_open', payload: { ticket: t.id, key: t.key, branch, pr: r.pr.number } })
    for (const k of ['pr_ready', 'pr_failed']) resolveKind(k, t.assignee_agent_id) // an older link or failure note is moot now
    tellTpm(f, `HQ: ${t.key} is finished; PR #${r.pr.number} is open (${branch}). The user merges it; you'll be told when it merges.`)
    return r.pr
  }
  const first = t.status !== 'pr_ready' // a watcher retry doesn't re-announce
  setTicket(t.id, { status: 'pr_ready', pr_url: r.link, pr_state: 'not_opened' })
  emit({ agentId: t.assignee_agent_id, source: 'system', kind: 'ticket.pr_ready', payload: { ticket: t.id, key: t.key, branch, pushed: true, error: r.error } })
  attention('pr_failed', `${t.key}: HQ pushed ${branch} but couldn't open the PR (${r.error}). Open it yourself → ${r.link}`, { agentId: t.assignee_agent_id, ticketId: t.id })
  if (first) tellTpm(f, `HQ: ${t.key} is finished and pushed (${branch}). The user opens and merges the PR; you'll be told when it merges.`)
  return null
}

let checking: Promise<void> | null = null
/** Notice merges by itself. GitHub repos ask GitHub for the ticket branch's PR (catches squash merges too); local repos check git. */
export function checkMerges(): Promise<void> {
  if (checking) return checking
  checking = (async () => {
    const waiting = q<Ticket & { repo_id: string }>(`SELECT t.*, f.repo_id FROM tickets t JOIN features f ON f.id = t.feature_id
      WHERE t.status IN ('pr_ready', 'pr_open') AND f.status != 'cancelled' AND t.branch IS NOT NULL`)
    for (const t of waiting) {
      const repo = getRepo(t.repo_id); if (!repo || !t.branch) continue
      const slug = repo.kind === 'github' ? parseGithubRemote(repo.remote ?? '') : null
      if (!slug) { if (await branchMerged(repo.path, t.branch, `refs/heads/${repo.default_branch}`)) markMerged(t, null); continue }
      const prs = await prsForBranch(slug, t.branch, ghOpts()).catch(() => null) // null: GitHub couldn't be asked
      const pr = decidingPr(prs ?? [])
      if (pr?.state === 'MERGED') markMerged(t, pr)
      else if (pr?.state === 'OPEN') {
        if (t.status !== 'pr_open' || t.pr_number !== pr.number || t.pr_state !== 'open') setTicket(t.id, { status: 'pr_open', pr_number: pr.number, pr_url: pr.url, pr_state: 'open' })
      } else if (pr?.state === 'CLOSED') {
        if (t.pr_state !== 'closed') {
          setTicket(t.id, { pr_number: pr.number, pr_url: pr.url, pr_state: 'closed' })
          attention('pr_closed', `${t.key}: PR #${pr.number} was closed without merging`, { agentId: t.assignee_agent_id, ticketId: t.id })
        }
      }
      else if (await branchMerged(repo.path, t.branch, `refs/remotes/origin/${repo.default_branch}`)) markMerged(t, null) // merged without a PR
      else if (prs && t.status === 'pr_ready' && t.pr_state === 'not_opened') { // no PR yet: try opening it again
        const doc = one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', `ticket:${t.id}`, 'pr')
        const m = doc?.text.match(/^# (.*)\n\n([\s\S]*)$/)
        if (m) await openTicketPr(t, repo, slug, m[1]!, m[2]!)
      }
    }
  })().finally(() => { checking = null })
  return checking
}
function markMerged(t: Ticket, pr: Pr | null): void {
  if (getTicket(t.id)?.status === 'merged') return // the watcher and Merge into main can both see the same merge
  setTicket(t.id, { status: 'merged', pr_state: 'merged', ...(pr ? { pr_number: pr.number, pr_url: pr.url } : {}) })
  emit({ agentId: t.assignee_agent_id, source: 'system', kind: 'ticket.merged', payload: { ticket: t.id, key: t.key, pr: pr?.number ?? null } })
  const a = t.assignee_agent_id ? getAgent(t.assignee_agent_id) : undefined
  if (t.assignee_agent_id) for (const k of ['pr_ready', 'pr_open', 'pr_failed']) resolveKind(k, t.assignee_agent_id)
  resolveForTicket(t.id) // its work is in main: older notices about it (exited, stuck, blocked…) are moot
  if (a && a.status !== 'exited') void stopAgent(a.id, 'merged') // its work is in main now; once it's gone its worktree goes too
  else void releaseWorktree(t).catch(() => {})
  const f = getFeature(t.feature_id)!
  const ready = readyDependents(t.key, tickets(f.id), j<string[]>(f.merge_order, [])).map((x) => x.key)
  const what = `${t.key} merged${pr ? ` (PR #${pr.number})` : ''}.${ready.length ? ` Ready now: ${ready.join(', ')}.` : ''}`
  attention('merged', ready.length ? `${what} Start them with "Start ready".` : what, { agentId: t.assignee_agent_id, ticketId: t.id })
  tellTpm(f, `HQ: ${what}${ready.length ? ' The user starts them from HQ.' : ''}`)
}
const merging = new Map<string, Promise<unknown>>() // one merge per repo at a time
/** "Merge into main" for a finished ticket of a local-only repo. HQ merges its branch with fixed rules (localmerge.ts: refuses,
 *  and says why, if the checkout isn't on main, has uncommitted changes, or the branch conflicts), then handles it like any
 *  merge it notices: the engineer stops, the user and the TPM hear what's ready now, the preview restarts. */
export function mergeTicket(ticketId: string): Promise<{ merged: true; sha: string; already: boolean }> {
  const t0 = getTicket(ticketId); const f = t0 && getFeature(t0.feature_id); const repo = f && getRepo(f.repo_id)
  if (!t0 || !repo) return Promise.reject(new Error('unknown ticket'))
  const job = (merging.get(repo.id) ?? Promise.resolve()).then(async () => {
    const t = getTicket(ticketId)!
    if (t.status === 'merged') return { merged: true as const, sha: '', already: true }
    if (repo.kind === 'github') throw new Error(`${repo.name} is on GitHub: merge ${t.key}'s PR there.`)
    if (t.status !== 'pr_ready' || t.pr_state !== 'local' || !t.branch) throw new Error(`${t.key} isn't finished yet (${t.status}).`)
    const doc = one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', `ticket:${t.id}`, 'pr')?.text ?? ''
    const body = doc.replace(/^# .*\n?/, '').trim() // the engineer's PR text, without its title line
    const r = await mergeIntoMain(repo.path, { branch: t.branch, into: repo.default_branch, subject: `Merge ${t.key}: ${t.title}`, body: [body, `HQ ticket ${t.key} · ${t.branch}`].filter(Boolean) })
    if (!r.ok) { emit({ agentId: null, source: 'ui', kind: 'ticket.merge_refused', payload: { ticket: t.id, key: t.key, why: r.why } }); throw new Error(r.why) }
    emit({ agentId: t.assignee_agent_id, source: 'ui', kind: 'ticket.merged_by_hq', payload: { ticket: t.id, key: t.key, sha: r.sha, already: r.already } })
    markMerged(t, null)
    void syncRepo(repo.id).catch(() => {}) // the repo's head, for the UI
    return { merged: true as const, sha: r.sha, already: r.already }
  })
  merging.set(repo.id, job.catch(() => {})); return job
}
/** Every 2 min, only while some ticket waits for its PR to be opened or merged. */
export function startMergeWatcher(): void {
  const tick = () => {
    sweepNotices(); if (!one("SELECT 1 AS x FROM tickets WHERE status IN ('pr_ready', 'pr_open')")) return
    checkMerges().catch((e) => emit({ agentId: null, source: 'system', kind: 'merge.check.error', payload: { error: String(e) } }))
  }
  tick(); setInterval(tick, 120_000)
}
