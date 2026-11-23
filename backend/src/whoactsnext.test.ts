// Bug 292: who moves a ticket on next depends on the mode: manual (the user), auto (HQ), auto stopped or a parked ticket (the user again, until Resume or
// another go) and a Clear (nobody: HQ refuses starts and merges until the board is gone). Each text that says it was written on its own, so each fix
// covered one place (Bugs 193, 209, 220, 243, 245, 246, 311). This test puts one project in every mode and checks every such text against one table:
// the board's boxes, Your turn and the ⚠ menu (frontend), the TPM's start-up board (handover.ts), HQ's notices on a finished ticket and its PR
// (mergewatch.ts) and the tool descriptions agents get (mcp.ts). A sentence for the wrong mode fails it. The rule itself is backend/src/mover.ts.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-whonext-'))
process.env.HQ_HOME = path.join(root, 'hq'); process.env.HQ_MCP_PORT = '0'
const { migrate, run } = await import('./db.ts')
migrate()
const { sha } = await import('./util.ts')
const { autoGoing, hqMoves, nextMover } = await import('./mover.ts')
const { tpmPrompt } = await import('./handover.ts')
const { finishWords, prWords } = await import('./mergewatch.ts')
const { startMcpServer } = await import('./mcp.ts')

// The frontend imports its own files without an extension (Vite finds them): the same here. The board measures text on a canvas; with none it counts.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^\\.\\.?\\//.test(s) && !/\\.[a-z]+$/.test(s)) { try { return await next(s + '.ts', c) } catch { /* not a .ts file */ } }
  return next(s, c) }`)}`)
;(globalThis as any).document ??= { createElement: () => ({ getContext: () => null }) }
const FRONT = '../../frontend/src/' // plain strings: the backend's typecheck stays out of the frontend's files
const { buildBoard, ticketLabel } = await import(`${FRONT}board.ts`) as { buildBoard: (s: any, now: number, repo?: any) => any
  ticketLabel: (t: any, hqPlan?: boolean, clearing?: boolean) => string }
const { yourTurn, needsYou } = await import(`${FRONT}needs.ts`) as { yourTurn: (s: any, r: string) => { start: string[] }; needsYou: (s: any, m: any) => { key: string }[] }
const { mergeAct } = await import(`${FRONT}alerts.ts`) as { mergeAct: (s: any) => (t: any) => string | null }

type Who = 'hq' | 'user' | 'nobody'
/** Every mode, and who moves a ticket on in it: `who` for starts and merges, `plan` for its plan (HQ's plan check answers every plan while auto mode is
 *  on, stopped or parked too: gate.ts and plancheck.ts ask autoOn). `tpm`: the TPM can be started (tpm.ts refuses during a Clear, so its board has no
 *  clearing words). `finish`: open_pr can be answered in this mode (see the clearing note below). */
const MODES: { name: string; repo: Record<string, unknown>; parked?: string; who: Who; plan: Who }[] = [
  { name: 'manual', repo: { auto_mode: 0 }, who: 'user', plan: 'user' },
  { name: 'auto', repo: { auto_mode: 1 }, who: 'hq', plan: 'hq' },
  { name: 'auto stopped', repo: { auto_mode: 1, auto_stopped_why: "main's own tests fail." }, who: 'user', plan: 'hq' },
  { name: 'a parked ticket', repo: { auto_mode: 1 }, parked: 'Its tests still fail on main after 2 fixes.', who: 'user', plan: 'hq' },
  { name: 'clearing on auto', repo: { auto_mode: 1, clearing_at: 5 }, who: 'nobody', plan: 'nobody' },
  { name: 'clearing in manual mode', repo: { auto_mode: 0, clearing_at: 5 }, who: 'nobody', plan: 'nobody' },
]
const clearing = (m: (typeof MODES)[number]) => !!m.repo.clearing_at
const repoOf = (m: (typeof MODES)[number]): any => ({ id: 'r1', name: 'garden', path: '/p', default_branch: 'main', auto_stopped_why: null, clearing_at: null, ...m.repo })

