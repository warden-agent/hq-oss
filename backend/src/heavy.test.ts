// Bug 76: builds and full test runs take turns, engineers' and HQ's own in one line; nothing ever waits for good.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-heavy-')))
process.env.HQ_HOME = path.join(tmp, 'hq'); process.env.HQ_TURN_WAIT_S = '1'; process.env.HQ_TURN_BEAT_MS = '40'
const { migrate, setSetting, q } = await import('./db.ts'); migrate()
const { gateBash, heavyKind, laneMoved, programs, pump, release, startTurns, take, turns, withTurn } = await import('./heavy.ts')
const { bus, emit } = await import('./events.ts')
const { validSetting, bashLimitMs } = await import('./config.ts')
type Agent = import('./agents.ts').Agent
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
startTurns()

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const turn = (id: string, o: Partial<{ agentId: string; lane: string; limitMs: number }> = {}) =>
  ({ id, who: id, what: 'tests' as const, agentId: o.agentId ?? null, lane: o.lane ?? 'main', limitMs: o.limitMs ?? Infinity })
/** Everything given back, so each test starts with nobody running or waiting. */
function clear() { for (const w of turns().running) release(w); assert.deepEqual(turns(), { running: [], waiting: [] }); setSetting('heavy_at_once', 1) }

test('which commands are heavy: test runs and builds by the program they run, and the project\'s own test command', () => {
  const tests = ['npm test', 'npm t', 'npm run test', 'npm run test:unit -- --watch=false', 'npm run test-backend', 'yarn test', 'pnpm test', 'bun test', 'npm run e2e',
    'npm --workspace @hq/backend test', 'npm -s test', 'cd backend && npm test 2>&1 | tail -40', 'CI=1 npm test', 'npx vitest run', './node_modules/.bin/jest --ci',
    'node --test', 'node --experimental-strip-types --test --test-timeout=120000 e2e/*.test.ts', 'pytest -q', 'uv run pytest -q', '.venv/bin/python -m pytest -q', 'python3 -m pytest tests',
    'cargo test', 'cargo nextest run', 'go test ./...', 'make test', './gradlew test', 'mvn -q verify', 'npx playwright test', 'timeout 120 npm test', 'time npm test',
    '(cd web && npm test)', 'npm run lint && npm test']
  for (const c of tests) assert.equal(heavyKind(c, null), 'tests', c)
  const builds = ['npm run build', 'yarn build', 'pnpm build', 'npm --workspace frontend run build', 'npx vite build', 'vite build --outDir /tmp/x', 'next build', 'npx tsc -b',
    'cargo build --release', 'go build ./...', 'make', 'make build', 'npm run build:prod', './gradlew assemble']
  for (const c of builds) assert.equal(heavyKind(c, null), 'build', c)
  const light = ['ls', 'git status', 'git commit -m "run npm test before a merge"', "echo 'npm run build'", 'grep -rn "vitest" package.json', 'cat package.json', 'npm run lint', 'npm run dev',
    'npm ci', 'npm install', 'npx tsc --noEmit', 'node server.js', 'node --test-timeout=5 x.js', 'ls node_modules/.bin/jest', 'cat test/build.md', 'npm run typecheck', 'curl localhost:3000/test',
    'make clean', 'git log --oneline -5 -- build', 'npm view jest version', 'rm -rf build', 'mkdir test && cd test']
  for (const c of light) assert.equal(heavyKind(c, null), null, c)
  // a run aimed at a few named test files, or at tests picked by name, is small and never waits
  const narrow = ['node --test test/a.test.js', 'npm test -- src/board.test.ts', 'npx vitest run src/a.test.ts src/b.spec.tsx', 'pytest tests/test_stock.py::test_low -q',
    'go test ./pkg/x -run TestOne',
    'npm test -- -t "adds an item"', 'node --experimental-strip-types --test --test-timeout=120000 e2e/turns.test.ts', 'pytest -k low_stock', 'npx playwright test -g "phone"', 'go test ./a/b_test.go']
  for (const c of narrow) assert.equal(heavyKind(c, null), null, c)
  const wide = ['node --test test/*.test.js', 'npm test -- a.test.js b.test.js c.test.js d.test.js', 'npm test -- --coverage', 'pytest tests/', 'npx vitest run src/']
  for (const c of wide) assert.equal(heavyKind(c, null), 'tests', c)
  assert.equal(heavyKind('node --test test/a.test.js', 'node --test test/a.test.js'), 'tests') // unless that is the project's whole test command
  // the project's own command, whatever it runs
  assert.equal(heavyKind('node scripts/check.mjs --all 2>&1 | tail -5', 'node scripts/check.mjs --all'), 'tests')
  assert.equal(heavyKind('node  scripts/check.mjs   --all', ' node scripts/check.mjs --all '), 'tests'); assert.equal(heavyKind('node scripts/check.mjs', 'node scripts/check.mjs --all'), null)
  assert.equal(heavyKind('ls', ''), null)
  assert.deepEqual(programs('cd a && FOO=1 BAR=2 npx --yes vitest run; (./bin/tool x | tail -1)'), ['cd a', 'vitest run', 'tool x', 'tail -1'])
})

