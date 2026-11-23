// Bug 76: builds and full test runs take turns. On 2026-11-08 three engineers and auto mode's own test each ran `vite build` and the test suite at the same moment:
// load 26 on 14 cores. Now at most `heavy_at_once` of them run at a time on this machine (1 unless the user raises it), first come first served, and HQ's own test
// runs wait in the same line as engineers' commands.
// An engineer's command is held at its PreToolUse hook: Claude Code starts a command when that hook answers, the command's own time limit only starts then, and a wait
// costs no tokens (spike 2026-11-09 on 2.1.300, again on 2.1.322: held 40 s, the command began the second the hook answered, and a 5 s limit still let it run). The engineer just
// sees the command take longer.
// Nothing waits for good. A turn comes back when its command ends, when its agent moves on to its next tool, when its agent's turn ends, when its agent goes, or
// when the command's own time limit has passed; and whoever has waited TURN_WAIT_S goes ahead anyway.
// HQ down or restarted (Bug 112): the engineer's hook is a script (turnwait.mjs) that asks again every second until HQ answers, so a build or test run that
// starts meanwhile, or that was waiting here when HQ went, is back in this line once HQ is up; it goes by the same rules (heavykind.ts) and by the test
// commands HQ leaves it in a file (saveTestCmds). After HQ_AWAY_WAIT_S without HQ the command goes ahead anyway.
import fs from 'node:fs'
import type http from 'node:http'
import { bashLimitMs, DEFAULTS, PATHS, TURN_WAIT_S } from './config.ts'
import { getSetting, now, q, run } from './db.ts'
import { bus, emit, patch, type HqEvent } from './events.ts'
import { getAgent, update, type Agent } from './agents.ts'
import { getRepo, repoOfAgent, repos } from './records.ts'
import { heldKind, type Heavy } from './heavykind.ts'

export { heavyKind, programs, type Heavy } from './heavykind.ts'

/** `lane`: who in the agent runs the command: 'main' for the agent itself, else its helper's (subagent's) id. One lane runs one command at a time.
 *  `at`: when it asked for its turn. `activity`: what the agent's box says while it runs ("Running: npm test"), kept for a restart (Bug 186).
 *  `away`: read back after a restart (Bug 145); its hook (or HQ's own run, Bug 312) hasn't asked again yet, so nobody is told when its turn comes. */
type Turn = { id: string; who: string; what: Heavy; agentId: string | null; lane: string; limitMs: number; at?: number; activity?: string | null; away?: boolean }
const running = new Map<string, Turn & { at: number; started: number; until: number; timer: NodeJS.Timeout | null }>()
/** `behind`: told whom it waits behind each time that changes (Bug 289); `said`: whom it was told last. */
type Waiting = Turn & { at: number; go: (late: boolean) => void; giveUp: NodeJS.Timeout; left?: () => void; behind?: (who: string[]) => void
  said?: string }
const line: Waiting[] = []
const MAX_WAIT_MS = TURN_WAIT_S * 1000, BEAT_MS = Number(process.env.HQ_TURN_BEAT_MS) || 30_000, BG_TURN_MS = 2 * 3_600_000
/** Bug 145: how long a command that waited in the line before a restart keeps its place (or its turn, once it comes) for its hook to ask again. The hook
 *  asks every second (turnwait.mjs); one that doesn't in this time isn't coming. */
