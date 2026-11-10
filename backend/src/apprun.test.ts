// Live preview rules: which command, when to install, which port, where the app answers, whether HQ may frame it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assignPorts, portRange, checkRecipe, commandRecipe, detectCommand, frameBlocked, installMark, installStep, lockfileProblem, needsInstall, parseRunMark, printedPorts, runMark,
  runScript, RUN_MARK, sameCommands, supervisorSpec, type Recipe } from './apprun.ts'

const repo = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-apprun-'))
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
  return dir
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts })
const age = (dir: string, f: string, secondsAgo: number) => { const t = new Date(Date.now() - secondsAgo * 1000); fs.utimesSync(path.join(dir, f), t, t) }

test('command: dev beats start; neither or no package.json means HQ cannot tell', () => {
  assert.equal(detectCommand(repo({ 'package.json': pkg({ start: 'node a.js', dev: 'vite' }) })), 'npm run dev')
  assert.equal(detectCommand(repo({ 'package.json': pkg({ start: 'node a.js', test: 'node --test' }) })), 'npm start')
  assert.equal(detectCommand(repo({ 'package.json': pkg({ test: 'node --test' }) })), null)
  assert.equal(detectCommand(repo({ 'README.md': 'hi' })), null)
  assert.equal(detectCommand(repo({ 'package.json': '{ not json' })), null)
})

test('install: only when npm\'s record is missing or older than the lockfile', () => {
  const fresh = repo({ 'package.json': pkg({ start: 'x' }), 'package-lock.json': '{}', 'node_modules/.package-lock.json': '{}' })
  age(fresh, 'package-lock.json', 60); assert.equal(installStep(fresh), null)
  age(fresh, 'node_modules/.package-lock.json', 120); assert.equal(installStep(fresh), 'npm ci') // a merge changed dependencies
  assert.equal(installStep(repo({ 'package.json': pkg({ start: 'x' }), 'package-lock.json': '{}' })), 'npm ci') // never installed
  assert.equal(installStep(repo({ 'package.json': pkg({ start: 'x' }) })), 'npm install') // no lockfile, nothing installed
  assert.equal(installStep(repo({ 'package.json': pkg({ start: 'x' }), 'node_modules/a/index.js': '' })), null)
  assert.equal(installStep(repo({ 'README.md': 'hi' })), null)
})

test('run script: the supervisor with its spec, from the checkout', () => {
  assert.equal(runScript({ cwd: "/tmp/it's here", node: '/n/node', supervisor: '/hq/supervise.mjs', spec: '/hq/p/spec.json' }),
    "#!/bin/bash\ncd '/tmp/it'\\''s here' || exit 1\nexec '/n/node' '/hq/supervise.mjs' '/hq/p/spec.json'\n")
  // Bug 77: the run's mark is exported before the supervisor starts, so everything the app starts carries it
  const mark = runMark('/Users/x/.hq', 'repo-1a2b3c4d', 1794265131000)
  assert.match(mark, /^[0-9a-f]{8}\.repo-1a2b3c4d\.1794265131000$/); assert.notEqual(mark.split('.')[0], runMark('/tmp/other-hq', 'repo-1a2b3c4d', 1).split('.')[0])
  assert.deepEqual(parseRunMark(mark), { hq: mark.split('.')[0], repoId: 'repo-1a2b3c4d', startedAt: 1794265131000 }); assert.equal(parseRunMark('nonsense'), null)
  assert.equal(runScript({ cwd: '/r', node: '/n/node', supervisor: '/hq/supervise.mjs', spec: '/hq/p/spec.json', mark }),
    `#!/bin/bash\ncd '/r' || exit 1\nexport ${RUN_MARK}='${mark}'\nexec '/n/node' '/hq/supervise.mjs' '/hq/p/spec.json'\n`)
})

test('printed ports: loopback URLs only, colours stripped, each once', () => {
  assert.deepEqual(printedPorts('  VITE ready\n  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: http://192.168.1.4:5173/'), [5173])
  assert.deepEqual(printedPorts('Demo listening on http://localhost:3090\napi at http://127.0.0.1:4000/api and http://localhost:3090/'), [3090, 4000])
  assert.deepEqual(printedPorts('docs: https://example.com:8443/'), [])
})

