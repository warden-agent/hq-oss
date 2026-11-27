// Bug 374: HQ's test of an app whose hard-wired port is in use (testports.ts). The rules for where a port is written, on the lines two real projects had,
// and the move itself against a real git checkout: the copy's files and start commands get the new port, the user's own folder is never touched, and a port
// HQ can't be sure about is left where it is, with words that say who has it and what to do. The sandbox's side is in testrun.test.ts; a real app, a real
// browser and a server holding the port, in smoke.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HqEvent } from './events.ts'
import type { LookPlan } from './smoke.ts'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testports-'))
const { migrate, run } = await import('./db.ts'); migrate()
const { PATHS } = await import('./config.ts')
const { bus } = await import('./events.ts')
const { blocked, dotenv, heldBy, mentions, moveAddresses, moveLine, ownPort, placePorts, portTaken, scanned, scriptsOf, unsureWords } = await import('./testports.ts')
const { copyPorts, handing, releaseCopy } = await import('./copyports.ts')

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd,
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const VITE = 'export default defineConfig({\n  server: {\n    proxy: {\n      "/api": "http://127.0.0.1:8000",\n    },\n  },\n});\n'
const FILES: Record<string, string> = {
  'frontend/vite.config.ts': VITE,
  'backend/app/limits.py': 'MAX_CHARS = 8000\n', // a number, not the port
  'backend/tests/test_limits.py': 'def test_max(monkeypatch):\n    monkeypatch.setenv("MAX_TOKENS", "8000")\n    assert resolve() == 8000\n',
  'README.md': 'The page proxies `/api` to the backend on port 8000.\n', // for people: never read for the port, never changed
  'Dockerfile': 'CMD ["uvicorn", "app.main:app", "--port", "8000"]\n', // nothing in HQ's sandbox runs it
}
/** A git checkout with `files` committed, as a test run's throwaway one is, and the start steps of a two-part app whose api part hard-wires 8000. */
function checkout(files: Record<string, string> = FILES) {
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testports-wt-'))); sh(wt, 'init', '-q')
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), text) }
  sh(wt, 'add', '-A'); sh(wt, 'commit', '-qm', 'app')
  const recipe = { parts: [{ name: 'api', dir: 'backend', run: 'uv run --locked uvicorn app.main:app --host 127.0.0.1 --port 8000', port: 8000 as number | 'auto' },
    { name: 'web', dir: 'frontend', run: 'npm run dev -- --host 127.0.0.1 --port $PORT --strictPort', port: 'auto' as number | 'auto' }], show: 'web',
  worktree_files: ['backend/.env'], notes: '' }
  const plan: LookPlan = { recipe, repoPath: '/nowhere/the-users-own-folder', how: 'x' }
  return { wt, plan }
}
const read = (wt: string, f: string): string => fs.readFileSync(path.join(wt, f), 'utf8')
const mac = { platform: 'darwin', busy: async (p: number) => p === 8000 || p === 3001, who: async () => ({ who: "HQ's preview of shop", fix: 'Stop the app in the preview, then test again' }) }

test('mentions: an address on this machine is one HQ rewrites; another way of writing the port stops it; a plain number is neither', () => {
  const of = (line: string, port = 8000) => mentions(line, port)
  assert.deepEqual(of('      "/api": "http://127.0.0.1:8000",'), { addresses: 1, unsure: [] })
  for (const a of ['http://localhost:8000/api', 'ws://[::1]:8000', '--bind 0.0.0.0:8000', "fetch('http://localhost:8000')"]) assert.deepEqual(of(a), { addresses: 1, unsure: [] }, a)
  // plain numbers, of the kinds a real project had beside its port: none of them the port
  for (const plain of ['MAX_CHARS = 8000', '    monkeypatch.setenv("MAX_TOKENS", "8000")', '    assert resolve_max("small") == 8000', 'setTimeout(tick, 8000)',
    'timeout: 8000,', 'export const MAX_CHARS = 8000', 'exports.MAX_CHARS = 8000', 'import { a } from "./a" // 8000 rows', 'report every 8000 rows', 'retry during 8000 ms',
    'const capital = 8000', 'hourly = 8000']) assert.deepEqual(of(plain), { addresses: 0, unsure: [] }, plain)
  // not the number at all
  for (const other of ['port: 18000', 'wait 8000ms', 'v1.8000', 'http://127.0.0.1:80000', 'x = 8000.5']) assert.deepEqual(of(other), { addresses: 0, unsure: [] }, other)
  // the port, written a way HQ can't rewrite safely
  for (const hard of ['        port: 8000,', 'const API_PORT = 8000', 'app.listen(8000)', 'url = base + ":8000"', 'upstream api:8000', 'http://example.test:8000/x', 'PORT=8000',
    'const apiPort = 8000', 'devServer(8000)', 'connect("localhost", 8000)', 'BASE_URL = f"http://{h}:" + str(8000)', 'net.connect(8000, "127.0.0.1")', 'x = [8000] # the backend'])
    assert.deepEqual(of(hard), { addresses: 0, unsure: [1] }, hard)
  // the ways a project with a server on 3001 and its page on 3000 can write them: each stops a move
  for (const [line, port] of [['const port = [args.port, process.env.APP_PORT, process.env.PORT, 3001]', 3001], ['        ? location.protocol + "//" + location.hostname + ":3001"', 3001],
    ['            if (location.port === "3000" || localStorage.dev === "dev") {', 3000], ['        port: 3000,', 3000]] as const) assert.deepEqual(of(line, port).unsure, [1], line)
  for (const [line, port] of [['    3000: "Unauthorized",', 3000], ['            }, 3000);', 3000]] as const) assert.deepEqual(of(line, port), { addresses: 0, unsure: [] }, line)
  // an address and another mention on one line; and line numbers from 1
  assert.deepEqual(of('proxy("http://localhost:8000", { port: 8000 })'), { addresses: 1, unsure: [1] })
  assert.deepEqual(of('a\nport = 8000\nb\nlisten(8000)'), { addresses: 0, unsure: [2, 4] })
})

