// The findings loop (Part 5): what the UI tester and the backend checker found, kept per project across runs (findingrules.ts has the rules). Stored in the
// docs table, scope `findings:<repoId>`, one row per finding (key = its id), so the loop needs no migration of its own; `stage:<runId>` marks a run whose
// findings stage is done. Everything here survives a backend restart: a stage that was cut off runs again, and skips the looks it already made.
// The user decides on the page (Fix / Ignore / make it a rule / fine as it is, with their own wording) and presses Send; HQ tells the TPM, and the TPM's
// create_fix_ticket is the only way a finding becomes a ticket (checked here, not left to the prompt).
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { DEFAULTS } from './config.ts'
import { getSetting, now, one, q, run, tx } from './db.ts'
import { bus, emit, patch } from './events.ts'
import { readCriteria, type Criterion } from './criteria.ts'
import { createTicket } from './tickets.ts'
import { featureByHandle, features, getRepo, ticketInRepo, type Repo } from './records.ts'
import { messageTpm } from './tpm.ts'
import { inputs, type Retry } from './loopinputs.ts'
import { afterCheck, decide, dueForReplay, fromTester, ticketGone, findingLines, MAX_STRIKES, said, take,
   ticketBlock, toSend, type Check, type Decision, type Fresh, type Kept } from './findingrules.ts'
import { checkRun } from './backendcheck.ts'
import { judgeRetry, replay, retryGoal, retryOf } from './replay.ts'
import { autoWork } from './testrun.ts'

const scope = (repoId: string): string => `findings:${repoId}`
const put = (k: Kept): void => {
  run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
    scope(k.repo_id), k.id, JSON.stringify(k), now())
  patch('finding', `${k.repo_id}:${k.id}`, view(k))
}
/** A finding as the page has it: `id` unique across projects ("repo:P-3"), `fid` its own id. Every optional field is there, null when unset: the page merges
 *  patches into what it has, so a decision taken back has to arrive as null, not as a missing field. */
const view = (k: Kept): Record<string, unknown> => ({ decision: null, wording: null, rule: null, decided_at: null, sent_at: null, criterion: null, expect: null, back: null,
  ...k, id: `${k.repo_id}:${k.id}`, fid: k.id })
const parse = (text: string): Kept | null => { try { const k = JSON.parse(text) as Kept; return k && typeof k.id === 'string' ? k : null } catch { return null } }
/** A project's findings, oldest first. */
export function findingsOf(repoId: string): Kept[] {
  return q<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key LIKE 'P-%'", scope(repoId)).map((r) => parse(r.text)).filter((k): k is Kept => !!k)
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
}
/** Every project's findings, for the page. */
export function allFindings(): Record<string, unknown>[] {
  return q<{ text: string }>("SELECT text FROM docs WHERE scope LIKE 'findings:%' AND key LIKE 'P-%'").map((r) => parse(r.text)).filter((k): k is Kept => !!k).map(view)
}
export const getFinding = (repoId: string, fid: string): Kept | null => {
  const r = one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', scope(repoId), fid); return r ? parse(r.text) : null
}
/** Clear and Remove: the project's findings go with it. */
export function dropFindings(repoId: string): void {
  for (const k of findingsOf(repoId)) patch('finding', `${repoId}:${k.id}`, null)
  run('DELETE FROM docs WHERE scope = ?', scope(repoId))
}
const nextId = (repoId: string): number => findingsOf(repoId).reduce((m, k) => Math.max(m, Number(k.id.slice(2)) || 0), 0) + 1

/** Testing is optional: HQ's `tester` setting, and the project's own switch (`repos.ui_test`, 'off' or NULL, from the UI tester's PR #135), the same two
 *  auto.ts uiTestOn reads. Read fresh: the user may turn it off while the stage waits. Before that column exists the project's switch reads as on. */
export const testingOn = (repoId: string): boolean => getSetting('tester', DEFAULTS.tester) !== 'off'
  && (getRepo(repoId) as { ui_test?: string | null } | undefined)?.ui_test !== 'off'

/** The rule the user writes for an unspecified finding becomes a criterion of its fix ticket, so it's held to the criteria's own checks. */
const ruleProblem = (text: string): string | null => { const c = readCriteria([{ kind: 'backend', text }]); return 'error' in c ? c.error.replace(/^Criterion A1/, 'The rule') : null }

