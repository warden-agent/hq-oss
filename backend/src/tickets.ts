// Features and tickets: creating them, starting TPM and engineer sessions, Start ready, Fix conflicts, and cancelling.
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.ts'
import { attention, resolveForTicket, resolveKind, resolveKindForTicket } from './attention.ts'
import { depsProblem, launchBlocker, readyTickets, unmergedDeps } from './readiness.ts'
import { canLaunch, starting } from './scheduler.ts'
import { one, q, run, now, tx } from './db.ts'
import { emit, patch } from './events.ts'
import { id, j } from './util.ts'
import type { TicketStatus } from './readiness.ts'
import { getAgent, launchAgent, stopAgent, type Agent } from './agents.ts'
import { sendMessage, type Message } from './delivery.ts'
import { modelFor } from './roles.ts'
import { features, getFeature, getRepo, getTicket, liveTpm, notClearing, setTicket, sweepNotices, ticketInRepo, tickets, type Feature, type Ticket } from './records.ts'
import { ensureFresh, git } from './repos.ts'
import { nextWorkerSlot, releaseSlot } from './slots.ts'
import { tellTpm } from './mergewatch.ts'
import { engineerResumePrompt } from './handover.ts'
import { handOver, keepFirstRequest, messageTpm, tpmStarting } from './tpm.ts'
import { writeFeatureMd, writeProjectMd } from './projectmd.ts'
import { gitFacts, readNote } from './notes.ts'
import { clearConflict, fixConflictsText, fixTestsText, mergeBase, whoMergedFirst } from './conflicts.ts'
import { conflictsWith } from './localmerge.ts'
import * as tmux from './tmux.ts'
import { excludeHqFolders, seedPackages } from './worktrees.ts'
import { actionOf, closeAsks, openAsks } from './asks.ts'

export const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'

/** A new feature (one request) in the project: a branch of the board, named by its handle (F-1…). Made by the TPM with
 *  start_feature; `POST /api/features` (scripts, tests) also tells the project's TPM, starting it with the request if needed. */