// HQ gives every part its port in PORT, so a fallback for PORT is never read in a run of HQ's: it doesn't stop a move. Everything near it still does.
test('mentions: a fallback for the variable PORT is no place the copy reads its port from; another variable, a set PORT or an address built with it still is', () => {
  const of = (line: string, file = '') => mentions(line, 8000, file), none = { addresses: 0, unsure: [] }
  for (const fallback of ['const port = process.env.PORT || 8000', 'const PORT = process.env.PORT|| 8000;', "const port = process.env.PORT ?? '8000';", 'await app.listen(process.env.PORT ?? 8000);',
    'const port = Number(process.env.PORT) || 8000', 'const port = parseInt(process.env.PORT, 10) || 8000', "app.listen(process.env['PORT'] || 8000)", 'Bun.serve({ port: Bun.env.PORT || 8000 })',
    'const port = Deno.env.get("PORT") ?? "8000"', 'port = int(os.environ.get("PORT", 8000))', "port = int(os.getenv('PORT', '8000'))", 'port = os.environ.get("PORT") or 8000',
    'port ENV.fetch("PORT") { 8000 }', 'port ENV.fetch("PORT", 8000)', 'port = ENV["PORT"] || 8000', 'uvicorn app.main:app --port ${PORT:-8000}', 'exec gunicorn -b :${PORT-8000} app:app'])
    assert.deepEqual(of(fallback), none, fallback)
  // not the variable HQ sets; not a fallback; or a second mention on the line
  for (const hard of ['const port = process.env.API_PORT || 8000', 'const port = process.env.PORT_API || 8000', 'port = int(os.environ.get("APP_PORT", 8000))', 'x --port ${API_PORT:-8000}',
    'const { PORT = 8000 } = process.env', 'const port = process.env.PORT && 8000', 'const port = process.env.PORT ?? (isDev ? "8000" : "8811")', '"dev": "PORT=8000 node server.js"',
    'app.listen(process.env.PORT || 8000, () => log("on 8000"))', 'PORT=8000', 'export PORT=8000']) assert.deepEqual(of(hard), { addresses: 0, unsure: [1] }, hard)
  // an address built with it is a caller's, which may run where PORT isn't set (the browser): HQ can't rewrite it, so it stops the move
  for (const caller of ['const api = `http://localhost:${process.env.PORT || 8000}/api`', "baseURL: 'http://' + host + ':' + (process.env.PORT || 8000)"])
    assert.deepEqual(of(caller), { addresses: 0, unsure: [1] }, caller)
  assert.deepEqual(of('const port = process.env.PORT || 80000'), none) // not the number at all
  // a .env sets defaults the run's own environment wins over: its PORT line is a fallback too, and only that line
  for (const f of ['.env', 'backend/.env.local', '.env.example', '.envexample', 'apps/web/.env.example-e2e', 'env.sample', 'example.env']) {
    assert.equal(dotenv(f), true, f)
    for (const line of ['PORT=8000', 'PORT = 8000  # the api', 'export PORT="8000"']) assert.deepEqual(of(line, f), none, `${f}: ${line}`)
    assert.deepEqual(of('API_PORT=8000', f), { addresses: 0, unsure: [1] }, f); assert.deepEqual(of('PORTS=8000', f), { addresses: 0, unsure: [1] }, f)
    assert.deepEqual(of('API=http://localhost:8000', f), { addresses: 1, unsure: [] }, f)
  }
  for (const f of ['src/env.ts', 'env.py', 'src/environment.ts', 'package.json', 'Procfile']) {
    assert.equal(dotenv(f), false, f); assert.deepEqual(of('PORT = 8000', f), { addresses: 0, unsure: [1] }, f)
  }
})