const CLAIM_MS = Number(process.env.HQ_TURN_CLAIM_MS) || 30_000
const cap = (): number => Math.max(1, Math.floor(Number(getSetting('heavy_at_once', DEFAULTS.heavy_at_once))) || 1)
/** What runs now and what waits, in order, for tests and the Events tab. */
export const turns = (): { running: string[]; waiting: string[] } => ({ running: [...running.values()].map((r) => r.who), waiting: line.map((w) => w.who) })
/** Bug 289: whom a turn waits behind, in words: "eng T-02", "eng T-02 and HQ's test of T-01", "eng T-02 and 2 more". '' for nobody (a row from before). */
export const behindWords = (who: unknown): string => {
  const b = Array.isArray(who) ? who.map(String).filter(Boolean) : []; return b.length > 2 ? `${b[0]} and ${b.length - 1} more` : b.join(' and ')
}
/** Bug 289: everyone in the line hears whom it waits behind now, once per change: an agent's box says it (waitText), HQ's own run is told (`behind`). */
function tellLine(): void {
  const who = turns().running, said = who.join('\n')
  for (const w of line) {
    if (w.said === said) continue
    w.said = said; w.behind?.(who)
    if (w.agentId) patch('agent', w.agentId, { activity: waitText(w.what, who) })
  }
}

/** Bug 145: an agent's turn, running (`started` set) or waiting, is kept in the database too, so a restarted backend still counts it. Bug 312: so is HQ's
 *  own run's (id `hq:<place>`, agent_id ''): a restart ends the run, but it keeps its place in the line for HQ to start it again (readBackTurns). */
const hqKept = (id: string): boolean => id.startsWith('hq:')
function save(t: Turn & { at: number }, started: number | null, until: number | null): void {
  if (t.agentId || hqKept(t.id)) run('INSERT OR REPLACE INTO turns(id, agent_id, who, what, lane, asked_at, started_at, until, activity) VALUES (?,?,?,?,?,?,?,?,?)',
    t.id, t.agentId ?? '', t.who, t.what, t.lane, t.at, started, until !== null && Number.isFinite(until) ? until : null, t.activity ?? null)
}
const forget = (id: string): void => run('DELETE FROM turns WHERE id = ?', id)
function begin(t: Turn, started = now(), until = now() + t.limitMs): void { // a turn nobody gives back ends with its command's own time limit
  const timer = Number.isFinite(until) ? setTimeout(() => release(t.id), Math.max(0, until - now())) : null; timer?.unref()
  const r = { ...t, at: t.at ?? started, started, until, timer }; running.set(t.id, r); save(r, started, until); tellLine()
}
/** Free turns go to whoever has waited longest. Also called when the user raises the limit. */
export function pump(): void {
  while (line.length && running.size < cap()) { const w = line.shift()!; clearTimeout(w.giveUp); begin(w); w.go(false) }
}
export function release(id: string): void {
  const r = running.get(id); if (!r) return
  if (r.timer) clearTimeout(r.timer); running.delete(id); forget(id); pump(); tellLine()
}
/** Out of the line without a turn: it isn't coming (its agent went, moved on, or dropped the hook). */
function leave(w: Waiting): void { const i = line.indexOf(w); if (i < 0) return; line.splice(i, 1); clearTimeout(w.giveUp); forget(w.id); w.left?.() }
/** Asks for a turn. `waiting` false: it has one already. Else `got` resolves when its turn comes, `late` when it waited MAX_WAIT_MS and goes ahead over the limit.
 *  `drop`: it isn't coming after all (or is done). `left`: called if it leaves the line without ever getting a turn, whoever took it out.
 *  Asked again by the same command (its hook asks again after a restart, Bug 145): it has the turn it held, or its old place in the line. */