/** The user's decision (or a change of wording) on one finding. `decision: null` takes the decision back. */
export function decideFinding(repoId: string, fid: string, body: { decision?: Decision | null; wording?: string; rule?: string }): Kept {
  const d = body.decision === undefined ? undefined : body.decision
  if (d != null && !['fix', 'ignore', 'rule', 'fine'].includes(d)) throw new Error('decision is fix, ignore, rule or fine')
  return tx(() => {
    const k = getFinding(repoId, fid); if (!k) throw new Error(`no finding ${fid}`)
    const r = decide(k, d === undefined ? k.decision ?? null : d, { wording: body.wording, rule: body.rule }, ruleProblem); if ('error' in r) throw new Error(r.error)
    put(r); return r
  })
}
/** Send: the findings marked Fix or rule go to the TPM in one message; Ignore and fine close. Nothing marked: nothing happens (the loop ends there). */
export async function sendFindings(repoId: string): Promise<{ sent: string[]; closed: string[] }> {
  const repo = getRepo(repoId); if (!repo) throw new Error('unknown repo')
  const { send, close } = toSend(findingsOf(repoId)), t = now()
  if (!send.length && !close.length) throw new Error('Mark at least one finding Fix, Ignore, a rule or fine first.')
  tx(() => { for (const k of close) put({ ...k, state: 'closed' }); for (const k of send) put({ ...k, state: 'sent', sent_at: t }) })
  if (send.length) {
    const body = `The user sent ${send.length === 1 ? 'a finding' : `${send.length} findings`} from auto mode's testing for fix tickets. For each, call create_fix_ticket `
      + '(list_findings shows them in full: what is wrong, the steps, the criterion it breaks or the user\'s new rule). One ticket per finding unless two are '
      + 'plainly the same fix. Keep the user\'s wording.\n' + send.map((k) => `- ${k.id}: ${said(k)}${k.rule ? ` (new rule: ${k.rule})` : k.criterion ? ` (breaks ${k.criterion})` : ''}`).join('\n')
    try { await messageTpm(repoId, body, { keepAsks: true }) } catch (e) { // not sent: they go back to waiting, so Send can be pressed again
      tx(() => { for (const k of send) put({ ...k, state: 'new', sent_at: undefined }) }); throw e
    }
  }
  emit({ agentId: null, source: 'ui', kind: 'findings.sent', payload: { repo: repoId, sent: send.map((k) => k.id), closed: close.map((k) => k.id) } })
  return { sent: send.map((k) => k.id), closed: close.map((k) => k.id) }
}

/** The TPM's side: a fix ticket for a sent finding. HQ checks the finding is sent and not broken twice, adds the user's rule as a criterion when it's a
 *  rule, and puts the finding (steps, criterion, evidence) under the TPM's spec. */
export function createFixTicket(repoId: string, a: { finding: string; feature?: string; title: string; size: 'S' | 'M' | 'L'; spec: string; criteria: unknown[] }): string {
  const fid = a.finding.trim().toUpperCase(), k = getFinding(repoId, fid)
  if (!k) throw new Error(`There's no finding ${fid}. list_findings shows the ones sent to you.`)
  if (k.state === 'flagged' || k.tickets.length >= MAX_STRIKES) throw new Error(`${fid} was still broken after ${k.tickets.length} fix tickets: HQ makes no more. The user decides what happens to it.`)
  if (k.state !== 'sent') throw new Error(`${fid} isn't sent for a ticket (it's ${k.state}). Only findings the user sent become tickets.`)
  const f = a.feature?.trim() ? featureByHandle(repoId, a.feature) : undefined
  if (a.feature?.trim() && !f) throw new Error(`There's no feature ${a.feature}.`)
  const feature = f ?? features().filter((x) => x.repo_id === repoId && x.status !== 'cancelled').at(-1)
  if (!feature) throw new Error('Start a feature for the fix first (start_feature).')
  const given = readCriteria(a.criteria); if ('error' in given) throw new Error(given.error)
  let list: Criterion[] = given.list
  if (k.rule && !list.some((c) => c.text.toLowerCase() === k.rule!.toLowerCase())) {
    const more = readCriteria([...list.map((c) => ({ kind: c.kind, text: c.text })), { kind: 'backend', text: k.rule }]); if ('error' in more) throw new Error(more.error)
    list = more.list
  }
  if (!list.length) throw new Error('Give the fix ticket its acceptance criteria: what is true once it is fixed.')
  const t = createTicket(feature.id, { title: a.title, size: a.size, spec: `${a.spec.trim()}\n\n${ticketBlock(k)}`, criteria: list })
  run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
    `ticket:${t.id}`, 'finding', fid, now())
  put({ ...k, state: 'fixing', tickets: [...k.tickets, t.key] })
  emit({ agentId: null, source: 'mcp', kind: 'findings.ticket', payload: { repo: repoId, finding: fid, ticket: t.key } })
  return `Created ${t.key} for ${fid} in ${feature.handle}. Its spec carries the finding; after it merges, the next run replays the steps to check the fix.`
}
/** The TPM's tools for the loop, registered by mcp.ts for the TPM only. */
export function findingTools(s: McpServer, repoId: string, log: (tool: string, args: unknown) => void): void {
  const out = (t: string) => ({ content: [{ type: 'text' as const, text: t }] }), bad = (t: string) => ({ ...out(t), isError: true })
  s.registerTool('list_findings', { description: 'Findings from auto mode\'s testing that the user sent for fix tickets, in full.', inputSchema: {} }, async () => {
    log('list_findings', {})
    const sent = findingsOf(repoId).filter((k) => k.state === 'sent')
    return out(sent.length ? sent.map(ticketBlock).join('\n\n') : 'No findings are waiting for a ticket.')
  })
  s.registerTool('create_fix_ticket', {
    description: 'Create the fix ticket for a finding the user sent (list_findings). Like create_ticket, plus `finding` (P-3). HQ adds the finding\'s steps and evidence under your spec. '
      + 'Only sent findings, at most two tickets per finding.',
    inputSchema: { finding: z.string(), feature: z.string().optional(), title: z.string(), size: z.enum(['S', 'M', 'L']), spec: z.string(),
      criteria: z.array(z.object({ id: z.string().optional(), kind: z.string(), text: z.string() })).default([]) },
  }, async (a) => { log('create_fix_ticket', a); try { return out(createFixTicket(repoId, a)) } catch (e) { return bad((e as Error).message) } })
}