// Bug 382: a script's short flag is the port written as a plain number. HQ rewrites the number in the start command only, so in a file it stops the move.
test('mentions: the number after -p or -l, or Django\'s runserver, in a script stops a move; a short flag before another number doesn\'t', () => {
  const of = (line: string, port = 3001) => mentions(line, port)
  for (const flag of ['    "dev": "next dev -p 3001",', '    "start": "serve -s build -l 3001",', '"dev": "next dev -p=3001"', 'dev: python manage.py runserver 3001',
    '"start": "http-server ./dist -p 3001 -c-1"', 'web: (-p 3001)']) assert.deepEqual(of(flag), { addresses: 0, unsure: [1] }, flag)
  for (const plain of ['"build": "tsc -p tsconfig.json && node seed.js 3001"', '"seed": "node seed.js -n 3001"', 'npx jest -t 3001', 'xargs -P 3001 echo', '"dev": "next dev -p 13001"',
    'runservers = 3001']) assert.deepEqual(of(plain), { addresses: 0, unsure: [] }, plain)
  assert.deepEqual(of('"dev": "next dev -p 3001 --hostname localhost:3001"'), { addresses: 1, unsure: [1] }) // the address is rewritten, the flag still stops it
})

// Bug 382: a tool that picks its own port and never reads PORT, started without naming one, asks for the old port in HQ's copy whatever HQ does.
test('ownPort: a start command (or a script it runs) that starts such a tool without naming the port; one that names it, or another tool, is fine', () => {
  const of = (run: string, scripts: Record<string, unknown> = {}) => ownPort(run, 8000, scripts)
  assert.equal(of('npm run dev', { dev: 'vite' }), 'vite'); assert.equal(of('pnpm dev', { dev: 'vite --host 127.0.0.1' }), 'vite')
  assert.equal(of('npm run build && npm run preview', { build: 'vite build', preview: 'vite preview' }), 'vite'); assert.equal(of('npx vite'), 'vite')
  assert.equal(of('./node_modules/.bin/vite'), 'vite'); assert.equal(of('yarn start', { start: 'npm run dev:web', 'dev:web': 'vite' }), 'vite') // a script that runs another
  assert.equal(of('uv run uvicorn app.main:app --reload'), 'uvicorn'); assert.equal(of('python manage.py runserver'), 'runserver')
  assert.equal(of('uv run flask --app app run --debug'), 'flask run'); assert.equal(of('flask run'), 'flask run'); assert.equal(of('python3 -m http.server'), 'http.server')
  // the command names the port (HQ rewrites the number), or PORT (HQ sets it to the new port)
  for (const named of ['uv run --locked uvicorn app.main:app --host 127.0.0.1 --port 8000', 'python manage.py runserver 127.0.0.1:8000', 'npm run dev -- --port $PORT --strictPort',
    'uvicorn app:app --port ${PORT}', 'python -m http.server $PORT']) assert.equal(of(named, { dev: 'vite' }), null, named)
  assert.equal(of('npm run dev', { dev: 'vite --port $PORT --strictPort' }), null); assert.equal(of('npm run dev', { dev: 'cross-env PORT=$PORT vite' }), null)
  // tools that read PORT, or nothing HQ knows
  for (const fine of ['npm run dev', 'fastapi dev app/main.py', 'gunicorn -k uvicorn.workers.UvicornWorker app:app', 'node server.js', 'npx vitest', 'node scripts/vite-env.js',
    'node build.js --config vite.config.ts', 'npm run build && node server.js', 'flask db upgrade']) assert.equal(of(fine, { dev: 'next dev', build: 'vite build' }), null, fine)
  assert.deepEqual(scriptsOf('npm run a', { a: 'npm run b', b: 'npm run a && vite' }), ['npm run b', 'npm run a && vite']) // a loop ends
  assert.deepEqual(scriptsOf('npm ci && npm start', { start: 7 }), [])
})