export function take(t: Turn, left?: () => void, behind?: (who: string[]) => void): { waiting: boolean; got: Promise<{ waitedMs: number; late: boolean }>; drop: () => void } {
  const had = running.get(t.id), mine = line.findIndex((w) => w.id === t.id && w.away)
  if (had || (mine < 0 && running.size < cap() && !line.length)) {
    if (had?.timer) clearTimeout(had.timer)
    begin({ ...t, at: had?.at }); return { waiting: false, got: Promise.resolve({ waitedMs: 0, late: false }), drop: () => release(t.id) }
  }
  const at = mine < 0 ? now() : line[mine]!.at; let go!: (late: boolean) => void
  const got = new Promise<{ waitedMs: number; late: boolean }>((resolve) => { go = (late) => resolve({ waitedMs: now() - at, late }) })
  const w: Waiting = { ...t, at, go, left, behind, said: turns().running.join('\n'), // whom it waits behind now: the caller says so itself
    giveUp: setTimeout(() => { const i = line.indexOf(w); if (i < 0) return; line.splice(i, 1); begin(w); go(true) }, Math.max(0, at + MAX_WAIT_MS - now())) }
  w.giveUp.unref()
  if (mine < 0) line.push(w); else { clearTimeout(line[mine]!.giveUp); line[mine] = w }
  save(w, null, null)
  return { waiting: true, got, drop: () => { if (line.includes(w)) leave(w); else release(t.id) } }
}
let n = 0
/** What a waiting agent's box says, and behind whom (Bug 289). It starts "Waiting its turn" either way: the top bar counts those. */
const waitText = (what: Heavy, behind: string[] = []): string => {
  const b = behindWords(behind); return `Waiting its turn to ${what === 'tests' ? 'run tests' : 'build'}${b ? ` behind ${b}` : ''}`
}
/** HQ's own heavy work (a test run): waits its turn like an engineer's command, and gives it back however `fn` ends. `onWait`: it has to wait first
 *  (Bug 106: the board says so), behind whom; called again each time that changes (Bug 289). `ticket`: the ticket it's for, so its wait reaches that
 *  ticket's engineer's Events tab (Bug 309; lineOwner). `place`: its project's folder: with `who` it names this run across a restart (Bug 312), so the
 *  same run started again after a restart gets back the place in the line (or the turn) it had. None, or that run is going already: not kept. */
export async function withTurn<T>(who: string, what: Heavy, fn: () => Promise<T>, onWait?: (behind: string[]) => void,
  o: { ticket?: string | null; place?: string } = {}): Promise<T> {
  const named = o.place ? `hq:${o.place}:${who}` : '', live = running.get(named) ?? line.find((w) => w.id === named)
  const id = named && !(live && !live.away) ? named : `hq#${++n}`, ticket = o.ticket ?? null
  const t = take({ id, who, what, agentId: null, lane: 'main', limitMs: Infinity }, undefined, (b) => onWait?.(b))
  if (t.waiting) onWait?.(turns().running)
  if (t.waiting) emit({ agentId: null, source: 'system', kind: 'turns.waiting', payload: { who, what, behind: turns().running, ticket, hq: true } })
  const { waitedMs, late } = await t.got
  if (t.waiting) emit({ agentId: null, source: 'system', kind: 'turns.started', payload: { who, what, waitedS: Math.round(waitedMs / 1000), late, ticket, hq: true } })
  try { return await fn() } finally { release(id) }
}

/** An engineer's (or the Launch helper's) Bash command is about to start. False: nothing to wait for, answer the hook as usual. True: it waits, and `answer` is
 *  called when its turn comes. `res` is the hook's connection: when Claude Code drops it (Esc, a fresh start, the agent stopped) the command isn't coming, and its
 *  place in the line goes. Not held: a run_in_background command (a server, not a run), and anything in plan mode (it's refused anyway). */
