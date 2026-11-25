// Auto mode's test of a finished ticket, against throwaway repos and this machine's real sandbox: two branches that each pass alone can
// fail together with no git conflict, the sandbox holds, and nothing is left behind.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testrun-')))
// A made-up home with secrets to go after. Not under the temp folder: Linux's runs get their own /tmp, which hides it whatever the rules say.
// Bug 378: nor under a folder the Mac sandbox lets every run write to (/private/tmp, /private/var/folders), or a write to it isn't refused.
// So a checkout there (a scratch worktree) makes it in the real home instead, under a name of its own, removed after.
const anyRunWrites = (p: string) => /^\/(private\/)?(tmp|var\/folders)\//.test(`${fs.realpathSync(p)}/`)
const home = fs.mkdtempSync(path.join(anyRunWrites(import.meta.dirname) ? os.homedir() : path.join(import.meta.dirname, '..'), '.test-home-'))
after(() => fs.rmSync(home, { recursive: true, force: true }))
const SECRETS = ['.ssh/id_rsa', '.netrc', '.npmrc', '.git-credentials', '.config/gh/hosts.yml', '.config/gcloud/creds.json', '.docker/config.json', '.gnupg/key', '.kube/config', '.claude.json',
  '.cargo/credentials.toml', '.cargo/credentials']
for (const f of SECRETS) { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), 'secret') }
process.env.RUSTUP_HOME ??= path.join(os.homedir(), '.rustup') // the toolchain stays where it's installed, whatever HOME says
process.env.HOME = home; process.env.HQ_HOME = path.join(tmp, 'hq'); process.env.HQ_ENGINEER_CACHE = path.join(tmp, 'cache')
const { bwrapArgs, detectTests, testFolders, failReport, failedLine, failureLines, sandboxProblem, runSandboxed, autoGen, stopAutoTests, sweepRunTmp, testBase, testCombined, sweepTestWorktrees,
  testRunViews, testWorktree } = await import('./testrun.ts')
const { db, migrate } = await import('./db.ts'); migrate(); void db
const { bus } = await import('./events.ts')

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd,
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (d: string, files: Record<string, string>) => { for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
  fs.writeFileSync(path.join(d, f), text) } }
const dir = (files: Record<string, string>) => { const d = fs.mkdtempSync(path.join(tmp, 'd-')); write(d, files); return d }
const TEST = "const t=require('node:test'),a=require('node:assert');"
const problem = await sandboxProblem()
const boxed = { skip: problem ? `no sandbox here: ${problem}` : false }