test('moveAddresses and moveLine: only the port changes, in a file as an address and in a start command as the number', () => {
  assert.equal(moveAddresses(VITE, 8000, 50123), VITE.replace('8000', '50123'))
  assert.equal(moveAddresses('a = "localhost:8000"; b = 8000; c = "127.0.0.1:80001"', 8000, 5), 'a = "localhost:5"; b = 8000; c = "127.0.0.1:80001"')
  const moved = [{ from: 8000, to: 50123 }]
  assert.equal(moveLine('uv run --locked uvicorn app.main:app --host 127.0.0.1 --port 8000', moved), 'uv run --locked uvicorn app.main:app --host 127.0.0.1 --port 50123')
  assert.equal(moveLine('API=http://localhost:8000 npm run build', moved), 'API=http://localhost:50123 npm run build')
  for (const same of ['npm run dev -- --port $PORT --strictPort', 'node --max-old-space-size=18000 server.js', 'sleep 8000s']) assert.equal(moveLine(same, moved), same)
  assert.equal(moveLine('a --port 3000 --api 3001', [{ from: 3000, to: 1 }, { from: 3001, to: 2 }]), 'a --port 1 --api 2')
})

test('scanned: not docs, lockfiles, or Docker and CI files; everything else', () => {
  for (const no of ['README.md', 'docs/setup.txt', '.cursor/rules/x.mdc', 'package-lock.json', 'frontend/package-lock.json', 'uv.lock', 'bun.lockb', 'Dockerfile', 'api/Dockerfile.dev',
    'docker-compose.yml', 'compose.yaml', '.github/workflows/ci.yml', '.gitlab-ci.yml', '.travis.yml', 'Jenkinsfile', 'ci/Jenkinsfile.release', 'azure-pipelines.yml',
    'bitbucket-pipelines.yml', '.buildkite/pipeline.yml', '.drone.yml', 'appveyor.yml']) assert.equal(scanned(no), false, no)
  for (const yes of ['frontend/vite.config.ts', 'backend/.env', 'package.json', 'src/compose.ts', 'config/local.json', 'src/travis.js', 'src/pipelines.yml', 'jenkins.ts'])
    assert.equal(scanned(yes), true, yes)
})

test('a held port is moved in the checkout only: the address in its files, the number in its start command, and the sandbox is told the old one', async () => {
  const { wt, plan } = checkout(), events: HqEvent[] = [], on = (e: HqEvent) => { if (e.kind === 'testrun.port_moved') events.push(e) }
  fs.writeFileSync(path.join(wt, 'backend', '.env'), 'KEY=secret\nAPI_BASE=http://127.0.0.1:8000\n') // the user's own settings, copied in: git doesn't track them
  bus.on('event', on)
  const got = await placePorts(wt, plan, ['backend/.env'], mac).finally(() => bus.off('event', on))
  assert.ok('plan' in got, JSON.stringify(got))
  const to = got.plan.moved![0]!.to
  assert.deepEqual(got.plan.moved, [{ part: 'api', from: 8000, to, by: "HQ's preview of shop", fix: 'Stop the app in the preview, then test again' }]); assert.ok(to > 1023 && to !== 8000)
  assert.deepEqual(got.plan.recipe.parts.map((p) => [p.name, p.port, p.run]), [['api', to, `uv run --locked uvicorn app.main:app --host 127.0.0.1 --port ${to}`],
    ['web', 'auto', 'npm run dev -- --host 127.0.0.1 --port $PORT --strictPort']])
  assert.equal(got.plan.how, 'x'); assert.deepEqual(blocked(got.plan), [8000]); assert.deepEqual(blocked(plan), [])
  assert.equal(read(wt, 'frontend/vite.config.ts'), VITE.replace('8000', String(to)))
  assert.equal(read(wt, 'backend/.env'), `KEY=secret\nAPI_BASE=http://127.0.0.1:${to}\n`)
  for (const f of ['backend/app/limits.py', 'backend/tests/test_limits.py', 'README.md', 'Dockerfile']) assert.equal(read(wt, f), FILES[f], f) // not the port, or not read
  assert.equal(sh(wt, 'status', '--porcelain', '--untracked-files=no'), 'M frontend/vite.config.ts') // the one tracked file, in the throwaway checkout
  assert.equal(plan.recipe.parts[0]!.port, 8000, 'the plan it was given is as it was') // the next checkout starts from the saved steps again
  assert.deepEqual(events.map((e) => ({ ...e.payload, files: (e.payload.files as string[]).slice().sort() })),
    [{ repo: null, part: 'api', from: 8000, to, by: "HQ's preview of shop", files: ['backend/.env', 'frontend/vite.config.ts'] }])
})

