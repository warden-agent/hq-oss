// Auto mode's test of a finished ticket, against throwaway repos and this machine's real sandbox: two branches that each pass alone can
// fail together with no git conflict, the sandbox holds, and nothing is left behind.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testrun-')))
// A made-up home with secrets to go after. Not under the temp folder: Linux's runs get their own /tmp, which hides it whatever the rules say.
const home = fs.mkdtempSync(path.join(import.meta.dirname, '..', '.test-home-'))
after(() => fs.rmSync(home, { recursive: true, force: true }))
const SECRETS = ['.ssh/id_rsa', '.netrc', '.npmrc', '.git-credentials', '.config/gh/hosts.yml', '.config/gcloud/creds.json', '.docker/config.json', '.gnupg/key', '.kube/config', '.claude.json']
for (const f of SECRETS) { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), 'secret') }
process.env.HOME = home; process.env.HQ_HOME = path.join(tmp, 'hq'); process.env.HQ_ENGINEER_CACHE = path.join(tmp, 'cache')
const { bwrapArgs, detectTests, sandboxProblem, runSandboxed, testBase, testCombined, sweepTestWorktrees, testWorktree } = await import('./testrun.ts')
const { db, migrate } = await import('./db.ts'); migrate(); void db

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

const listen = (file: string): Promise<net.Server> => new Promise((resolve) => { fs.mkdirSync(path.dirname(file), { recursive: true })
  const s = net.createServer((c) => c.end('reached')).listen(file, () => resolve(s)) })
test('runSandboxed: another program\'s socket is out of reach, network on or off; the run\'s own works', boxed, async () => {
  const d = dir({}), tmux = path.join(tmp, 'tmux.sock'), docker = path.join(home, '.docker', 'd.sock'), servers = [await listen(tmux), await listen(docker)]
  const dial = (file: string, network: boolean) => runSandboxed(d, `node -e "require('net').connect(${JSON.stringify(JSON.stringify(file)).slice(1, -1)})
    .on('data',(b)=>console.log(String(b)))"`, { network, timeoutMs: 10_000 })
  for (const file of [tmux, docker]) for (const network of [false, true]) assert.doesNotMatch((await dial(file, network)).output, /reached/, `${file} network ${network}`)
  servers.forEach((s) => s.close())
  const own = await runSandboxed(d, `node -e "const s=require('net').createServer((c)=>c.end('here')).listen('own.sock',()=>require('net').connect('own.sock')
    .on('data',(b)=>{console.log(String(b));s.close()}))"`, { network: false, timeoutMs: 10_000 })
  assert.equal(own.output, 'here')
})

test('runSandboxed: `open` can\'t start a program outside the sandbox', { skip: boxed.skip || (process.platform === 'darwin' ? false : 'macOS only') }, async () => {
  const app = path.join(tmp, 'Probe.app'), marker = path.join(home, 'escaped'); fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>run</string><key>CFBundleIdentifier</key><string>hq.test.probe</string>'
    + '<key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/></dict></plist>')
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'run'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 })
  const r = await runSandboxed(dir({}), `open -g ${JSON.stringify(app)}`, { network: false, timeoutMs: 10_000 })
  await new Promise((f) => setTimeout(f, 1500)); assert.equal(fs.existsSync(marker), false, `open: ${r.code} ${r.output}`)
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
test('with no sandbox on the machine nothing runs: HQ says so instead of running the tests bare', async () => {
  process.env.HQ_SANDBOX_BIN = 'hq-no-such-sandbox'
  try {
    const d = oneFile(), r = await testCombined(d, 'main', 'b', 'T1', 'touch ran.txt')
    assert.equal(r.kind, 'error'); assert.match((r as { why: string }).why, /wouldn't start/)
    assert.equal((await runSandboxed(d, 'touch ran.txt', { network: false, timeoutMs: 1000 })).sandboxFailed, true); assert.equal(fs.existsSync(path.join(d, 'ran.txt')), false)
  } finally { delete process.env.HQ_SANDBOX_BIN }
})

test('sweepTestWorktrees: what a stopped backend left behind goes', async () => {
  const d = mismatch(); const wt = testWorktree(d, 'T9'); fs.mkdirSync(path.dirname(wt), { recursive: true }); sh(d, 'worktree', 'add', '-q', '--detach', wt, 'main')
  await sweepTestWorktrees(d); assert.equal(fs.existsSync(wt), false); assert.equal(sh(d, 'worktree', 'list').split('\n').length, 1)
})
