// Clear project: one repo's board is wiped (features, tickets, agents, messages, notes, notices) and the repo stays registered.
// Two steps, because a handoff note can take minutes: clearRepo locks the repo (repos.clearing_at, so nothing new starts there),
// stops its app and asks the TPM and every engineer mid-work for a handoff note; once nobody runs, finishClear saves unsaved code
// as a WIP commit on its branch, removes the worktrees, archives the feature files and notes under ~/.hq/archive, and deletes the
// rows. Branches, GitHub and PRs are left alone. The project's TPM stays (Bug 52): what the cleared features built goes into
// "Built so far", its note is kept, and if it was running a new session starts after the clear without the old tickets.
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.ts'
import { one, q, run, now, tx } from './db.ts'
import { bus, emit, patch } from './events.ts'
import { rememberGone, sweepNow } from './leftovers.ts'
import { attention, resolveKind } from './attention.ts'
import { agentDir, liveAgents, stopAgent, update, type Agent } from './agents.ts'
import { features, getRepo, repoOfAgent, setTicket, tickets, type Feature, type Repo, type Ticket } from './records.ts'
import { fallbackNote, freshStart, freshStartBlocker, inRepo } from './freshstart.ts'
import { readNote, saveNote } from './notes.ts'
import { launching } from './tickets.ts'
import { builtLines, dropFeatureMd, keepBuilt, tpmWorkspace, writeFeatureMd, writeProjectMd } from './projectmd.ts'
import { restartTpm, tpmStarting } from './tpm.ts'
import { stopPreview } from './preview.ts'
import { git } from './repos.ts'

const name = (a: Agent): string => a.display_name ?? a.id
/** The repo's agents that a clear stops: its TPM, engineers and reviewers (not a Launch helper: it goes with the app). */
const ofRepo = (repoId: string) => (a: Agent): boolean => a.role !== 'launcher' && repoOfAgent(a) === repoId
/** Repos whose TPM was running when their clear started: it comes back once the clear is done. */
const tpmWasOn = new Set<string>()
const UNFINISHED = ['planning', 'implementing', 'awaiting_answer', 'resolving', 'plan_review']

/** What of the repo is starting right now: stopping it halfway could leave an agent behind. */
export function startingNow(repoId: string): string[] {
  const fids = inRepo(repoId), mine = features().filter((f) => fids.has(f.id)), tks = tickets().filter((t) => fids.has(t.feature_id))
  return [...(tpmStarting(repoId) ? ['the TPM'] : []), ...mine.filter((f) => launching(f.id)).map((f) => f.title), ...tks.filter((t) => launching(t.id)).map((t) => t.key)]
}
export const startingWhy = (busy: string[]): string => `${busy.join(', ')} ${busy.length > 1 ? 'are' : 'is'} starting right now; try again in a moment.`

/** Clear `repoId`: lock it, stop its app, and have each running TPM and engineer write a handoff note and stop (`noting`). Ones
 *  that can't write one now (waiting on a dialog or a plan review, or done) stop at once, with a note from HQ when their work
 *  was unfinished (`stopped`, with why). The rest happens in finishClear once the last of them has stopped. */