test('a port written a way HQ can\'t rewrite safely is not moved: nothing changes, and the words say who has it, where, and what to do', async () => {
  const { wt, plan } = checkout({ ...FILES, 'frontend/src/api.ts': '// the backend\nexport const API_PORT = 8000\n', 'frontend/src/ws.ts': 'export const WS = host + ":8000"\n' })
  const got = await placePorts(wt, plan, [], mac)
  assert.deepEqual(got, { skip: "port 8000, which its api part always uses, is in use by HQ's preview of shop. HQ couldn't run its own copy on another port: "
    + "frontend/src/api.ts line 2 and 1 more place name 8000 in a way HQ can't safely change. Stop the app in the preview, then test again" })
  assert.equal(sh(wt, 'status', '--porcelain'), ''); assert.equal(read(wt, 'frontend/vite.config.ts'), VITE)
  assert.equal(unsureWords(8000, [{ file: 'a.js', line: 3 }]), "a.js line 3 names 8000 in a way HQ can't safely change")
  assert.equal(unsureWords(8000, [{ file: 'big.js', line: 0 }, { file: 'b', line: 1 }, { file: 'c', line: 1 }]), "big.js and 2 more places name 8000 in a way HQ can't safely change")
  // the user's own settings count too, and nothing of them is quoted
  const env = checkout(); fs.writeFileSync(path.join(env.wt, 'backend', '.env'), 'KEY=secret\nAPI_PORT=8000\n')
  const kept = await placePorts(env.wt, env.plan, ['backend/.env'], mac)
  assert.ok('skip' in kept && /backend\/\.env line 2 names 8000/.test(kept.skip) && !/secret/.test(kept.skip), JSON.stringify(kept))
})

test('a fallback for PORT, in the code and in the user\'s own .env, doesn\'t stop the move and is left as written', async () => {
  const server = "const port = process.env.PORT || 8000\napp.listen(port)\n"
  const { wt, plan: p0 } = checkout({ ...FILES, 'backend/server.js': server, '.env.example': 'PORT=8000\nAPI_URL=http://localhost:8000\n' })
  const plan = { ...p0, recipe: { ...p0.recipe, parts: p0.recipe.parts.map((p) => p.name === 'api' ? { ...p, run: 'node server.js' } : p) } }
  fs.writeFileSync(path.join(wt, 'backend', '.env'), 'KEY=secret\nPORT=8000\n')
  const got = await placePorts(wt, plan, ['backend/.env'], mac); assert.ok('plan' in got, JSON.stringify(got))
  const to = got.plan.moved![0]!.to
  assert.deepEqual(got.plan.recipe.parts.map((p) => [p.name, p.port, p.run])[0], ['api', to, 'node server.js']) // PORT, which HQ sets from the part's port, tells it
  assert.equal(read(wt, 'backend/server.js'), server); assert.equal(read(wt, 'backend/.env'), 'KEY=secret\nPORT=8000\n')
  assert.equal(read(wt, '.env.example'), `PORT=8000\nAPI_URL=http://localhost:${to}\n`); assert.equal(read(wt, 'frontend/vite.config.ts'), VITE.replace('8000', String(to)))
})