/** A fix ticket that's gone (cancelled, removed, or its run undone) sends its finding back to the user. Heard as it happens, and looked for again as a stage
 *  starts (the backend may have been down when it happened). */
function settleGone(repoId: string): void {
  for (const k of findingsOf(repoId)) for (const key of k.tickets) {
    const t = ticketInRepo(repoId, key); if (t && t.status !== 'cancelled') continue
    const back = ticketGone(getFinding(repoId, k.id) ?? k, key, t ? `its fix ticket ${key} was cancelled` : `its fix ticket ${key} is gone`); if (back) put(back)
  }
}
bus.on('patch', (p: { entity: string; id: string; patch: Record<string, unknown> | null }) => {
  if (p.entity !== 'ticket' || p.patch?.status !== 'cancelled') return
  const fid = findingOfTicket(p.id); if (!fid) return
  const repoId = one<{ repo_id: string }>('SELECT f.repo_id FROM tickets t JOIN features f ON f.id = t.feature_id WHERE t.id = ?', p.id)?.repo_id; if (repoId) settleGone(repoId)
})

// ---- the stage at the end of an auto run --------------------------------------------------------------------------------------------------------------

const mergedAt = (repoId: string) => (key: string): number | null => { const t = ticketInRepo(repoId, key); return t?.status === 'merged' ? t.updated_at : null }
/** Before the UI tester's run: replay each sent finding whose fix tickets have merged. A replay that ran is judged in code where it can be, else by the
 *  checker; one whose steps can't run any more (the button moved) goes to the tester to retry by its goal, with nothing of the checker's in it. */
export async function beforeUiTest(repo: Repo, runId: string, gen: number): Promise<{ retry: Retry[] } | 'stopped'> {
  if (!testingOn(repo.id)) return { retry: [] }
  const work = autoWork(repo.path, gen); try { return await replayDue(repo, runId, work.signal, gen) } finally { work.done() }
}
async function replayDue(repo: Repo, runId: string, signal: AbortSignal, gen: number): Promise<{ retry: Retry[] } | 'stopped'> {
  settleGone(repo.id) // a ticket cancelled while the backend was down
  const due = dueForReplay(findingsOf(repo.id), mergedAt(repo.id)), retry: Retry[] = []
  for (const k of due) {
    if (signal.aborted) break
    const r = await replay(repo, k, signal, gen); if (r === 'stopped') return 'stopped'
    const cur = getFinding(repo.id, k.id); if (!cur || cur.state !== 'fixing') continue // the user or a Clear changed it meanwhile
    if (r.kind === 'retry') { retry.push(retryOf(cur)); retrying.set(`${repo.id}:${cur.id}`, runId); continue }
    put(afterCheck(cur, { run: runId, at: now(), ...r.check }))
  }
  return signal.aborted ? 'stopped' : { retry }
}
const retrying = new Map<string, string>() // finding → the run whose tester retries it (in memory: after a restart the stage runs again and replays it again)

/** After the UI tester's run: retried findings take its answer, the backend checker reads every recording, and what both found is kept. The stage is
 *  marked done, so a restart doesn't pay for it twice. */