export async function clearRepo(repoId: string): Promise<{ noting: string[]; stopped: string[]; done: boolean }> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  if (repo.clearing_at) throw new Error(`${repo.name} is already being cleared.`)
  const fids = inRepo(repoId), tks = tickets().filter((t) => fids.has(t.feature_id))
  const busy = startingNow(repoId); if (busy.length) throw new Error(startingWhy(busy))
  const at = now()
  tx(() => { // locked first: a stop below frees a slot, and nothing of this repo may start in it
    run('UPDATE repos SET clearing_at = ? WHERE id = ?', at, repoId)
    for (const t of tks.filter((x) => x.go_ahead)) setTicket(t.id, { go_ahead: 0 })
  })
  patch('repo', repoId, { clearing_at: at })
  if ((one<{ status: string }>('SELECT status FROM previews WHERE id = ?', repoId)?.status ?? 'stopped') !== 'stopped') await stopPreview(repoId).catch(() => {})
  const noting: string[] = [], stopped: string[] = []
  for (const a of liveAgents().filter(ofRepo(repoId))) {
    if (a.role === 'tpm') tpmWasOn.add(repoId)
    if (a.fresh_start_at) { update(a.id, { fresh_start_then: 'clear' }); noting.push(name(a)); continue } // already writing one
    let why = a.role === 'tpm' || a.role === 'engineer' ? freshStartBlocker(a) : `${a.role}s don't keep notes`
    if (!why) { try { await freshStart(a.id, { how: 'now', then: 'clear' }); noting.push(name(a)); continue } catch (e) { why = (e as Error).message } }
    if (unfinished(a, tks)) saveNote(a, fallbackNote(a, why))
    await stopAgent(a.id, 'cleared'); stopped.push(`${name(a)}: ${why}`)
  }
  emit({ agentId: null, source: 'ui', kind: 'repo.clear_started', payload: { repo: repoId, noting, stopped } })
  const done = !noting.length && await maybeFinishClear(repoId)
  return { noting, stopped, done }
}
export const unfinished = (a: Agent, tks: Ticket[]): boolean => a.role === 'tpm' ? true
  : a.role === 'engineer' && UNFINISHED.includes(tks.find((t) => t.id === a.ticket_id)?.status ?? '')

const finishing = new Set<string>()
/** Finishes the clear of `repoId` once none of its agents runs or is still writing a note. True when it did. Called after each
 *  note and by the fresh-start sweep every 10 s (which also picks a clear up after a restart). */
export async function maybeFinishClear(repoId: string): Promise<boolean> {
  const repo = getRepo(repoId); if (!repo?.clearing_at || finishing.has(repoId)) return false
  if (q<Agent>("SELECT * FROM agents WHERE status != 'exited' OR fresh_start_at IS NOT NULL").some(ofRepo(repoId))) return false
  finishing.add(repoId)
  try { await finishClear(repo); resolveKind(`repo_clear_failed:${repoId}`, null); return true } catch (e) {
    // The repo stays locked and the sweep tries again every 10 s; the notice says why, once, until it works.
    emit({ agentId: null, source: 'system', kind: 'repo.clear_failed', payload: { repo: repoId, error: String(e) } })
    attention(`repo_clear_failed:${repoId}`, `Clearing ${repo.name} hasn't finished: ${(e as Error).message} HQ keeps trying every 10 seconds.`)
    return false
  } finally { finishing.delete(repoId) }
}