test('detectTests: reads the project\'s files, and skips npm\'s placeholder', () => {
  assert.deepEqual(detectTests(dir({ 'package.json': '{"scripts":{"test":"node --test"}}' })), { install: null, test: 'npm test' })
  assert.deepEqual(detectTests(dir({ 'package.json': '{"scripts":{"test":"node --test"},"dependencies":{"x":"1"}}', 'package-lock.json': '{}' })), { install: 'npm ci', test: 'npm test' })
  assert.equal(detectTests(dir({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null)
  assert.deepEqual(detectTests(dir({ 'server/package.json': '{"scripts":{"test":"x"}}', 'web/package.json': '{"scripts":{"test":"y"}}', 'docs/package.json': '{}' })),
    { install: null, test: '(cd "server" && npm test) && (cd "web" && npm test)' })
  assert.deepEqual(detectTests(dir({ 'pyproject.toml': '' })), { install: 'uv sync', test: 'uv run pytest -q' })
  assert.equal(detectTests(dir({ 'go.mod': '' }))?.test, 'go test ./...')
  assert.equal(detectTests(dir({ 'Cargo.toml': '' }))?.test, 'cargo test')
  assert.equal(detectTests(dir({ Makefile: 'build:\n\tcc\ntest:\n\t./t\n' }))?.test, 'make test')
  assert.equal(detectTests(dir({ 'README.md': 'hi' })), null)
})
test('Bug 376: testFolders reads the folders back from the command detectTests builds, and from no other', () => {
  const two = detectTests(dir({ 'admin/package.json': '{"scripts":{"test":"x"}}', 'web/package.json': '{"scripts":{"test":"y"}}' }))!.test
  assert.deepEqual(testFolders(two), ['admin', 'web']); assert.deepEqual(testFolders(' (cd "web" && npm test) '), ['web']); assert.deepEqual(testFolders('(cd "my app" && npm test)'), ['my app'])
  for (const c of ['npm test', 'cd web && npm test', '(cd web && npm test)', '(cd "web" && npm test) && npm run lint', '(cd "web" && npm test) || (cd "admin" && npm test)',
    '(cd "web/app" && npm test)', '(cd ".." && npm test)', '(cd "$HOME" && npm test)', '(cd "web" && npm test -- src/api.test.ts)', '(cd "web" && npm test)(cd "admin" && npm test)', ''])
    assert.equal(testFolders(c), null, c)
})

/** Bug 392: stand-ins for Yarn, pnpm and Bun on PATH, each logging what it was asked to do (and where pnpm was told to keep its store); `pnpm test` runs node's tests. */
// In the engineer cache, which Linux's sandbox binds in: its runs get a /tmp of their own, where a stand-in under the temp folder isn't there
fs.mkdirSync(path.join(tmp, 'cache'), { recursive: true })
const toolBin = fs.mkdtempSync(path.join(tmp, 'cache', 'bin-')), noTools = fs.mkdtempSync(path.join(tmp, 'cache', 'none-')), pmLog = path.join(tmp, 'cache', 'pm.log')
for (const t of ['pnpm', 'yarn', 'bun']) {
  const script = [`echo "${t} $* store=$npm_config_store_dir" >> "${pmLog}"`, '[ "$1" = install ] && mkdir -p node_modules', '[ "$1" = test ] && exec node --test', 'exit 0']
  fs.writeFileSync(path.join(toolBin, t), `#!/bin/sh\n${script.join('\n')}\n`, { mode: 0o755 })
}
/** `fn` with PATH set to `dirs`, until it has ended (a run reads PATH after its git steps). */
const withPath = <T>(dirs: string, fn: () => T): T => {
  const was = process.env.PATH, back = () => { process.env.PATH = was }; process.env.PATH = dirs
  try { const r = fn(); if (r instanceof Promise) return r.finally(back) as T; back(); return r } catch (e) { back(); throw e }
}
const DEPS = '{"scripts":{"test":"node --test"},"dependencies":{"ms":"2.1.3"}}'
test('Bug 392: a Yarn, pnpm or Bun project installs by its lockfile and runs its test script with its own tool, as the preview would; npm\'s as before', () => {
  withPath(`${toolBin}${path.delimiter}${process.env.PATH}`, () => {
    const plan = (files: Record<string, string>) => detectTests(dir({ 'package.json': DEPS, ...files }))
    assert.deepEqual(plan({ 'pnpm-lock.yaml': '' }), { install: 'pnpm install --frozen-lockfile', test: 'pnpm test' })
    assert.deepEqual(plan({ 'yarn.lock': '' }), { install: 'yarn install --frozen-lockfile', test: 'yarn test' })
    assert.deepEqual(plan({ 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': 'nodeLinker: node-modules\n' }), { install: 'yarn install --immutable', test: 'yarn test' })
    assert.deepEqual(plan({ 'bun.lock': '{}' }), { install: 'bun install --frozen-lockfile', test: 'bun run test' }) // `bun test` is Bun's own runner, not the script
    assert.deepEqual(plan({ 'bun.lockb': '' }), { install: 'bun install --frozen-lockfile', test: 'bun run test' })
    assert.deepEqual(detectTests(dir({ 'package.json': DEPS.replace('{', '{"packageManager":"pnpm@10.4.0",') })), { install: 'pnpm install --no-lockfile', test: 'pnpm test' })
    assert.deepEqual(plan({ 'pnpm-lock.yaml': '', 'node_modules/ms/index.js': '' }), { install: null, test: 'pnpm test' }) // the main checkout's, copied
    assert.deepEqual(plan({ 'package-lock.json': '{}' }), { install: 'npm ci', test: 'npm test' }) // npm's own: as before, other tools or not
    assert.deepEqual(plan({}), { install: 'npm install', test: 'npm test' })
    const two = detectTests(dir({ 'api/package.json': DEPS, 'api/package-lock.json': '{}', 'web/package.json': DEPS, 'web/pnpm-lock.yaml': '' }))!
    assert.deepEqual(two, { install: '(cd "api" && npm ci) && (cd "web" && pnpm install --frozen-lockfile)', test: '(cd "api" && npm test) && (cd "web" && pnpm test)' })
    assert.deepEqual(testFolders(two.test), ['api', 'web']); assert.deepEqual(testFolders('(cd "web" && bun run test) && (cd "x" && yarn test)'), ['web', 'x'])
    assert.equal(testFolders('(cd "web" && bun test)'), null)
    const berry = detectTests(dir({ 'package.json': DEPS.replace('{', '{"packageManager":"yarn@4.5.0",') }))! // Yarn 2+ with no yarn.lock would write one
    assert.equal(berry.install, null); assert.match(berry.stop!, /no yarn\.lock.*then test again\.$/)
  })
})
test('Bug 392: its tool not installed, HQ says so in the preview\'s words and never installs with npm instead; packages already there still run', () => {
  withPath(noTools, () => {
    const lone = detectTests(dir({ 'package.json': DEPS, 'pnpm-lock.yaml': '' }))!
    assert.equal(lone.install, null); assert.equal(lone.test, 'npm test')
    assert.match(lone.stop!, /^it uses pnpm \(it has a pnpm-lock\.yaml\), and pnpm isn't installed on this computer .*npm ignores the pnpm-lock\.yaml .*Install pnpm, then test again\.$/)
    assert.deepEqual(detectTests(dir({ 'package.json': DEPS, 'bun.lock': '{}', 'node_modules/ms/index.js': '' })), { install: null, test: 'npm test' })
    assert.deepEqual(detectTests(dir({ 'package.json': '{"scripts":{"test":"node --test"}}', 'yarn.lock': '' })), { install: null, test: 'npm test' }) // nothing to install
    const two = detectTests(dir({ 'api/package.json': DEPS, 'api/package-lock.json': '{}', 'web/package.json': DEPS, 'web/yarn.lock': '' }))!
    assert.equal(two.install, '(cd "api" && npm ci)'); assert.match(two.stop!, /^web: it uses Yarn \(it has a yarn\.lock\), and yarn isn't installed/)
  })
})
test('CI really has the sandbox: these tests can\'t quietly go back to being skipped', { skip: process.env.CI ? false : 'only matters in CI' }, () => assert.equal(problem, null))

test('runSandboxed: the tests can use their own folder and localhost, and nothing of the user\'s', boxed, async () => {
  const d = dir({}), run = (cmd: string, network = false) => runSandboxed(d, cmd, { network, timeoutMs: 20_000 })
  assert.equal((await run('echo hi > own.txt && cat own.txt')).output, 'hi')
  assert.notEqual((await run('echo x > "$HOME/hq-sandbox-probe"')).code, 0)
  assert.equal(fs.existsSync(path.join(os.homedir(), 'hq-sandbox-probe')), false)
  const secrets = await run('ls "$HOME/.ssh"'); assert.notEqual(secrets.code, 0); assert.match(secrets.output, /not permitted|permission denied/i)
  for (const f of SECRETS) for (const network of [false, true]) assert.doesNotMatch((await run(`cat "$HOME/${f}"`, network)).output, /secret/, f)
  assert.equal((await run('env | grep -c -E "GH_TOKEN|ANTHROPIC|HQ_|TMUX"')).output, '0')
  assert.notEqual((await run('curl -sS -m 3 https://github.com')).code, 0)
  assert.equal((await run(`node -e "const s=require('net').createServer((c)=>c.end('here')).listen(0,'127.0.0.1',()=>require('net').connect(s.address().port,'127.0.0.1')
    .on('data',(b)=>{console.log(String(b));s.close()}))"`)).output, 'here')
  const t = await runSandboxed(d, 'sleep 30', { network: false, timeoutMs: 300 }); assert.equal(t.timedOut, true); assert.notEqual(t.code, 0)
})

// Bug 150: a listen that fails rejects, and the servers close whatever the checks do: one left open kept the test file, and the run, from ever ending.
// What failed was the made-up home's socket: from a checkout in a deep folder its path was longer than a socket's can be (104 bytes on macOS).
const listen = (file: string): Promise<net.Server> => new Promise((resolve, reject) => { fs.mkdirSync(path.dirname(file), { recursive: true })
  const s = net.createServer((c) => c.end('reached')).once('error', (e: NodeJS.ErrnoException) => reject(e.code !== 'EINVAL' ? e
    : new Error(`can't listen on ${file}: its ${Buffer.byteLength(file)} bytes are likely too long for a socket's path (104 on macOS); run from a shorter folder`, { cause: e })))
  s.listen(file, () => resolve(s)) })
// Bug 317: so on a Mac a socket whose path is too long is listened on and dialled through a short link to its folder (under /tmp, where the sandbox
// has no rule of its own for sockets); the socket itself stays where it was. Not on Linux: a run there has its own /tmp, which would hide the link,
// so the test would pass for the wrong reason. A deep checkout still fails there, saying why (Linux allows 108 bytes).
const links: string[] = []; after(() => { for (const l of links) fs.rmSync(l, { recursive: true, force: true }) })
const shortPath = (file: string): string => {
  if (Buffer.byteLength(file) < 104 || process.platform !== 'darwin') return file
  const l = fs.mkdtempSync(path.join(process.env.HQ_SHORT_TMPDIR ?? '/tmp', 'hq-sock-')); links.push(l)
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(path.dirname(file), path.join(l, 'to')); return path.join(l, 'to', path.basename(file))
}
/** What a socket answers outside the sandbox: each one the sandbox holds must be one a program could otherwise reach. */
const reach = (file: string): Promise<string> => new Promise((resolve) => { let out = ''
  net.connect(file).on('data', (b) => { out += String(b) }).on('end', () => resolve(out)).on('error', (e) => resolve(String(e))) })
test('runSandboxed: another program\'s socket is out of reach, network on or off; the run\'s own works', boxed, async () => {
  const d = dir({}), tmux = shortPath(path.join(tmp, 'tmux.sock')), docker = shortPath(path.join(home, '.docker', 'd.sock')), servers: net.Server[] = []
  const dial = (file: string, network: boolean) => runSandboxed(d, `node -e "require('net').connect(${JSON.stringify(JSON.stringify(file)).slice(1, -1)})
    .on('data',(b)=>console.log(String(b)))"`, { network, timeoutMs: 10_000 })
  try {
    for (const file of [tmux, docker]) { servers.push(await listen(file)); assert.equal(await reach(file), 'reached', file) }
    for (const file of [tmux, docker]) for (const network of [false, true]) assert.doesNotMatch((await dial(file, network)).output, /reached/, `${file} network ${network}`)
  } finally { servers.forEach((s) => s.close()) }
  const own = await runSandboxed(d, `node -e "const s=require('net').createServer((c)=>c.end('here')).listen('own.sock',()=>require('net').connect('own.sock')
    .on('data',(b)=>{console.log(String(b));s.close()}))"`, { network: false, timeoutMs: 10_000 })
  assert.equal(own.output, 'here')
})

// Bug 374: HQ runs its copy of an app on another port when the project's hard-wired one is in use (testports.ts), and the run is refused the old one, where
// somebody else's server answers (the user's preview, with their data). Linux: a run has a network of its own, with nothing of the machine's on it.
const PROBE = `const net = require('net'), port = Number(process.argv[2])
const call = (host, p) => new Promise((r) => { let out = ''; const c = net.connect({ host, port: p }); c.on('data', (b) => { out += b }); c.on('end', () => r(out)); c.on('error', (e) => r(e.code)) })
const listen = (host) => new Promise((r) => { const s = net.createServer(); s.on('error', (e) => r(e.code)); s.listen(port, host, () => s.close(() => r('listening'))) })
;(async () => {
  console.log('call 127.0.0.1:', await call('127.0.0.1', port))
  for (const h of ['127.0.0.1', '0.0.0.0', '::1', '::']) console.log('listen ' + h + ':', await listen(h))
  const own = net.createServer((c) => c.end('here')); own.listen(0, '127.0.0.1', async () => { console.log('own:', await call('127.0.0.1', own.address().port)); own.close() })
})()
`
test('Bug 374: a run is refused the port HQ moved its copy of the app off, to call or to listen on, and every other localhost port still works',
  { skip: boxed.skip || (process.platform === 'darwin' ? false : 'macOS only: on Linux a run has a network of its own') }, async () => {
    const held = net.createServer((c) => c.end('the preview')); await new Promise<void>((r) => held.listen(0, '127.0.0.1', r))
    const port = (held.address() as net.AddressInfo).port, d = dir({ 'probe.js': PROBE })
    const probe = async (block?: number[]) => (await runSandboxed(d, `node probe.js ${port}`, { network: false, timeoutMs: 20_000, block })).output.split('\n')
    try {
      const open = await probe()
      assert.equal(open[0], 'call 127.0.0.1: the preview'); assert.equal(open.at(-1), 'own: here') // with no block the run reaches whoever has the port
      assert.deepEqual(await probe([port]), ['call 127.0.0.1: EPERM', 'listen 127.0.0.1: EPERM', 'listen 0.0.0.0: EPERM', 'listen ::1: EPERM', 'listen ::: EPERM', 'own: here'])
      assert.equal((await probe([port + 1]))[0], 'call 127.0.0.1: the preview', 'only the ports named')
      // the install step has the whole network, and runs no app: nothing is blocked there
      assert.equal((await runSandboxed(d, `node probe.js ${port}`, { network: true, timeoutMs: 20_000, block: [port] })).output.split('\n')[0], 'call 127.0.0.1: the preview')
    } finally { held.close() }
  })

test('runSandboxed: `open` can\'t start a program outside the sandbox', { skip: boxed.skip || (process.platform === 'darwin' ? false : 'macOS only') }, async () => {
  const app = path.join(tmp, 'Probe.app'), marker = path.join(home, 'escaped'); fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>run</string><key>CFBundleIdentifier</key><string>hq.test.probe</string>'
    + '<key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/></dict></plist>')
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'run'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 })
  const r = await runSandboxed(dir({}), `open -g ${JSON.stringify(app)}`, { network: false, timeoutMs: 10_000 })
  await new Promise((f) => setTimeout(f, 1500)) // real-time: macOS starts an app some time after `open` has returned, and nothing shows that it won't
  assert.equal(fs.existsSync(marker), false, `open: ${r.code} ${r.output}`)
})

test('bwrapArgs: what\'s hidden is mounted after what\'s writable, and only the install step has the network', () => {
  const a = bwrapArgs(tmp, { network: false }), hideAt = a.indexOf(path.join(fs.realpathSync(home), '.ssh'))
  assert.ok(a.indexOf('--ro-bind') === 0 && a.indexOf('--tmpfs') < a.indexOf('--bind') && a.indexOf('--bind') < hideAt)
  assert.equal(a.includes('--share-net'), false); assert.equal(bwrapArgs(tmp, { network: true }).includes('--share-net'), true)
  assert.equal(a.at(-2), '--chdir'); assert.ok(a.includes('--die-with-parent') && a.includes('--unshare-all'))
})
test('sandboxProblem: says what to do, in words, when the sandbox won\'t start, and looks again next time', async () => {
  process.env.HQ_SANDBOX_BIN = 'hq-no-such-sandbox'
  try { assert.match((await sandboxProblem()) ?? '', /bubblewrap|sandbox/) } finally { delete process.env.HQ_SANDBOX_BIN }
  assert.equal(await sandboxProblem(), problem)
})

function mismatch(): string {
  const d = fs.mkdtempSync(path.join(tmp, 'r-')); sh(d, 'init', '-q', '-b', 'main')
  write(d, { 'package.json': '{"scripts":{"test":"node --test"}}', '.gitignore': '.claude/\n', 'server.js': "exports.item=()=>({name:'apples'})\n", 'screen.js': 'exports.label=(i)=>i.name\n',
    'test/join.test.js': `${TEST}t.test('join',()=>{const {item}=require('../server'),{label}=require('../screen');a.ok(!label(item()).includes('undefined'))})\n` })
  sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base')
  sh(d, 'switch', '-qc', 'a'); write(d, { 'server.js': "exports.item=()=>({name:'apples',dueDate:'2027'})\n" }); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'server sends dueDate')
  sh(d, 'switch', '-q', 'main'); sh(d, 'switch', '-qc', 'b'); write(d, { 'screen.js': "exports.label=(i)=>i.name+' '+(i.expiresOn??(i.dueDate?undefined:''))\n" }); sh(d,
    'add', '.'); sh(d, 'commit', '-qm', 'screen reads expiresOn')
  sh(d, 'switch', '-q', 'main'); return d
}
test('testCombined: passes alone, fails together with no git conflict, and leaves main and the checkout alone', boxed, async () => {
  const d = mismatch(), tip = sh(d, 'rev-parse', 'main')
  assert.equal((await testCombined(d, 'main', 'a', 'T1', null)).kind, 'pass')
  assert.equal((await testCombined(d, 'main', 'b', 'T2', null)).kind, 'pass')
  sh(d, 'merge', '-q', '--no-edit', 'a') // T1 merged; T2 hasn't moved, but main has
  const r = await testCombined(d, 'main', 'b', 'T2', null)
  assert.equal(r.kind, 'fail'); assert.match((r as { output: string }).output, /join/)
  assert.equal((await testBase(d, 'main', 'T2', null)).kind, 'pass') // the ticket's fault, not main's
  assert.notEqual(sh(d, 'rev-parse', 'main'), tip); assert.equal(sh(d, 'status', '--porcelain'), '')
  assert.equal(sh(d, 'worktree', 'list').split('\n').length, 1); assert.equal(fs.existsSync(testWorktree(d, 'T2')), false)
})

/** main (a.txt) and branch b changing it. */
function oneFile(): string {
  const d = fs.mkdtempSync(path.join(tmp, 'r-')); sh(d, 'init', '-q', '-b', 'main'); write(d, { 'a.txt': '1\n' }); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base')
  sh(d, 'switch', '-qc', 'b'); write(d, { 'a.txt': '2\n' }); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'two'); return d
}
test('testCombined: no tests at all, and a conflict; neither gets as far as running anything', async () => {
  const d = oneFile(); assert.deepEqual(await testCombined(d, 'main', 'b', 'T1', null), { kind: 'no_tests' })
  sh(d, 'switch', '-q', 'main'); write(d, { 'a.txt': '3\n' }); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'three')
  assert.deepEqual(await testCombined(d, 'main', 'b', 'T1', null), { kind: 'conflicts', files: ['a.txt'] })
})
test('testCombined: the user\'s own command', boxed, async () => {
  const d = oneFile()
  assert.equal((await testCombined(d, 'main', 'b', 'T1', 'grep -q 2 a.txt')).kind, 'pass')
  assert.equal((await testCombined(d, 'main', 'b', 'T1', 'grep -q 3 a.txt')).kind, 'fail')
})
test('Bug 392: a pnpm project\'s run installs and tests with pnpm in the sandbox, its store in the cache; with no pnpm nothing runs, the user\'s command neither', boxed, async () => {
  const d = fs.mkdtempSync(path.join(tmp, 'r-')); sh(d, 'init', '-q', '-b', 'main')
  write(d, { '.gitignore': 'node_modules/\n.claude/\n', 'package.json': DEPS, 'pnpm-lock.yaml': '', 'a.test.js': `${TEST}t.test('one',()=>a.ok(1))` })
  sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base'); fs.rmSync(pmLog, { force: true })
  const r = await withPath(`${toolBin}${path.delimiter}${process.env.PATH}`, () => testBase(d, 'main', 'P1', null))
  assert.equal(r.kind, 'pass', JSON.stringify(r)); assert.equal((r as { test: string }).test, 'pnpm test')
  assert.deepEqual(fs.readFileSync(pmLog, 'utf8').trim().split('\n'), [`pnpm install --frozen-lockfile store=${path.join(tmp, 'cache', 'pnpm-store')}`, 'pnpm test store='])
  for (const custom of [null, 'touch "$HOME/../ran.txt"']) {
    const x = await withPath(`${noTools}${path.delimiter}${process.env.PATH!.split(path.delimiter).filter((p) => !fs.existsSync(path.join(p, 'pnpm'))).join(path.delimiter)}`,
      () => testBase(d, 'main', 'P2', custom))
    assert.equal(x.kind, 'error'); assert.match((x as { why: string }).why, /^it uses pnpm .*Install pnpm, then test again\.$/)
  }
  assert.equal(fs.readFileSync(pmLog, 'utf8').trim().split('\n').length, 2); assert.equal(fs.existsSync(testWorktree(d, 'P2-main')), false)
})
const noCargo = (() => { try { execFileSync('cargo', ['--version'], { stdio: 'ignore' }); return false } catch { return 'no cargo here' } })()
test('Bug 58: a Rust project with a dependency installs and tests in the sandbox, and nothing lands in ~/.cargo', { skip: boxed.skip || noCargo }, async () => {
  const d = fs.mkdtempSync(path.join(tmp, 'r-')); sh(d, 'init', '-q', '-b', 'main')
  write(d, { '.gitignore': '.claude/\ntarget/\n', 'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nitoa = "1"\n',
    'src/lib.rs': '#[test]\nfn formats() { assert_eq!(itoa::Buffer::new().format(7), "7"); }\n' })
  sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base')
  const r = await testBase(d, 'main', 'R1', null) // cargo fetch with the network, cargo test without it
  assert.equal(r.kind, 'pass', JSON.stringify(r))
  assert.equal(fs.existsSync(path.join(home, '.cargo', 'registry')), false)
  assert.ok(fs.existsSync(path.join(tmp, 'cache', 'cargo', 'registry')))
})
test('with no sandbox on the machine nothing runs: HQ says so instead of running the tests bare', async () => {
  process.env.HQ_SANDBOX_BIN = 'hq-no-such-sandbox'
  try {
    const d = oneFile(), r = await testCombined(d, 'main', 'b', 'T1', 'touch ran.txt')
    assert.equal(r.kind, 'error'); assert.match((r as { why: string }).why, /wouldn't start/)
    assert.equal((await runSandboxed(d, 'touch ran.txt', { network: false, timeoutMs: 1000 })).sandboxFailed, true); assert.equal(fs.existsSync(path.join(d, 'ran.txt')), false)
  } finally { delete process.env.HQ_SANDBOX_BIN }
})

test('Bug 69: a test run that outlived its backend goes with its folder; its command line doesn\'t name it', async () => {
  const d = mismatch(); const wt = testWorktree(d, 'T8'); fs.mkdirSync(path.dirname(wt), { recursive: true }); sh(d, 'worktree', 'add', '-q', '--detach', wt, 'main')
  const left = spawn('sleep', ['61.8'], { cwd: wt, detached: true, stdio: 'ignore' }), gone = new Promise((r) => left.once('exit', r))
  await sweepTestWorktrees(d)
  assert.equal(await Promise.race([gone.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]), true); assert.equal(fs.existsSync(wt), false)
})

test('sweepTestWorktrees: what a stopped backend left behind goes', async () => {
  const d = mismatch(); const wt = testWorktree(d, 'T9'); fs.mkdirSync(path.dirname(wt), { recursive: true }); sh(d, 'worktree', 'add', '-q', '--detach', wt, 'main')
  await sweepTestWorktrees(d); assert.equal(fs.existsSync(wt), false); assert.equal(sh(d, 'worktree', 'list').split('\n').length, 1)
})

test('Bug 81: each run has its own temp folder, and it goes when the run ends, a killed run\'s too', { skip: boxed.skip || (process.platform === 'darwin' ? false : 'macOS only') }, async () => {
  const d = dir({}), mine = path.join(fs.realpathSync(os.tmpdir()), `hq-run-tmp-${process.pid}-`)
  const runs = await Promise.all([runSandboxed(d, 'echo "$TMPDIR" && head -c 1000000 /dev/zero > "$TMPDIR/coverage"', { network: false, timeoutMs: 20_000 }),
    runSandboxed(d, 'echo "$TMPDIR" && touch "$TMPDIR/coverage" && sleep 30', { network: false, timeoutMs: 1500 })])
  assert.equal(runs[0].code, 0, runs[0].output); assert.equal(runs[1].timedOut, true)
  const dirs = runs.map((r) => r.output.split('\n')[0]!)
  assert.notEqual(dirs[0], dirs[1])
  for (const t of dirs) { assert.ok(t.startsWith(mine), t); assert.equal(fs.existsSync(t), false, t) }
})

test('Bug 81: a start-up sweep takes the temp folders of runs whose backend died, and nothing else', async () => {
  const root = fs.realpathSync(os.tmpdir()), dead = spawn('true'); await new Promise((r) => dead.once('exit', r))
  const make = (name: string) => { const f = path.join(root, name); fs.mkdirSync(f, { recursive: true }); fs.writeFileSync(path.join(f, 'coverage'), 'x'); return f }
  const gone = make(`hq-run-tmp-${dead.pid}-x1`), kept = [make(`hq-run-tmp-${process.pid}-x2`), make('hq-run-tmp-1-x3'), make(`hq-run-tmpish-${dead.pid}-x4`)]
  after(() => { for (const f of kept) fs.rmSync(f, { recursive: true, force: true }) })
  assert.ok(sweepRunTmp().includes(path.basename(gone)))
  assert.equal(fs.existsSync(gone), false); for (const f of kept) assert.equal(fs.existsSync(f), true, f)
})

const passing = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `  ✔ case ${from + i} checks a thing (1ms)`)
test('Bug 82: failureLines keeps what names a failure or an error and a few lines after, however the output comes in, and only what\'s before the tail', () => {
  const crash = ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'jsdom'", '    at a', '    at b', '    at c']
  const text = `${['▶ list', ...passing(2), ...crash, '    at d', '    at e', ...passing(30)].join('\n')}\n\x1b[31m✖ shows who has it (2ms)\x1b[39m\n${['  AssertionError: 1 == 2',
    ...passing(30, 100)].join('\n')}\n`
  const f = failureLines(); for (let i = 0; i < text.length; i += 7) f.take(text.slice(i, i + 7))
  assert.equal(f.before(text.length), [...crash, '…', '✖ shows who has it (2ms)', '  AssertionError: 1 == 2'].join('\n')) // a pass ends it
  assert.equal(f.before(text.indexOf('\x1b[31m')), crash.join('\n')) // the tail starts at the ✖: it's in there already
  assert.equal(f.before(text.indexOf('Error')), '')
  const logged = Array.from({ length: 30 }, (_, i) => [`Error: connect ECONNREFUSED 127.0.0.1:${3000 + i}`, ...['a', 'b', 'c'].map((x) =>
    `    at ${x} (/app/server/check-a-monitor-that-is-meant-to-be-down.js:1:1)`), ...passing(1, i)].join('\n')).join('\n')
  const g = failureLines(); g.take(`${logged}\n✖ shows the outage (3ms)\n  AssertionError: 1 == 2\n✔ next\n`); const kept = g.before(Infinity)
  assert.match(kept, /✖ shows the outage \(3ms\)\n {2}AssertionError: 1 == 2$/); assert.ok(kept.length < 3000, String(kept.length)) // errors alone: half the room
})
test('Bug 383: failureLines and failedLine read a line as a terminal shows it (mocha --reporter list draws a test over its title)', () => {
  const f = failureLines(); f.take('✖ one fails\n  AssertionError: 1 == 2\n    two: \r  ✔ two: 0ms\n    after a pass\n'); f.take('x\n')
  assert.equal(f.before(Infinity), '✖ one fails\n  AssertionError: 1 == 2')
  assert.equal(failedLine('  one: \r  ✖ one fails (2ms)\n  two: \r  ✔ two: 0ms\n'), '✖ one fails') // the line a user names, as a terminal shows it
})
// Failing runs captured through HQ's own sandbox (bug372capture.mts) on 2026-11-24: mocha 11.8 (spec, list, dot, spec with --color), node 25 --test, vitest 3.2,
// jest 30, go 1.26, cargo 1.88; the project paths renamed /tmp/b391. In testdata/bug391.
const cap391 = (name: string): string => fs.readFileSync(new URL(`./testdata/bug391/${name}.txt`, import.meta.url), 'utf8')
test('Bug 391: failedLine names the first test mocha lists as failing, whatever the reporter, and the other runners\' lines stay as they were', () => {
  for (const r of ['', '-list', '-dot', '-color']) assert.equal(failedLine(cap391(`mocha-11.8.0${r}`)), '1) book list marks a book due soon', r)
  assert.equal(failedLine(cap391('node-25.4.0')), '✖ shows who has the book'); assert.equal(failedLine(cap391('go-1.26.4')), '--- FAIL: TestList (0.00s)')
  assert.equal(failedLine(cap391('jest-30.1.3')), 'FAIL ./j.jest.js'); assert.equal(failedLine(cap391('cargo-1.88.0')), 'error: test failed, to rerun pass `--lib`')
  assert.equal(failedLine(cap391('vitest-3.2.4')), '× book list > marks a book due soon 3ms') // its colours are gone: before, the line was escape codes
  // a hook's failure; a title with no ":" line in reach is its first line alone; what comes first in the output wins
  assert.equal(failedLine('  1 failing\n\n  1) shelf\n       "before each" hook for "lends a book":\n     Error: no db\n'), '1) shelf "before each" hook for "lends a book"')
  assert.equal(failedLine('1 failing\n1) shelf\na\nb\nc\nd\ne\nf\ng\nh:\n'), '1) shelf')
  assert.equal(failedLine('✖ first (1ms)\n1 failing\n1) later:\n'), '✖ first')
})
test('Bug 391: what failedLine must not read as mocha\'s, and an error\'s name before a stack frame', () => {
  assert.equal(failedLine('1) step one\n2) step two\n  at x (a.js:1:1)'), 'at x (a.js:1:1)') // a numbered line with no "N failing" over it
  assert.equal(failedLine('2 failing\n  AssertionError: 1 == 2\n  at y (b.js:1:1)'), 'AssertionError: 1 == 2') // the list cut off
  assert.equal(failedLine('  TypeError: list.map is not a function\n      at Context.<anonymous> (test/a.js:3:9)'), 'TypeError: list.map is not a function')
})
test('Bug 391: a long mocha run whose failure list starts before the tail keeps its first failure in `earlier`, and failedLine names it', () => {
  const diff = Array.from({ length: 12 }, (_, i) => `      +  "a line of the expected value, number ${i}, long enough to fill the tail"`).join('\n')
  const fail = (n: number) => `  ${n}) book list\n       case ${n}:\n\n      AssertionError [ERR_ASSERTION]: values differ\n${diff}\n      at Context.<anonymous> (test/a.js:${n}:1)\n`
  const text = `${passing(5).join('\n')}\n\n  5 passing (9ms)\n  30 failing\n\n${Array.from({ length: 30 }, (_, i) => fail(i + 1)).join('\n')}`
  const f = failureLines(); for (let i = 0; i < text.length; i += 500) f.take(text.slice(i, i + 500))
  const at = text.length - 8000, tail = text.slice(at)
  assert.ok(!tail.includes('30 failing') && !tail.includes('  1) book list'))
  assert.match(f.before(at), /^30 failing\n\n {2}1\) book list\n {7}case 1:/)
  assert.equal(failedLine(`${f.before(at)}\n${tail}`), '1) book list case 1')
})
test('Bug 82: failReport puts the early failures first, then the end of the output, cut between lines, in about the size asked', () => {
  const output = passing(200).join('\n'), earlier = 'Error: boom\n    at x'
  assert.equal(failReport({ output: 'short', earlier: '' }, 100), 'short'); assert.equal(failReport({ output, earlier: '' }, 50).split('\n')[0], '…')
  const r = failReport({ output, earlier }, 1000)
  assert.ok(r.startsWith('Lines that named a failure or an error, from earlier in the output:\nError: boom\n    at x\n\nThe end of the output:\n…\n  ✔ case'), r)
  assert.ok(r.endsWith('case 199 checks a thing (1ms)')); assert.ok(r.length <= 1100, String(r.length))
  const many = failReport({ output: 'ℹ fail 9', earlier: Array.from({ length: 500 }, (_, i) => `Error: ${i}`).join('\n') }, 1000)
  assert.match(many, /output:\nError: 0\n/); assert.match(many, /\n…\n\nThe end of the output:\nℹ fail 9$/); assert.ok(many.length <= 1100, String(many.length))
})
/** A node project whose tests print about 50 KB of passes, plus `extra` files. */
function bigSuite(extra: Record<string, string>): string {
  const files: Record<string, string> = { 'package.json': '{"scripts":{"test":"node --test"}}', ...extra }
  for (let i = 10; i < 50; i++) files[`test/f${i}.test.js`] = `${TEST}for(let k=0;k<15;k++)t.test('case ${i}-'+k+' checks a thing with a fairly long name to fill the output',()=>{})\n`
  return dir(files)
}
test('Bug 82: a test file that crashes early says why, though 50 KB of passing tests come after it', boxed, async () => {
  const r = await runSandboxed(bigSuite({ 'test/f03.test.js': `require('no-such-package-82')\n${TEST}t.test('never runs',()=>{})\n` }), 'node --test', { network: false, timeoutMs: 60_000 })
  assert.notEqual(r.code, 0); assert.match(r.output, /ℹ fail 1/); assert.doesNotMatch(r.output, /Cannot find module/) // node's summary only says the file failed
  assert.match(r.earlier, /Cannot find module 'no-such-package-82'/)
  const report = failReport(r, 4000); assert.match(report, /Cannot find module 'no-such-package-82'/); assert.match(report, /ℹ fail 1/); assert.ok(report.length < 4600)
})
test('Bug 82: a run past its time limit gets Ctrl+C first, so node names the test that never finished',
  { skip: boxed.skip || (process.platform === 'darwin' ? false : 'macOS only: bubblewrap doesn\'t pass Ctrl+C on') }, async () => {
  const d = bigSuite({ 'test/f99.test.js': `${TEST}t.test('waits for a server that never answers',()=>new Promise(()=>setInterval(()=>{},1000)))\n` })
  const r = await runSandboxed(d, 'node --test', { network: false, timeoutMs: 3000 })
  // node 25.4 prints its summary (`ℹ cancelled 1`, `✖ test/f99.test.js`), 25.9 `Interrupted while running: ⚠ test/f99.test.js`; killed outright, neither names it
  assert.equal(r.timedOut, true); assert.match(r.output, /[✖⚠] test\/f99\.test\.js/)
})
test('Bug 82: a run that ignores Ctrl+C is still stopped, a little later', boxed, async () => {
  const t0 = Date.now(), r = await runSandboxed(dir({}), "trap '' INT; echo waiting; sleep 60", { network: false, timeoutMs: 500 })
  assert.equal(r.timedOut, true); assert.equal(r.output, 'waiting'); assert.ok(Date.now() - t0 < 20_000, String(Date.now() - t0))
})

// Bug 89: turning auto off stops auto mode's own test run in that project at once, whatever step it's at, and nothing else.
const cache = path.join(tmp, 'cache'), seen = (f: string) => fs.existsSync(path.join(cache, f)) // the one folder outside the checkout a run can write to
const until = async (what: string, ok: () => boolean, ms = 15_000) => { const t0 = Date.now(); while (!ok()) { assert.ok(Date.now() - t0 < ms, `waited for ${what}`)
  await new Promise((r) => setTimeout(r, 50)) } }
const SLEEP = `sleep 57.${process.pid}`, sleeping = () => execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').some((l) => l.startsWith(SLEEP))
test('Bug 89: auto off ends its test run at once and says stopped, not failed; the checkout and the run go', boxed, async () => {
  const d = oneFile(), t0 = Date.now(), r = testBase(d, 'main', 'S1', `touch "${cache}/s1" && ${SLEEP}`, autoGen(d))
  await until('the run', () => seen('s1') && sleeping()); assert.equal(stopAutoTests(d), 1)
  assert.deepEqual(await r, { kind: 'stopped' }); assert.ok(Date.now() - t0 < 15_000, String(Date.now() - t0))
  assert.equal(sleeping(), false); assert.equal(fs.existsSync(testWorktree(d, 'S1-main')), false); assert.equal(stopAutoTests(d), 0, 'nothing left to stop')
})
test('Bug 89: auto off while packages install: the tests never run', boxed, async () => {
  const d = fs.mkdtempSync(path.join(tmp, 'r-')); sh(d, 'init', '-q', '-b', 'main')
  write(d, { 'package.json': JSON.stringify({ name: 'p', private: true, dependencies: {}, scripts: { test: 'node --test', preinstall: `touch "${cache}/s2" && ${SLEEP}` } }) })
  sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'base')
  const r = testBase(d, 'main', 'S2', `touch "${cache}/s2-tested"`, autoGen(d))
  await until('the install', () => seen('s2') && sleeping()); stopAutoTests(d)
  assert.deepEqual(await r, { kind: 'stopped' }); assert.equal(seen('s2-tested'), false); assert.equal(sleeping(), false)
})
test('Bug 89: a run waiting for its turn never starts; a run that isn\'t auto mode\'s, or another project\'s, carries on', boxed, async () => {
  const d = oneFile(), e = oneFile()
  const first = testBase(e, 'main', 'S3', `touch "${cache}/s3" && sleep 1 && grep -q 1 a.txt`, null) // a repair's try of a command, say: it has the one turn
  await until('the first run', () => seen('s3'))
  const queued = testBase(d, 'main', 'S4', `touch "${cache}/s4"`, autoGen(d))
  assert.equal(stopAutoTests(e), 0, 'not auto mode\'s'); stopAutoTests(d)
  assert.equal((await first).kind, 'pass'); assert.deepEqual(await queued, { kind: 'stopped' }); assert.equal(seen('s4'), false)
  assert.equal((await testBase(d, 'main', 'S5', 'grep -q 1 a.txt', autoGen(d))).kind, 'pass', 'a new run after a stop runs as usual')
})
test('Bug 89: auto off before the run has started (HQ still at its git steps) stops it too', boxed, async () => {
  const d = oneFile(), gen = autoGen(d), r = testCombined(d, 'main', 'b', 'S6', `touch "${cache}/s6"`, gen); stopAutoTests(d)
  assert.deepEqual(await r, { kind: 'stopped' }); assert.equal(seen('s6'), false)
  const late = testBase(d, 'main', 'S7', `touch "${cache}/s7"`, gen) // HQ read the count before auto went off, and is only now starting the run
  assert.deepEqual(await late, { kind: 'stopped' }); assert.equal(seen('s7'), false)
  assert.equal((await testBase(d, 'main', 'S8', 'grep -q 1 a.txt', autoGen(d))).kind, 'pass', 'a run that starts after the stop runs')
})

