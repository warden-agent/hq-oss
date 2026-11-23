// Live preview rules: which command, when to install, which port, where the app answers, whether HQ may frame it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { commandWarning, EPHEMERAL_FROM, onPath, ownInstall, packageManager, installLeftovers, installOutputs, portBusy, portBusyWith, strayPorts, testPorts } from './apprun.ts'
import { assignPorts, portRange, checkRecipe, commandRecipe, detectCommand, frameBlocked, installMark, installStep, lockfileProblem, needsInstall, NO_LOCK_INSTALL, npmLock, parseRunMark, printedPorts,
  recipeProblem, refusedWords, runMark, runScript, RUN_MARK, sameCommands, supervisorSpec, type Recipe } from './apprun.ts'

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

test('the user\'s own command installs with the project\'s own package manager, never npm in its place (Bug 343)', () => {
  const all = () => true, none = () => false, own = (files: Record<string, string>, has: (tool: string) => boolean = all) => ownInstall(repo({ 'package.json': deps, ...files }), has)
  const named = (pm: string) => JSON.stringify({ name: 'x', dependencies: { ms: '2.1.3' }, packageManager: pm })
  // the entry's case: a yarn.lock, no node_modules (it was `npm install --no-package-lock`); each follows its lockfile, or writes none with none
  assert.deepEqual(own({ 'yarn.lock': '# yarn lockfile v1\n' }), { install: 'yarn install --frozen-lockfile', install_when: 'yarn.lock' })
  assert.deepEqual(own({ 'yarn.lock': '__metadata:\n  version: 8\n' }), { install: 'yarn install --immutable', install_when: 'yarn.lock' }) // Yarn 2+
  assert.deepEqual(own({ 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules\n' }), { install: 'yarn install --immutable', install_when: 'yarn.lock' })
  assert.deepEqual(own({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" }), { install: 'pnpm install --frozen-lockfile', install_when: 'pnpm-lock.yaml' })
  // package.json's packageManager decides, lockfile or not (Yarn 1 and pnpm can install without writing one)
  assert.deepEqual(own({ 'package.json': named('pnpm@9.15.9+sha512.abc') }), { install: 'pnpm install --no-lockfile', install_when: 'package.json' })
  assert.deepEqual(own({ 'package.json': named('yarn@1.22.22') }), { install: 'yarn install --pure-lockfile', install_when: 'package.json' })
  assert.deepEqual(own({ 'package.json': named('yarn@4.5.3'), 'yarn.lock': '' }), { install: 'yarn install --immutable', install_when: 'yarn.lock' })
  assert.deepEqual(own({ 'package.json': named('pnpm@9.0.0'), 'package-lock.json': '{}' }), { install: 'pnpm install --no-lockfile', install_when: 'package.json' })
  assert.equal(packageManager(repo({ 'package.json': named('pnpm@9.15.9+sha512.abc') })).why, 'its package.json names pnpm@9.15.9 as its packageManager')
  // what it must not catch: npm's projects as before (npm-shrinkwrap.json is npm's lockfile too), an unknown packageManager, no packages at all
  assert.deepEqual(own({}), { install: NO_LOCK_INSTALL }); assert.deepEqual(own({ 'package-lock.json': '{}', 'yarn.lock': '' }), { install: 'npm ci' })
  assert.deepEqual(own({ 'npm-shrinkwrap.json': '{}' }), { install: 'npm ci' }); assert.deepEqual(own({ 'package.json': named('npm@10.9.0') }), { install: NO_LOCK_INSTALL })
  assert.deepEqual(own({ 'package.json': named('bun@1.1.0'), 'yarn.lock': '' }), { install: 'yarn install --frozen-lockfile', install_when: 'yarn.lock' })
  assert.deepEqual(ownInstall(repo({ 'package.json': pkg({ start: 'x' }), 'yarn.lock': '' }), all), {})
  // each install passes the same lockfile check as Claude's steps (it writes no lockfile, and follows the one there is)
  const cases: Record<string, string>[] = [{ 'yarn.lock': '' }, { 'yarn.lock': '__metadata:\n' }, { 'pnpm-lock.yaml': '' },
    { 'package.json': named('pnpm@9.0.0') }, { 'package.json': named('yarn@1.0.0') }]
  for (const files of cases) {
    const dir = repo({ 'package.json': deps, ...files }), o = ownInstall(dir, all); assert.equal(lockfileProblem(o.install!, dir, dir, o.install_when), null, JSON.stringify(files))
  }
  // the tool isn't installed: HQ says so (never npm in its place), unless the packages are installed already (it runs as it is, as before)
  const stop = own({ 'yarn.lock': '' }, none).stop ?? ''
  assert.match(stop, /^it uses Yarn \(it has a yarn\.lock\), and yarn isn't installed on this computer .*npm ignores the yarn\.lock .*Install Yarn, then press Start again\.$/)
  assert.match(own({ 'package.json': named('pnpm@9.0.0') }, none).stop ?? '', /it uses pnpm \(its package\.json names pnpm@9\.0\.0 as its packageManager\).*the project asks for pnpm/)
  assert.deepEqual(own({ 'yarn.lock': '', 'node_modules/ms/index.js': '' }, none), {})
  assert.deepEqual(own({ 'yarn.lock': '__metadata:\n', '.pnp.cjs': '' }, none), {}); assert.ok(own({ 'yarn.lock': '__metadata:\n', 'node_modules/x': '' }, none).stop)
  assert.deepEqual(own({ 'pnpm-lock.yaml': '' }, (t) => t !== 'yarn'), { install: 'pnpm install --frozen-lockfile', install_when: 'pnpm-lock.yaml' })
  // Yarn 2+ with no yarn.lock always writes one: no install, and why
  assert.match(own({ 'package.json': named('yarn@4.5.3') }).stop ?? '', /^it uses Yarn 4 .*has no yarn\.lock.*Run yarn install in the project yourself/)
  assert.deepEqual(own({ 'package.json': named('yarn@4.5.3'), 'node_modules/ms/index.js': '' }), {})
  // the recipe: install_when makes it run when the lockfile changes or what it made is gone (Bug 303), like Claude's steps
  const dir = repo({ 'package.json': deps, 'pnpm-lock.yaml': 'a' }), r = commandRecipe('pnpm start', dir)
  if (!onPath('pnpm')) assert.equal(r.parts[0]!.install, undefined) // stopped by startJob instead (ownInstall's stop)
  const part = { ...r.parts[0]!, install: 'pnpm install --frozen-lockfile', install_when: 'pnpm-lock.yaml' }
  assert.equal(needsInstall(part, dir, {}), true); fs.mkdirSync(path.join(dir, 'node_modules'))
  assert.equal(needsInstall(part, dir, { [dir]: installMark(dir, 'pnpm-lock.yaml')! }), false)
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'b'); assert.equal(needsInstall(part, dir, { [dir]: installMark(dir, 'pnpm-lock.yaml')! }), false)
  assert.equal(needsInstall(part, dir, { [dir]: 'an older mark' }), true)
})

test('onPath: an executable file in a PATH folder', () => {
  const d = repo({ 'yarn': '#!/bin/sh\n', 'pnpm/x': '' }); fs.chmodSync(path.join(d, 'yarn'), 0o755); fs.writeFileSync(path.join(d, 'npm'), '')
  assert.equal(onPath('yarn', `/nowhere${path.delimiter}${d}`), true)
  assert.equal(onPath('npm', d), false); assert.equal(onPath('pnpm', d), false); assert.equal(onPath('yarn', ''), false) // not executable; a folder; no PATH
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
  parts: [{ name: 'api', dir: 'server', install: 'uv sync --locked', install_when: 'uv.lock', run: 'uv run --locked uvicorn app.main:app --port 3189', port: 3189 },
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
  const root = workspace(), web = path.join(root, 'web'); fs.mkdirSync(path.join(root, 'node_modules')) // installed, at the root (Bug 303)
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
  assert.match(recipeProblem({ ...ok, parts: [{ ...ok.parts[0]!, install: 'npm install' }] }, root)?.why ?? '', /^web: use `npm install --no-package-lock`/)
  assert.equal(recipeProblem({ ...ok, parts: [{ ...ok.parts[0]!, install: undefined }] }, root), null)
  assert.equal(recipeProblem({ ...ok, parts: [member] }, workspace()), null)
  assert.match(recipeProblem({ ...ok, parts: [{ ...member, install: 'npm i' }] }, workspace())?.why ?? '', /use `npm ci`/)
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

test('ports (Bug 354): a port another app of this HQ was given is never taken, though nothing listens on it yet', async () => {
  const busy = (taken: number[]) => async (p: number) => taken.includes(p)
  const r = (checkRecipe(splitApp(), split()) as { recipe: Recipe }).recipe
  assert.equal((await assignPorts(r, null, busy([]), [], [3090]))!.ports.web, 3091)
  assert.equal((await assignPorts(r, 3090, busy([]), [], [3090]))!.ports.web, 3091) // not even its saved one: the other app has it now
  assert.equal((await assignPorts(r, 3094, busy([]), [], [3090]))!.ports.web, 3094) // what the others weren't given is kept as before
  assert.equal((await assignPorts(r, null, busy([3091]), [3092], [3090]))!.ports.web, 3093) // busy, given and a helper's ports all skipped
  assert.equal(await assignPorts(r, null, busy([]), [], Array.from({ length: 10 }, (_, i) => 3090 + i)), null) // never as a last resort
  assert.deepEqual((await assignPorts(r, null, busy([]), [], [3189]))!.taken, []) // a fixed port is the recipe's own: as before
  const two = { ...r, parts: r.parts.map((p) => ({ ...p, port: 'auto' as const })) }
  assert.deepEqual((await assignPorts(two, null, busy([]), [], [3090, 3092]))!.ports, { web: 3091, api: 3093 })
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

/** Bug 322: a socket bound to a port of the OS's choosing on `host` and not listening, as Linux keeps the local end of an outgoing connection: nothing answers
 *  there and, on Linux and macOS alike, nothing can listen there. Python, not Node: Node's sockets set SO_REUSEADDR, and Linux lets a listener through a
 *  socket that has it and isn't listening. Null when the machine has no such address (no IPv6). */
async function bindOnly(host: string): Promise<{ port: number; release: () => Promise<void> } | null> {
  const code = ['import socket, sys', 's = socket.socket(socket.AF_INET6 if ":" in sys.argv[1] else socket.AF_INET)',
    'try: s.bind((sys.argv[1], 0))', 'except OSError: print("none", flush=True); sys.exit(0)', 'print(s.getsockname()[1], flush=True); sys.stdin.read()'].join('\n')
  const py = spawn('python3', ['-c', code, host], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = new Promise<void>((resolve) => py.once('close', () => resolve()))
  const line = await new Promise<string>((resolve, reject) => {
    py.stdout.once('data', (d) => resolve(String(d).trim())); py.once('error', reject); void exited.then(() => reject(new Error('python3 ended before it bound')))
  })
  const release = async () => { py.stdin.end(); await exited }
  if (line === 'none') { await release(); return null }
  return { port: Number(line), release }
}
const listensAt = (port: number, host: string): Promise<void> => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject); s.listen(port, host, () => s.close(() => resolve()))
})

test('portBusy (Bug 322): a port nothing answers on but nothing can listen on is busy, on IPv4 and IPv6; once it is let go it is free, and the check leaves it so',
  { timeout: 20_000 }, async () => {
    let tried = 0
    for (const host of ['127.0.0.1', '::1']) {
      const held = await bindOnly(host); if (!held) continue // this machine has no IPv6
      tried++
      try {
        assert.equal(await portBusyWith(held.port, [], null), false, `nothing answers on ${host}: a connect alone takes it as free (the bug)`)
        assert.equal(await portBusy(held.port), true, `held on ${host}`)
        assert.deepEqual(await Promise.all([held.port].map(portBusy)), [true], 'as freeBase calls it, with map\'s index and array after the port')
        // what it must not catch: an address this machine doesn't have (EADDRNOTAVAIL) says nothing about the port
        assert.equal(await portBusyWith(held.port, ['192.0.2.1'], null), false)
      } finally { await held.release() }
      assert.equal(await portBusy(held.port), false, `once it is let go on ${host}`)
      await listensAt(held.port, host) // the check closed its own listeners before it answered
    }
    assert.ok(tried >= 1, 'at least the IPv4 hold ran')
  })

test('portBusy (Bug 322): the local end of an outgoing connection is busy on Linux, where no listener can take it, and free on macOS, where one can',
  { timeout: 10_000 }, async () => {
    const server = net.createServer((c) => c.resume()); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const c = net.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port }); await new Promise((r) => c.once('connect', r))
    try { assert.equal(await portBusy(c.localPort!), process.platform === 'linux') } finally { c.destroy(); await new Promise((r) => server.close(r)) }
  })

test('portBusy (Bug 340): a port bound but not listening is busy at once, not after a connect\'s whole 500 ms wait (macOS answers no such connect)',
  { timeout: 20_000 }, async () => {
    for (const host of ['127.0.0.1', '::1']) {
      const held = await bindOnly(host); if (!held) continue // this machine has no IPv6
      try {
        const t0 = performance.now(); assert.equal(await portBusy(held.port), true, `held on ${host}`)
        const ms = performance.now() - t0; assert.ok(ms < 400, `held on ${host}: answered after ${Math.round(ms)} ms`)
        const ports = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(() => bindOnly(host)))
        try { // as an engineer's slot is checked: ten ports at once
          const t1 = performance.now(); assert.deepEqual(await Promise.all(ports.map((x) => portBusy(x!.port))), ports.map(() => true))
          assert.ok(performance.now() - t1 < 400, 'ten held ports at once')
        } finally { for (const x of ports) await x?.release() }
      } finally { await held.release() }
    }
  })

test('portBusy (Bug 340): what the early listen must not catch: an app that answers, on all addresses, is busy and HQ never listens beside it, even when its loop is held up',
  { timeout: 20_000 }, async () => {
    const app = net.createServer((c) => c.end()); await new Promise<void>((r) => app.listen(0, r)) // '::', as Node apps listen by default
    const port = (app.address() as net.AddressInfo).port, real = net.createServer; let listens = 0
    net.createServer = ((...a: Parameters<typeof real>) => { listens++; return real(...a) }) as typeof real // what cantListen opens
    try {
      for (let i = 0; i < 10; i++) assert.equal(await portBusy(port), true)
      const busy = portBusy(port); await new Promise((r) => process.nextTick(r)) // the connects have gone out
      const until = Date.now() + 200; while (Date.now() < until) { /* HQ's loop held up past QUIET_MS */ }
      assert.equal(await busy, true, 'with the loop held up')
      assert.equal(listens, 0, 'a listen of HQ\'s on 127.0.0.1 would take connections meant for the app')
    } finally { net.createServer = real; await new Promise((r) => app.close(r)) }
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

test('installs (Bug 303): again when what the install made is gone, the lockfile unchanged; each tool\'s own, where it puts it', () => {
  const root = repo({ 'package.json': JSON.stringify({ private: true, workspaces: ['web'] }), 'package-lock.json': '{}', 'web/package.json': deps,
    'yarnapp/package.json': deps, 'yarnapp/yarn.lock': '__metadata:\n  version: 8\n', 'linked/package.json': deps, 'linked/yarn.lock': '__metadata:\n',
    'linked/.yarnrc.yml': 'nodeLinker: "node-modules"\n', 'classic/package.json': deps, 'classic/yarn.lock': '# yarn lockfile v1\n',
    'admin/package.json': deps, 'admin/pnpm-lock.yaml': '', 'server/pyproject.toml': '[project]\nname = "api"\n', 'server/uv.lock': 'x',
    'bare/pyproject.toml': '[project]\nname = "b"\n', 'empty/package.json': '{"name":"e"}', 'empty/package-lock.json': '{}' })
  const cases: [string, string, string, string][] = [ // folder, install, install_when, what it makes (relative to the checkout)
    ['web', 'npm ci', 'package-lock.json', 'node_modules'], // a workspace member: npm installs at the root
    ['yarnapp', 'yarn install --immutable', 'yarn.lock', 'yarnapp/.pnp.cjs'], // the entry's case: Yarn 2+ Plug'n'Play
    ['linked', 'yarn install --immutable', 'yarn.lock', 'linked/node_modules'], ['classic', 'yarn --frozen-lockfile', 'yarn.lock', 'classic/node_modules'],
    ['.', 'cd admin && pnpm install --frozen-lockfile', 'admin/pnpm-lock.yaml', 'admin/node_modules'], ['server', 'uv sync --locked', 'uv.lock', 'server/.venv'],
    ['bare', 'uv venv --allow-existing && uv pip install -r pyproject.toml', 'pyproject.toml', 'bare/.venv'],
  ]
  for (const [dir, install, when, made] of cases) {
    const at = path.join(root, dir), part = { name: 'app', dir, install, install_when: when, run: 'x', port: 'auto' as const }
    assert.deepEqual(installOutputs(install, at, root), [path.join(root, made)], install)
    const marks = { [at]: installMark(at, when, root)! }; assert.ok(marks[at], when)
    assert.equal(needsInstall(part, at, marks, root), true, `${install}: never installed, though marked`)
    fs.mkdirSync(path.join(root, made), { recursive: true }); assert.equal(needsInstall(part, at, marks, root), false, `${install}: installed`)
    fs.rmSync(path.join(root, made), { recursive: true }); assert.equal(needsInstall(part, at, marks, root), true, `${install}: deleted`)
    const spec = supervisorSpec({ recipe: { parts: [part], show: 'app', worktree_files: [], notes: '' }, root, ports: { app: 3090 }, marks, marksFile: '/m.json', header: 'h' })
    assert.deepEqual([spec.parts[0]!.install, spec.parts[0]!.mark], [install, marks[at]]) // installs again, and the mark stays the lockfile's
  }
  // what it must not catch: nothing to install (npm makes no node_modules), installs HQ can't read or follow, a `uv run`, a venv outside the checkout
  for (const [dir, install] of [['empty', 'npm ci'], ['.', 'go build ./...'], ['.', 'pip install -r requirements.txt'], ['.', 'cd $X && npm ci'],
    ['server', 'uv run --locked python -c 1'], ['bare', 'uv venv /tmp/elsewhere']]) assert.deepEqual(installOutputs(install!, path.join(root, dir!), root), [], install)
  assert.deepEqual(installOutputs('uv venv --python 3.12 env2 && uv pip install .', path.join(root, 'bare'), root), [path.join(root, 'bare', 'env2')])
  const empty = path.join(root, 'empty'), part = { name: 'e', dir: 'empty', install: 'npm ci', install_when: 'package-lock.json', run: 'x', port: 'auto' as const }
  assert.equal(needsInstall(part, empty, { [empty]: installMark(empty, 'package-lock.json')! }, root), false)
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
  const root = split(), r = (checkRecipe(splitApp(), root) as { recipe: Recipe }).recipe; fs.mkdirSync(path.join(root, 'server', '.venv'))
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
  assert.match(recipeProblem(saved, root)?.why ?? '', /^app: `npm install` runs in web: use `npm install --no-package-lock`/)
})

test('recipe (Bug 191): what is not an npm install is not caught', () => {
  const root = repo({ 'web/package.json': deps, 'npm/Makefile': '' }) // no lockfile: any npm install would be refused
  for (const c of ['pnpm install', 'yarn install']) assert.doesNotMatch(lockfileProblem(c, root, root) ?? '', /package-lock|`npm /, c) // their own check (Bug 239)
  for (const c of ['bun install', 'echo npm install', 'cd npm && make', './npm-install.sh', 'npm run build', 'npm --prefix web run build',
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
  // what it must not catch: following the lockfile, a folder with no uv project, commands that aren't installs (no lockfile: Bug 239's test)
  for (const ok of ['cd server && uv sync --locked', 'cd server && uv sync --frozen', 'UV_LOCKED=1 uv sync --directory server', 'cd $SRV && uv sync --locked',
    'cd web && yarn install --frozen-lockfile', 'yarn --cwd web install --immutable', 'pnpm -C admin install --frozen-lockfile', 'uv sync',
    'cd server && uv run --locked app.py', 'cd web && yarn build', "sh -c 'cd server && uv sync'", 'echo cd server && echo uv sync'])
    assert.ok('recipe' in app(ok), ok)
  // its own folder, as before: no folder named in the words
  assert.match(lockfileProblem('uv sync', path.join(root, 'server'), root) ?? '', /^use `uv sync --locked`/)
  assert.match(lockfileProblem('yarn install --verbose', path.join(root, 'web'), root) ?? '', /^use `yarn install --frozen-lockfile`/)
  // in the run command (it runs on every start), and in steps saved before this check (Bug 156's re-check)
  assert.match(err('cd server && uv sync --locked', 'cd server && uv sync && uv run app.py'),
    /^app: run has an install that would run on every start \(`uv sync`; put installs in install\): `uv sync` runs in server: use `uv sync --locked`/)
  assert.ok('recipe' in app('cd server && uv sync --locked', 'cd server && uv run --locked app.py'))
  const part = { name: 'app', dir: '.', install: 'cd web && yarn', install_when: 'web/yarn.lock', run: 'cd web && yarn dev', port: 'auto' as const }
  assert.match(recipeProblem({ parts: [part], show: 'app', worktree_files: [], notes: '' }, root)?.why ?? '', /^app: `yarn` runs in web: use `yarn install --frozen-lockfile`/)
})

test('recipe (Bug 239): with no lockfile, uv, yarn and pnpm installs must not write one', () => {
  const root = repo({ 'server/pyproject.toml': '[project]\nname = "api"\n', 'web/package.json': deps, 'admin/package.json': deps, 'scripts/x.py': '' })
  const app = (install: string, when: string, run = 'node x') => checkRecipe({ parts: [{ name: 'app', dir: '.', install, install_when: when, run, port: 'auto' }], show: 'app' }, root)
  const err = (install: string, when = 'server/pyproject.toml', run?: string) => { const x = app(install, when, run); return 'error' in x ? x.error : '(accepted)' }
  const uvBare = '`uv venv --allow-existing && uv pip install -r pyproject.toml` with install_when `pyproject.toml`, and `uv run --no-sync` to run it'
  assert.equal(err('cd server && uv sync'), `app: \`uv sync\` runs in server: there is no uv.lock, and \`uv sync\` would write one into the user's project: use ${uvBare}`)
  assert.match(err('cd server && uv sync --locked'), /there is no uv.lock for `uv sync --locked` to follow: use `uv venv --allow-existing /) // uv fails there
  const uvInstall = 'cd server && uv venv --allow-existing && uv pip install -r pyproject.toml'
  assert.equal(err(uvInstall, 'server/pyproject.toml', 'cd server && uv run app.py'), // a run writes one too: said as itself, not as an install on every start
    'app: `uv run app.py` runs in server: there is no uv.lock, and `uv run app.py` would write one into the user\'s project: '
    + 'use `uv run --no-sync` (install with `uv venv --allow-existing && uv pip install -r pyproject.toml`)')
  assert.match(err(uvInstall, 'server/pyproject.toml', 'uv run --directory server app.py'), /^app: `uv run --directory server app.py` runs in server: there is no uv.lock.*: use `uv run --no-sync`/)
  for (const run of ['cd server && uv run --no-sync app.py', 'cd server && UV_NO_SYNC=1 uv run app.py', 'cd server && uv run --no-project app.py',
    'uv run scripts/x.py', 'cd scripts && uv run x.py', 'cd $SRV && uv run --no-sync app.py', 'cd server && .venv/bin/python app.py'])
    assert.ok('recipe' in app(uvInstall, 'server/pyproject.toml', run), run) // no project there (no pyproject.toml), or a run that writes nothing
  assert.match(err(uvInstall, 'server/uv.lock', 'cd server && uv run --no-sync app.py'), // a file that isn't there: it would never install again
    /^app: install_when must be a `pyproject.toml` with `uv pip install` \(there is no uv.lock to watch\)$/)
  assert.match(err('cd web && yarn', 'web/package.json'),
    /^app: `yarn` runs in web: there is no yarn.lock, and `yarn` would write one into the user's project: use `yarn install --pure-lockfile` with install_when `package.json` \(Yarn 1; /)
  assert.match(err('cd web && yarn install --frozen-lockfile', 'web/package.json'), /there is no yarn.lock for `yarn install --frozen-lockfile` to follow: use `yarn install --pure-lockfile`/)
  assert.match(err('cd admin && pnpm install', 'admin/package.json'),
    /^app: `pnpm install` runs in admin: there is no pnpm-lock.yaml, and `pnpm install` would write one into the user's project: use `pnpm install --no-lockfile` with install_when `package.json`$/)
  assert.match(err('pnpm -C admin i --frozen-lockfile', 'admin/package.json'), /no pnpm-lock.yaml for `pnpm -C admin i --frozen-lockfile` to follow/)
  for (const [ok, when] of [['cd web && yarn install --pure-lockfile', 'web/package.json'], ['yarn --cwd web --no-lockfile', 'web/package.json'],
    ['cd admin && pnpm install --no-lockfile', 'admin/package.json'], ['pnpm -C admin i --lockfile=false', 'admin/package.json']] as const)
    assert.ok('recipe' in app(ok, when), ok)
  assert.match(err('cd web && yarn install --pure-lockfile', 'web/yarn.lock'),
    /runs in web: install_when must be a `package.json` with `yarn install --pure-lockfile` \(there is no lockfile to watch\)/)
  assert.match(err('cd web && yarn && yarn dev', 'web/package.json'), /`yarn` runs in web: there is no yarn.lock.*: use `yarn install --pure-lockfile`/) // the first, not the run after it
  // saved steps refused when they run, naming the lockfile they'd write (Bug 238)
  const saved = (install: string): Recipe =>
    ({ parts: [{ name: 'app', dir: 'server', install, install_when: 'uv.lock', run: 'uv run --locked app.py', port: 'auto' }], show: 'app', worktree_files: [], notes: '' })
  assert.deepEqual(recipeProblem(saved('uv sync'), root), { why: `app: there is no uv.lock, and \`uv sync\` would write one into the user's project: use ${uvBare}`, lock: 'uv.lock' })
  assert.equal(recipeProblem(saved('uv venv --allow-existing && uv pip install -r pyproject.toml'), root)?.lock, 'uv.lock') // its run
  assert.equal(recipeProblem({ ...saved(''), parts: [{ name: 'web', dir: 'web', install: 'yarn', install_when: 'package.json', run: 'yarn dev', port: 'auto' }] }, root)?.lock, 'yarn.lock')
  assert.equal(recipeProblem({ ...saved(''), parts: [{ name: 'web', dir: 'web', install: 'npm i', install_when: 'package.json', run: 'npm start', port: 'auto' }] }, root)?.lock, 'package-lock.json')
  assert.equal(refusedWords('uv.lock'), 'would write a uv.lock into the project, or not follow the one it has')
  fs.writeFileSync(path.join(root, 'server', 'uv.lock'), 'x') // a lockfile now: the old advice, and `uv run --locked` follows it
  assert.equal(recipeProblem(saved('uv sync --locked'), root), null)
  assert.match(recipeProblem(saved('uv sync'), root)?.why ?? '', /^app: use `uv sync --locked` \(there is a uv.lock\)$/)
})

test('recipe (Bug 240): uv, yarn and pnpm workspace members follow the lockfile at the workspace root', () => {
  const toml = '[project]\nname = "root"\n\n[tool.uv.workspace]\nmembers = [\n  "packages/*",\n  \'libs/core/\',\n]\nexclude = ["packages/skip"]\n\n[tool.ruff]\nexclude = ["tools/*"]\n'
  const root = repo({ 'pyproject.toml': toml,
    'uv.lock': 'x', 'packages/api/pyproject.toml': '[project]\nname = "api"\n', 'packages/skip/pyproject.toml': '', 'libs/core/pyproject.toml': '', 'tools/x/pyproject.toml': '' })
  const at = (d: string) => path.join(root, d)
  for (const d of ['packages/api', 'packages/api/src', 'libs/core', '.']) {
    if (!fs.existsSync(at(d))) fs.mkdirSync(at(d))
    assert.match(lockfileProblem('uv sync', at(d), root) ?? '',
      d === '.' ? /^use `uv sync --locked` \(there is a uv.lock\)$/ : /^use `uv sync --locked` \(there is a uv.lock at uv.lock, which this folder follows\)$/, d)
    assert.equal(lockfileProblem('uv sync --locked', at(d), root), null, d); assert.equal(lockfileProblem('uv run --locked app.py', at(d), root), null, d)
    assert.match(lockfileProblem('uv run app.py', at(d), root) ?? '', /^use `uv run --locked` \(there is a uv.lock.*, and `uv run app.py` rewrites it when it is out of date\)$/, d) // Bug 262
  }
  for (const d of ['packages/skip', 'tools/x']) // excluded, or not listed (another table's `exclude` doesn't count): a project of its own (uv 0.12.9 writes its own uv.lock)
    assert.match(lockfileProblem('uv sync', at(d), root) ?? '', /there is no uv.lock, and `uv sync` would write one/, d)
  assert.match(lockfileProblem('cd packages/api && uv sync', root, root) ?? '', /^`uv sync` runs in packages\/api: use `uv sync --locked` \(there is a uv.lock at uv.lock/) // the entry's case
  assert.match(lockfileProblem('uv sync', at('packages/api'), at('packages')) ?? '', /there is no uv.lock/) // never above the checkout it's given

  const yarn = repo({ 'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }), 'yarn.lock': '', 'packages/a/package.json': deps, 'tools/x/package.json': deps })
  assert.match(lockfileProblem('yarn', path.join(yarn, 'packages/a'), yarn) ?? '',
    /^use `yarn install --frozen-lockfile` \(or --immutable\) \(there is a yarn.lock at yarn.lock, which this folder follows\)$/)
  assert.equal(lockfileProblem('yarn install --frozen-lockfile', path.join(yarn, 'packages/a'), yarn), null)
  assert.match(lockfileProblem('yarn', path.join(yarn, 'tools/x'), yarn) ?? '', /use `yarn install --pure-lockfile`/) // not a workspace: yarn 1 writes tools/x/yarn.lock

  const pnpm = repo({ 'package.json': deps, 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n", 'pnpm-lock.yaml': '', 'packages/a/package.json': deps, 'tools/x/package.json': deps })
  for (const d of ['packages/a', 'tools/x']) { // pnpm takes the nearest pnpm-workspace.yaml as its workspace, listed or not (pnpm 9.15.9)
    assert.match(lockfileProblem('pnpm install', path.join(pnpm, d), pnpm) ?? '',
      /^use `pnpm install --frozen-lockfile` \(there is a pnpm-lock.yaml at pnpm-lock.yaml, which this folder follows\)$/, d)
    assert.equal(lockfileProblem('pnpm install --frozen-lockfile', path.join(pnpm, d), pnpm), null, d)
  }
  const own = repo({ 'pnpm-workspace.yaml': '', 'pnpm-lock.yaml': '', 'packages/a/package.json': deps, 'packages/a/pnpm-lock.yaml': '' }) // its own (shared-workspace-lockfile=false)
  assert.match(lockfileProblem('pnpm i', path.join(own, 'packages/a'), own) ?? '', /\(there is a pnpm-lock.yaml\)$/)
})

test('recipe (Bug 262): a `uv run` must follow the uv.lock as it is, not rewrite an out-of-date one', () => {
  const root = repo({ 'server/pyproject.toml': '[project]\nname = "api"\n', 'server/uv.lock': 'x', 'web/package.json': deps })
  const app = (run: string, dir = 'server') => checkRecipe({ parts: [{ name: 'app', dir, install: 'uv sync --locked', install_when: 'uv.lock', run, port: 'auto' }], show: 'app' }, root)
  const err = (run: string, dir?: string) => { const x = app(run, dir); return 'error' in x ? x.error : '(accepted)' }
  assert.equal(err('uv run app.py'), 'app: use `uv run --locked` (there is a uv.lock, and `uv run app.py` rewrites it when it is out of date)') // the entry's case
  assert.match(err('cd server && uv run uvicorn app:app', '.'), /^app: `uv run uvicorn app:app` runs in server: use `uv run --locked` \(there is a uv.lock/)
  assert.match(err('uv run --directory server app.py', '.'), /runs in server: use `uv run --locked`/)
  assert.match(err('cd $SRV && uv run app.py'), /^app: HQ can't tell which folder of the repo `uv run app.py` runs in: use `uv run --locked`, or give the part that folder as its dir$/)
  // the flag must be uv's: after the command it is the app's argument, and uv still rewrites uv.lock (round-5 UI test, uv 0.12.9)
  for (const late of ['uv run app.py --locked', 'uv run python app.py --frozen', 'uv run app.py --no-sync', 'uv run uvicorn app:app --locked'])
    assert.match(err(late), /^app: use `uv run --locked`/, late)
  // what it must not catch: a run that follows the lockfile (--locked stops on an out-of-date one, --frozen ignores it) or syncs nothing
  for (const ok of ['uv run --locked app.py', 'uv run --frozen app.py', 'UV_LOCKED=1 uv run app.py', 'UV_FROZEN=1 uv run app.py', 'uv run --no-sync app.py',
    'UV_NO_SYNC=1 uv run app.py', 'uv run --no-project app.py', 'cd $SRV && uv run --locked app.py', '.venv/bin/python app.py', 'uvx ruff check',
    'uv run --with rich --locked app.py', 'uv run --python 3.12 --no-sync app.py --locked'])
    assert.ok('recipe' in app(ok), ok)
  assert.ok('recipe' in app('uv --directory server run --frozen app.py', '.')) // uv's options before `run` are uv's too
  const saved = (run: string): Recipe => ({ parts: [{ name: 'app', dir: 'server', install: 'uv sync --locked', install_when: 'uv.lock', run, port: 'auto' }],
    show: 'app', worktree_files: [], notes: '' })
  assert.deepEqual(recipeProblem(saved('uv run app.py'), root), // saved before this check: refused when it starts, and the helper fixes it (Bug 156)
    { why: 'app: use `uv run --locked` (there is a uv.lock, and `uv run app.py` rewrites it when it is out of date)', lock: 'uv.lock' })
  assert.equal(recipeProblem(saved('uv run --locked app.py'), root), null)
})

test('the user\'s own command (Bug 316): a warning in plain words when it would write or rewrite a lockfile, the same check as Claude\'s steps', () => {
  const uv = repo({ 'pyproject.toml': '[project]\nname = "a"\n', 'uv.lock': 'version = 1\n' }), lockless = repo({ 'package.json': deps })
  assert.equal(commandWarning('uv run app.py', uv), '`uv run app.py` would write a uv.lock into the project, or not follow the one it has: '
    + 'use `uv run --locked` (there is a uv.lock, and `uv run app.py` rewrites it when it is out of date). '
    + 'If it then says the uv.lock needs to be updated, run `uv lock` yourself first, where the command runs, and commit the new uv.lock.') // Bug 343
  assert.match(commandWarning('yarn && yarn start', repo({ 'package.json': deps, 'yarn.lock': '' })) ?? '', /needs to be updated, run `yarn install` yourself/)
  assert.match(commandWarning('npm i && npm start', repo({ 'package.json': deps, 'package-lock.json': '{}' })) ?? '', /needs to be updated, run `npm install` yourself/)
  assert.equal(commandWarning('npm install && npm start', lockless), '`npm install` would write a package-lock.json into the project, or not follow the one it has: '
    + 'use `npm install --no-package-lock` (there is no package-lock.json, and `npm install` would write one into the user\'s project).') // no recipe words
  assert.match(commandWarning('cd sub && uv sync', repo({ 'sub/pyproject.toml': '', 'sub/uv.lock': 'x' })) ?? '', /^`uv sync` would write a uv\.lock .*: `uv sync` runs in sub: use `uv sync --locked`/)
  assert.doesNotMatch(commandWarning('uv run app.py', repo({ 'pyproject.toml': '' })) ?? '', /install_when/)
  // what it must not catch: commands that follow the lockfile or write none, no install at all, a folder HQ can't follow, a plain script
  for (const c of ['uv run --locked app.py', 'uv run --frozen app.py', 'UV_FROZEN=1 uv run app.py', 'uv run --no-sync app.py', 'npm start',
    'python app.py', 'cd $X && uv sync']) assert.equal(commandWarning(c, uv), null, c)
  assert.equal(commandWarning('npm install --no-package-lock && npm start', lockless), null)
  assert.equal(commandWarning('uv run app.py', repo({ 'app.py': '' })), null) // no pyproject.toml: uv writes no uv.lock
})

test('installLeftovers (Bug 263): what each install leaves in the project, in the folder it runs in and at the root it follows', () => {
  const root = repo({ 'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }), 'yarn.lock': '', 'packages/a/package.json': deps,
    'web/package.json': deps, 'web/package-lock.json': '{}', 'admin/package.json': deps, 'admin/pnpm-lock.yaml': '', 'server/pyproject.toml': '', 'server/uv.lock': 'x' })
  const of = (...parts: [string, string | undefined, string][]): string[] =>
    installLeftovers({ parts: parts.map(([dir, install, run], i) => ({ name: `p${i}`, dir, install, install_when: 'x', run, port: 'auto' })), show: 'p0', worktree_files: [], notes: '' }, root)
  const YARN = ['node_modules/', '.pnp.cjs', '.pnp.loader.mjs', '.pnp.data.json', '.yarn/install-state.gz', '.yarn/cache/', '.yarn/unplugged/', '.yarn/__virtual__/']
  assert.deepEqual(of(['.', 'yarn install --immutable', 'yarn start']), YARN) // the entry's case: Yarn 2+ writes .pnp.cjs and its install state, lockfile followed or not
  assert.deepEqual(of(['packages/a', 'yarn install --immutable', 'yarn start']).sort(), [...YARN.map((f) => `packages/a/${f}`), ...YARN].sort()) // a member: the root's
  assert.deepEqual(of(['.', 'cd web && npm ci', 'cd web && npm start']), ['web/node_modules/'])
  assert.deepEqual(of(['admin', 'pnpm install --frozen-lockfile', 'pnpm dev']), ['admin/node_modules/'])
  assert.deepEqual(of(['web', undefined, 'npm ci && npm start']), ['web/node_modules/']) // the user's own ⚙ command: its run, too
  // what it must not catch: uv (its .venv ignores itself), commands that aren't installs, folders HQ can't follow or outside the checkout
  assert.deepEqual(of(['server', 'uv sync --locked', 'uv run --locked app.py'], ['web', undefined, 'npm start'], ['.', 'cd $X && yarn', 'yarn --version'],
    ['.', 'cd ../.. && npm ci', 'node x'], ['.', 'echo yarn install', 'yarn build']), [])
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
  assert.match(recipeProblem(saved, root)?.why ?? '', /^app: run has an install/) // saved before this check: refused when it runs
  fs.writeFileSync(path.join(root, 'web', 'package-lock.json'), '{}')
  assert.ok('recipe' in app('cd web && npm ci && npm start')) // follows the lockfile: slow on every start, but nothing written
  assert.match(err('cd web && npm install && npm start'), /`npm install` runs in web: use `npm ci`/)
})
