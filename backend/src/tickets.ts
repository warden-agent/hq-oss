// Features and tickets: creating them, starting TPM and engineer sessions, Start ready, Fix conflicts, and cancelling.
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.ts'
import { attention, resolveForTicket, resolveKind, resolveKindForTicket } from './attention.ts'
import { launchBlocker, readyTickets, unmergedDeps } from './readiness.ts'
import { canLaunch, starting } from './scheduler.ts'
import { one, q, run, now, tx } from './db.ts'
import { emit, patch } from './events.ts'
import { id, j } from './util.ts'
import { getAgent, launchAgent, stopAgent, type Agent } from './agents.ts'
import { sendMessage, type Message } from './delivery.ts'
import { modelFor } from './roles.ts'
import { features, getFeature, getRepo, getTicket, setTicket, sweepNotices, ticketByKey, tickets, type Feature, type Ticket } from './records.ts'
import { ensureFresh, git } from './repos.ts'
import { nextWorkerSlot, releaseSlot } from './slots.ts'
import { tellTpm } from './mergewatch.ts'
import { handoverPrompt } from './handover.ts'
import { clearConflict, fixConflictsText, mergeBase, whoMergedFirst } from './conflicts.ts'
import { conflictsWith } from './localmerge.ts'
import * as tmux from './tmux.ts'

export const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'