// Bug 382: HQ says at once that it can't move the port, without starting an app that can't start; with a sign the copy reads PORT after all it moves.
test('a part whose start command runs a tool that picks its own port is not moved, unless its code reads PORT; a script\'s -p stops a move too', async () => {
  const api = (run: string, files: Record<string, string> = {}) => { const c = checkout({ ...FILES, ...files })
    return { ...c, plan: { ...c.plan, recipe: { ...c.plan.recipe, parts: c.plan.recipe.parts.map((p) => p.name === 'api' ? { ...p, run } : p) } } } }
  const own = api('uv run --locked uvicorn app.main:app --reload', { 'backend/Dockerfile': 'ENV PORT=80\n', 'README.md': 'Run with `PORT=8000 uvicorn`\n' })
  assert.deepEqual(await placePorts(own.wt, own.plan, [], mac), { skip: "port 8000, which its api part always uses, is in use by HQ's preview of shop. HQ couldn't run "
    + 'its own copy on another port: its start command runs uvicorn, which uses its own port unless the command names one. Stop the app in the preview, then test again' })
  assert.equal(sh(own.wt, 'status', '--porcelain'), '')
  // the part's code reads PORT: the tool may get HQ's port that way, so HQ moves as before (and a copy that still doesn't start says so)
  const reads = api('uv run --locked uvicorn app.main:app --reload', { 'backend/app/main.py': 'import os\nPORT = int(os.environ["PORT"])\n' })
  const moved = await placePorts(reads.wt, reads.plan, [], mac); assert.ok('plan' in moved, JSON.stringify(moved))
  assert.equal(moved.plan.recipe.parts[0]!.run, 'uv run --locked uvicorn app.main:app --reload')
  // ...but only the part's own folder counts
  const elsewhere = api('uv run --locked uvicorn app.main:app --reload', { 'frontend/server.js': 'listen(process.env.PORT)\n' })
  assert.ok('skip' in await placePorts(elsewhere.wt, elsewhere.plan, [], mac))
  // a page part run through its package.json, Vite and Next
  const web = (scripts: Record<string, string>, files: Record<string, string> = {}) => { const c = checkout({ ...FILES, 'backend/cors.py': 'ORIGIN = "http://localhost:3001"\n',
    'frontend/package.json': JSON.stringify({ scripts }, null, 2) + '\n', ...files })
    return { ...c, plan: { ...c.plan, recipe: { ...c.plan.recipe, parts: c.plan.recipe.parts.map((p) => p.name === 'web' ? { ...p, run: 'npm run dev', port: 3001 } : p) } } } }
  const vite = web({ dev: 'vite' }), v = await placePorts(vite.wt, vite.plan, [], mac)
  assert.ok('skip' in v && /^port 3001, which its web part always uses.*its start command runs vite, which uses its own port unless the command names one/.test(v.skip), JSON.stringify(v))
  const viteReads = web({ dev: 'vite' }, { 'frontend/vite.config.ts': 'export default { server: { port: Number(process.env.PORT) } }\n' })
  const vr = await placePorts(viteReads.wt, viteReads.plan, [], mac); assert.ok('plan' in vr && vr.plan.moved!.map((m) => m.part).join() === 'api,web', JSON.stringify(vr))
  const next = web({ dev: 'next dev' }), n = await placePorts(next.wt, next.plan, [], mac); assert.ok('plan' in n, JSON.stringify(n)) // Next reads PORT
  assert.equal(read(next.wt, 'backend/cors.py'), `ORIGIN = "http://localhost:${n.plan.moved![1]!.to}"\n`)
  const flag = web({ dev: 'next dev -p 3001' }), f = await placePorts(flag.wt, flag.plan, [], mac)
  assert.ok('skip' in f && /^port 3001, which its web part always uses.*frontend\/package\.json line 3 names 3001 in a way HQ can't safely change/.test(f.skip), JSON.stringify(f))
  assert.equal(sh(flag.wt, 'status', '--porcelain'), '', 'nothing moved, the api\'s port either')
})

test('two held ports: both move, or neither does', async () => {
  const two = (files: Record<string, string>) => { const c = checkout({ ...FILES, ...files })
    return { ...c, plan: { ...c.plan, recipe: { ...c.plan.recipe, parts: [...c.plan.recipe.parts, { name: 'jobs', dir: '.', run: 'node jobs.js --port 3001', port: 3001 as number | 'auto' }] } } } }
  const ok = two({ 'web.config.js': 'jobs = "http://localhost:3001"\n' }), both = await placePorts(ok.wt, ok.plan, [], mac)
  assert.ok('plan' in both, JSON.stringify(both))
  const [a, j] = both.plan.moved!; assert.deepEqual([a!.part, a!.from, j!.part, j!.from], ['api', 8000, 'jobs', 3001]); assert.notEqual(a!.to, j!.to)
  assert.equal(both.plan.recipe.parts[2]!.run, `node jobs.js --port ${j!.to}`); assert.equal(read(ok.wt, 'web.config.js'), `jobs = "http://localhost:${j!.to}"\n`)
  assert.deepEqual(blocked(both.plan), [8000, 3001])
  const no = two({ 'jobs.js': 'server.listen(3001)\n' }), neither = await placePorts(no.wt, no.plan, [], mac)
  assert.ok('skip' in neither && /^port 3001, which its jobs part always uses.*jobs\.js line 1 names 3001/.test(neither.skip), JSON.stringify(neither))
  assert.equal(sh(no.wt, 'status', '--porcelain'), '', 'the first port\'s files were left alone too')
})

test('nothing to do: a free port, a part HQ gives its port, and Linux (a run there has a network of its own)', async () => {
  const { wt, plan } = checkout()
  assert.equal((await placePorts(wt, plan, [], { ...mac, busy: async () => false }) as { plan: unknown }).plan, plan)
  assert.equal((await placePorts(wt, plan, [], { ...mac, platform: 'linux' }) as { plan: unknown }).plan, plan)
  const auto = { ...plan, recipe: { ...plan.recipe, parts: plan.recipe.parts.map((p) => ({ ...p, port: 'auto' as const })) } }
  assert.equal((await placePorts(wt, auto, [], { ...mac, busy: async () => true }) as { plan: unknown }).plan, auto)
  assert.equal(sh(wt, 'status', '--porcelain'), '')
})

test('only real files inside the checkout are read or changed: a link out of it is left alone, and a folder that is no checkout is not guessed at', async () => {
  const { wt, plan } = checkout(), outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testports-out-')), 'shared.env')
  fs.writeFileSync(outside, 'API=http://localhost:8000\n'); fs.symlinkSync(outside, path.join(wt, 'backend', '.env'))
  fs.mkdirSync(path.join(wt, 'data')); fs.writeFileSync(path.join(wt, 'data', 'settings.json'), '{ "api": "http://localhost:8000" }\n'); fs.writeFileSync(path.join(wt, 'data', 'app.db'), 'a\0b 8000')
  const got = await placePorts(wt, plan, ['backend/.env', 'data', '../outside'], mac); assert.ok('plan' in got, JSON.stringify(got))
  assert.equal(fs.readFileSync(outside, 'utf8'), 'API=http://localhost:8000\n')
  assert.equal(read(wt, 'data/settings.json'), `{ "api": "http://localhost:${got.plan.moved![0]!.to}" }\n`) // a copied folder's own files are read
  assert.equal(read(wt, 'data/app.db'), 'a\0b 8000') // not a database
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testports-bare-'))), not = await placePorts(bare, plan, [], mac)
  assert.ok('skip' in not && /couldn't run its own copy on another port: it couldn't search the code \(not a git repository/.test(not.skip), JSON.stringify(not))
})

test('heldBy: this HQ\'s own preview is named, of this project or another, by any of its parts\' ports', async () => {
  run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('r1', 'shop', '/tmp/hq-testports-shop', 'local', 1), ('r2', 'garden', '/tmp/hq-testports-garden', 'local', 1)")
  run("INSERT INTO previews(id, status, port, updated_at) VALUES ('r1', 'running', 3090, 1), ('r2', 'stopped', 3091, 1)")
  for (const [id, port] of [['r1', 8000], ['r2', 9000]] as const) {
    fs.mkdirSync(path.join(PATHS.home, 'previews', id), { recursive: true })
    fs.writeFileSync(path.join(PATHS.home, 'previews', id, 'spec.json'), JSON.stringify({ parts: [{ env: { PORT: String(port) } }, { env: { PORT: '3090' } }] }))
  }
  assert.deepEqual(await heldBy(8000, 'r1'), { who: "HQ's preview of shop", fix: 'Stop the app in the preview, then test again' })
  assert.deepEqual(await heldBy(3090, 'r1'), { who: "HQ's preview of shop", fix: 'Stop the app in the preview, then test again' })
  assert.deepEqual(await heldBy(8000, 'r2'), { who: "HQ's preview of shop", fix: "Stop shop's app, then test again" })
  // a stopped preview holds nothing: whoever lsof names has it, and with nobody listening, "another program"
  assert.deepEqual(await heldBy(9000, 'r2'), { who: 'another program', fix: 'Stop it, then test again' })
})

// Bug 381: after a merge HQ restarts the preview (preview.ts restartAfterMerge): it ends the app, then starts it on main. A look that started in those seconds
// found the fixed port free and ran its copy there, and the preview's start was then refused ("Can't start shop: port N (api) is being used by node in
// …hq-test-T-02/backend") and stayed stopped. A port one of this HQ's previews was given counts as taken whether or not its app listens there yet.
test('Bug 381: a port HQ\'s preview was given is taken while its app isn\'t listening (restarting, installing); a stopped or crashed one\'s is free', async () => {
  const free = (): Promise<number> => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)) }) })
  const api = await free(), page = await free(), other = await free()
  run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('b381', 'b381shop', '/tmp/hq-testports-b381', 'local', 1)")
  fs.mkdirSync(path.join(PATHS.home, 'previews', 'b381'), { recursive: true })
  fs.writeFileSync(path.join(PATHS.home, 'previews', 'b381', 'spec.json'), JSON.stringify({ parts: [{ env: { PORT: String(api) } }, { env: { PORT: String(page) } }] }))
  const { wt, plan: p0 } = checkout({ 'frontend/vite.config.ts': VITE.replace('8000', String(api)) })
  const plan = { ...p0, repoPath: '/tmp/hq-testports-b381', recipe: { ...p0.recipe, parts: p0.recipe.parts.map((p) => p.name === 'api' ? { ...p, run: `node api.js --port ${api}`, port: api } : p) } }
  const darwin = { platform: 'darwin' } // the real check: nothing listens on these ports
  for (const [status, stopping] of [['running', 'restart'], ['starting', null]] as const) {
    run('INSERT OR REPLACE INTO previews(id, status, port, stopping, updated_at) VALUES (?, ?, ?, ?, 1)', 'b381', status, page, stopping)
    assert.equal(await portTaken(api), true, status); assert.equal(await portTaken(page), true, status); assert.equal(await portTaken(other), false, status)
    sh(wt, 'checkout', '-q', '--', '.')
    const got = await placePorts(wt, plan, [], darwin); assert.ok('plan' in got && got.plan.moved?.length === 1, `${status}: ${JSON.stringify(got)}`)
    const to = got.plan.moved[0]!.to
    assert.deepEqual(got.plan.moved, [{ part: 'api', from: api, to, by: "HQ's preview of b381shop", fix: 'Stop the app in the preview, then test again' }])
    assert.equal(got.plan.recipe.parts[0]!.run, `node api.js --port ${to}`); assert.deepEqual(blocked(got.plan), [api])
  }
  // what it must not catch: a preview that has ended holds nothing, so the copy keeps the project's own port
  for (const status of ['stopped', 'crashed']) {
    run('INSERT OR REPLACE INTO previews(id, status, port, stopping, updated_at) VALUES (?, ?, ?, NULL, 1)', 'b381', status, page)
    assert.equal(await portTaken(api), false, status)
    sh(wt, 'checkout', '-q', '--', '.')
    const got = await placePorts(wt, plan, [], darwin); assert.ok('plan' in got && !got.plan.moved, `${status}: ${JSON.stringify(got)}`)
    releaseCopy(wt) // that copy's run is over (testrun.ts dropWorktree): its port is free again (Bug 410)
  }
})