test('one at a time, first come first served; the limit is the user\'s setting, and raising it lets the next ones go', async () => {
  clear()
  const order: string[] = [], ask = (id: string) => { const t = take(turn(id)); void t.got.then(() => order.push(id)); return t }
  const a = ask('a'), b = ask('b'), c = ask('c')
  assert.equal(a.waiting, false); assert.equal(b.waiting, true); assert.equal(c.waiting, true)
  await tick(); assert.deepEqual(order, ['a']); assert.deepEqual(turns(), { running: ['a'], waiting: ['b', 'c'] })
  release('a'); await tick(); assert.deepEqual(order, ['a', 'b']); assert.deepEqual(turns(), { running: ['b'], waiting: ['c'] })
  release('nobody'); release('a'); await tick(); assert.deepEqual(turns(), { running: ['b'], waiting: ['c'] }) // given back twice, or never taken: nothing happens
  const d = ask('d'); setSetting('heavy_at_once', 3); pump(); await tick()
  assert.deepEqual(turns(), { running: ['b', 'c', 'd'], waiting: [] }); assert.equal(d.waiting, true)
  assert.equal(ask('e').waiting, true); setSetting('heavy_at_once', 1); release('b'); release('c'); await tick() // lowered: nobody running is stopped, the next waits for room
  assert.deepEqual(turns(), { running: ['d'], waiting: ['e'] }); release('d'); await tick(); assert.deepEqual(turns().running, ['e'])
  assert.equal(validSetting('heavy_at_once', 2), null); assert.match(validSetting('heavy_at_once', 0) ?? '', /at least 1/); assert.match(validSetting('heavy_at_once', 1.5) ?? '', /whole number/)
})

test('nothing waits for good: a turn ends with its command\'s time limit, and whoever has waited long enough goes ahead anyway', async () => {
  clear()
  const a = take(turn('a', { limitMs: 150 })), b = take(turn('b')); let got: { late: boolean } | null = null; void b.got.then((x) => { got = x })
  assert.equal(a.waiting, false); await tick(60); assert.equal(got, null)
  await tick(200); assert.deepEqual(got && { late: (got as { late: boolean }).late }, { late: false }) // a's end never came: its limit passed
  const c = take(turn('c')); let late: boolean | null = null; void c.got.then((x) => { late = x.late })
  await tick(1200); assert.equal(late, true); assert.deepEqual(turns(), { running: ['b', 'c'], waiting: [] }) // HQ_TURN_WAIT_S is 1 here: over the limit, but running
  assert.equal(bashLimitMs(undefined), 120_000); assert.equal(bashLimitMs(5000), 5000); assert.equal(bashLimitMs(9e9), 600_000); assert.equal(bashLimitMs('x'), 120_000)
})