type Saved = { key: string; branch: string | null; head: string | null; wip: boolean; failed: string | null }
async function finishClear(repo: Repo): Promise<void> {
  const fs0 = features().filter((f) => f.repo_id === repo.id), F = fs0.map((f) => f.id)
  const tks = tickets().filter((t) => F.includes(t.feature_id)), T = tks.map((t) => t.id)
  const A = q<{ id: string }>(`SELECT id FROM agents WHERE ${inList('feature_id', F)} OR ${inList('ticket_id', T)} OR (repo_id = ? AND role = 'tpm')`, ...F, ...T, repo.id).map((r) => r.id)
  const saved = await saveWork(repo, tks)
  const dir = archive(repo, fs0, tks, saved)
  const built = builtLines(fs0)
  rememberGone(repo.id) // its tickets go next, and with them the names that say which folders are HQ's
  tx(() => { keepBuilt(repo.id, built); deleteRows(repo.id, F, T, A) })
  for (const a of A) fs.rmSync(agentDir(a), { recursive: true, force: true })
  for (const f of fs0) dropFeatureMd(f)
  writeProjectMd(repo.id)
  const failed = [...saved.values()].filter((s) => s.failed).map((s) => `${s.key}: ${s.failed}`)
  emit({ agentId: null, source: 'system', kind: 'repo.cleared', payload: { repo: repo.id, archive: dir, features: F.length, tickets: T.length, agents: A.length, failed } })
  for (const kind of ['repo_cleared', 'auto_finished', 'auto_stopped', 'test_cmd_proposed']) resolveKind(`${kind}:${repo.id}`, null) // the runs they're about are gone
  attention(`repo_cleared:${repo.id}`, `Cleared ${repo.name}: ${F.length} feature${F.length === 1 ? '' : 's'} and ${T.length} ticket${T.length === 1 ? '' : 's'}. `
    + `Notes and a summary are in ${dir.replace(process.env.HOME ?? '\0', '~')}.`
    + (failed.length ? ` These worktrees couldn't be removed (their code is safe on its branch): ${failed.join('; ')}.` : ''))
  bus.emit('resnapshot') // the UI drops everything at once (ui.ts)
  if (tpmWasOn.delete(repo.id)) { // it was running: a new session, from its note and what has been built, without the old tickets
    void restartTpm(repo.id, { cleared: true }).catch((e) => attention(`repo_cleared:${repo.id}`, `Cleared ${repo.name}, but its TPM didn't start again: `
      + `${(e as Error).message} Send it a message to start it.`))
  }
}

/** Each ticket worktree: changes not committed yet go into a "WIP (HQ clear)" commit on its branch, then the worktree is
 *  removed. The branch stays. Keys repeat across features (T1…), so a folder is handled once, for whatever it holds now. */
async function saveWork(repo: Repo, tks: Ticket[]): Promise<Map<string, Saved>> {
  await sweepNow() // what the stopped engineers left running there (Bug 75)
  const out = new Map<string, Saved>(), seen = new Set<string>()
  for (const t of tks) {
    const wt = t.worktree_path; if (!wt || seen.has(wt) || !fs.existsSync(wt)) continue
    seen.add(wt)
    const s: Saved = { key: t.key, branch: null, head: null, wip: false, failed: null }
    try {
      s.branch = await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')
      if (await git(wt, 'status', '--porcelain')) {
        await git(wt, 'add', '-A') // ignored folders (seeded node_modules, Try it data) stay out
        await git(wt, '-c', 'user.name=HQ', '-c', 'user.email=hq@localhost', 'commit', '--no-verify', '-q', '-m', `WIP (HQ clear): ${t.key} ${t.title}`)
        s.wip = true
      }
      s.head = await git(wt, 'rev-parse', '--short', 'HEAD')
      await git(repo.path, 'worktree', 'unlock', wt).catch(() => {})
      await git(repo.path, 'worktree', 'remove', '--force', wt)
    } catch (e) { s.failed = (e as Error).message.trim().split('\n')[0] ?? 'git failed' }
    for (const x of tks.filter((y) => y.worktree_path === wt)) out.set(x.id, s)
  }
  await git(repo.path, 'worktree', 'prune').catch(() => {})
  emit({ agentId: null, source: 'system', kind: 'repo.clear_saved', payload: { repo: repo.id, worktrees: [...new Set(out.values())] } })
  return out
}

const stamp = (t: number): string => new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const safe = (s: string): string => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
/** ~/.hq/archive/<repo>/<time>/: each feature's workspace (FEATURE.md brought up to date, CONTEXT.md, the handoff notes), any
 *  note, update_handoff log or plan not in it yet, and SUMMARY.md: the requests, tickets, branches and where their code is. */
