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
import { getSetting, now } from './db.ts'
import { bus, emit, patch, type HqEvent } from './events.ts'
import { update, type Agent } from './agents.ts'
import { getRepo, repoOfAgent, repos } from './records.ts'
import { heldKind, type Heavy } from './heavykind.ts'

export { heavyKind, programs, type Heavy } from './heavykind.ts'

/** `lane`: who in the agent runs the command: 'main' for the agent itself, else its helper's (subagent's) id. One lane runs one command at a time. */
type Turn = { id: string; who: string; what: Heavy; agentId: string | null; lane: string; limitMs: number }
const running = new Map<string, Turn & { timer: NodeJS.Timeout | null }>()
type Waiting = Turn & { go: (late: boolean) => void; giveUp: NodeJS.Timeout; left?: () => void }
const line: Waiting[] = []
const MAX_WAIT_MS = TURN_WAIT_S * 1000, BEAT_MS = Number(process.env.HQ_TURN_BEAT_MS) || 30_000, BG_TURN_MS = 2 * 3_600_000
const cap = (): number => Math.max(1, Math.floor(Number(getSetting('heavy_at_once', DEFAULTS.heavy_at_once))) || 1)
/** What runs now and what waits, in order, for tests and the Events tab. */
export const turns = (): { running: string[]; waiting: string[] } => ({ running: [...running.values()].map((r) => r.who), waiting: line.map((w) => w.who) })

function begin(t: Turn): void { // a turn nobody gives back ends with its command's own time limit
  const timer = Number.isFinite(t.limitMs) ? setTimeout(() => release(t.id), t.limitMs) : null; timer?.unref()
  running.set(t.id, { ...t, timer })
}
/** Free turns go to whoever has waited longest. Also called when the user raises the limit. */
export function pump(): void {
  while (line.length && running.size < cap()) { const w = line.shift()!; clearTimeout(w.giveUp); begin(w); w.go(false) }
}
export function release(id: string): void {
  const r = running.get(id); if (!r) return
  if (r.timer) clearTimeout(r.timer); running.delete(id); pump()
}
/** Out of the line without a turn: it isn't coming (its agent went, moved on, or dropped the hook). */
function leave(w: Waiting): void { const i = line.indexOf(w); if (i < 0) return; line.splice(i, 1); clearTimeout(w.giveUp); w.left?.() }
/** Asks for a turn. `waiting` false: it has one already. Else `got` resolves when its turn comes, `late` when it waited MAX_WAIT_MS and goes ahead over the limit.
 *  `drop`: it isn't coming after all (or is done). `left`: called if it leaves the line without ever getting a turn, whoever took it out. */
export function take(t: Turn, left?: () => void): { waiting: boolean; got: Promise<{ waitedMs: number; late: boolean }>; drop: () => void } {
  if (running.size < cap() && !line.length) { begin(t); return { waiting: false, got: Promise.resolve({ waitedMs: 0, late: false }), drop: () => release(t.id) } }
  const at = now(); let go!: (late: boolean) => void
  const got = new Promise<{ waitedMs: number; late: boolean }>((resolve) => { go = (late) => resolve({ waitedMs: now() - at, late }) })
  const w: Waiting = { ...t, go, left, giveUp: setTimeout(() => { const i = line.indexOf(w); if (i < 0) return; line.splice(i, 1); begin(w); go(true) }, MAX_WAIT_MS) }
  w.giveUp.unref(); line.push(w)
  return { waiting: true, got, drop: () => { if (line.includes(w)) leave(w); else release(t.id) } }
}
let n = 0
/** HQ's own heavy work (a test run): waits its turn like an engineer's command, and gives it back however `fn` ends. `onWait`: it has to wait first
 *  (Bug 106: the board says so). */
export async function withTurn<T>(who: string, what: Heavy, fn: () => Promise<T>, onWait?: () => void): Promise<T> {
  const id = `hq:${++n}`, t = take({ id, who, what, agentId: null, lane: 'main', limitMs: Infinity })
  if (t.waiting) onWait?.()
  if (t.waiting) emit({ agentId: null, source: 'system', kind: 'turns.waiting', payload: { who, what, behind: turns().running } })
  const { waitedMs, late } = await t.got
  if (t.waiting) emit({ agentId: null, source: 'system', kind: 'turns.started', payload: { who, what, waitedS: Math.round(waitedMs / 1000), late } })
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
  const t = take({ id, who, what, agentId: agent.id, lane: c.lane, limitMs: bashLimitMs(c.timeout) + 15_000 }, left); if (!t.waiting) return false
  const behind = turns().running
  const waiting = { activity: `Waiting its turn to ${what === 'tests' ? 'run tests' : 'build'}` }
  patch('agent', agent.id, waiting)
  emit({ agentId: agent.id, source: 'system', kind: 'turns.waiting', payload: { who, what, use: c.use, command: c.command.slice(0, 200), behind } })
  // waiting isn't stuck: the stuck loop goes by the last event. The box says it again too, for a page opened meanwhile (what an agent is doing isn't stored)
  beat = setInterval(() => { update(agent.id, { last_event_at: now() }); patch('agent', agent.id, waiting) }, BEAT_MS); beat.unref()
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
function releaseAgent(agentId: string, lane: string | null): void {
  for (const w of [...line]) if (w.agentId === agentId && (lane === null || w.lane === lane)) leave(w)
  for (const r of [...running.values()]) if (r.agentId === agentId && (lane === null || r.lane === lane)) release(r.id)
}
/** The agent (or one helper of its) is starting its next tool, or has finished: whatever command that lane was running is over. HQ doesn't always hear a command
 *  end: one that Claude Code refuses by a deny rule fires its PreToolUse hook and nothing after (spike 2026-11-09), and its turn would sit unused for minutes. */
export const laneMoved = (agentId: string, lane: string): void => releaseAgent(agentId, lane)
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
    if (r.timer) clearTimeout(r.timer); r.lane = `bg:${String(e.payload.task)}`; r.timer = setTimeout(() => release(r.id), BG_TURN_MS); r.timer.unref()
  })
  bus.on('event:bg.ended', (e: HqEvent) => releaseAgent(e.agentId ?? '', `bg:${String(e.payload.task)}`))
  bus.on('event:hook.Stop', (e: HqEvent) => { if (!e.payload.sub) releaseAgent(e.agentId ?? '', 'main') })
  for (const k of ['agent.stopped', 'agent.lost', 'hook.SessionEnd']) bus.on(`event:${k}`, (e: HqEvent) => { if (e.payload.reason !== 'clear') releaseAgent(e.agentId ?? '', null) })
}