export async function afterUiTest(repo: Repo, runId: string, gen: number): Promise<'done' | 'stopped'> {
  if (!testingOn(repo.id) || stageDone(repo.id, runId)) return 'done'
  const ui = inputs().uiRun(repo.id, runId)
  for (const [key, rid] of retrying) {
    const [rp, fid] = key.split(':'); if (rp !== repo.id || rid !== runId) continue
    retrying.delete(key); const k = getFinding(repo.id, fid!); if (!k || k.state !== 'fixing') continue
    const sc = ui?.scenarios.find((s) => s.scenario.kind === 'retry' && s.scenario.goal.startsWith(retryGoal(k).split(':')[0]! + ':'))
    if (sc && !fromTester(k)) { // the checker's finding: the tester only did the steps again; the recording says whether it's fixed
      const work = autoWork(repo.path, gen), j = await judgeRetry(repo, k, sc.recording ? inputs().recording(repo.id, sc.recording) : null, work.signal).finally(work.done)
      if (j === 'stopped') return 'stopped'
      const now0 = getFinding(repo.id, k.id); if (now0?.state === 'fixing') put(afterCheck(now0, { run: runId, at: now(), ...j })); continue
    }
    const c: Omit<Check, 'run' | 'at'> = !sc ? { result: 'unknown', how: 'retry', why: 'the tester didn\'t retry it' }
      : sc.findings.length ? { result: 'broken', how: 'retry', why: `the tester, trying it by its goal: ${sc.findings[0]!.what}` }
      : sc.outcome === 'ok' ? { result: 'fixed', how: 'retry', why: 'the old steps no longer fit, and the tester, trying it by its goal, found nothing wrong' }
      : { result: 'unknown', how: 'retry', why: `the tester's retry didn't settle it (${sc.why ?? sc.outcome})` }
    put(afterCheck(k, { run: runId, at: now(), ...c }))
  }
  const fresh: Fresh[] = (ui?.findings ?? []).map((f) => ({ source: 'ui' as const, by: 'tester' as const, what: f.what, expected: f.expected, criterion: f.criterion, steps: f.steps, expect: f.expect,
    evidence: { scenario: f.scenario, goal: ui?.scenarios.find((s) => s.scenario.id === f.scenario)?.scenario.goal,
      recording: ui?.scenarios.find((s) => s.scenario.id === f.scenario)?.recording ?? undefined, rows: [], flags: [] } }))
  if (ui?.scenarios.length) {
    const c = await checkRun(repo, runId, ui.scenarios, gen); if (c === 'stopped') return 'stopped'
    fresh.push(...c.findings); if (c.note) note(repo.id, runId, c.note)
  }
  keep(repo.id, runId, fresh)
  run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO NOTHING', scope(repo.id), `stage:${runId}`, 'done', now())
  return 'done'
}
/** The stage hit an error: said once in the summary, and marked done, so the run can end (a stage that throws every tick would hold it for ever). */
export function stageFailed(repoId: string, runId: string, why: string): void {
  note(repoId, runId, `HQ hit an error in the findings stage, so this run's findings may be missing: ${why.split('\n')[0]!.slice(0, 200)}`)
  run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO NOTHING', scope(repoId), `stage:${runId}`, 'done', now())
}
export const stageDone = (repoId: string, runId: string): boolean => !!one('SELECT 1 AS x FROM docs WHERE scope = ? AND key = ?', scope(repoId), `stage:${runId}`)
const note = (repoId: string, runId: string, text: string): void => run('INSERT INTO docs(scope, key, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET text = excluded.text',
  scope(repoId), `note:${runId}`, text, now())
/** Keeps a run's findings (findingrules.ts take: one per key, ignored ones never again). */
export function keep(repoId: string, runId: string, found: Fresh[]): { added: number; dropped: number } {
  return tx(() => {
    const r = take(findingsOf(repoId), found, { repoId, runId, next: nextId(repoId) })
    for (const k of [...r.add, ...r.seen]) put(k)
    return { added: r.add.length, dropped: r.dropped }
  })
}
/** The run summary's section: what the replays showed, what's new, and anything about the checker the user should know. */
export function findingsSection(repoId: string, runId: string): string {
  const lines = findingLines(findingsOf(repoId), runId), n = one<{ text: string }>('SELECT text FROM docs WHERE scope = ? AND key = ?', scope(repoId), `note:${runId}`)?.text
  if (!lines.length && !n) return ''
  const waiting = findingsOf(repoId).filter((k) => k.state === 'new').length
  return [`## Findings`, ...lines, n ? `- ${n}` : '', waiting ? `\n${waiting} waiting for you: mark each Fix or Ignore under Findings, then Send. Nothing is fixed until you do.` : '']
    .filter(Boolean).join('\n')
}
/** A fix ticket's finding, for the Ticket tab. */
export const findingOfTicket = (ticketId: string): string | null => one<{ text: string }>("SELECT text FROM docs WHERE scope = ? AND key = 'finding'", `ticket:${ticketId}`)?.text ?? null