export function archive(repo: Repo, fs0: Feature[], tks: Ticket[], saved: Map<string, Saved>, how: 'cleared' | 'removed' = 'cleared'): string {
  const dir = path.join(PATHS.archive, safe(repo.name), stamp(now())); fs.mkdirSync(dir, { recursive: true })
  const put = (file: string, text: string | null | undefined) => {
    if (!text || fs.existsSync(file)) return
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
  }
  const lines = [`# ${repo.name}: ${how} ${new Date().toLocaleString('en-GB')}`, '',
    `HQ's ${how === 'cleared' ? 'Clear project' : 'Remove from HQ'} archived this ${how === 'cleared' ? 'board' : "project's records"}. Each feature's folder has FEATURE.md`
      + " (the request, tickets, decisions and specs) and the engineers' handoff notes (HANDOFF.md); tpm/HANDOFF.md is the TPM's note at the time.",
    how === 'cleared' ? 'No code was deleted: changes that were not committed are in a "WIP (HQ clear)" commit on the ticket\'s branch, and every branch is kept.'
      : `Nothing in ${repo.path} was touched: worktrees, branches and uncommitted work are where they were, and HQ has forgotten them.`, '']
  put(path.join(dir, 'tpm', 'HANDOFF.md'), readNote(`resume:repo:${repo.id}`)) // copied: the TPM keeps it (Bug 52)
  if (how === 'removed') { // nothing keeps these any more, and start steps cost tokens to work out again
    for (const f of ['PROJECT.md', 'CONTEXT.md']) { const from = path.join(tpmWorkspace(repo.id), f); if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, f)) }
    const p = one<{ command: string | null; recipe: string | null }>('SELECT command, recipe FROM previews WHERE id = ?', repo.id)
    lines.push('## Settings', '', `- Test command: ${repo.test_cmd ?? 'the one HQ finds'}`, `- Start command: ${p?.command ?? 'none set'}`,
      ...(p?.recipe ? [`- Start steps you OK'd: ${p.recipe}`] : []), '')
  }
  for (const f of fs0) {
    const folder = `${f.handle ? `${f.handle}-` : ''}${f.slug}-${f.id.replace(/^feat-/, '')}`, fdir = path.join(dir, folder), ws = path.join(PATHS.workspaces, f.id)
    if (fs.existsSync(ws)) fs.renameSync(ws, fdir); else fs.mkdirSync(fdir, { recursive: true }) // engineers' notes (the TPM's workspace stays)
    try { fs.copyFileSync(writeFeatureMd(f), path.join(fdir, 'FEATURE.md')) } catch {} // the ticket table as it stands now
    put(path.join(fdir, 'tpm', 'HANDOFF.md'), readNote(`resume:feature:${f.id}`)) // a feature's own TPM, from before Bug 52
    const mine = tks.filter((t) => t.feature_id === f.id)
    for (const t of mine) {
      const tdir = path.join(fdir, 'tickets', t.key)
      put(path.join(tdir, 'HANDOFF.md'), readNote(`resume:ticket:${t.id}`))
      put(path.join(tdir, 'LOG.md'), one<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'handoff'", `ticket:${t.id}`)?.text)
      const plan = one<{ plan_text: string; edited_plan_text: string | null }>(
        'SELECT plan_text, edited_plan_text FROM plan_revisions WHERE ticket_id = ? ORDER BY round DESC, submitted_at DESC', t.id)
      put(path.join(tdir, 'PLAN.md'), plan ? plan.edited_plan_text ?? plan.plan_text : null)
    }
    lines.push(`## ${f.title} (${f.status}): ${folder}/`, '', ...f.request_text.split('\n').map((l) => `> ${l}`), '')
    if (!mine.length) { lines.push('No tickets.', ''); continue }
    lines.push('| Ticket | Status | Branch | Code | PR | Note |', '|---|---|---|---|---|---|')
    for (const t of mine) {
      const s = saved.get(t.id), note = readNote(`resume:ticket:${t.id}`)
      const code = !s ? (how === 'removed' && t.worktree_path && fs.existsSync(t.worktree_path) ? `in its worktree (${t.worktree_path})` : t.branch ? 'on its branch' : 'never started')
        : s.failed ? `worktree kept: ${s.failed}` : `${s.head}${s.wip ? ' (WIP commit)' : ''}`
      const noted = !note ? '' : note.startsWith('(Written by HQ') ? "HQ's (the engineer couldn't)" : 'yes'
      const branch = s?.branch && s.branch !== t.branch ? `${t.branch ?? ''} (folder was on ${s.branch})` : t.branch ?? ''
      lines.push(`| ${t.key} ${t.title.replace(/\|/g, '/')} | ${t.status} | ${branch} | ${code} | ${t.pr_url ?? ''} | ${noted} |`)
    }
    lines.push('')
  }
  fs.writeFileSync(path.join(dir, 'SUMMARY.md'), lines.join('\n'))
  return dir
}