export function gateBash(agent: Agent, c: { use: string; command: string; timeout: unknown; background: boolean; lane: string; plan: boolean; activity: string },
  res: http.ServerResponse, answer: () => void): boolean {
  if (agent.role !== 'engineer' && agent.role !== 'launcher') return false
  const what = heldKind(c, getRepo(repoOfAgent(agent) ?? '')?.test_cmd ?? null); if (!what) return false
  const who = agent.display_name ?? agent.id, id = `${agent.id}:${c.use || `?${++n}`}`
  let over = false, beat: NodeJS.Timeout | null = null
  const left = () => { // out of the line with no turn: the hook was dropped, or HQ heard the agent move on or go. A hook still held is answered, so nothing hangs on it
    if (over) return; over = true; if (beat) clearInterval(beat)
    emit({ agentId: agent.id, source: 'system', kind: 'turns.left', payload: { who, what, use: c.use } })
    if (!res.writableEnded && !res.destroyed) answer()
  }
  const limitMs = bashLimitMs(c.timeout) + 15_000, t = take({ id, who, what, agentId: agent.id, lane: c.lane, limitMs, activity: c.activity }, left)
  if (!t.waiting) return false
  const behind = turns().running
  patch('agent', agent.id, { activity: waitText(what, behind) }) // and again each time whom it waits behind changes (tellLine)
  emit({ agentId: agent.id, source: 'system', kind: 'turns.waiting', payload: { who, what, use: c.use, command: c.command.slice(0, 200), behind } })
  // waiting isn't stuck: the stuck loop goes by the last event. The box says it again too, for a page opened meanwhile (what an agent is doing isn't stored)
  beat = setInterval(() => { update(agent.id, { last_event_at: now() }); patch('agent', agent.id, { activity: waitText(what, turns().running) }) }, BEAT_MS); beat.unref()
  res.on('close', () => { if (!over) t.drop() })
  void t.got.then(({ waitedMs, late }) => {
    if (over) return release(id)
    over = true; clearInterval(beat!); patch('agent', agent.id, { activity: c.activity })
    // leftovers.ts counts the command as running from now, not from when it asked
    emit({ agentId: agent.id, source: 'system', kind: 'turns.started', payload: { who, what, use: c.use, timeout: c.timeout, sub: c.lane !== 'main', waitedS: Math.round(waitedMs / 1000), late } })
    answer()
  })
  return true
}
/** Bug 112: every project's test command, in a file. An engineer's Bash hook reads it when HQ is down and can't be asked whether a command is the project's
 *  test run (turnwait.mjs). Written whole (a removed project drops out) at every start and whenever a command changes (auto.ts setRepo), then moved into
 *  place, so the hook never reads half a file. A write that fails costs only this: with HQ down, a test command not known by its program's name goes ahead. */