test('one that stops waiting leaves the line; HQ\'s own test run waits like anyone and gives its turn back even when it throws', async () => {
  clear()
  take(turn('a')); const b = take(turn('b')), c = take(turn('c')); let cGot = false; void c.got.then(() => { cGot = true })
  b.drop(); assert.deepEqual(turns().waiting, ['c']); release('a'); await tick(); assert.equal(cGot, true); c.drop(); assert.deepEqual(turns(), { running: [], waiting: [] })
  take(turn('eng')); const seen: string[] = []
  const run = withTurn("HQ's test of T-01", 'tests', async () => { seen.push('ran'); throw new Error('boom') })
  await tick(); assert.deepEqual(seen, []); assert.deepEqual(turns(), { running: ['eng'], waiting: ["HQ's test of T-01"] })
  release('eng'); await assert.rejects(run, /boom/); assert.deepEqual(seen, ['ran']); assert.deepEqual(turns(), { running: [], waiting: [] })
  assert.equal(await withTurn('free', 'build', async () => 7), 7)
  const kinds = q<{ kind: string; payload: string }>("SELECT kind, payload FROM events WHERE kind LIKE 'turns.%' ORDER BY id").map((e) => [e.kind, JSON.parse(e.payload).who])
  assert.deepEqual(kinds, [['turns.waiting', "HQ's test of T-01"], ['turns.started', "HQ's test of T-01"]]) // quiet when nobody had to wait
})

const agent = (id: string, role = 'engineer') => ({ id, role, display_name: `eng ${id}`, repo_id: null, feature_id: null } as unknown as Agent)
/** A PreToolUse hook's connection, as far as the gate uses it. */
const conn = () => new EventEmitter() as unknown as http.ServerResponse
const cmd = (use: string, command = 'npm test', o: Partial<{ background: boolean; lane: string; plan: boolean; timeout: number }> = {}) =>
  ({ use, command, timeout: o.timeout, background: !!o.background, lane: o.lane ?? 'main', plan: !!o.plan, activity: `Running: ${command}` })

