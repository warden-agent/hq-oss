// Live preview rules: which command, when to install, which port, where the app answers, whether HQ may frame it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EPHEMERAL_FROM, strayPorts, testPorts } from './apprun.ts'
import { assignPorts, portRange, checkRecipe, commandRecipe, detectCommand, frameBlocked, installMark, installStep, lockfileProblem, needsInstall, NO_LOCK_INSTALL, npmLock, parseRunMark, printedPorts,
  recipeProblem, runMark, runScript, RUN_MARK, sameCommands, supervisorSpec, type Recipe } from './apprun.ts'

const repo = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-apprun-'))
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
  return dir
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts })
const deps = JSON.stringify({ name: 'x', scripts: { start: 'x' }, dependencies: { ms: '2.1.3' } }) // something for npm to install
const age = (dir: string, f: string, secondsAgo: number) => { const t = new Date(Date.now() - secondsAgo * 1000); fs.utimesSync(path.join(dir, f), t, t) }

test('command: dev beats start; neither or no package.json means HQ cannot tell', () => {
  assert.equal(detectCommand(repo({ 'package.json': pkg({ start: 'node a.js', dev: 'vite' }) })), 'npm run dev')
  assert.equal(detectCommand(repo({ 'package.json': pkg({ start: 'node a.js', test: 'node --test' }) })), 'npm start')
  assert.equal(detectCommand(repo({ 'package.json': pkg({ test: 'node --test' }) })), null)
  assert.equal(detectCommand(repo({ 'README.md': 'hi' })), null)
  assert.equal(detectCommand(repo({ 'package.json': '{ not json' })), null)
})

test('install: only when npm\'s record is missing or older than the lockfile', () => {
  const fresh = repo({ 'package.json': deps, 'package-lock.json': '{}', 'node_modules/.package-lock.json': '{}' })
  age(fresh, 'package-lock.json', 60); assert.equal(installStep(fresh), null)
  age(fresh, 'node_modules/.package-lock.json', 120); assert.equal(installStep(fresh), 'npm ci') // a merge changed dependencies
  assert.equal(installStep(repo({ 'package.json': deps, 'package-lock.json': '{}' })), 'npm ci') // never installed
  assert.equal(installStep(repo({ 'package.json': deps })), NO_LOCK_INSTALL) // no lockfile, nothing installed
  assert.equal(installStep(repo({ 'package.json': deps, 'node_modules/a/index.js': '' })), null) // not npm's (yarn, pnpm): left alone
  assert.equal(installStep(repo({ 'README.md': 'hi' })), null)
})

test('install: never for a package.json that lists no packages (Bug 90: npm would write a package-lock.json)', () => {
  const with_ = (extra: object) => JSON.stringify({ name: 'x', scripts: { start: 'x' }, ...extra })
  assert.equal(installStep(repo({ 'package.json': pkg({ start: 'x' }) })), null)
  assert.equal(installStep(repo({ 'package.json': with_({ dependencies: {}, devDependencies: {} }) })), null)
  // a project already hit by Bug 90: npm ci never makes node_modules for it, so it would run on every start
  assert.equal(installStep(repo({ 'package.json': pkg({ start: 'x' }), 'package-lock.json': '{}' })), null)
  assert.equal(commandRecipe('npm start', repo({ 'package.json': pkg({ start: 'x' }) })).parts[0].install, undefined)
  // what it must not catch: any kind of dependency, a workspace root, a package.json npm itself would choke on
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
    assert.equal(installStep(repo({ 'package.json': with_({ [k]: { ms: '2.1.3' } }) })), NO_LOCK_INSTALL, k)
  assert.equal(installStep(repo({ 'package.json': with_({ workspaces: ['pkgs/*'] }) })), NO_LOCK_INSTALL)
  assert.equal(installStep(repo({ 'package.json': '{ not json' })), NO_LOCK_INSTALL)
  assert.equal(installStep(repo({ 'package.json': 'null' })), NO_LOCK_INSTALL)
})