export async function createFeature(repoId: string, title: string, request: string): Promise<Feature> {
  if (!getRepo(repoId)) throw new Error('unknown repo')
  await ensureFresh(repoId)
  const slug = slugify(title); const t = now()
  const f: Feature = {
    id: id('feat'), repo_id: repoId, slug, title, request_text: request, status: 'planning', tpm_agent_id: null, merge_order: '[]', stacked_branches: 0,
    created_at: t, updated_at: t,
  }
  run('INSERT INTO features(id, repo_id, slug, title, request_text, status, merge_order, stacked_branches, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    f.id, repoId, slug, title, request, 'planning', '[]', 0, t, t)
  patch('feature', f.id, f as unknown as Record<string, unknown>)
  await launchTpm(f)
  return getFeature(f.id)!
}
/** The TPM's FEATURE.md: the request, the tickets, the decisions recorded with write_feature, and every ticket's spec. */
export function writeFeatureMd(f: Feature, extra = ''): string {
  const ws = path.join(PATHS.workspaces, f.id, 'tpm'); fs.mkdirSync(ws, { recursive: true })
  const tk = tickets(f.id), decisions = q<{ key: string; text: string }>('SELECT key, text FROM docs WHERE scope = ? ORDER BY updated_at', `feature:${f.id}`)
  const md = `---\nfeature: ${f.slug}\nrepo: ${getRepo(f.repo_id)?.name}\nstatus: ${f.status}\nmerge_order: ${f.merge_order}\n---\n## Request (verbatim)\n\n${f.request_text}\n\n## Tickets\n\n| Key | Size | Status | Depends on | Expected files | Title |\n|---|---|---|---|---|---|\n${tk.map((x) => `| ${x.key} | ${x.size} | ${x.status} | ${x.deps} | ${x.expected_files} | ${x.title} |`).join('\n')}\n`
    + (decisions.length ? `\n## Decisions\n\n${decisions.map((d) => `### ${d.key}\n${d.text}`).join('\n\n')}\n` : '')
    + (tk.length ? `\n## Ticket specs\n\n${tk.map((x) => `### ${x.key}: ${x.title}\n${x.spec ?? ''}`).join('\n\n')}\n` : '') + extra
  fs.writeFileSync(path.join(ws, 'FEATURE.md'), md)
  const ctx = getRepo(f.repo_id)?.context_doc_path; if (ctx && fs.existsSync(ctx)) fs.copyFileSync(ctx, path.join(ws, 'CONTEXT.md'))
  return ws
}
export async function launchTpm(f: Feature, handover?: string): Promise<Agent> {
  const repo = getRepo(f.repo_id)!; const ws = writeFeatureMd(f)
  const prompt = handover ?? `New feature for repo "${repo.name}" (read-only copy at ${repo.path}; your workspace is ${ws} with FEATURE.md).\n\nThe user's request, verbatim:\n"""\n${f.request_text}\n"""\n\nExplore the repo as needed, then split this into tickets with create_ticket (S/M/L, spec with acceptance criteria, expected_files, depends_on), set the merge order with set_merge_order, and tell the user the breakdown in a few lines. Do not assign tickets yet unless the user asked you to start immediately.`
  const a = await launchAgent({ role: 'tpm', featureId: f.id, model: modelFor('tpm'), cwd: ws, displayName: `TPM ${f.slug}`, launchPrompt: prompt, extraFlags: ['--add-dir', repo.path] })
  run('UPDATE features SET tpm_agent_id = ?, updated_at = ? WHERE id = ?', a.id, now(), f.id); patch('feature', f.id, { tpm_agent_id: a.id })
  return a
}
const tpmStarting = new Set<string>() // features whose TPM is being started right now
/** "Start TPM again": a fresh TPM for a feature whose TPM has exited, briefed from HQ's records. Messages still waiting for the
 *  old TPM, and engineers' open questions to it, move to the new one. */
export async function restartTpm(featureId: string): Promise<Agent> {
  const f = getFeature(featureId); if (!f || f.status === 'cancelled') throw new Error('unknown feature')
  const old = f.tpm_agent_id ? getAgent(f.tpm_agent_id) : undefined
  if (old && old.status !== 'exited') throw new Error(`${f.title} already has a TPM running (${old.id})`)
  if (tpmStarting.has(f.id)) throw new Error(`${f.title}'s TPM is already starting`)
  tpmStarting.add(f.id)
  try {
    const repo = await ensureFresh(f.repo_id), ws = writeFeatureMd(f)
    const talk = old ? q<Message>(`SELECT * FROM messages WHERE delivered_at IS NOT NULL
      AND ((from_id = 'user' AND to_id = ?) OR (from_id = ? AND to_id = 'user')) ORDER BY created_at DESC LIMIT 10`, old.id, old.id).reverse() : []
    const a = await launchTpm(f, handoverPrompt(f, { repo, ws, previous: old?.id ?? null, tickets: tickets(f.id), messages: talk }))
    if (old) {
      const moved = q<{ id: string }>('SELECT id FROM messages WHERE to_id = ? AND delivered_at IS NULL', old.id)
      tx(() => {
        run('UPDATE messages SET to_id = ? WHERE to_id = ? AND delivered_at IS NULL', a.id, old.id)
        run('UPDATE questions SET to_target = ? WHERE to_target = ? AND answered_at IS NULL', a.id, old.id)
      })
      for (const m of moved) patch('message', m.id, { to_id: a.id })
      resolveKind('agent_exited', old.id)
    }
    emit({ agentId: a.id, source: 'ui', kind: 'tpm.restarted', payload: { feature: f.id, previous: old?.id ?? null } })
    return a
  } finally { tpmStarting.delete(f.id) }
}
export function createTicket(featureId: string, t: { key?: string; title: string; size: string; spec: string; expected_files?: string[]; depends_on?: string[] }): Ticket {
  const f = getFeature(featureId); if (!f) throw new Error('unknown feature')
  const n = tickets(featureId).length + 1; const key = t.key ?? `T-${String(n).padStart(2, '0')}`
  if (ticketByKey(featureId, key)) throw new Error(`ticket ${key} exists`)
  const ts = now()
  const row: Ticket = {
    id: id('tkt'), feature_id: featureId, key, slug: slugify(t.title), title: t.title, size: (t.size || 'M').toUpperCase(), status: 'queued',
    prior_status: null, assignee_agent_id: null, expected_files: JSON.stringify(t.expected_files ?? []), deps: JSON.stringify(t.depends_on ?? []),
    edit_overrides: '[]', branch: null, worktree_path: null, pr_number: null, pr_url: null, pr_state: null, plan_round: 0, handoff_updated_at: null,
    last_handoff_hash: null, spec: t.spec, go_ahead: 0, conflict_files: null, conflict_with: null, created_at: ts, updated_at: ts,
  }
  run(`INSERT INTO tickets(id, feature_id, key, slug, title, size, status, expected_files, deps, edit_overrides, plan_round, spec, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, featureId, key, row.slug, row.title, row.size, 'queued', row.expected_files, row.deps, '[]', 0, t.spec, ts, ts)
  patch('ticket', row.id, row as unknown as Record<string, unknown>); writeFeatureMd(f)
  return row
}

/** Start an engineer on a ticket. Every caller (TPM, Launch engineer, Start ready) gets the same rules: one engineer per ticket,
 *  dependencies merged first, the parallel limit. They're all checked before the first await, so a second launch of the same
 *  ticket is refused while the first is still under way. */
export async function launchEngineer(ticketId: string, opts: { synced?: boolean } = {}): Promise<Agent> {
  const t = getTicket(ticketId); if (!t) throw new Error('unknown ticket')
  const live = one<{ id: string }>("SELECT id FROM agents WHERE role = 'engineer' AND status != 'exited' AND (id = ? OR ticket_id = ?)", t.assignee_agent_id ?? '', t.id)?.id ?? null
  const blocked = launchBlocker(t, { starting: starting.has(t.id), liveEngineer: live }); if (blocked) throw new Error(blocked)
  const waits = unmergedDeps(t, tickets(t.feature_id)); if (waits.length) throw new Error(`${t.key} waits on ${waits.join(', ')} (not merged yet)`)
  const cap = canLaunch(); if (!cap.ok) throw new Error(cap.why)
  starting.add(t.id)
  try { return await startEngineer(t, opts) } finally { starting.delete(t.id) }
}
/** `fix`: an engineer that merges main into finished work (Fix conflicts): it starts in acceptEdits with HQ's instructions as its
 *  prompt (no plan to review), and the ticket goes to `resolving`. */
async function startEngineer(t: Ticket, opts: { synced?: boolean; fix?: (worktree: string) => string }): Promise<Agent> {
  const f = getFeature(t.feature_id)!; const repo = opts.synced ? getRepo(f.repo_id)! : await ensureFresh(f.repo_id)
  const branch = t.branch ?? `hq/${f.slug}/${t.key}-${t.slug}`
  const wtName = t.key; const wtPath = path.join(repo.path, '.claude', 'worktrees', wtName)
  const hasRemote = !!repo.remote
  if (fs.existsSync(wtPath)) {
    const cur = await git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')
    if (cur !== branch) {
      const dirty = await git(wtPath, 'status', '--porcelain').catch(() => 'unknown')
      if (dirty) throw new Error(`worktree ${wtPath} is on branch ${cur} with uncommitted work; remove it manually`)
      await git(repo.path, 'worktree', 'unlock', wtPath).catch(() => {}); await git(repo.path, 'worktree', 'remove', '--force', wtPath); await git(repo.path, 'worktree', 'prune').catch(() => {})
      emit({ agentId: null, source: 'system', kind: 'worktree.replaced', payload: { path: wtPath, was: cur, branch } })
    }
  }
  if (!fs.existsSync(wtPath)) {
    const base = hasRemote ? `origin/${repo.default_branch}` : repo.default_branch
    const exists = await git(repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(() => '')
    if (exists) await git(repo.path, 'worktree', 'add', wtPath, branch); else await git(repo.path, 'worktree', 'add', '-b', branch, wtPath, base)
  }
  const excl = await git(repo.path, 'rev-parse', '--git-path', 'info/exclude') // HQ's own folders never show up as changes in the repo
  const exclPath = path.isAbsolute(excl) ? excl : path.join(repo.path, excl)
  fs.mkdirSync(path.dirname(exclPath), { recursive: true }); const cur = fs.existsSync(exclPath) ? fs.readFileSync(exclPath, 'utf8') : ''
  const missing = ['.hq-plans/', '.claude/worktrees/'].filter((p) => !cur.split('\n').includes(p))
  if (missing.length) fs.appendFileSync(exclPath, (cur.endsWith('\n') || !cur ? '' : '\n') + missing.map((p) => `${p}\n`).join(''))
  const spec = t.spec ?? ''
  const prompt = opts.fix ? opts.fix(wtPath)
    : `Ticket ${t.key} (${t.size}): ${t.title}\nFeature: ${f.title}\nBranch: ${branch} (your worktree: ${wtPath})\nExpected files: ${t.expected_files}\nDepends on: ${t.deps}\n\n## Spec\n${spec}\n\nStart by calling get_ticket, explore the code, write your plan, and call ExitPlanMode.`
  const slot = nextWorkerSlot(`pending-${t.id}`) // a fix runs on the S model below: no plan, so no opusplan plan→exec switch
  const a = await launchAgent({
    role: 'engineer', featureId: f.id, ticketId: t.id, model: modelFor('engineer', opts.fix ? 'S' : t.size), cwd: repo.path, displayName: `eng ${t.key}`, launchPrompt: prompt,
    worktreeName: wtName, size: t.size, repoAllowlist: j<string[]>(repo.network_allowlist, []), editOverrides: j<string[]>(t.edit_overrides, []), extraEnv: slot.env,
    permissionMode: opts.fix ? 'acceptEdits' : 'plan',
  }).catch((e) => { releaseSlot(`pending-${t.id}`); throw e })
  run('UPDATE worker_slots SET agent_id = ? WHERE idx = ?', a.id, slot.idx)
  setTicket(t.id, { status: opts.fix ? 'resolving' : 'planning', prior_status: null, assignee_agent_id: a.id, branch, worktree_path: wtPath })
  emit({ agentId: a.id, source: 'system', kind: 'ticket.launched', payload: { ticket: t.id, branch, worktree: wtPath, slot: slot.idx, fix: !!opts.fix } })
  const why = opts.fix ? ` to merge ${repo.default_branch} in and fix its conflicts` : ''
  tellTpm(f, `HQ: engineer ${a.id} started on ${t.key}${why} (branch ${branch}). Address messages for this ticket to id ${a.id}.`)
  return a
}

const fixing = new Set<string>() // tickets whose Fix conflicts is under way
/** "Fix conflicts" for a finished ticket that conflicts with main (or a resolving one whose engineer has gone). HQ checks
 *  again first (GitHub repos fetch); clean now → nothing starts. Otherwise its engineer gets HQ's instructions: as a message
 *  when it still runs, else a fresh engineer on the same worktree and branch starts with them, even over the parallel limit. */
export async function fixConflicts(ticketId: string): Promise<{ key: string; clean: boolean; via?: 'message' | 'launch'; engineer?: string }> {
  const t0 = getTicket(ticketId); if (!t0) throw new Error('unknown ticket')
  if (!['pr_ready', 'pr_open', 'resolving'].includes(t0.status) || !t0.branch) throw new Error(`${t0.key} has nothing to fix (${t0.status}).`)
  if (fixing.has(t0.id) || starting.has(t0.id)) throw new Error(`${t0.key}'s conflicts are already being fixed`)
  fixing.add(t0.id)
  try {
    const f = getFeature(t0.feature_id)!; if (f.status === 'cancelled') throw new Error(`${f.title} is cancelled`)
    const liveId = one<{ id: string }>("SELECT id FROM agents WHERE role = 'engineer' AND status != 'exited' AND ticket_id = ? ORDER BY started_at DESC", t0.id)?.id
    const live = liveId ? getAgent(liveId) : undefined
    if (live && !(await tmux.hasSession(live.tmux_session))) throw new Error(`${t0.key}'s engineer (${live.id}) can't be reached right now; try again in a minute.`)
    if (live && t0.status === 'resolving') { // again only once it has stopped working without finishing, and nothing from HQ waits for it
      if (live.status !== 'idle') throw new Error(`${t0.key}'s engineer (${live.id}) is already fixing its conflicts`)
      if (one("SELECT 1 AS x FROM messages WHERE from_id = 'hq' AND to_id = ? AND delivered_at IS NULL", live.id)) throw new Error(`HQ's instructions to ${live.id} haven't been delivered yet`)
    }
    if (!live) { const cap = canLaunch({ ignoreCap: true }); if (!cap.ok) throw new Error(cap.why) }
    const repo = await ensureFresh(f.repo_id).catch((e) => { throw new Error(`HQ couldn't bring ${getRepo(f.repo_id)?.name ?? 'the repo'} up to date: ${(e as Error).message}`) })
    const t = getTicket(t0.id)!, base = mergeBase(repo)
    if (!['pr_ready', 'pr_open', 'resolving'].includes(t.status)) throw new Error(`${t.key} has nothing to fix (${t.status}).`) // merged while fetching
    const files = await conflictsWith(repo.path, base.ref, `refs/heads/${t.branch}`)
    if (files === null) throw new Error(`git couldn't check ${t.branch} against ${base.name}`)
    if (!files.length && t.status !== 'resolving') { // fixed by hand meanwhile: nothing to do
      clearConflict(t.id); emit({ agentId: null, source: 'ui', kind: 'ticket.fix_conflicts', payload: { ticket: t.id, key: t.key, clean: true } })
      return { key: t.key, clean: true }
    }
    const merged = files.length ? await whoMergedFirst(repo, t, files, base.ref) : []
    const mh = t.worktree_path && fs.existsSync(t.worktree_path) ? await git(t.worktree_path, 'rev-parse', '--git-path', 'MERGE_HEAD').catch(() => '') : ''
    const text = (launch?: { worktree: string }) => fixConflictsText({ t, base: base.name, files, merged, inProgress: !!mh && fs.existsSync(path.resolve(t.worktree_path!, mh)), launch })
    let via: 'message' | 'launch', engineer: string
    if (live) {
      setTicket(t.id, { status: 'resolving', prior_status: null })
      sendMessage({ featureId: f.id, channel: 'dm', from: 'hq', to: live.id, reason: 'fyi', body: text() }); via = 'message'; engineer = live.id
    } else {
      starting.add(t.id)
      try { engineer = (await startEngineer(t, { synced: true, fix: (worktree) => text({ worktree }) })).id; via = 'launch' } finally { starting.delete(t.id) }
      if (t.assignee_agent_id) for (const k of ['engineer_exited', 'agent_exited', 'stuck']) resolveKind(k, t.assignee_agent_id) // the old engineer's notices
    }
    for (const k of ['merge_conflict', 'conflicts_fixed']) resolveKindForTicket(k, t.id) // a later conflict gets a fresh notice
    emit({ agentId: engineer, source: 'ui', kind: 'ticket.fix_conflicts', payload: { ticket: t.id, key: t.key, clean: false, via, files, merged } })
    if (via === 'message') tellTpm(f, `HQ: ${t.key} conflicts with ${base.name}${merged.length ? ` after ${merged.join(', ')} merged` : ''}; its engineer ${engineer} is merging ${base.name} in now.`)
    return { key: t.key, clean: false, via, engineer }
  } finally { fixing.delete(t0.id) }
}

/** Cancel a ticket: it can't start again, its engineer (if one runs) stops, an open plan review closes, notices about it go,
 *  and the TPM hears it from HQ. Its branch and worktree are kept. A merged ticket can't be cancelled; a cancelled one is left. */
export async function cancelTicket(ticketId: string, opts: { tell?: boolean } = {}): Promise<{ key: string; stopped: string | null }> {
  const t = getTicket(ticketId); if (!t) throw new Error('unknown ticket')
  if (t.status === 'merged') throw new Error(`${t.key} is already merged`)
  if (t.status === 'cancelled') return { key: t.key, stopped: null }
  if (starting.has(t.id)) throw new Error(`${t.key} is starting an engineer right now; try again in a moment`)
  const at = now()
  tx(() => { // cancelled first: the engineer's stop frees a slot, and fillSlots must not start this ticket in it
    setTicket(t.id, { status: 'cancelled', go_ahead: 0 })
    for (const r of q<{ id: string }>("SELECT id FROM review_requests WHERE ticket_id = ? AND status = 'open'", t.id)) {
      run("UPDATE review_requests SET status = 'abandoned', answered_at = ?, closed_reason = 'cancelled' WHERE id = ?", at, r.id)
      patch('review', r.id, { status: 'abandoned', closed_reason: 'cancelled', answered_at: at })
    }
  })
  resolveForTicket(t.id)
  const eng = t.assignee_agent_id ? getAgent(t.assignee_agent_id) : undefined
  const stopped = eng && eng.status !== 'exited' ? eng.id : null
  if (stopped) await stopAgent(stopped, 'cancelled')
  emit({ agentId: stopped, source: 'ui', kind: 'ticket.cancelled', payload: { ticket: t.id, key: t.key, stopped } })
  const f = getFeature(t.feature_id)
  if (f && opts.tell !== false) {
    tellTpm(f, `HQ: The user cancelled ${t.key}${stopped ? ` and its engineer ${stopped} was stopped` : ''}.`
      + " Don't assign it again; tickets that depend on it can't start until you change their dependencies.")
  }
  return { key: t.key, stopped }
}
/** Cancel a feature: every ticket not merged yet is cancelled (engineers stop), then its TPM stops. */
export async function cancelFeature(featureId: string): Promise<{ tickets: string[]; stopped: string[] }> {
  const f = getFeature(featureId); if (!f) throw new Error('unknown feature')
  if (f.status === 'cancelled') return { tickets: [], stopped: [] }
  if (tpmStarting.has(f.id)) throw new Error(`${f.title}'s TPM is starting right now; try again in a moment`)
  const done: string[] = [], stopped: string[] = []
  for (const t of tickets(f.id)) {
    if (t.status === 'merged' || t.status === 'cancelled') continue
    const r = await cancelTicket(t.id, { tell: false }); done.push(r.key); if (r.stopped) stopped.push(r.stopped)
  }
  run("UPDATE features SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), f.id); patch('feature', f.id, { status: 'cancelled' })
  const tpm = f.tpm_agent_id ? getAgent(f.tpm_agent_id) : undefined
  if (tpm && tpm.status !== 'exited') { await stopAgent(tpm.id, 'cancelled'); stopped.push(tpm.id) }
  sweepNotices()
  emit({ agentId: null, source: 'ui', kind: 'feature.cancelled', payload: { feature: f.id, tickets: done, stopped } })
  return { tickets: done, stopped }
}
/** "Start ready": every ticket of the feature that may start now gets the go-ahead; they start as parallel slots allow. */
export async function startReady(featureId: string): Promise<{ started: string[]; queued: string[]; blocked: { key: string; on: string[] }[] }> {
  const f = getFeature(featureId); if (!f || f.status === 'cancelled') throw new Error('unknown feature')
  for (const t of readyTickets(tickets(featureId), j<string[]>(f.merge_order, []))) setTicket(t.id, { go_ahead: 1 })
  const started = await fillSlots()
  const all = tickets(featureId)
  return {
    started,
    queued: all.filter((t) => t.go_ahead && t.status === 'queued' && !t.assignee_agent_id).map((t) => t.key),
    blocked: all.filter((t) => t.status === 'queued' && unmergedDeps(t, all).length).map((t) => ({ key: t.key, on: unmergedDeps(t, all) })),
  }
}
let filling: Promise<unknown> = Promise.resolve()
/** Start go-ahead tickets while parallel slots are free, oldest feature first. One fill at a time so no ticket starts twice;
 *  each repo is synced once per fill, not once per ticket. */
export function fillSlots(): Promise<string[]> {
  const job = filling.then(async () => {
    const started: string[] = []; const synced = new Set<string>()
    for (;;) {
      if (!canLaunch().ok) break
      const next = features().filter((f) => f.status !== 'cancelled').reverse()
        .flatMap((f) => readyTickets(tickets(f.id), j<string[]>(f.merge_order, [])).filter((t) => t.go_ahead && !starting.has(t.id)))[0]
      if (!next) break
      const repoId = getFeature(next.feature_id)!.repo_id
      try { await launchEngineer(next.id, { synced: synced.has(repoId) }); synced.add(repoId); started.push(next.key) } catch (e) {
        setTicket(next.id, { go_ahead: 0 }); attention('launch_failed', `${next.key} could not start: ${(e as Error).message}`, { ticketId: next.id }); break
      }
    }
    return started
  })
  filling = job.catch(() => {}); return job
}