// Bug 410: a test copy that runs on the project's own fixed port may not listen there yet (installing, starting), and another project's preview with the
// same fixed port was started on it, then read "running" off the copy's page. What a copy was given is HQ's own record now, from the moment its ports are
// settled until its checkout goes: taken for the previews (preview.ts choosePorts, e2e/test-copy-ports.test.ts) and for another copy, which moves off it.
test('Bug 410: a test copy\'s fixed port is taken, and named as HQ\'s test, from its settling until its checkout is gone; a preview start on its way too', async () => {
  const free = (): Promise<number> => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)) }) })
  const api = await free(), darwin = { platform: 'darwin' }
  run("INSERT INTO repos(id, name, path, kind, created_at) VALUES ('b410', 'b410shop', '/tmp/hq-testports-b410', 'local', 1)")
  const copy = () => {
    const { wt, plan: p0 } = checkout({ 'frontend/vite.config.ts': VITE.replace('8000', String(api)) })
    const parts = p0.recipe.parts.map((p) => p.name === 'api' ? { ...p, run: `node api.js --port ${api}`, port: api } : p)
    return { wt, plan: { ...p0, repoPath: '/tmp/hq-testports-b410', recipe: { ...p0.recipe, parts } } }
  }
  const a = copy(), b = copy()
  assert.equal(await portTaken(api), false)
  const got = await placePorts(a.wt, a.plan, [], darwin); assert.ok('plan' in got && !got.plan.moved, JSON.stringify(got)) // nobody had it: the copy keeps it
  assert.equal(await portTaken(api), true); assert.equal(copyPorts().get(api), 'b410') // nothing listens there, and it is taken all the same
  assert.deepEqual(await heldBy(api, null), { who: "HQ's own test of b410shop's app", fix: 'Test again once that test is over' })
  // a second copy (another test of the project, or of another one with the same fixed port) moves off it, saying whose test has it
  const second = await placePorts(b.wt, b.plan, [], darwin); assert.ok('plan' in second && second.plan.moved?.length === 1, JSON.stringify(second))
  const to = second.plan.moved[0]!.to
  assert.deepEqual(second.plan.moved, [{ part: 'api', from: api, to, by: "HQ's own test of b410shop's app", fix: 'Test again once that test is over' }])
  assert.equal(copyPorts().get(to), 'b410') // and what it moved to is its own while it runs
  // what it must not catch: a copy that is over (its checkout removed, released or not) holds nothing
  releaseCopy(a.wt); assert.equal(await portTaken(api), false)
  assert.ok('plan' in await placePorts(a.wt, a.plan, [], darwin)); assert.equal(await portTaken(api), true)
  fs.rmSync(a.wt, { recursive: true, force: true }); assert.equal(await portTaken(api), false); assert.equal(copyPorts().has(api), false)
  releaseCopy(b.wt); assert.equal(copyPorts().has(to), false)
  // Bug 354's claim of a preview start on its way (its row not yet "starting") counts for a copy too, named as that project's preview
  handing.set('b410', [api]); assert.equal(await portTaken(api), true)
  assert.deepEqual(await heldBy(api, 'b410'), { who: "HQ's preview of b410shop", fix: 'Stop the app in the preview, then test again' })
  handing.delete('b410'); assert.equal(await portTaken(api), false)
})

// A rule with no check gets broken: a run that starts a moved app without `block` could reach the preview's server and the user's data on the old port.
test('every sandboxed run in a file that prepares an app is refused the ports the app was moved off', () => {
  const dir = import.meta.dirname, files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && /\bprepareApp\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
  assert.ok(files.length >= 5 && files.includes('uitester.ts'), files.join(' '))
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8'), runs = text.match(/network: false/g)?.length ?? 0, told = text.match(/network: false[^})]*\bblock: blocked\(/g)?.length ?? 0
    assert.equal(told, runs, `${f}: ${runs} sandboxed run(s) with the network off, ${told} of them given \`block: blocked(plan)\``)
  }
})