export function addFeature(repoId: string, title: string, request: string): Feature {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  notClearing(repoId)
  const name = title.trim() || request.trim().split(/\s+/).slice(0, 5).join(' '); if (!name) throw new Error('Give the feature a title.')
  const t = now(), handle = `F-${repo.next_feature}`
  const f: Feature = { id: id('feat'), repo_id: repoId, slug: slugify(name), title: name, request_text: request, status: 'planning', tpm_agent_id: null,
    merge_order: '[]', stacked_branches: 0, created_at: t, updated_at: t, tpm_parked_at: null, handle }
  tx(() => {
    run('INSERT INTO features(id, repo_id, slug, title, request_text, status, merge_order, stacked_branches, created_at, updated_at, handle) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      f.id, repoId, f.slug, f.title, request, 'planning', '[]', 0, t, t, handle)
    run('UPDATE repos SET next_feature = next_feature + 1 WHERE id = ?', repoId)
  })
  patch('feature', f.id, f as unknown as Record<string, unknown>); writeFeatureMd(f)
  emit({ agentId: null, source: 'system', kind: 'feature.created', payload: { feature: f.id, handle, title: f.title } })
  return f
}
export async function createFeature(repoId: string, title: string, request: string): Promise<Feature> {
  if (!getRepo(repoId)) throw new Error('unknown repo')
  notClearing(repoId); const repo = await ensureFresh(repoId)
  if (repo.empty && !repo.context_doc_path && !one('SELECT 1 AS x FROM features WHERE repo_id = ?', repoId)) keepFirstRequest(repo, request)
  const f = addFeature(repoId, title, request)
  const tell = `New request from the user. HQ made feature ${f.handle} "${f.title}" for it; add its tickets with create_ticket(feature: "${f.handle}").\n\n${request}`
  const live = liveTpm(repoId)
  const tpm = live ? (tellTpm(f, `HQ: ${tell}`), live) : (await messageTpm(repoId, tell, { keepAsks: true })).agent
  return { ...getFeature(f.id)!, tpm_agent_id: tpm.id }
}
/** A ticket or feature with an engineer launch or Fix conflicts under way, or a repo whose TPM is starting (Clear waits for those). */
export const launching = (id: string): boolean => starting.has(id) || fixing.has(id) || tpmStarting(id)
/** A ticket in a feature. Keys are unique in the project (their worktree folder is the key) and HQ's count up and never repeat,
 *  not even after a Clear (Bug 52): T-01, T-02… across every feature. */
export function createTicket(featureId: string, t: { key?: string; title: string; size: string; spec: string; expected_files?: string[]; depends_on?: string[] }): Ticket {
  const f = getFeature(featureId); if (!f) throw new Error('unknown feature')
  if (f.status === 'cancelled') throw new Error(`${f.handle ?? f.title} is cancelled; start a new feature for this`)
  notClearing(f.repo_id)
  let n = getRepo(f.repo_id)!.next_ticket, key = t.key?.trim()
  if (key && ticketInRepo(f.repo_id, key)) throw new Error(`ticket ${key} exists`)
  while (!key || ticketInRepo(f.repo_id, key)) { key = `T-${String(n).padStart(2, '0')}`; if (ticketInRepo(f.repo_id, key)) { key = undefined; n++ } else n++ }
  run('UPDATE repos SET next_ticket = MAX(next_ticket, ?) WHERE id = ?', n, f.repo_id)
  const ts = now()
  const row: Ticket = {
    id: id('tkt'), feature_id: featureId, key, slug: slugify(t.title), title: t.title, size: (t.size || 'M').toUpperCase(), status: 'queued',
    prior_status: null, assignee_agent_id: null, expected_files: JSON.stringify(t.expected_files ?? []), deps: JSON.stringify(t.depends_on ?? []),
    edit_overrides: '[]', branch: null, worktree_path: null, pr_number: null, pr_url: null, pr_state: null, plan_round: 0, handoff_updated_at: null,
    last_handoff_hash: null, spec: t.spec, go_ahead: 0, conflict_files: null, conflict_with: null, auto_tries: 0, auto_parked_why: null, parked_at: null, created_at: ts, updated_at: ts,
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
type Resume = { prompt: (worktree: string) => Promise<string>; mode: 'plan' | 'acceptEdits'; status: TicketStatus }
async function startEngineer(t: Ticket, opts: { synced?: boolean; fix?: (worktree: string) => string; resume?: Resume }): Promise<Agent> {
  const f = getFeature(t.feature_id)!; notClearing(f.repo_id); const repo = opts.synced ? getRepo(f.repo_id)! : await ensureFresh(f.repo_id)
  const branch = t.branch ?? `hq/${f.slug}/${t.key}-${t.slug}`
  const wtName = t.key; const wtPath = path.join(repo.path, '.claude', 'worktrees', wtName)
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
    const base = mergeBase(repo).name // local main for a local-only repo, so a ticket builds on what was merged here
    const exists = await git(repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(() => '')
    if (exists) await git(repo.path, 'worktree', 'add', wtPath, branch); else await git(repo.path, 'worktree', 'add', '-b', branch, wtPath, base)
  }
  await excludeHqFolders(repo.path)
  // Installed packages come from the main checkout, so the engineer can run the tests straight away (never blocks the launch)
  await seedPackages(repo.path, wtPath).then((dirs) => { if (dirs.length) emit({ agentId: null, source: 'system', kind: 'worktree.packages', payload: { path: wtPath, dirs } }) },
    (e) => emit({ agentId: null, source: 'system', kind: 'worktree.packages_failed', payload: { path: wtPath, error: String(e) } }))
  const spec = t.spec ?? ''
  const prompt = opts.fix ? opts.fix(wtPath) : opts.resume ? await opts.resume.prompt(wtPath)
    : `Ticket ${t.key} (${t.size}): ${t.title}\nFeature: ${f.title}\nBranch: ${branch} (your worktree: ${wtPath})\nExpected files: ${t.expected_files}\nDepends on: ${t.deps}\n\n## Spec\n${spec}\n\nStart by calling get_ticket, explore the code, write your plan, and call ExitPlanMode.`
  const slot = nextWorkerSlot(`pending-${t.id}`) // a fix runs on the S model below: no plan, so no opusplan plan→exec switch
  const a = await launchAgent({
    role: 'engineer', repoId: f.repo_id, featureId: f.id, ticketId: t.id, model: modelFor('engineer', opts.fix || opts.resume?.status === 'resolving' ? 'S' : t.size), cwd: repo.path, displayName: `eng ${t.key}`, launchPrompt: prompt,
    worktreeName: wtName, size: t.size, repoAllowlist: j<string[]>(repo.network_allowlist, []), editOverrides: j<string[]>(t.edit_overrides, []), extraEnv: slot.env,
    permissionMode: opts.fix ? 'acceptEdits' : opts.resume?.mode ?? 'plan',
  }).catch((e) => { releaseSlot(`pending-${t.id}`); throw e })
  run('UPDATE worker_slots SET agent_id = ? WHERE idx = ?', a.id, slot.idx)
  setTicket(t.id, { status: opts.fix ? 'resolving' : opts.resume?.status ?? 'planning', prior_status: opts.resume ? t.prior_status : null, assignee_agent_id: a.id, branch, worktree_path: wtPath, parked_at: null })
  emit({ agentId: a.id, source: 'system', kind: 'ticket.launched', payload: { ticket: t.id, branch, worktree: wtPath, slot: slot.idx, fix: !!opts.fix } })
  const why = opts.fix ? ` to merge ${repo.default_branch} in and fix its conflicts` : opts.resume ? ' to take over after a fresh start (the last engineer left a handoff note)' : ''
  tellTpm(f, `HQ: engineer ${a.id} started on ${t.key}${why} (branch ${branch}). Address messages for this ticket to id ${a.id}.`)
  return a
}

/** A fresh engineer for a ticket whose engineer left a handoff note: same worktree and branch, briefed with the note, what git
 *  shows and the approved plan (or HQ's conflict instructions). `replace`: it takes the place of the one that just stopped, so
 *  the parallel limit doesn't hold it back; a Resume from parked respects the limit. */
export async function resumeEngineer(ticketId: string, o: { replace?: boolean } = {}): Promise<Agent> {
  const t = getTicket(ticketId); if (!t) throw new Error('unknown ticket')
  if (!['planning', 'implementing', 'awaiting_answer', 'resolving'].includes(t.status) || !t.branch) throw new Error(`${t.key} has nothing to resume (${t.status}).`)
  const old = t.assignee_agent_id ? getAgent(t.assignee_agent_id) : undefined
  if (old && old.status !== 'exited') throw new Error(`${t.key} still has an engineer running (${old.id}).`)
  if (starting.has(t.id)) throw new Error(`${t.key} is already starting.`)
  notClearing(getFeature(t.feature_id)?.repo_id ?? '')
  const cap = canLaunch({ ignoreCap: !!o.replace }); if (!cap.ok) throw new Error(cap.why)
  starting.add(t.id)
  try {
    const f = getFeature(t.feature_id)!; const repo = await ensureFresh(f.repo_id); const base = mergeBase(repo)
    const note = readNote(`resume:ticket:${t.id}`)
    const rev = one<{ edited_plan_text: string | null; plan_text: string }>(`SELECT edited_plan_text, plan_text FROM plan_revisions
      WHERE ticket_id = ? AND verdict IN ('approve', 'approve_with_edits') ORDER BY round DESC, submitted_at DESC`, t.id)
    const plan = t.status === 'planning' || t.status === 'resolving' ? null : rev ? rev.edited_plan_text ?? rev.plan_text : null
    const a = await startEngineer(t, { synced: true, resume: { mode: t.status === 'planning' ? 'plan' : 'acceptEdits', status: t.status, prompt: async (wt) => {
      let fix: string | null = null
      if (t.status === 'resolving') {
        const mh = await git(wt, 'rev-parse', '--git-path', 'MERGE_HEAD').catch(() => '')
        fix = fixConflictsText({ t, base: base.name, files: j<string[]>(t.conflict_files, []), merged: j<string[]>(t.conflict_with, []), inProgress: !!mh && fs.existsSync(path.resolve(wt, mh)) })
      }
      return engineerResumePrompt(t, { feature: f.title, worktree: wt, base: base.name, note, git: await gitFacts(wt, base.ref), plan, fix })
    } } })
    if (old) { handOver(old.id, a.id); for (const k of ['engineer_exited', 'agent_exited', 'stuck', 'context_high']) resolveKind(k, old.id) }
    emit({ agentId: a.id, source: 'system', kind: 'ticket.resumed', payload: { ticket: t.id, key: t.key, previous: old?.id ?? null, note: !!note } })
    return a
  } finally { starting.delete(t.id) }
}

const fixing = new Set<string>() // tickets whose Fix conflicts is under way
/** A finished ticket goes back to its engineer with HQ's instructions: as a message when it still runs, else a fresh engineer on
 *  the same worktree and branch starts with them. */
async function sendBack(t: Ticket, featureId: string, live: Agent | undefined, text: (launch?: { worktree: string }) => string): Promise<{ via: 'message' | 'launch'; engineer: string }> {
  if (live) {
    setTicket(t.id, { status: 'resolving', prior_status: null })
    sendMessage({ featureId, channel: 'dm', from: 'hq', to: live.id, reason: 'fyi', body: text() }); return { via: 'message', engineer: live.id }
  }
  starting.add(t.id)
  try {
    const engineer = (await startEngineer(t, { synced: true, fix: (worktree) => text({ worktree }) })).id
    if (t.assignee_agent_id) for (const k of ['engineer_exited', 'agent_exited', 'stuck']) resolveKind(k, t.assignee_agent_id) // the old engineer's notices
    return { via: 'launch', engineer }
  } finally { starting.delete(t.id) }
}
/** Auto mode: the tests failed on main plus this ticket, so it goes back to its engineer, even over the parallel limit (like Fix conflicts). */
export async function fixTests(ticketId: string, test: string, output: string): Promise<{ via: 'message' | 'launch'; engineer: string }> {
  const t = getTicket(ticketId); if (!t) throw new Error('unknown ticket')
  if (!['pr_ready', 'pr_open'].includes(t.status) || !t.branch) throw new Error(`${t.key} has nothing to fix (${t.status}).`)
  if (fixing.has(t.id) || starting.has(t.id)) throw new Error(`${t.key} is already being fixed`)
  fixing.add(t.id)
  try {
    const f = getFeature(t.feature_id)!, repo = getRepo(f.repo_id)!, base = mergeBase(repo).name
    const liveId = one<{ id: string }>("SELECT id FROM agents WHERE role = 'engineer' AND status != 'exited' AND ticket_id = ? ORDER BY started_at DESC", t.id)?.id
    const live = liveId ? getAgent(liveId) : undefined
    if (live && !(await tmux.hasSession(live.tmux_session))) throw new Error(`${t.key}'s engineer (${live.id}) can't be reached right now`)
    if (!live) { const cap = canLaunch({ ignoreCap: true }); if (!cap.ok) throw new Error(cap.why) }
    const r = await sendBack(t, f.id, live, (launch) => fixTestsText({ t, base, test, output, launch }))
    emit({ agentId: r.engineer, source: 'system', kind: 'ticket.fix_tests', payload: { ticket: t.id, key: t.key, via: r.via, test } })
    return r
  } finally { fixing.delete(t.id) }
}

/** "Fix conflicts" for a finished ticket that conflicts with main (or a resolving one whose engineer has gone). HQ checks
 *  again first (GitHub repos fetch); clean now → nothing starts. Otherwise its engineer gets HQ's instructions: as a message
 *  when it still runs, else a fresh engineer on the same worktree and branch starts with them, even over the parallel limit. */
export async function fixConflicts(ticketId: string): Promise<{ key: string; clean: boolean; via?: 'message' | 'launch'; engineer?: string }> {
  const t0 = getTicket(ticketId); if (!t0) throw new Error('unknown ticket')
  if (!['pr_ready', 'pr_open', 'resolving'].includes(t0.status) || !t0.branch) throw new Error(`${t0.key} has nothing to fix (${t0.status}).`)
  if (fixing.has(t0.id) || starting.has(t0.id)) throw new Error(`${t0.key}'s conflicts are already being fixed`)
  notClearing(getFeature(t0.feature_id)?.repo_id ?? '')
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
    const { via, engineer } = await sendBack(t, f.id, live, text)
    for (const k of ['merge_conflict', 'conflicts_fixed']) resolveKindForTicket(k, t.id) // a later conflict gets a fresh notice
    emit({ agentId: engineer, source: 'ui', kind: 'ticket.fix_conflicts', payload: { ticket: t.id, key: t.key, clean: false, via, files, merged } })
    if (via === 'message') tellTpm(f, `HQ: ${t.key} conflicts with ${base.name}${merged.length ? ` after ${merged.join(', ')} merged` : ''}; its engineer ${engineer} is merging ${base.name} in now.`)
    return { key: t.key, clean: false, via, engineer }
  } finally { fixing.delete(t0.id) }
}

/** Cancel a ticket: it can't start again, its engineer (if one runs) stops, an open plan review closes, notices about it go,
 *  and the TPM hears it from HQ. Its branch and worktree are kept. A merged ticket can't be cancelled; a cancelled one is left. */
/** "T4", "T4 and T5", "T4, T5 and T6". */
const listKeys = (ks: string[]): string => ks.length < 2 ? ks.join('') : `${ks.slice(0, -1).join(', ')} and ${ks.at(-1)}`
/** Tickets not merged or cancelled that wait on `key`: they can't start until the TPM rewires them (Bug 50). */
export const waitingOn = (featureId: string, key: string): string[] =>
  tickets(featureId).filter((x) => x.status !== 'merged' && x.status !== 'cancelled' && j<string[]>(x.deps, []).includes(key)).map((x) => x.key)

/** set_dependencies (Bug 50): which tickets must merge before this one may start, replacing its list. Only before it starts. */
export function setDependencies(ticketId: string, keys: string[]): string[] {
  const t = getTicket(ticketId); if (!t) throw new Error('unknown ticket')
  if (t.status !== 'queued' || t.assignee_agent_id) throw new Error(`${t.key} has already started (${t.status}); its dependencies don't matter any more`)
  const want = [...new Set(keys.map((k) => k.trim()).filter(Boolean))]
  const bad = depsProblem(t.key, want, tickets(t.feature_id)); if (bad) throw new Error(bad)
  setTicket(t.id, { deps: JSON.stringify(want) })
  const f = getFeature(t.feature_id); if (f) writeFeatureMd(f)
  emit({ agentId: null, source: 'mcp', kind: 'ticket.deps_changed', payload: { ticket: t.id, key: t.key, depends_on: want } })
  return want
}

export async function cancelTicket(ticketId: string, opts: { tell?: boolean; asked?: boolean } = {}): Promise<{ key: string; stopped: string | null }> {
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
  const f = getFeature(t.feature_id); if (f) writeFeatureMd(f)
  if (f && opts.tell !== false) {
    const waiting = waitingOn(f.id, t.key), them = waiting.length === 1 ? 'it' : 'them'
    tellTpm(f, `HQ: ${opts.asked ? `The user OK'd removing ${t.key}; it is cancelled` : `The user cancelled ${t.key}`}${stopped ? ` and its engineer ${stopped} was stopped` : ''}.`
      + ` Don't assign it again.${waiting.length ? ` ${listKeys(waiting)} waited on it and can't start until you rewire ${them} with set_dependencies (or remove ${them} with cancel_ticket).` : ''}`)
  }
  return { key: t.key, stopped }
}
/** Cancel a feature: every ticket not merged yet is cancelled (engineers stop). The project's TPM stays (Bug 52) and is told. */
export async function cancelFeature(featureId: string): Promise<{ tickets: string[]; stopped: string[] }> {
  const f = getFeature(featureId); if (!f) throw new Error('unknown feature')
  if (f.status === 'cancelled') return { tickets: [], stopped: [] }
  const done: string[] = [], stopped: string[] = []
  for (const t of tickets(f.id)) {
    if (t.status === 'merged' || t.status === 'cancelled') continue
    const r = await cancelTicket(t.id, { tell: false }); done.push(r.key); if (r.stopped) stopped.push(r.stopped)
  }
  run("UPDATE features SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), f.id); patch('feature', f.id, { status: 'cancelled' }); closeAsks(f.id)
  writeProjectMd(f.repo_id); sweepNotices()
  tellTpm(f, `HQ: The user cancelled feature ${f.handle ?? ''} "${f.title}"${done.length ? `: ${listKeys(done)} ${done.length === 1 ? 'is' : 'are'} cancelled` : ''}. Don't add to it.`)
  emit({ agentId: null, source: 'ui', kind: 'feature.cancelled', payload: { feature: f.id, tickets: done, stopped } })
  return { tickets: done, stopped }
}
/** "Start" on the TPM box's Your turn (Bug 52): every feature's ready tickets in the project. */
export async function startReadyRepo(repoId: string): Promise<{ started: string[]; queued: string[] }> {
  const out = { started: [] as string[], queued: [] as string[] }
  for (const f of features().filter((x) => x.repo_id === repoId && x.status !== 'cancelled')) {
    const r = await startReady(f.id); out.started.push(...r.started); out.queued.push(...r.queued)
  }
  return out
}
/** "Start ready": every ticket of the feature that may start now gets the go-ahead; they start as parallel slots allow. */
export async function startReady(featureId: string): Promise<{ started: string[]; queued: string[]; blocked: { key: string; on: string[] }[] }> {
  const f = getFeature(featureId); if (!f || f.status === 'cancelled') throw new Error('unknown feature')
  notClearing(f.repo_id)
  const going = new Set(openAsks().map((a) => actionOf(a)?.ticket)) // Bug 50: the user is being asked whether to remove it
  for (const t of readyTickets(tickets(featureId), j<string[]>(f.merge_order, []))) if (!going.has(t.id)) setTicket(t.id, { go_ahead: 1 })
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
      const asking = new Set(openAsks().map((a) => actionOf(a)?.ticket)) // Bug 50: not while the user is asked whether to remove it
      const next = features().filter((f) => f.status !== 'cancelled' && !getRepo(f.repo_id)?.clearing_at).reverse()
        .flatMap((f) => readyTickets(tickets(f.id), j<string[]>(f.merge_order, [])).filter((t) => t.go_ahead && !starting.has(t.id) && !asking.has(t.id)))[0]
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