export const inList = (col: string, ids: string[]): string => ids.length ? `${col} IN (${ids.map(() => '?').join(',')})` : '0'
/** Every row of the repo's work, children first (only features→repos, tickets→features and sessions→agents are real foreign
 *  keys; everything else points by convention). The repo row, its app's start command and port, and its sync notices stay. */
export function deleteRows(repoId: string, F: string[], T: string[], A: string[]): void {
  const del = (table: string, where: string, ...ids: string[]) => run(`DELETE FROM ${table} WHERE ${where}`, ...ids)
  for (const table of ['events', 'task_progress', 'model_switches', 'usage_samples', 'batches', 'sessions', 'jobs']) del(table, inList('agent_id', A), ...A)
  del('jobs', inList('ticket_id', T), ...T)
  del('review_issues', `plan_revision_id IN (SELECT id FROM plan_revisions WHERE ${inList('ticket_id', T)})`, ...T)
  for (const table of ['review_requests', 'plan_revisions', 'escalations']) del(table, inList('ticket_id', T), ...T)
  del('questions', `${inList('ticket_id', T)} OR ${inList('from_agent_id', A)}`, ...T, ...A)
  del('messages', `${inList('feature_id', F)} OR ${inList('from_id', A)} OR ${inList('to_id', A)}`, ...F, ...A, ...A)
  del('needs_attention', `${inList('agent_id', A)} OR ${inList('ticket_id', T)}`, ...A, ...T)
  del('file_overlap', inList('feature_id', F), ...F)
  del('asks', 'repo_id = ?', repoId)
  const scopes = [...F.flatMap((f) => [`feature:${f}`, `resume:feature:${f}`]), ...T.flatMap((t) => [`ticket:${t}`, `resume:ticket:${t}`])]
  del('docs', inList('scope', scopes), ...scopes)
  const slots = [...A, ...T.map((t) => `pending-${t}`)]
  run(`UPDATE worker_slots SET agent_id = NULL WHERE ${inList('agent_id', slots)}`, ...slots)
  del('agents', inList('id', A), ...A)
  del('tickets', inList('id', T), ...T)
  del('features', inList('id', F), ...F)
  run("UPDATE previews SET ticket_id = NULL, status = 'stopped', updated_at = ? WHERE id = ?", now(), repoId)
  del('auto_runs', 'repo_id = ?', repoId)
  run('UPDATE repos SET clearing_at = NULL, tpm_agent_id = NULL, tpm_parked_at = NULL, auto_mode = 0, auto_stopped_why = NULL, auto_waiting = NULL, test_cmd_proposed = NULL WHERE id = ?',
    repoId) // its sessions' rows went with the board
}
/** What only goes when the repo itself does (Remove from HQ): Clear keeps all of it. */
export function deleteRepoRows(repoId: string): void {
  run('DELETE FROM messages WHERE repo_id = ?', repoId)
  run('DELETE FROM docs WHERE scope IN (?, ?)', `repo:${repoId}`, `resume:repo:${repoId}`)
  run('DELETE FROM needs_attention WHERE kind LIKE ?', `%:${repoId}`)
  run('DELETE FROM previews WHERE id = ?', repoId)
  run('DELETE FROM repos WHERE id = ?', repoId)
}