test('framing: X-Frame-Options and CSP frame-ancestors', () => {
  const h = (o: Record<string, string>) => (n: string) => o[n] ?? null
  assert.equal(frameBlocked(h({})), false)
  assert.equal(frameBlocked(h({ 'x-frame-options': 'DENY' })), true)
  assert.equal(frameBlocked(h({ 'x-frame-options': 'SAMEORIGIN' })), true) // HQ is another origin
  assert.equal(frameBlocked(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" })), true)
  assert.equal(frameBlocked(h({ 'content-security-policy': "frame-ancestors 'none'" })), true)
  assert.equal(frameBlocked(h({ 'content-security-policy': 'frame-ancestors *' })), false)
  assert.equal(frameBlocked(h({ 'content-security-policy': "frame-ancestors 'self' http://127.0.0.1:4780" })), false)
  assert.equal(frameBlocked(h({ 'content-security-policy': "script-src 'self'" })), false)
})

const split = (): string => repo({ 'server/uv.lock': 'x', 'server/app.py': '', 'web/package.json': pkg({ dev: 'vite' }), 'web/package-lock.json': '{}' })
const splitApp = (over: Partial<Recipe> = {}): unknown => ({
  parts: [{ name: 'api', dir: 'server', install: 'uv sync --locked', install_when: 'uv.lock', run: 'uv run uvicorn app.main:app --port 3189', port: 3189 },
    { name: 'web', dir: 'web', install: 'npm ci', install_when: 'package-lock.json', run: 'npm run dev -- --port $PORT --strictPort', port: 'auto' }],
  show: 'web', worktree_files: ['server/.env'], notes: 'proxy → 3189', ...over })

test('recipe: a split app passes; bad shapes are explained', () => {
  const root = split()
  const ok = checkRecipe(splitApp(), root); assert.ok('recipe' in ok, JSON.stringify(ok))
  const err = (r: unknown) => { const x = checkRecipe(r, root); return 'error' in x ? x.error : '' }
  assert.match(err(splitApp({ show: 'docs' })), /show must be one of the parts \(api, web\)/)
  assert.match(err(splitApp({ parts: [] })), /parts/)
  assert.match(err({ ...splitApp() as object, parts: [{ name: 'api', dir: '../elsewhere', run: 'x', port: 'auto' }], show: 'api' }), /inside the repo/)
  assert.match(err({ ...splitApp() as object, parts: [{ name: 'api', dir: 'nope', run: 'x', port: 'auto' }], show: 'api' }), /folder nope doesn't exist/)
  assert.match(err({ ...splitApp() as object, parts: [{ name: 'api', dir: '.', run: 'x', port: 3091 }], show: 'api' }), /3091 is one HQ hands out/)
  assert.match(err({ ...splitApp() as object, parts: [{ name: 'a', dir: '.', run: 'x', port: 4000 }, { name: 'A', dir: '.', run: 'y', port: 4001 }], show: 'a' }), /names must be different/)
  assert.match(err({ ...splitApp() as object, worktree_files: ['/etc/passwd'] }), /inside the repo/)
})

test('recipe: installs must follow the lockfile', () => {
  const root = split()
  assert.match(lockfileProblem('npm install', path.join(root, 'web')) ?? '', /npm ci/)
  assert.equal(lockfileProblem('npm ci', path.join(root, 'web')), null)
  assert.match(lockfileProblem('uv sync', path.join(root, 'server')) ?? '', /--locked/)
  assert.equal(lockfileProblem('uv sync --frozen', path.join(root, 'server')), null)
  assert.equal(lockfileProblem('npm install', root), null) // no lockfile there: nothing to follow
  const x = checkRecipe(splitApp({ parts: [{ name: 'web', dir: 'web', install: 'npm i', install_when: 'package-lock.json', run: 'vite', port: 'auto' }], show: 'web' }), root)
  assert.match('error' in x ? x.error : '', /web: use `npm ci`/)
})

test('recipe: the OK covers commands and files, not the notes', () => {
  const root = split(), a = (checkRecipe(splitApp(), root) as { recipe: Recipe }).recipe
  assert.ok(sameCommands(a, { ...a, notes: 'reworded' }))
  assert.ok(!sameCommands(a, { ...a, worktree_files: ['server/.env', 'server/app.db'] }))
  assert.ok(!sameCommands(a, { ...a, parts: [{ ...a.parts[0]!, run: 'rm -rf ~' }, a.parts[1]!] }))
  assert.ok(!sameCommands(null, a))
})

test('recipe: the user\'s own command is one part on an auto port', () => {
  const r = commandRecipe('PORT=4000 node server.js', repo({ 'package.json': pkg({ start: 'x' }), 'package-lock.json': '{}' }))
  assert.deepEqual(r, { parts: [{ name: 'app', dir: '.', run: 'PORT=4000 node server.js', port: 'auto', install: 'npm ci' }], show: 'app', worktree_files: [], notes: '' })
})

test('ports: fixed as written, auto from 3090 (the page keeps its saved one); a held fixed port is reported', async () => {
  const busy = (taken: number[]) => async (p: number) => taken.includes(p)
  const r = (checkRecipe(splitApp(), split()) as { recipe: Recipe }).recipe
  assert.deepEqual(await assignPorts(r, null, busy([])), { ports: { api: 3189, web: 3090 }, taken: [] })
  assert.deepEqual(await assignPorts(r, 3094, busy([3090])), { ports: { api: 3189, web: 3094 }, taken: [] })
  assert.deepEqual(await assignPorts(r, 3094, busy([3094])), { ports: { api: 3189, web: 3090 }, taken: [] })
  assert.deepEqual(await assignPorts(r, 8080, busy([])), { ports: { api: 3189, web: 3090 }, taken: [] }) // outside the range: not reused
  assert.deepEqual((await assignPorts(r, null, busy([3189])))!.taken, [{ part: 'api', port: 3189 }]) // the user's own server, say
  assert.equal(await assignPorts(r, null, busy(Array.from({ length: 10 }, (_, i) => 3090 + i))), null)
  const two = { ...r, parts: r.parts.map((p) => ({ ...p, port: 'auto' as const })) }
  assert.deepEqual((await assignPorts(two, null, busy([])))!.ports, { web: 3090, api: 3091 })
})

test('installs: once per checkout, again when the install_when file changes', () => {
  const root = split(), web = path.join(root, 'web'), part = { name: 'web', dir: 'web', install: 'npm ci', install_when: 'package-lock.json', run: 'vite', port: 'auto' as const }
  assert.equal(needsInstall(part, web, {}), true)
  const mark = installMark(web, 'package-lock.json')!; assert.match(mark, /^[0-9a-f]{16}$/)
  assert.equal(needsInstall(part, web, { [web]: mark }), false)
  fs.writeFileSync(path.join(web, 'package-lock.json'), '{"changed":1}'); assert.equal(needsInstall(part, web, { [web]: mark }), true)
  assert.equal(needsInstall({ ...part, install_when: undefined }, web, { [web]: 'installed' }), true) // the user's own command: installStep decided
  assert.equal(needsInstall({ ...part, install: undefined }, web, {}), false)
})

test('the user\'s own command installs again after a merge changes dependencies, even after an earlier install', () => {
  const dir = repo({ 'package.json': pkg({ start: 'x' }), 'package-lock.json': '{}', 'node_modules/.package-lock.json': '{}' })
  age(dir, 'node_modules/.package-lock.json', 120); age(dir, 'package-lock.json', 60) // a merge brought a newer lockfile
  const r = commandRecipe('npm start', dir)
  const spec = supervisorSpec({ recipe: r, root: dir, ports: { app: 3090 }, marks: { [dir]: 'installed' }, marksFile: '/m.json', header: 'h' })
  assert.equal(spec.parts[0]!.install, 'npm ci')
  age(dir, 'node_modules/.package-lock.json', 30) // installed since: nothing to do
  assert.equal(supervisorSpec({ recipe: commandRecipe('npm start', dir), root: dir, ports: { app: 3090 }, marks: {}, marksFile: '/m.json', header: 'h' }).parts[0]!.install, null)
})

test('recipe: an install needs install_when', () => {
  const x = checkRecipe(splitApp({ parts: [{ name: 'web', dir: 'web', install: 'npm ci', run: 'vite', port: 'auto' }], show: 'web' }), split())
  assert.match('error' in x ? x.error : '', /web: install_when is required/)
})

test('supervisor spec: each part\'s folder, port and the others\' ports; installs only where needed', () => {
  const root = split(), r = (checkRecipe(splitApp(), root) as { recipe: Recipe }).recipe
  const marks = { [path.join(root, 'server')]: installMark(path.join(root, 'server'), 'uv.lock')! }
  const spec = supervisorSpec({ recipe: r, root, ports: { api: 3189, web: 3090 }, marks, marksFile: '/m.json', header: 'h' })
  assert.deepEqual(spec.parts.map((p) => [p.name, p.cwd, p.install, p.env.PORT, p.env.HQ_PORT_API, p.env.HQ_PORT_WEB, p.env.BROWSER]),
    [['api', path.join(root, 'server'), null, '3189', '3189', '3090', 'none'], ['web', path.join(root, 'web'), 'npm ci', '3090', '3189', '3090', 'none']])
  assert.equal(spec.parts[1]!.mark, installMark(path.join(root, 'web'), 'package-lock.json'))
})

test('portRange (Bug 44): HQ_PREVIEW_PORTS, 3090-3099 by default; a bad one is refused', () => {
  assert.deepEqual(portRange(undefined), Array.from({ length: 10 }, (_, i) => 3090 + i))
  assert.deepEqual(portRange(' 50000 - 50002 '), [50000, 50001, 50002])
  for (const bad of ['', '3090', '3099-3090', '80-89', '60000-70000', '3000-3200']) assert.throws(() => portRange(bad), /HQ_PREVIEW_PORTS must look like/)
})