test('install with packages but no lockfile: never writes one, and installs again when package.json changes (Bug 116)', () => {
  assert.equal(NO_LOCK_INSTALL, 'npm install --no-package-lock')
  const dir = repo({ 'package.json': deps, 'node_modules/.package-lock.json': '{}' })
  age(dir, 'package.json', 120); age(dir, 'node_modules/.package-lock.json', 60); assert.equal(installStep(dir), null) // installed since
  age(dir, 'package.json', 30); assert.equal(installStep(dir), NO_LOCK_INSTALL) // a merge or an edit changed it
  assert.equal(commandRecipe('npm start', dir).parts[0]!.install, NO_LOCK_INSTALL)
  // npm rewrites its record on every install, even one with nothing to do, so the next start doesn't install again
  age(dir, 'node_modules/.package-lock.json', 10); assert.equal(installStep(dir), null)
  // a lockfile the project has is still followed
  assert.equal(installStep(repo({ 'package.json': deps, 'package-lock.json': '{}' })), 'npm ci')
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
  const x = checkRecipe(splitApp({ parts: [{ name: 'web', dir: 'web', install: 'npm i', install_when: 'package-lock.json', run: 'vite', port: 'auto' }], show: 'web' }), root)
  assert.match('error' in x ? x.error : '', /web: use `npm ci`/)
})

const member = { name: 'web', dir: 'web', install: 'npm ci', install_when: 'package-lock.json', run: 'vite', port: 'auto' as const }
const workspace = (over: Record<string, string> = {}): string => repo({ 'package.json': JSON.stringify({ name: 'r', workspaces: ['packages/*', './web'] }),
  'package-lock.json': '{"v":1}', 'web/package.json': deps, 'packages/lib/package.json': deps, 'tools/package.json': deps, ...over })

