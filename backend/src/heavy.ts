// Bug 76: builds and full test runs take turns. On 2026-11-08 three engineers and auto mode's own test each ran `vite build` and the test suite at the same moment:
// load 26 on 14 cores. Now at most `heavy_at_once` of them run at a time on this machine (1 unless the user raises it), first come first served, and HQ's own test
// runs wait in the same line as engineers' commands.
// An engineer's command is held at its PreToolUse hook: Claude Code starts a command when that hook answers, the command's own time limit only starts then, and a wait
// costs no tokens (spike 2026-11-09 on 2.1.300: held 40 s, the command began the second the hook answered, and a 5 s limit still let it run). The engineer just
// sees the command take longer.
// Nothing waits for good. A turn comes back when its command ends, when its agent moves on to its next tool, when its agent's turn ends, when its agent goes, or
// when the command's own time limit has passed; and whoever has waited TURN_WAIT_S goes ahead anyway. HQ down or restarted: held hooks fail, and Claude Code runs
// the command (it treats a failed hook as no answer).
import type http from 'node:http'
import { bashLimitMs, DEFAULTS, TURN_WAIT_S } from './config.ts'
import { getSetting, now } from './db.ts'
import { bus, emit, patch, type HqEvent } from './events.ts'
import { update, type Agent } from './agents.ts'
import { getRepo, repoOfAgent } from './records.ts'

export type Heavy = 'tests' | 'build'
const unquoted = (s: string): string => s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' Q ') // a commit message that says "npm test" runs nothing
/** What goes in front of a program without changing which program it is. */
const WRAPPER = new RegExp(String.raw`^(?:[A-Za-z_]\w*=\S*|time|exec|env|command|nohup|nice(?:\s+-n\s*-?\d+|\s+-\d+)?|caffeinate(?:\s+-[a-z]+)*|timeout(?:\s+-\S+)*\s+\S+`
  + String.raw`|npx(?:\s+(?:-y|--yes|--no|--no-install))*|bunx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx)|uv\s+run|poetry\s+run|pipenv\s+run|python[\d.]*\s+-m)\s+`)
/** The program each simple command in a shell line runs, with its arguments: split at && || ; | & and brackets, wrappers and the program's folder taken off. */
export function programs(command: string): string[] {
  return unquoted(command).split(/&&|\|\||[;|&\n(){}]/).map((part) => {
    let s = part.trim()
    for (let i = 0; i < 8; i++) { const next = s.replace(/^\S*\/(?=[^\s/]+(?:\s|$))/, '').replace(WRAPPER, ''); if (next === s) break; s = next }
    return s
  }).filter(Boolean)
}
// `npm test`, `yarn build`, `npm --workspace web run test:unit`: a package manager, its own options, then a script named for tests or a build
const PM = String.raw`(?:npm|pnpm|yarn|bun)\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*?(?:(?:run|run-script)\s+)?`
const TESTS = new RegExp(String.raw`^(?:${PM}(?:t|tst|test|e2e)(?:$|[\s:._-])|(?:vitest|jest|mocha|ava|pytest|tox|nox|rspec|phpunit)(?:\s|$)|(?:playwright|cypress)\s+(?:test|run)\b`
  + String.raw`|node\s+(?:\S+\s+)*?--test(?:[\s=]|$)|deno\s+test\b|cargo\s+(?:test|nextest)\b|go\s+test\b|make\s+(?:test|check)\b|gradlew?\s+(?:\S+\s+)*?(?:test|check)\b`
  + String.raw`|mvnw?\s+(?:\S+\s+)*?(?:test|verify)\b|swift\s+test\b|dotnet\s+test\b|mix\s+test\b|(?:rails|rake)\s+test\b)`)
const BUILDS = new RegExp(String.raw`^(?:${PM}build(?:$|[\s:._-])|(?:vite|next|nuxt|astro|ng)\s+build\b|(?:turbo|nx)\s+(?:run\s+)?build\b|webpack(?:\s|$)|tsc\s+(?:-b|--build)\b`
  + String.raw`|cargo\s+build\b|go\s+build\b|make(?:\s+(?:all|build))?$|gradlew?\s+(?:\S+\s+)*?(?:build|assemble)\b|mvnw?\s+(?:\S+\s+)*?(?:package|install)\b|swift\s+build\b`
  + String.raw`|dotnet\s+build\b|xcodebuild\b)`)
const squeezed = (s: string): string => s.trim().replace(/\s+/g, ' ')
// A test run aimed at up to three named test files (no wildcards), or at tests picked by name, is small: engineers do these all the time while they work
const TEST_FILE = /(?:^|\s)(?!-)[^\s*?{]*(?:[._-](?:test|spec)\.[cm]?[jt]sx?|_test\.(?:go|py|rb)|(?:^|\/)test_[\w-]+\.py)(?:::\S+)?(?=\s|$)/g
const BY_NAME = /\s(?:-t|-k|-g|-run|--grep|--filter|--test-name-pattern|--testNamePattern|--testPathPattern)(?:[=\s]|$)/
const narrow = (program: string): boolean => { const files = program.match(TEST_FILE)?.length ?? 0; return (files >= 1 && files <= 3 && !/[*?{]/.test(program)) || BY_NAME.test(program) }
/** Is this shell command a full test run or a build: the kind that fills every core for minutes? By the program it runs, or because it is the project's own test
 *  command. A guess both ways, and both are cheap: a small command taken for a big one waits a little, a big one missed runs alongside as before. */
export function heavyKind(command: string, testCmd: string | null): Heavy | null {
  if (testCmd?.trim() && squeezed(command).includes(squeezed(testCmd))) return 'tests'
  const ps = programs(command)
  return ps.some((p) => TESTS.test(p) && !narrow(p)) ? 'tests' : ps.some((p) => BUILDS.test(p)) ? 'build' : null
}

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
/** HQ's own heavy work (a test run): waits its turn like an engineer's command, and gives it back however `fn` ends. */
export async function withTurn<T>(who: string, what: Heavy, fn: () => Promise<T>): Promise<T> {
  const id = `hq:${++n}`, t = take({ id, who, what, agentId: null, lane: 'main', limitMs: Infinity })
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
  if ((agent.role !== 'engineer' && agent.role !== 'launcher') || c.plan || c.background) return false
  const what = heavyKind(c.command, getRepo(repoOfAgent(agent) ?? '')?.test_cmd ?? null); if (!what) return false
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