/** Whom a sentence on the board names as moving next. The board speaks to the user ("you", "Merge"); a line can name no one (a conflict's files). */
function boardNames(text: string): Who[] {
  const out: Who[] = []
  if (/being cleared/.test(text)) out.push('nobody')
  if (/\bHQ (tests|starts|merges|is checking|checks)\b|HQ's (plan )?check/.test(text)) out.push('hq')
  if (/\byou\b|\byour\b|ready to start|merge it here|then merge it|Merge to try|Merge or Make PR|^parked:/.test(text)) out.push('user')
  return out
}
/** Whom a sentence to an agent (the TPM, an engineer) names: there "you" is the agent, so only "the user" is the user. */
function agentNames(text: string): Who[] {
  const out: Who[] = []
  if (/being cleared/.test(text)) out.push('nobody')
  if (/\bHQ (tests|starts|merges|checks|has its engineer|opens)\b/.test(text)) out.push('hq')
  if (/\b[Tt]he user\b|\buser's\b/.test(text)) out.push('user')
  return out
}
/** The buttons that move a ticket on by the user's hand. A link to an open PR (PR #7 ↗) only shows it. */
const userActs = (acts: any[]): string[] => acts.filter((a) => ['launch', 'approve', 'merge', 'make-pr', 'fix', 'resume'].includes(a.kind)
  || (a.kind === 'link' && /^Create PR/.test(a.label))).map((a) => a.kind)

/** Checks every case and fails with all the wrong ones listed, not only the first. */
function allOf(each: (want: (got: unknown, expected: unknown, what: string) => void) => void): void {
  const bad: string[] = []
  each((got, expected, what) => { if (JSON.stringify(got) !== JSON.stringify(expected)) bad.push(`${what} → ${JSON.stringify(got)}, wants ${JSON.stringify(expected)}`) })
  assert.deepEqual(bad, [])
}

/** Each kind of ticket that waits on someone: ready to start, a plan, finished in each way (local, pushed, GitHub refused its PR, PR open), and in conflict. */
const KINDS: { name: string; t: Record<string, unknown>; plan?: boolean; noWords?: boolean }[] = [
  { name: 'ready to start', t: { status: 'queued' } },
  { name: 'a plan', t: { status: 'plan_review', branch: 'hq/x/T-01' }, plan: true },
  { name: 'finished, local', t: { status: 'pr_ready', pr_state: 'local', branch: 'hq/x/T-01' } },
  { name: 'finished, pushed', t: { status: 'pr_ready', pr_state: 'waiting', branch: 'hq/x/T-01' } },
  { name: 'finished, GitHub refused its PR', t: { status: 'pr_ready', pr_state: 'not_opened', branch: 'hq/x/T-01', pr_url: 'https://github.com/o/r/compare/main...x' } },
  { name: 'PR open', t: { status: 'pr_open', pr_state: 'open', branch: 'hq/x/T-01', pr_number: 7, pr_url: 'https://github.com/o/r/pull/7' } },
  { name: 'in conflict', t: { status: 'pr_ready', pr_state: 'local', branch: 'hq/x/T-01', conflict_files: '["a.ts"]', conflict_with: '["T-02"]' }, noWords: true },
]
const ticketOf = (m: (typeof MODES)[number], k: (typeof KINDS)[number]): any => ({ id: 'a0', key: 'T-01', feature_id: 'f1', title: 'Reminders', size: 'S',
  deps: '[]', go_ahead: 0, auto_parked_why: m.parked ?? null, conflict_files: null, conflict_with: null, pr_state: null, pr_number: null, pr_url: null, branch: null, ...k.t })
const stateOf = (m: (typeof MODES)[number], k: (typeof KINDS)[number]): any => ({
  repos: [repoOf(m)], features: [{ id: 'f1', repo_id: 'r1', title: 'Water the plants', status: 'planning', created_at: 1, merge_order: '[]' }],
  tickets: [ticketOf(m, k)],
  agents: k.plan ? [{ id: 'e1', role: 'engineer', display_name: 'eng-1', status: 'plan_review', ticket_id: 'a0', feature_id: 'f1', repo_id: 'r1' }] : [],
  reviews: k.plan ? [{ id: 'R1', ticket_id: 'a0', status: 'open', round: 1, plan_check: null }] : [],
  messages: [], attention: [], asks: [], settings: {}, defaults: {}, held: 0, ports: {}, previews: [], testRuns: [], working: 0,
})

test('the rule: mover.ts says who moves a ticket on in each mode, and records.ts gives the backend the same one', async () => {
  const records = await import('./records.ts')
  assert.equal(records.hqMoves, hqMoves); assert.equal(records.autoGoing, autoGoing)
  for (const m of MODES) {
    const t = { auto_parked_why: m.parked ?? null }
    assert.equal(nextMover(repoOf(m), t), m.who, m.name)
    assert.equal(hqMoves(repoOf(m), t), m.who === 'hq' || (clearing(m) && !!m.repo.auto_mode), `${m.name}: hqMoves leaves a Clear to nextMover`)
  }
})

test('board: each box\'s words and buttons name whoever moves it on next, in every mode (Bug 311: a Clear on auto said "HQ tests it, then merges it")', () => {
  allOf((want) => { for (const m of MODES) for (const k of KINDS) {
    const s = stateOf(m, k), v = buildBoard(s, 10, s.repos[0]).nodes.find((n: any) => n.id === 't:a0').data.view, at = `${m.name}, ${k.name}`
    const who = k.plan ? m.plan : m.who, first: string = v.lines[0]?.text ?? ''
    // a parked ticket's first line is why auto mode parked it: the user's to try again. One with an engineer at work (a plan here: only the user starts one
    // on a parked ticket) says what goes on, as any box: its plan is still HQ's to check (no Approve), and the park comes under it (Bug 336)
    if (!k.noWords) want(boardNames(first), [who], `${at}: "${first}"`)
    if (m.parked) want(boardNames(first), [k.plan ? 'hq' : 'user'], `${at}: "${first}"`)
    if (m.parked && k.plan) want(v.lines[1]?.text, `parked by auto mode: ${m.parked}`, `${at}: the park under it`)
    want(userActs(v.acts).length > 0, who === 'user', `${at}: buttons for the user ${JSON.stringify(userActs(v.acts))}`)
  } })
})

test('Bug 335: during a Clear the pill follows the box (no "ready to merge"), and no Try again or Try it (HQ refuses both)', () => {
  allOf((want) => { for (const m of [...MODES, { ...MODES[4]!, name: 'clearing on auto, parked', parked: 'Its tests failed twice.' }]) for (const k of KINDS) {
    const s = stateOf(m, k), at = `${m.name}, ${k.name}`; s.tickets[0].worktree_path = '/wt' // a finished one's worktree: Try it shows
    const v = buildBoard(s, 10, s.repos[0]).nodes.find((n: any) => n.id === 't:a0').data.view
    const pill = ticketLabel(v.t, v.hqPlan, v.clearing) // as Nodes.tsx shows it; the Ticket tab (App.tsx) passes the same clearing (needs.ts clearingPlan)
    want(/ready to/.test(pill), !clearing(m) && /ready to/.test(ticketLabel(v.t)), `${at}: pill "${pill}"`)
    if (clearing(m) && k.t.status === 'pr_ready' && !k.noWords) want(pill, 'not merged', `${at}: pill`)
    want(v.acts.some((a: any) => a.kind === 'auto-retry'), !!m.parked && !clearing(m), `${at}: Try again`)
    want(v.acts.some((a: any) => a.kind === 'try'), /^pr_/.test(String(k.t.status)) && !k.noWords && !clearing(m), `${at}: Try it`) // the preview is refused too
  } })
})

test('Your turn and the ⚠ menu: a ticket to start, a plan to answer, a merge to do or a conflict to fix are listed for the user only when it is theirs', () => {
  allOf((want) => { for (const m of MODES) for (const k of KINDS) {
    const s = stateOf(m, k), at = `${m.name}, ${k.name}`, keys = needsYou(s, mergeAct(s)).map((n) => n.key.split(':')[0])
    const who = k.plan ? m.plan : m.who
    if (k.name === 'ready to start') want(yourTurn(s, 'r1').start, who === 'user' ? ['T-01'] : [], `${at}: Your turn's Start`)
    else want(keys.some((x) => ['review', 'merge', 'fix'].includes(x!)), who === 'user', `${at}: listed for the user (${keys.join(', ')})`)
  } })  // the ⚠ menu's own list of merges (App.tsx Bell, a .tsx this test can't load) asks the same rule as mergeAct above
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'frontend', 'src', 'App.tsx'), 'utf8')
  assert.match(app, /acts = f\.cancelled \|\| \(b\.repo && nextMover\(b\.repo, t\) !== 'user'\) \? \[\] : mergeActs\(/)
})

test('the TPM\'s start-up board names who moves each ticket on, and the mode lines say the same (no Clear: the TPM is not started during one)', () => {
  allOf((want) => { for (const m of MODES.filter((x) => !clearing(x))) {
    const tks = KINDS.map((k, i) => ({ ...ticketOf(m, k), id: `a${i}`, key: `T-0${i + 1}`, title: k.name }))
    const brief = (localOnly = false) => tpmPrompt(repoOf(m), { ws: '/ws', previous: null, messages: [], localOnly, board: [{ f: { title: 'Plants', handle: 'F-1' } as never, tickets: tks }] })
    const text = brief()
    for (const [i, k] of KINDS.entries()) {
      const line = text.match(new RegExp(`T-0${i + 1} \\(S\\) ${k.name}: ([^\\n]*)`))?.[1] ?? '', words = line.replace(/ · branch .*$/, '').replace(/ \(auto mode parked it: [^)]*\)$/, '')
      want(agentNames(words), [k.plan ? m.plan : m.who], `${m.name}, ${k.name}: "${line}"`)
    }
    const mode = text.match(/Auto mode is (on|off) for this project[^\n]*/)![0]
    if (m.who === 'hq' || m.parked) want(/the user starts|the user merges|meanwhile the user/.test(mode), false, `${m.name}: "${mode}"`)
    if (!m.repo.auto_mode) want(/HQ starts|HQ merges/.test(mode), false, `${m.name}: "${mode}"`)
    if (m.repo.auto_stopped_why) want(/until the user presses Resume, and meanwhile the user starts and merges tickets from HQ/.test(mode), true, `${m.name}: "${mode}"`)
    const local = brief(true).match(/HQ can't push to garden[^\n]*/)![0] // a GitHub project worked on locally: who merges into the local main
    want(agentNames(local), [m.parked ? 'hq' : m.who], `${m.name}: "${local}"`) // the project's line: a parked ticket is the one exception
  } })
})

// A Clear asks each engineer for its handoff note and stops it. open_pr is not refused meanwhile (logged with Bug 292's PR: the lead's call, the
// family of Bug 294), so these notices have no clearing words of their own yet; the modes before it are checked.
test('HQ\'s notices on a finished ticket (open_pr) and on its PR name who merges it, in every mode', () => {
  allOf((want) => { for (const m of MODES.filter((x) => !clearing(x))) {
    const t = ticketOf(m, KINDS[2]!)
    for (const pushed of [false, true]) for (const why of ['', 'tests', 'changed', 'fixed']) {
      const w = finishWords(repoOf(m), t, { base: 'main', pushed, tests: why === 'tests', changed: why === 'changed', fixed: why === 'fixed' || why === 'tests', fixedWhat: 'its tests' })
      const at = `${m.name}, ${pushed ? 'pushed' : 'local'}, ${why || 'first finish'}`
      want(agentNames(w.tpm), [m.who], `${at}: to the TPM "${w.tpm}"`); want(agentNames(w.reply), [m.who], `${at}: to the engineer "${w.reply}"`)
      want(w.notice !== null, why === 'fixed' && m.who === 'user', `${at}: "Ready to merge again" is for the user's merge only`)
    }
    for (const pr of [7, null]) {
      const words = prWords(repoOf(m), t, { pr, branch: 'hq/x/T-01', base: 'main' })
      want(agentNames(words), [m.who], `${m.name}, PR ${pr ?? 'refused'}: "${words}"`)
    }
  } })
})

test('the tool descriptions agents get are the same in every mode: Claude Code keeps the list from the session\'s start, and the mode can change (Bug 245)', async () => {
  const srv = startMcpServer(); await new Promise((r) => srv.once('listening', r))
  after(() => { srv.close(); srv.closeAllConnections(); fs.rmSync(root, { recursive: true, force: true }) })
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`
  const tools = async (token: string) => {
    const client = new Client({ name: 'hq-unit', version: '0.0.1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    try { return JSON.stringify((await client.listTools()).tools) } finally { await client.close() }
  }
  const seen = new Map<string, string>()
  for (const [i, m] of MODES.entries()) {
    const r = repoOf(m), id = `r${i}`
    run('INSERT INTO repos(id, name, path, kind, default_branch, auto_mode, auto_stopped_why, clearing_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, `garden${i}`, `/tmp/garden${i}`, 'local', 'main', r.auto_mode, r.auto_stopped_why, r.clearing_at, 1)
    for (const role of ['tpm', 'engineer']) {
      const aid = `${role}-${i}`, token = `token-of-${aid}`
      run(`INSERT INTO agents(id, role, repo_id, model_alias, tmux_session, cwd, token_hash, status, in_plan_mode, started_at, last_event_at)
        VALUES (?, ?, ?, 'sonnet', ?, '/tmp', ?, 'working', 0, 1, 1)`, aid, role, id, `hq-${aid}`, sha(token))
      const list = await tools(token)
      if (seen.has(role)) assert.equal(list, seen.get(role), `${role}'s tools in mode ${m.name} differ from manual's`)
      else seen.set(role, list)
    }
  }
})