test('recipe (Bug 156): with no package-lock.json anywhere, npm installs must not write one', () => {
  const root = repo({ 'package.json': deps, 'web/package.json': deps })
  for (const dir of [root, path.join(root, 'web')]) {
    assert.match(lockfileProblem('npm install', dir, root) ?? '', /npm install --no-package-lock` with install_when `package.json`.*would write one/)
    assert.match(lockfileProblem('npm i', dir, root) ?? '', /--no-package-lock/)
    assert.match(lockfileProblem('npm ci', dir, root) ?? '', /no package-lock.json for `npm ci` to follow/)
    assert.equal(lockfileProblem('npm install --no-package-lock', dir, root, 'package.json'), null)
    assert.equal(lockfileProblem('npm install --package-lock=false', dir, root), null)
    assert.match(lockfileProblem(NO_LOCK_INSTALL, dir, root, 'package-lock.json') ?? '', /install_when must be a `package.json`/)
    assert.equal(lockfileProblem(NO_LOCK_INSTALL, root, root, 'web/package.json'), null) // a member's, from the workspace root (a real helper's pick)
  }
  const x = checkRecipe({ parts: [{ name: 'app', dir: '.', install: 'npm install', install_when: 'package-lock.json', run: 'npm start', port: 'auto' }], show: 'app' }, root)
  assert.match('error' in x ? x.error : '', /^app: use `npm install --no-package-lock`/)
  assert.ok('recipe' in checkRecipe({ parts: [{ name: 'app', dir: '.', install: NO_LOCK_INSTALL, install_when: 'package.json', run: 'npm start', port: 'auto' }], show: 'app' }, root))
  assert.equal(lockfileProblem('pip install -r requirements.txt', root, root), null) // not npm: not this rule
})

test('recipe (Bug 156): a workspace member follows the root lockfile; a project of its own does not', () => {
  const root = workspace(), web = path.join(root, 'web'), lib = path.join(root, 'packages', 'lib')
  assert.equal(npmLock(web, root), path.join(root, 'package-lock.json'))
  assert.equal(npmLock(path.join(web, 'src'), root), path.join(root, 'package-lock.json')) // no package.json there: npm uses web's
  assert.equal(npmLock(lib, root), path.join(root, 'package-lock.json'))
  assert.equal(npmLock(path.join(root, 'tools'), root), null) // not listed in workspaces: its own project, with no lockfile
  for (const dir of [web, lib]) {
    assert.equal(lockfileProblem('npm ci', dir, root), null)
    assert.match(lockfileProblem('npm install', dir, root) ?? '', /use `npm ci` \(there is a package-lock.json at package-lock.json, which this folder follows\)/)
  }
  assert.match(lockfileProblem('npm install', path.join(root, 'tools'), root) ?? '', /--no-package-lock/)
  assert.equal(lockfileProblem('npm install --no-package-lock', web, root), null) // writes nothing (a git-ignored lockfile can be in one checkout only)
  assert.ok('recipe' in checkRecipe({ parts: [member], show: 'web' }, root))
  const own = workspace({ 'web/package-lock.json': '{}' }) // a member with a lockfile of its own: that one
  assert.equal(npmLock(path.join(own, 'web'), own), path.join(own, 'web', 'package-lock.json'))
  assert.equal(npmLock(path.join(root, 'web'), web), null) // never above the checkout it's given
  const obj = repo({ 'package.json': JSON.stringify({ name: 'r', workspaces: { packages: ['web'] } }), 'npm-shrinkwrap.json': '{}', 'web/package.json': deps })
  assert.equal(npmLock(path.join(obj, 'web'), obj), path.join(obj, 'npm-shrinkwrap.json'))
})

test('installs (Bug 156): a member\'s install_when is the root lockfile, so a change there installs again', () => {
  const root = workspace(), web = path.join(root, 'web')
  const mark = installMark(web, 'package-lock.json', root)!; assert.equal(mark, installMark(root, 'package-lock.json'))
  assert.equal(installMark(web, 'package-lock.json'), null) // only its own folder without the checkout
  assert.equal(needsInstall(member, web, { [web]: mark }, root), false)
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"v":2}'); assert.equal(needsInstall(member, web, { [web]: mark }, root), true)
  const r = { parts: [member], show: 'web', worktree_files: [], notes: '' }
  const spec = supervisorSpec({ recipe: r, root, ports: { web: 3090 }, marks: { [web]: mark }, marksFile: '/m.json', header: 'h' })
  assert.deepEqual([spec.parts[0]!.install, spec.parts[0]!.mark], ['npm ci', installMark(root, 'package-lock.json')])
})

test('saved recipes (Bug 156): checked again in the checkout they run in', () => {
  const root = repo({ 'package.json': deps }), ok = { parts: [{ ...member, dir: '.', install: NO_LOCK_INSTALL, install_when: 'package.json' }], show: 'web', worktree_files: [], notes: '' }
  assert.equal(recipeProblem(ok, root), null)
  assert.match(recipeProblem({ ...ok, parts: [{ ...ok.parts[0]!, install: 'npm install' }] }, root) ?? '', /^web: use `npm install --no-package-lock`/)
  assert.equal(recipeProblem({ ...ok, parts: [{ ...ok.parts[0]!, install: undefined }] }, root), null)
  assert.equal(recipeProblem({ ...ok, parts: [member] }, workspace()), null)
  assert.match(recipeProblem({ ...ok, parts: [{ ...member, install: 'npm i' }] }, workspace()) ?? '', /use `npm ci`/)
})

test('recipe: the OK covers commands and files, not the notes', () => {
  const root = split(), a = (checkRecipe(splitApp(), root) as { recipe: Recipe }).recipe
  assert.ok(sameCommands(a, { ...a, notes: 'reworded' }))
  assert.ok(!sameCommands(a, { ...a, worktree_files: ['server/.env', 'server/app.db'] }))
  assert.ok(!sameCommands(a, { ...a, parts: [{ ...a.parts[0]!, run: 'rm -rf ~' }, a.parts[1]!] }))
  assert.ok(!sameCommands(null, a))
})

test('recipe: the user\'s own command is one part on an auto port', () => {
  const r = commandRecipe('PORT=4000 node server.js', repo({ 'package.json': deps, 'package-lock.json': '{}' }))
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

test('ports (Bug 226): previews keep off a Launch helper\'s test ports while others are free, and take them when none is', async () => {
  const busy = (taken: number[]) => async (p: number) => taken.includes(p)
  const r = (checkRecipe(splitApp(), split()) as { recipe: Recipe }).recipe, avoid = [3090, 3091]
  assert.deepEqual((await assignPorts(r, null, busy([]), avoid))!.ports, { api: 3189, web: 3092 })
  assert.deepEqual((await assignPorts(r, 3090, busy([]), avoid))!.ports.web, 3092) // even its saved port, while the helper has it
  assert.deepEqual((await assignPorts(r, 3095, busy([]), avoid))!.ports.web, 3095) // a saved port of its own is still kept
  assert.deepEqual((await assignPorts(r, null, busy([3092, 3093, 3094, 3095, 3096, 3097, 3098, 3099]), avoid))!.ports.web, 3090) // the last free ones
})

test('test ports (Bug 226): up to three free ones from the top of the range, another helper\'s only when no others are free; [] when none is', async () => {
  const busy = (taken: number[]) => async (p: number) => taken.includes(p)
  assert.deepEqual(await testPorts([], busy([])), [3097, 3098, 3099])
  assert.deepEqual(await testPorts([3097, 3098, 3099], busy([3096])), [3093, 3094, 3095]) // another helper's, and a busy one
  assert.deepEqual(await testPorts([], busy([]), 3, [4080, 4081]), [4080, 4081]) // a small range: what there is
  const others = [3091, 3092, 3093, 3094, 3095, 3096, 3097, 3098, 3099]
  assert.deepEqual(await testPorts(others, busy([3099])), [3090, 3097, 3098]) // the one nobody holds, then other helpers' free ones
  assert.deepEqual(await testPorts([], busy([...others, 3090])), [])
})

test('stray test ports (Bug 226): only a port the helper chose itself; its given ports, the recipe\'s fixed ones and the OS\'s own are fine', () => {
  const r = (checkRecipe(splitApp(), split()) as { recipe: Recipe }).recipe // api on fixed 3189, web on auto
  assert.deepEqual(strayPorts([3180, 4087, 3180, 5173], [4087, 4088], r), [3180, 5173])
  assert.deepEqual(strayPorts([4087, 4088, 3189], [4087, 4088], r), []) // what it must not catch: given ports, a port the project hard-wires
  assert.deepEqual(strayPorts([EPHEMERAL_FROM, 51234, 4088], [4087, 4088], r), []) // a dev server's own workers on ports the OS handed out
  assert.deepEqual(strayPorts([], [4087], r), [])
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
  const dir = repo({ 'package.json': deps, 'package-lock.json': '{}', 'node_modules/.package-lock.json': '{}' })
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

test('recipe (Bug 191): an npm install anywhere in the command is checked in the folder it runs in', () => {
  const root = repo({ 'web/package.json': deps, 'web/server.js': '', 'README.md': 'hi' }) // the app in web/, no lockfile anywhere
  const app = (install: string, install_when = 'web/package.json') =>
    checkRecipe({ parts: [{ name: 'app', dir: '.', install, install_when, run: 'cd web && npm start', port: 'auto' }], show: 'app' }, root)
  const err = (install: string, when?: string) => { const x = app(install, when); return 'error' in x ? x.error : '(accepted)' }
  for (const c of ['cd web && npm install', 'cd web && npm install && npm start', 'npm --prefix web install', '(cd web; npm i)', 'cd web; npm ci', 'npm i --prefix=web 2>&1'])
    assert.match(err(c), /^app: `npm .*` runs in web: use `npm install --no-package-lock` with install_when `package.json`/, c)
  assert.match(err('cd web && npm ci'), /no package-lock.json for `npm ci` to follow/)
  assert.match(err('cd web && npm install --no-package-lock', 'package-lock.json'), /runs in web: install_when must be a `package.json`/)
  assert.ok('recipe' in app('cd web && npm install --no-package-lock'))
  assert.ok('recipe' in app('npm --prefix web install --no-package-lock'))
  assert.match(err('cd $WEB && npm install'), /HQ can't tell which folder of the repo `npm install` runs in: give the part that folder as its dir/)
  assert.match(err('cd ../.. && npm install'), /HQ can't tell which folder/) // outside the repo
  assert.match(err('cd wbe && npm install'), /`npm install` runs in wbe: that folder doesn't exist/)
  // its own folder, as before: no folder named in the words
  assert.match(lockfileProblem('npm install', path.join(root, 'web'), root) ?? '', /^use `npm install --no-package-lock`/)
  // with a lockfile in web/, the same compound command must use npm ci there
  fs.writeFileSync(path.join(root, 'web', 'package-lock.json'), '{}')
  assert.match(err('cd web && npm install', 'web/package-lock.json'), /^app: `npm install` runs in web: use `npm ci` \(there is a package-lock.json\)/)
  assert.ok('recipe' in app('cd web && npm ci', 'web/package-lock.json'))
  assert.ok('recipe' in app('npm ci --prefix web', 'web/package-lock.json'))
  // a saved recipe is refused the same way when it runs (Bug 156's re-check)
  fs.rmSync(path.join(root, 'web', 'package-lock.json'))
  const part = { name: 'app', dir: '.', install: 'cd web && npm install', install_when: 'web/package.json', run: 'cd web && npm start', port: 'auto' as const }
  const saved: Recipe = { parts: [part], show: 'app', worktree_files: [], notes: '' }
  assert.match(recipeProblem(saved, root) ?? '', /^app: `npm install` runs in web: use `npm install --no-package-lock`/)
})

test('recipe (Bug 191): what is not an npm install is not caught', () => {
  const root = repo({ 'web/package.json': deps, 'npm/Makefile': '' }) // no lockfile: any npm install would be refused
  for (const c of ['pnpm install', 'yarn install', 'bun install', 'echo npm install', 'cd npm && make', './npm-install.sh', 'npm run build', 'npm --prefix web run build',
    'cd web && npm start', 'npx npm-check-updates', 'pip install -r requirements.txt'])
    assert.equal(lockfileProblem(c, root, root), null, c)
})

test('recipe (Bug 211): a uv, yarn or pnpm install anywhere in the command is checked in the folder it runs in', () => {
  const root = repo({ 'server/uv.lock': 'x', 'server/pyproject.toml': '', 'web/yarn.lock': '', 'admin/pnpm-lock.yaml': '', 'README.md': 'hi' })
  const app = (install: string, run = 'node x') =>
    checkRecipe({ parts: [{ name: 'app', dir: '.', install, install_when: 'server/uv.lock', run, port: 'auto' }], show: 'app' }, root)
  const err = (install: string, run?: string) => { const x = app(install, run); return 'error' in x ? x.error : '(accepted)' }
  assert.match(err('cd server && uv sync'), /^app: `uv sync` runs in server: use `uv sync --locked` \(there is a uv.lock\)/) // the entry's case
  for (const c of ['uv --directory server sync', '(cd server; uv sync)', 'cd server\nuv sync --no-dev', 'uv sync --project server'])
    assert.match(err(c), /runs in server: use `uv sync --locked`/, c)
  for (const c of ['cd web && yarn install', 'cd web && yarn', 'yarn --cwd web install', 'cd web && yarn install --check-files'])
    assert.match(err(c), /runs in web: use `yarn install --frozen-lockfile` \(or --immutable\) \(there is a yarn.lock\)/, c)
  for (const c of ['cd admin && pnpm install', 'pnpm -C admin i', 'pnpm --dir admin install'])
    assert.match(err(c), /runs in admin: use `pnpm install --frozen-lockfile` \(there is a pnpm-lock.yaml\)/, c)
  assert.match(err('cd $SRV && uv sync'), /HQ can't tell which folder of the repo `uv sync` runs in: use `uv sync --locked`, or give the part that folder as its dir/)
  assert.match(err('cd ../.. && yarn'), /HQ can't tell which folder/) // outside the repo
  assert.match(err('cd srever && uv sync'), /`uv sync` runs in srever: that folder doesn't exist/)
  // what it must not catch: following the lockfile, a folder with no such lockfile, commands that aren't installs
  for (const ok of ['cd server && uv sync --locked', 'cd server && uv sync --frozen', 'UV_LOCKED=1 uv sync --directory server', 'cd $SRV && uv sync --locked',
    'cd web && yarn install --frozen-lockfile', 'yarn --cwd web install --immutable', 'pnpm -C admin install --frozen-lockfile', 'uv sync', 'cd admin && yarn',
    'cd web && pnpm install', 'cd server && uv run app.py', 'cd web && yarn build', "sh -c 'cd server && uv sync'", 'echo cd server && echo uv sync'])
    assert.ok('recipe' in app(ok), ok)
  // its own folder, as before: no folder named in the words
  assert.match(lockfileProblem('uv sync', path.join(root, 'server'), root) ?? '', /^use `uv sync --locked`/)
  assert.match(lockfileProblem('yarn install --verbose', path.join(root, 'web'), root) ?? '', /^use `yarn install --frozen-lockfile`/)
  // in the run command (it runs on every start), and in steps saved before this check (Bug 156's re-check)
  assert.match(err('cd server && uv sync --locked', 'cd server && uv sync && uv run app.py'),
    /^app: run has an install that would run on every start \(`uv sync`; put installs in install\): `uv sync` runs in server: use `uv sync --locked`/)
  assert.ok('recipe' in app('cd server && uv sync --locked', 'cd server && uv run app.py'))
  const part = { name: 'app', dir: '.', install: 'cd web && yarn', install_when: 'web/yarn.lock', run: 'cd web && yarn dev', port: 'auto' as const }
  assert.match(recipeProblem({ parts: [part], show: 'app', worktree_files: [], notes: '' }, root) ?? '', /^app: `yarn` runs in web: use `yarn install --frozen-lockfile`/)
})

test('recipe (Bug 191): an npm install in the run command runs on every start, so it is checked too', () => {
  const root = repo({ 'web/package.json': deps })
  const app = (run: string, dir = '.') => checkRecipe({ parts: [{ name: 'app', dir, run, port: 'auto' }], show: 'app' }, root)
  const err = (run: string, dir?: string) => { const x = app(run, dir); return 'error' in x ? x.error : '(accepted)' }
  assert.match(err('cd web && npm install && npm start'),
    /^app: run has an install that would run on every start \(`npm install`; put installs in install\): `npm install` runs in web: use `npm install --no-package-lock`/)
  assert.match(err('npm i && npm start', 'web'), /^app: run has an install .*: use `npm install --no-package-lock`/)
  for (const ok of ['cd web && npm start', 'npm --prefix web run dev -- --port $PORT', 'cd web && npm install --no-package-lock && npm start', 'echo npm install; node web/server.js'])
    assert.ok('recipe' in app(ok), ok)
  const saved: Recipe = { parts: [{ name: 'app', dir: '.', run: 'cd web && npm i && npm start', port: 'auto' }], show: 'app', worktree_files: [], notes: '' }
  assert.match(recipeProblem(saved, root) ?? '', /^app: run has an install/) // saved before this check: refused when it runs
  fs.writeFileSync(path.join(root, 'web', 'package-lock.json'), '{}')
  assert.ok('recipe' in app('cd web && npm ci && npm start')) // follows the lockfile: slow on every start, but nothing written
  assert.match(err('cd web && npm install && npm start'), /`npm install` runs in web: use `npm ci`/)
})
