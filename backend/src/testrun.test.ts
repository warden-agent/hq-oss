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
const home = fs.mkdtempSync(path.join(import.meta.dirname, '..', '.test-home-'))
after(() => fs.rmSync(home, { recursive: true, force: true }))
const SECRETS = ['.ssh/id_rsa', '.netrc', '.npmrc', '.git-credentials', '.config/gh/hosts.yml', '.config/gcloud/creds.json', '.docker/config.json', '.gnupg/key', '.kube/config', '.claude.json',
  '.cargo/credentials.toml', '.cargo/credentials']
for (const f of SECRETS) { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), 'secret') }
process.env.RUSTUP_HOME ??= path.join(os.homedir(), '.rustup') // the toolchain stays where it's installed, whatever HOME says
process.env.HOME = home; process.env.HQ_HOME = path.join(tmp, 'hq'); process.env.HQ_ENGINEER_CACHE = path.join(tmp, 'cache')
const { bwrapArgs, detectTests, failReport, failureLines, sandboxProblem, runSandboxed, sweepRunTmp, testBase, testCombined, sweepTestWorktrees, testWorktree } =
  await import('./testrun.ts')
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