test('an engineer\'s command: held at its hook until its turn, which its end, its turn\'s end, or its agent going gives back', async () => {
  clear()
  const patches: unknown[] = []; bus.on('patch', (p) => patches.push(p))
  const began: unknown[] = []; bus.on('event:turns.started', (e) => began.push(e.payload.use))
  let answered = 0; const answer = () => { answered++ }
  assert.equal(gateBash(agent('a'), cmd('u1'), conn(), answer), false) // free: the hook is answered as usual
  assert.equal(gateBash(agent('b'), cmd('u2', 'git status'), conn(), answer), false); assert.equal(gateBash(agent('b'), cmd('u3', 'npm test', { background: true }), conn(), answer), false)
  assert.equal(gateBash(agent('b'), cmd('u4', 'npm test', { plan: true }), conn(), answer), false); assert.equal(gateBash(agent('t', 'tpm'), cmd('u5'), conn(), answer), false)
  assert.equal(gateBash(agent('b'), cmd('u6', 'npm run build'), conn(), answer), true) // held
  assert.deepEqual(turns(), { running: ['eng a'], waiting: ['eng b'] }); assert.deepEqual(patches.at(-1), { entity: 'agent', id: 'b', patch: { activity: 'Waiting its turn to build' } })
  await tick(); assert.equal(answered, 0)
  emit({ agentId: 'a', source: 'hook', kind: 'hook.PostToolUse:Bash', payload: { use: 'u1' } }); await tick()
  assert.equal(answered, 1); assert.deepEqual(began, ['u6']); assert.deepEqual(patches.at(-1), { entity: 'agent', id: 'b', patch: { activity: 'Running: npm run build' } })
  // b's turn ends without HQ hearing its command end (a lost hook): its own turns come back, a helper's command of its doesn't
  assert.equal(gateBash(agent('c'), cmd('u7', 'npm test', { lane: 'helper-1' }), conn(), answer), true); assert.equal(gateBash(agent('a'), cmd('u8'), conn(), answer), true)
  emit({ agentId: 'b', source: 'hook', kind: 'hook.Stop', payload: {} }); await tick(); assert.deepEqual(turns(), { running: ['eng c'], waiting: ['eng a'] }); assert.equal(answered, 2)
  emit({ agentId: 'c', source: 'hook', kind: 'hook.Stop', payload: {} }); await tick(); assert.equal(answered, 2) // c's own turn ended; its helper still runs the tests
  emit({ agentId: 'c', source: 'system', kind: 'agent.stopped', payload: {} }); await tick(); assert.equal(answered, 3); assert.deepEqual(turns(), { running: ['eng a'], waiting: [] })
  // the one waiting is interrupted (Esc, a fresh start): Claude Code drops the hook, and its place goes to the next
  const gone = conn(); assert.equal(gateBash(agent('d'), cmd('u9'), gone, answer), true); assert.equal(gateBash(agent('e'), cmd('u10'), conn(), answer), true)
  Object.assign(gone, { destroyed: true }); gone.emit('close'); assert.deepEqual(turns().waiting, ['eng e'])
  emit({ agentId: 'a', source: 'hook', kind: 'hook.PostToolUseFailure:Bash', payload: { use: 'u8' } }); await tick()
  assert.equal(answered, 4); assert.deepEqual(turns(), { running: ['eng e'], waiting: [] })
  emit({ agentId: 'e', source: 'hook', kind: 'hook.SessionEnd', payload: { reason: 'clear' } }); assert.deepEqual(turns().running, ['eng e']) // /clear: the session goes on
  emit({ agentId: 'e', source: 'hook', kind: 'hook.SessionEnd', payload: { reason: 'exit' } }); assert.deepEqual(turns().running, [])
  // a hook with no command id: the agent's oldest turn is the one that ended
  assert.equal(gateBash(agent('f'), cmd(''), conn(), answer), false)
  emit({ agentId: 'g', source: 'hook', kind: 'hook.PostToolUse:Bash', payload: {} }); assert.deepEqual(turns().running, ['eng f'])
  emit({ agentId: 'f', source: 'hook', kind: 'hook.PostToolUse:Bash', payload: {} }); assert.deepEqual(turns().running, [])
  // HQ never hears a refused command end (Claude Code's deny rules: the PreToolUse hook and nothing after). The agent's next tool says it's over; a helper's
  // next tool says so only for that helper's own commands
  assert.equal(gateBash(agent('h'), cmd('u11', 'npm test && git push'), conn(), answer), false); assert.equal(gateBash(agent('i'), cmd('u12'), conn(), answer), true)
  laneMoved('h', 'helper-9'); laneMoved('i', 'main'); assert.deepEqual(turns().running, ['eng h']); assert.deepEqual(turns().waiting, [])
  assert.equal(gateBash(agent('i'), cmd('u13', 'npm test', { lane: 'helper-2' }), conn(), answer), true)
  laneMoved('h', 'main'); await tick(); assert.deepEqual(turns(), { running: ['eng i'], waiting: [] }); laneMoved('i', 'main'); assert.deepEqual(turns().running, ['eng i'])
  laneMoved('i', 'helper-2'); assert.deepEqual(turns().running, [])
  // while it waits its box keeps saying so (a page opened meanwhile has nothing stored to show); once it's out of the line, by any road, that stops
  take(turn('x')); assert.equal(gateBash(agent('j'), cmd('u14'), conn(), answer), true)
  type Said = { id: string; patch: { activity?: string } }
  const said = () => patches.filter((p) => (p as Said).id === 'j' && (p as Said).patch.activity === 'Waiting its turn to run tests').length
  const before = said(); await tick(150); assert.ok(said() >= before + 2, 'said again while waiting')
  const n = answered; emit({ agentId: 'j', source: 'system', kind: 'agent.lost', payload: {} }); const then = said(); await tick(150); assert.equal(said(), then, 'and not after it left')
  assert.equal(answered, n + 1, 'a hook still held is answered when HQ takes it out of the line, so nothing hangs on it')
  assert.equal(q<{ n: number }>("SELECT COUNT(*) n FROM events WHERE kind = 'turns.left' AND agent_id = 'j'")[0]!.n, 1); release('x')
})