// Bug 106: the page is told about HQ's own test runs while they go: which project and ticket, what is tested, and whether the run is in line for its turn.
const told: { id: string; patch: Record<string, unknown> | null }[] = []
bus.on('patch', (p: { entity: string; id: string; patch: Record<string, unknown> | null }) => { if (p.entity === 'test_run') told.push({ id: p.id, patch: p.patch }) })
const states = (id: string) => told.filter((p) => p.id === id).map((p) => p.patch === null ? 'gone' : p.patch.state)
/** A command that says it has started (`name` in the cache folder) and then waits until the test lets it go: no run is looked at against a clock. */
const held = (name: string) => `touch "${cache}/${name}" && until [ -f "${cache}/${name}-go" ]; do sleep 0.1; done`, go = (name: string) => fs.writeFileSync(path.join(cache, `${name}-go`), '')
test('Bug 106: a run is on the page from when it starts to when its checkout has gone, whether it passes, fails or is stopped', boxed, async () => {
  const d = oneFile(), show = { repoId: 'r1', ticketId: 't1', what: 'ticket' as const }, t0 = Date.now()
  const pass = testCombined(d, 'main', 'b', 'P1', `${held('p1')} && grep -q 2 a.txt`, null, show)
  await until('the run', () => seen('p1'))
  const [v] = testRunViews(); assert.equal(testRunViews().length, 1)
  assert.deepEqual([v!.repo_id, v!.ticket_id, v!.what, v!.state], ['r1', 't1', 'ticket', 'running']); assert.ok(v!.since >= t0 && v!.since <= Date.now(), String(v!.since))
  let checkout: boolean | null = null // was its checkout still there when the page was told the run had gone?
  const gone = (p: { id: string; patch: unknown }) => { if (p.id === v!.id && p.patch === null) checkout = fs.existsSync(testWorktree(d, 'P1')) }
  bus.on('patch', gone); go('p1')
  assert.equal((await pass).kind, 'pass'); bus.off('patch', gone); assert.equal(checkout, false, 'its checkout went first')
  assert.deepEqual(testRunViews(), []); assert.deepEqual(states(v!.id), ['running', 'gone'])

  const fail = testBase(d, 'main', 'P2', `${held('p2')} && grep -q 2 a.txt`, null, { repoId: 'r1', ticketId: 't1', what: 'main' })
  await until('the failing run', () => seen('p2')); const f = testRunViews()[0]!; assert.deepEqual([f.what, f.state], ['main', 'running']); go('p2')
  assert.equal((await fail).kind, 'fail'); assert.deepEqual(testRunViews(), []); assert.deepEqual(states(f.id), ['running', 'gone'])

  const stop = testBase(d, 'main', 'P3', held('p3'), autoGen(d), { repoId: 'r1', ticketId: null, what: 'main' })
  await until('the run to stop', () => seen('p3')); const s = testRunViews()[0]!; assert.equal(s.ticket_id, null); stopAutoTests(d)
  assert.deepEqual(await stop, { kind: 'stopped' }); assert.deepEqual(testRunViews(), []); assert.deepEqual(states(s.id), ['running', 'gone'])
})
test('Bug 106: nothing reaches the page for a run nobody asked to show, one with no tests to run, or one stopped before it began', boxed, async () => {
  const d = oneFile(), show = { repoId: 'r1', ticketId: 't1', what: 'ticket' as const }; told.length = 0
  assert.equal((await testCombined(d, 'main', 'b', 'Q1', 'grep -q 2 a.txt')).kind, 'pass')
  assert.deepEqual(await testCombined(d, 'main', 'b', 'Q2', null, null, show), { kind: 'no_tests' })
  const gen = autoGen(d); stopAutoTests(d); assert.deepEqual(await testBase(d, 'main', 'Q3', 'true', gen, show), { kind: 'stopped' })
  sh(d, 'switch', '-q', 'main'); write(d, { 'a.txt': '3\n' }); sh(d, 'commit', '-qam', 'three')
  assert.equal((await testCombined(d, 'main', 'b', 'Q4', 'true', null, show)).kind, 'conflicts')
  assert.deepEqual(told, []); assert.deepEqual(testRunViews(), [])
})
test('Bug 106: a run in line for its turn says waiting, and running from the moment its turn comes', boxed, async () => {
  const d = oneFile(), e = oneFile()
  const first = testBase(e, 'main', 'W1', held('w1'), null, { repoId: 'r2', ticketId: null, what: 'main' })
  await until('the first run', () => seen('w1'))
  const second = testCombined(d, 'main', 'b', 'W2', held('w2'), null, { repoId: 'r1', ticketId: 't1', what: 'ticket' })
  await until('the second in line', () => testRunViews().some((v) => v.repo_id === 'r1' && v.state === 'waiting'))
  const w = testRunViews().find((v) => v.repo_id === 'r1')!, waitedFrom = w.since
  assert.equal(seen('w2'), false, 'it has not started'); assert.deepEqual(testRunViews().map((v) => [v.repo_id, v.state]), [['r2', 'running'], ['r1', 'waiting']])
  go('w1'); assert.equal((await first).kind, 'pass')
  await until('its turn', () => seen('w2')); const now = testRunViews().find((v) => v.id === w.id)!
  assert.equal(now.state, 'running'); assert.ok(now.since >= waitedFrom, 'its clock starts again when its turn comes'); assert.equal(testRunViews().length, 1)
  go('w2'); assert.equal((await second).kind, 'pass'); assert.deepEqual(testRunViews(), [])
  assert.deepEqual(states(w.id), ['running', 'waiting', 'running', 'gone'])
})