export function saveTestCmds(): void {
  try {
    const cmds = Object.fromEntries(repos().filter((r) => r.test_cmd?.trim()).map((r) => [r.id, r.test_cmd]))
    const tmp = `${PATHS.testCmds}.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(cmds), { mode: 0o600 }); fs.renameSync(tmp, PATHS.testCmds)
  } catch (e) { emit({ agentId: null, source: 'system', kind: 'backend.error', payload: { what: 'test commands file', error: String(e) } }) }
}
/** Everything an agent holds or waits for, on one lane or (the agent is gone) on all of them. */
function releaseAgent(agentId: string, lane: string | null, except?: string): void {
  for (const w of [...line]) if (w.agentId === agentId && (lane === null || w.lane === lane) && w.id !== except) leave(w)
  for (const r of [...running.values()]) if (r.agentId === agentId && (lane === null || r.lane === lane) && r.id !== except) release(r.id)
}
/** The agent (or one helper of its) is starting its next tool, or has finished: whatever command that lane was running is over. HQ doesn't always hear a command
 *  end: one that Claude Code refuses by a deny rule fires its PreToolUse hook and nothing after (spike 2026-11-09), and its turn would sit unused for minutes.
 *  `use`: the tool now starting. The same command asking again (its hook does after a restart, Bug 145) isn't the next tool: it keeps its turn or place. */
export const laneMoved = (agentId: string, lane: string, use = ''): void => releaseAgent(agentId, lane, use ? `${agentId}:${use}` : undefined)
let started = false
/** A turn is given back when its command ends, when its agent's own turn ends (every command of its own has, then) and when its agent goes. hooks.ts tells
 *  laneMoved when an agent starts its next tool or a helper of its finishes. */
export function startTurns(): void {
  if (started) return
  started = true
  const ended = (e: HqEvent) => { // by the command's id; a hook that gives none ends the agent's oldest
    const use = String(e.payload.use ?? ''), id = use ? `${e.agentId ?? ''}:${use}` : [...running.values()].find((r) => r.agentId === e.agentId)?.id
    if (id) release(id)
  }
  bus.on('event:hook.PostToolUse:Bash', (e: HqEvent) => { if (!e.payload.bg) ended(e) }); bus.on('event:hook.PostToolUseFailure:Bash', ended)
  // Bug 96: a command that went on in the background (bgruns.ts) still fills the cores. Its turn moves to a lane of its own, which the agent's next tool and the
  // end of its turn don't free, and is given back when the run ends (or after BG_TURN_MS, whatever happens)
  bus.on('event:bg.started', (e: HqEvent) => {
    const r = running.get(`${e.agentId ?? ''}:${String(e.payload.use ?? '')}`); if (!r) return
    if (r.timer) clearTimeout(r.timer); r.lane = `bg:${String(e.payload.task)}`; r.until = now() + BG_TURN_MS
    r.timer = setTimeout(() => release(r.id), BG_TURN_MS); r.timer.unref(); save(r, r.started, r.until)
  })
  bus.on('event:bg.ended', (e: HqEvent) => releaseAgent(e.agentId ?? '', `bg:${String(e.payload.task)}`))
  bus.on('event:hook.Stop', (e: HqEvent) => { if (!e.payload.sub) releaseAgent(e.agentId ?? '', 'main') })
  for (const k of ['agent.stopped', 'agent.lost', 'hook.SessionEnd']) bus.on(`event:${k}`, (e: HqEvent) => { if (e.payload.reason !== 'clear') releaseAgent(e.agentId ?? '', null) })
  readBackTurns()
}
type Kept = { id: string; agent_id: string; who: string; what: Heavy; lane: string; asked_at: number; started_at: number | null; until: number | null
  activity: string | null }
/** Bug 145: what the last backend counted, read back at start (index.ts: after recoverAgents, before the hooks server answers). A command that was running
 *  holds its turn until HQ hears it end (or its agent move on, or go) or until its own time limit has passed. One that waited keeps its place for its hook to
 *  ask again, at most CLAIM_MS, and its turn when that comes first. An agent that ended meanwhile holds nothing. Bug 312: HQ's own run, waiting or running
 *  (the restart ended it), keeps its place the same way for HQ to start it again (withTurn's `place`); it used to come back last, behind those read back. */
export function readBackTurns(): void {
  const t0 = now(), kept: string[] = [], dropped: string[] = []
  for (const k of q<Kept>('SELECT * FROM turns ORDER BY asked_at, rowid')) {
    if (running.has(k.id) || line.some((w) => w.id === k.id)) continue // counted already
    const hq = hqKept(k.id), a = getAgent(k.agent_id), t: Turn = { id: k.id, who: k.who, what: k.what, agentId: hq ? null : k.agent_id, lane: k.lane,
      limitMs: CLAIM_MS, at: k.asked_at, activity: k.activity }
    if (!hq && (!a || a.status === 'exited' || (k.started_at !== null && (k.until === null || k.until <= t0)))) { forget(k.id); dropped.push(k.who); continue }
    kept.push(k.who)
    if (k.started_at !== null && !hq) { begin(t, k.started_at, k.until!); continue }
    const w: Waiting = { ...t, at: k.asked_at, away: true, go: () => {}, giveUp: setTimeout(() => leave(w), CLAIM_MS) }; w.giveUp.unref(); line.push(w)
  }
  pump() // a turn nobody runs any more is free: the longest waiting has it, for its hook to ask again
  // Bug 186: what each box said lives in memory only (ui.ts extras), so the boxes say it again: what runs and who waits. Not a run gone to the background:
  // its agent may be doing something else by now
  for (const r of running.values()) if (r.agentId && !r.lane.startsWith('bg:')) patch('agent', r.agentId, { activity: r.activity ?? `Running ${r.what === 'tests' ? 'tests' : 'a build'}` })
  for (const w of line) if (w.agentId) { w.said = turns().running.join('\n'); patch('agent', w.agentId, { activity: waitText(w.what, turns().running) }) }
  if (kept.length || dropped.length) emit({ agentId: null, source: 'system', kind: 'turns.read_back', payload: { ...turns(), dropped } })
}
