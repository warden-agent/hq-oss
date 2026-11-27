// Engineer settings: PyPI is reachable, every package cache (npm, Go, cargo, uv, pip) sits in a writable folder outside home, and uv
// never downloads a Python (that needs github.com, which stays blocked). Other roles get no sandbox.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-roles-'))
fs.mkdirSync(path.join(tmp, 'real-hq')); fs.symlinkSync(path.join(tmp, 'real-hq'), path.join(tmp, 'hq')) // a Mac's /tmp is a link, and so can ~/.hq be
process.env.HQ_HOME = path.join(tmp, 'hq'); process.env.HQ_ENGINEER_CACHE = path.join(tmp, 'cache')
const { migrate } = await import('./db.ts')
migrate()
const { buildSettings, toolReads, rustReads, checkoutReads, usesPnpm, pnpmLockDirs } = await import('./roles.ts')
const config = await import('./config.ts'); const { ENGINEER_CACHE } = config

test('engineers\' package caches (npm, Go, Python) sit outside home; PyPI is reachable, github.com stays blocked', () => {
  const s = buildSettings('engineer', 'tok', { agentDir: tmp }) as any
  const domains: string[] = s.sandbox.network.allowedDomains
  for (const d of ['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org']) assert.ok(domains.includes(d), d)
  assert.ok(!domains.some((d) => d.includes('github')))
  assert.equal(ENGINEER_CACHE, fs.realpathSync(path.join(tmp, 'cache')))
  assert.deepEqual(s.sandbox.filesystem.allowWrite, [ENGINEER_CACHE, ...pnpmLockDirs()]) // and pnpm 12's lock folders (Bug 455)
  assert.equal(s.env.UV_CACHE_DIR, path.join(ENGINEER_CACHE, 'uv')); assert.equal(s.env.PIP_CACHE_DIR, path.join(ENGINEER_CACHE, 'pip'))
  assert.equal(s.env.UV_PYTHON_INSTALL_DIR, path.join(ENGINEER_CACHE, 'python')); assert.equal(s.env.UV_PYTHON_DOWNLOADS, 'never')
  assert.equal(s.env.npm_config_cache, path.join(ENGINEER_CACHE, 'npm')) // npm writes its _logs there too, not under ~/.npm
  for (const k of ['GOCACHE', 'GOMODCACHE', 'GOPATH', 'CARGO_HOME']) assert.ok(String(s.env[k]).startsWith(ENGINEER_CACHE), k)
  // Bug 411: Poetry, Pipenv and PDM keep their caches there too, and make their environments inside the project's folder
  for (const k of ['POETRY_CACHE_DIR', 'PIPENV_CACHE_DIR', 'PDM_CACHE_DIR']) assert.ok(String(s.env[k]).startsWith(ENGINEER_CACHE), k)
  assert.equal(s.env.POETRY_VIRTUALENVS_IN_PROJECT, 'true'); assert.equal(s.env.PIPENV_VENV_IN_PROJECT, '1')
})

test('the test setup helper (localOnly) reaches localhost and nothing else: no package registry, not the repo\'s own allowlist', () => {
  const s = buildSettings('launcher', 'tok', { agentDir: tmp, localOnly: true, repoAllowlist: ['api.example.com'] }) as any
  assert.deepEqual(s.sandbox.network.allowedDomains, ['127.0.0.1', 'localhost', '[::1]']); assert.equal(s.sandbox.network.strictAllowlist, true)
  const launch = (buildSettings('launcher', 'tok', { agentDir: tmp, repoAllowlist: ['api.example.com'] }) as any).sandbox.network.allowedDomains // the Launch helper keeps them
  assert.ok(launch.includes('registry.npmjs.org') && launch.includes('api.example.com'))
})

test('Bug 425: the project\'s own hosts reach engineers\' sandbox as checked: one saved some other way that breaks the rules is left out', () => {
  const d: string[] = (buildSettings('engineer', 'tok', { agentDir: tmp, repoAllowlist: ['github.com', '*.com', '192.168.1.5', 'nas', 'x.example'] }) as any).sandbox.network.allowedDomains
  assert.ok(d.includes('github.com') && d.includes('x.example'), d.join(' '))
  for (const bad of ['*.com', '192.168.1.5', 'nas']) assert.ok(!d.includes(bad), bad)
})

test('Bug 59: engineers can\'t read HQ\'s folder, by its real path, because that\'s the one the sandbox compares', () => {
  const denied: string[] = (buildSettings('engineer', 'tok', { agentDir: tmp }) as any).sandbox.filesystem.denyRead
  assert.ok(denied.includes(fs.realpathSync(path.join(tmp, 'real-hq'))), denied.join(' '))
})

test('the TPM gets no sandbox and no package env', () => {
  const s = buildSettings('tpm', 'tok', { agentDir: tmp }) as any
  assert.equal(s.sandbox, undefined); assert.equal(s.env, undefined)
})

test('the Launch helper: the engineer sandbox, Go and npm caches out of home, no editing tools, no commits', async () => {
  const { roleFlags, modelFor } = await import('./roles.ts')
  const s = buildSettings('launcher', 'tok', { agentDir: tmp }) as any
  assert.equal(s.sandbox.enabled, true); assert.equal(s.sandbox.network.allowLocalBinding, true)
  for (const k of ['GOCACHE', 'GOMODCACHE', 'GOPATH', 'npm_config_cache', 'UV_CACHE_DIR']) assert.ok(String(s.env[k]).startsWith(ENGINEER_CACHE), k)
  assert.ok(s.permissions.deny.includes('Bash(git commit*)')); assert.ok(s.permissions.deny.includes('Read(.env)'))
  assert.ok(!(buildSettings('engineer', 'tok', { agentDir: tmp }) as any).permissions.deny.includes('Bash(git commit*)')) // engineers commit their work
  const flags = roleFlags('launcher', { worktreeName: 'launch-x', model: 'sonnet' })
  assert.deepEqual(flags.slice(0, 5), ['--worktree', 'launch-x', '--restricted', '--tools', 'Bash,Read,Glob,Grep,ToolSearch'])
  for (const t of ['Edit', 'Write', 'Agent', 'WebFetch']) assert.ok(flags.includes(t), t)
  assert.deepEqual(flags.slice(-4), ['--permission-mode', 'default', '--model', 'sonnet'])
  assert.equal(modelFor('launcher'), 'sonnet')
})

test('Bug 78: an agent\'s hq server is HQ\'s relay, run by a node that exists, and its config holds the token\'s file, not the token', async () => {
  const { buildMcp } = await import('./roles.ts')
  const tokenFile = path.join(tmp, 'agents', 'eng-1', 'token')
  const hq = (buildMcp(tokenFile) as any).mcpServers.hq
  assert.equal(hq.type, 'stdio'); assert.ok(fs.existsSync(hq.command), hq.command)
  assert.equal(hq.args.length, 1); assert.equal(path.basename(hq.args[0]), 'mcprelay.mjs'); assert.ok(fs.existsSync(hq.args[0]))
  assert.deepEqual(Object.keys(hq.env).sort(), ['HQ_MCP_URL', 'HQ_TOKEN_FILE']); assert.equal(hq.env.HQ_TOKEN_FILE, tokenFile)
  assert.match(hq.env.HQ_MCP_URL, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
})

test('Bugs 76, 112: an engineer\'s Bash hook is HQ\'s own script, which outlasts a wait for HQ plus a wait for a turn; other hooks, and the TPM\'s, stay short', async () => {
  const { TURN_WAIT_S, HQ_AWAY_WAIT_S, PATHS } = await import('./config.ts')
  for (const role of ['engineer', 'launcher'] as const) {
    const pre = (buildSettings(role, 'tok-secret', { agentDir: tmp, repoId: 'repo-1' }) as any).hooks.PreToolUse
    assert.deepEqual(pre.map((g: any) => g.matcher), ['Bash', '^(?!Bash$).*'], role)
    assert.ok(new RegExp(pre[1].matcher).test('Read') && !new RegExp(pre[1].matcher).test('Bash'))
    const bash = pre[0].hooks[0], [node, script, url, ...rest] = [...String(bash.command).matchAll(/'([^']*)'/g)].map((m) => m[1]!)
    assert.equal(bash.type, 'command'); assert.ok(fs.existsSync(node!), node); assert.equal(path.basename(script!), 'turnwait.mjs'); assert.ok(fs.existsSync(script!))
    assert.match(url!, /^http:\/\/127\.0\.0\.1:\d+\/hooks$/)
    const [tokenFile, awayS, totalS, cmdsFile, repoId] = rest
    assert.deepEqual([tokenFile, awayS, cmdsFile, repoId], [path.join(tmp, 'token'), String(HQ_AWAY_WAIT_S), PATHS.testCmds, 'repo-1'])
    assert.ok(Number(totalS) > HQ_AWAY_WAIT_S + TURN_WAIT_S, 'the script outlasts HQ being away and then the wait for a turn')
    assert.ok(bash.timeout > Number(totalS), 'and Claude Code\'s own limit comes after the script\'s')
    assert.ok(!JSON.stringify(pre[0]).includes('tok-secret'), 'its token stays in its own file') // Bug 87
    assert.equal(pre[1].hooks[0].type, 'http'); assert.equal(pre[1].hooks[0].timeout, 10); assert.match(pre[1].hooks[0].url, /\/hooks$/)
  }
  const tpm = (buildSettings('tpm', 'tok', { agentDir: tmp }) as any).hooks.PreToolUse
  assert.equal(tpm.length, 1); assert.equal(tpm[0].matcher, undefined); assert.equal(tpm[0].hooks[0].type, 'http'); assert.equal(tpm[0].hooks[0].timeout, 10)
})

test("Bug 96: the engineer prompt says what a Bash timeout really does, and never tells engineers to lean on it for a long suite", async () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'roles', 'engineer.prompt.md'), 'utf8') // what ensureAssets copies to ~/.hq/roles
  assert.doesNotMatch(text, /Give a long suite a time limit with the Bash tool's own `timeout`/)
  assert.match(text, /`timeout` setting doesn't stop a command: when it runs out, the command moves to the background and keeps going/)
  assert.match(text, /run only the test files for what you changed, with no extra flags/)
  assert.match(text, /never end your turn to wait on a run that is still going/)
  // Bug 447: Haiku engineers put node's `--test-force-exit` / `--test-timeout` on pytest ("unrecognized arguments"). Checked on real engineers:
  // a plain pytest example to copy stopped it; "the runner's own flags", a jest example (they took `--forceExit`) or "node only" alone didn't
  assert.match(text, /with no extra flags \(`uv run pytest tests\/test_x\.py`\), except that node --test needs `--test-force-exit --test-timeout=120000` \(pytest/)
  assert.doesNotMatch(text, /force-exit and per-test time limit|forceExit|testTimeout/)
  const { testCmdNote } = await import('./tickets.ts')
  assert.match(testCmdNote('npm test'), /^While you work, run only the tests for what you changed\. .*run it once, just before open_pr: .*: npm test$/)
  const from = testCmdNote('npm run t', { key: 'T-01', base: 'origin/main' }) // Bug 147: a repair's command may need what its branch adds
  assert.match(from, /usual one\. It came with T-01, which isn't in origin\/main yet.* merge origin\/main into your branch \(git merge --no-edit origin\/main;.*The command: npm run t$/)
  assert.doesNotMatch(testCmdNote('npm test'), /T-01|git merge/)
})

test('Bug 406: the TPM prompt says HQ tells the engineer of a change of mind itself, so the TPM sends no message of its own on top', () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'roles', 'tpm.prompt.md'), 'utf8')
  const line = text.split('\n').find((l) => l.includes('When the user changes their mind about a ticket'))
  assert.match(line ?? '', /HQ tells the ticket's engineer about the change itself, with what to do: don't send it your own message about the change or ask it to rebase/)
  assert.match(line ?? '', /a question it asked still gets your answer/) // what it must not stop: an engineer waiting on an answer
})
test('Bug 87: no hook URL or command holds the agent\'s token; http hooks send it in a header, and SessionStart reads it from a file', async () => {
  const token = 'tok-Bug87_secret'
  for (const role of ['tpm', 'architect', 'engineer', 'launcher'] as const) {
    const hooks = (buildSettings(role, token, { agentDir: path.join(tmp, "it's here") }) as any).hooks as Record<string, { hooks: any[] }[]>
    const all = Object.values(hooks).flat().flatMap((g) => g.hooks)
    for (const h of all.filter((x) => x.type === 'http')) {
      assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+\/hooks$/, role); assert.deepEqual(h.headers, { 'X-HQ-Token': token }, role)
    }
    const start = hooks.SessionStart![0]!.hooks[0]
    assert.equal(start.type, 'command'); assert.ok(!start.command.includes(token), role)
    assert.ok(start.command.includes(`-H @'${path.join(tmp, "it'\\''s here", 'hook-header')}'`), start.command)
    // the token shows up nowhere but in those headers
    const rest = JSON.stringify({ ...(buildSettings(role, token, { agentDir: tmp }) as any), hooks: undefined }) + JSON.stringify(all.map(({ headers: _, ...h }) => h))
    assert.ok(!rest.includes(token), role)
  }
})

test('Bug 85: every role asks HQ\'s OK through hookwait.mjs, which waits for a backend that\'s down; Claude Code\'s limit is past the wait', () => {
  const { DEFAULTS, HQ_AWAY_WAIT_S } = config
  for (const role of ['tpm', 'engineer', 'architect', 'launcher'] as const) {
    const [gate, other] = (buildSettings(role, 'tok-secret', { agentDir: tmp }) as any).hooks.PermissionRequest.map((g: any) => g.hooks[0])
    for (const h of [gate, other]) {
      assert.equal(h.type, 'command'); assert.match(h.command, /hookwait\.mjs' 'http:\/\/127\.0\.0\.1:\d+\/hooks' /)
      assert.ok(h.command.includes(`'${path.join(tmp, 'token')}'`)); assert.ok(!h.command.includes('tok-secret'), 'the token stays in its file')
    }
    assert.equal(gate.timeout, DEFAULTS.gate_timeout_s + HQ_AWAY_WAIT_S + 15); assert.ok(gate.command.endsWith(`'${DEFAULTS.gate_timeout_s + HQ_AWAY_WAIT_S}'`))
    assert.equal(other.timeout, 30 + HQ_AWAY_WAIT_S + 15)
  }
})

test('Bug 111: no role denies `Cd` (Claude Code 2.1.322 calls that a typo on every start screen); /cd is limited to a folder that can\'t exist', async () => {
  const { STAY_IN_FOLDER, roleFlags } = await import('./roles.ts')
  assert.match(STAY_IN_FOLDER, /^Cd\(\/\/dev\/null\/[a-z-]+\)$/) // an absolute path under /dev/null, where no folder can be, and no wildcard
  const cd = (rules: unknown) => ((rules ?? []) as string[]).filter((r) => /^Cd\b/.test(r))
  for (const role of ['tpm', 'architect', 'engineer', 'launcher'] as const) {
    const p = (buildSettings(role, 'tok', { agentDir: tmp }) as any).permissions
    assert.deepEqual(cd(p.allow), [STAY_IN_FOLDER], role) // the only one: a second allow rule for Cd would open a folder to move to
    assert.deepEqual([...cd(p.deny), ...cd(p.ask)], [], role)
    assert.ok(!roleFlags(role, { worktreeName: 'w', model: 'm' }).includes('Cd'), role) // `--disallowedTools Cd` gets the same warning
  }
  // What the change must leave alone: engineers reach HQ's tools unasked and keep their deny list; they and the helper have no /cd at all.
  for (const role of ['engineer', 'launcher'] as const) {
    const p = (buildSettings(role, 'tok', { agentDir: tmp }) as any).permissions
    assert.ok(p.allow.includes('mcp__hq__*'), role)
    for (const rule of ['Bash(git push*)', 'Bash(tmux *)', 'Read(.env)', 'Edit(.git/**)']) assert.ok(p.deny.includes(rule), `${role} ${rule}`)
    assert.ok(roleFlags(role, { worktreeName: 'w', model: 'm' }).includes('--disable-slash-commands'), role)
  }
  assert.equal((buildSettings('tpm', 'tok', { agentDir: tmp }) as any).permissions.deny, undefined)
})

test('Bug 71: engineers and the Launch helper reach crates.io and may read rustup\'s programs and toolchains, and no other part of home', () => {
  const r = path.join(tmp, 'rust'), cargo = path.join(r, 'cargo'), rustup = path.join(r, 'real-rustup')
  fs.mkdirSync(path.join(cargo, 'bin'), { recursive: true }); fs.mkdirSync(rustup); fs.symlinkSync(rustup, path.join(r, 'rustup'))
  const saved = { CARGO_HOME: process.env.CARGO_HOME, RUSTUP_HOME: process.env.RUSTUP_HOME, PATH: process.env.PATH }
  try {
    process.env.CARGO_HOME = cargo; process.env.RUSTUP_HOME = path.join(r, 'rustup'); process.env.PATH = path.join(r, 'none3') // no package tool in home (Bug 413)
    for (const role of ['engineer', 'launcher'] as const) {
      const s = buildSettings(role, 'tok', { agentDir: tmp }) as any
      for (const d of ['index.crates.io', 'static.crates.io']) assert.ok(s.sandbox.network.allowedDomains.includes(d), `${role} ${d}`)
      const reads: string[] = s.sandbox.filesystem.allowRead // ~/.cargo/bin only, not ~/.cargo (credentials); a linked folder by both spellings
      const both = (p: string) => [p, fs.realpathSync(p)]
      assert.deepEqual(reads.sort(), [...new Set([...both(path.join(cargo, 'bin')), ...both(path.join(r, 'rustup'))])].sort(), role)
      assert.ok(reads.includes(path.join(r, 'rustup')) && reads.includes(fs.realpathSync(rustup)), role)
      assert.ok(!reads.includes(os.homedir()) && !reads.includes(cargo), role)
    }
    process.env.CARGO_HOME = path.join(r, 'none'); process.env.RUSTUP_HOME = path.join(r, 'none2') // no rustup on this machine: nothing to read
    assert.deepEqual((buildSettings('engineer', 'tok', { agentDir: tmp }) as any).sandbox.filesystem.allowRead, [])
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

test('Bug 413: a package tool HQ finds in home is readable in an engineer\'s sandbox with its own folder, and nothing else of home', () => {
  const h = path.join(tmp, 'b413home'), sys = path.join(tmp, 'b413sys', 'bin')
  const prog = (p: string, text = '#!/bin/sh\n') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); fs.chmodSync(p, 0o755); return p }
  const link = (to: string, at: string) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(to, at); return at }
  const H = (...p: string[]) => path.join(h, ...p)
  prog(H('.local/bin/uv')); prog(H('.local/bin/uvx')); prog(H('.local/bin/claude')) // uv's installer: lone programs in a shared folder; claude isn't a package tool
  // Poetry's installer: a venv in its config folder (which holds auth.toml), made from a Python uv installed in home (a linked folder)
  const pypoetry = H('Library/Application Support/pypoetry'), py = H('.local/share/uv/python/cpython-3.12.14')
  prog(path.join(py, 'bin/python3.12')); link(py, H('.local/share/uv/python/cpython-3.12'))
  fs.mkdirSync(path.join(pypoetry, 'venv'), { recursive: true }); fs.writeFileSync(path.join(pypoetry, 'auth.toml'), '')
  fs.writeFileSync(path.join(pypoetry, 'venv/pyvenv.cfg'), `home = ${H('.local/share/uv/python/cpython-3.12/bin')}\nversion_info = 3.12.14\n`)
  link(prog(path.join(pypoetry, 'venv/bin/poetry')), H('.local/bin/poetry'))
  // npm's global folder (pnpm, a package with a bin/ folder of its own), and nvm's node with Corepack's yarn shim
  link(prog(H('.npm-global/lib/node_modules/pnpm/bin/pnpm.cjs')), H('.npm-global/bin/pnpm'))
  const nvm = H('.nvm/versions/node/v22.1.0')
  prog(path.join(nvm, 'bin/node')); link(prog(path.join(nvm, 'lib/node_modules/corepack/dist/yarn.js')), path.join(nvm, 'bin/yarn'))
  prog(H('.pyenv/shims/python3')) // a version manager's shim runs the manager: its whole folder
  prog(H('bin/deno')) // a folder whose parent is home itself: the program alone
  prog(H('.cargo/bin/bun')); fs.writeFileSync(H('.cargo/credentials.toml'), '') // a folder holding credentials is never opened
  prog(H('.local/bin/pip'), ''); fs.chmodSync(H('.local/bin/pip'), 0o644) // not a program: skipped
  prog(path.join(sys, 'npm')); prog(H('.local/bin/npm')) // first on PATH wins, and that one isn't in home
  prog(path.join(sys, 'go')) // outside home: readable already
  const PATH = [sys, H('.local/bin'), H('.npm-global/bin'), path.join(nvm, 'bin'), H('.pyenv/shims'), H('bin'), H('.cargo/bin')].join(path.delimiter)
  const homes = [h, fs.realpathSync(h)] // a Mac's temp folder is a link: each place comes by both spellings
  const rel = (p: string) => path.relative(homes.find((x) => p.startsWith(x + path.sep))!, p)
  const got = toolReads(PATH, h)
  for (const p of got) assert.ok(got.includes(path.join(fs.realpathSync(path.dirname(p)), path.basename(p))), `${p} by its real path too`)
  const reads = [...new Set(got.map(rel))].sort()
  assert.deepEqual(reads, [
    '.cargo/bin/bun', '.local/bin/poetry', '.local/bin/uv', '.local/bin/uvx',
    '.local/share/uv/python/cpython-3.12', '.local/share/uv/python/cpython-3.12.14',
    '.npm-global/bin/pnpm', '.npm-global/lib/node_modules/pnpm', '.nvm/versions/node/v22.1.0', '.pyenv',
    'Library/Application Support/pypoetry/venv', 'bin/deno',
  ].sort())
  // What it must not open: home, a folder many programs share, Poetry's config folder (auth.toml), ~/.cargo (credentials)
  for (const no of ['', '.local', '.local/bin', '.local/share', 'Library/Application Support/pypoetry', '.cargo', '.cargo/bin', 'bin', '.local/bin/claude', '.local/bin/npm']) {
    assert.ok(!reads.includes(no), no)
  }
  assert.deepEqual(toolReads(sys, h), []) // nothing in home on PATH: nothing to read
  assert.deepEqual(toolReads('', h), [])
  // The settings use HQ's own PATH (this machine's: uv in ~/.local/bin on a Mac with it, nothing on CI): an engineer's and the Launch helper's
  // sandbox read these, with rustup's (Bug 71); Corepack keeps its downloads with the other caches and fetches Yarn 2+ from npm's registry
  const saved = { COREPACK_NPM_REGISTRY: process.env.COREPACK_NPM_REGISTRY }
  try {
    delete process.env.COREPACK_NPM_REGISTRY
    for (const role of ['engineer', 'launcher'] as const) {
      const s = buildSettings(role, 'tok', { agentDir: tmp }) as any
      assert.deepEqual(s.sandbox.filesystem.allowRead, [...new Set([...rustReads(), ...toolReads()])], role)
      assert.equal(s.env.COREPACK_HOME, path.join(ENGINEER_CACHE, 'corepack')); assert.equal(s.env.COREPACK_NPM_REGISTRY, 'https://registry.npmjs.org')
    }
    process.env.COREPACK_NPM_REGISTRY = 'https://npm.example.test' // the user's own mirror is kept
    assert.equal((buildSettings('engineer', 'tok', { agentDir: tmp }) as any).env.COREPACK_NPM_REGISTRY, 'https://npm.example.test')
    assert.equal((buildSettings('tpm', 'tok', { agentDir: tmp }) as any).sandbox, undefined)
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

test('Bug 415: engineers and the Launch helper reach Go\'s module mirror and checksum database; the test setup helper still reaches nothing', () => {
  for (const role of ['engineer', 'launcher'] as const) {
    const d: string[] = (buildSettings(role, 'tok', { agentDir: tmp }) as any).sandbox.network.allowedDomains
    for (const h of ['proxy.golang.org', 'sum.golang.org']) assert.ok(d.includes(h), `${role} ${h}`)
    assert.ok(!d.some((x) => x.includes('github') || x.includes('googleapis')), d.join(' ')) // the mirror serves the zips itself
  }
  assert.ok(!(buildSettings('launcher', 'tok', { agentDir: tmp, localOnly: true }) as any).sandbox.network.allowedDomains.includes('proxy.golang.org'))
})

test('Bugs 412, 415: the Mac\'s certificate checker stays shut to agents unless the user turns sandbox_system_certs on, and only on a Mac', async () => {
  const { setSetting } = await import('./db.ts'), { REGISTRY_WORDS } = await import('./roles.ts')
  assert.equal(REGISTRY_WORDS, "npm, PyPI, crates.io and Go's module mirror") // downloads.ts's, said by roles.ts too
  const weaker = (o: { localOnly?: boolean } = {}) => (buildSettings('engineer', 'tok', { agentDir: tmp, ...o }) as any).sandbox.enableWeakerNetworkIsolation
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const on = (p: string) => Object.defineProperty(process, 'platform', { value: p })
  try {
    on('darwin'); assert.equal(weaker(), undefined, 'off by default')
    assert.equal(config.validSetting('sandbox_system_certs', 'on'), null); assert.match(String(config.validSetting('sandbox_system_certs', true)), /must be one of off, on/)
    setSetting('sandbox_system_certs', 'on'); assert.equal(weaker(), true)
    assert.equal(weaker({ localOnly: true }), undefined, 'the test setup helper downloads nothing')
    assert.equal((buildSettings('tpm', 'tok', { agentDir: tmp }) as any).sandbox, undefined)
    on('linux'); assert.equal(weaker(), undefined, 'Linux has no such checker')
  } finally { Object.defineProperty(process, 'platform', platform); setSetting('sandbox_system_certs', 'off') }
})

test('Bug 412: the engineer prompt makes Python environments with uv, not pip, and says which hosts downloads come from', () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'roles', 'engineer.prompt.md'), 'utf8')
  assert.doesNotMatch(text, /python3 -m venv \.venv` plus pip/)
  assert.match(text, /`uv venv`, then `uv pip install -r requirements\.txt`/)
  assert.match(text, /Don't install with pip itself: on a Mac it usually can't download in your sandbox/)
  assert.match(text, /`which uv` or `ls ~\/\.local\/bin` can say uv isn't there when it runs fine: check with `uv --version`/) // a real engineer read "not found" as no uv
  assert.match(text, /packages come from npm, PyPI, crates\.io and Go's module mirror; other hosts are blocked/)
  // Bug 424: with no uv, a pip that works in the sandbox (real 2.1.322: plain pip "OSStatus -26276", legacy-certs installs), and only after that error (pip 21 refuses the option)
  assert.match(text, /Only when `uv --version` fails too: `python3 -m venv \.venv`, then `\.venv\/bin\/pip install -r requirements\.txt`/)
  assert.match(text, /if pip gives that certificate error, the same pip install again with `--use-deprecated=legacy-certs`/)
})

test('Bug 423: an agent\'s sandbox may read the main checkout\'s config files that pytest and uv look for above the worktree, and nothing else there', () => {
  const real = path.join(tmp, 'b423real'), repo = path.join(tmp, 'b423repo') // reached through a link, as a Mac's temp folder is
  fs.mkdirSync(path.join(real, '.claude', 'worktrees', 'eng-1'), { recursive: true }); fs.symlinkSync(real, repo)
  for (const f of ['pyproject.toml', 'setup.cfg', '.env', 'test_a.py', 'app.py', '.claude/worktrees/pytest.ini', '.claude/settings.json']) fs.writeFileSync(path.join(real, f), '')
  fs.writeFileSync(path.join(tmp, 'b423elsewhere'), ''); fs.symlinkSync(path.join(tmp, 'b423elsewhere'), path.join(real, 'tox.ini')) // a link could lead anywhere
  fs.mkdirSync(path.join(real, 'setup.py')) // not a file
  const both = (f: string) => [path.join(repo, f), path.join(fs.realpathSync(real), f)]
  const want = [...new Set(['pyproject.toml', 'setup.cfg', '.claude/worktrees/pytest.ini'].flatMap(both))].sort()
  assert.deepEqual(checkoutReads(repo).sort(), want)
  for (const role of ['engineer', 'launcher'] as const) {
    const reads: string[] = (buildSettings(role, 'tok', { agentDir: tmp, repoPath: repo }) as any).sandbox.filesystem.allowRead
    for (const p of want) assert.ok(reads.includes(p), `${role} ${p}`)
    for (const no of ['', '.env', 'test_a.py', 'app.py', 'tox.ini', 'setup.py', '.claude', '.claude/settings.json', '.claude/worktrees']) { // must not open
      assert.ok(!reads.some((r) => r === path.join(repo, no) || r === path.join(fs.realpathSync(real), no)), `${role} ${no || 'the checkout'}`)
    }
    assert.deepEqual((buildSettings(role, 'tok', { agentDir: tmp }) as any).sandbox.filesystem.allowRead, [...new Set([...rustReads(), ...toolReads()])], role)
  }
  assert.deepEqual(checkoutReads(path.join(tmp, 'b423none')), []) // no such folder: nothing
  assert.equal((buildSettings('tpm', 'tok', { agentDir: tmp, repoPath: repo }) as any).sandbox, undefined)
})

test('Bug 455: engineers and the Launch helper keep Yarn\'s, pnpm\'s and Bun\'s downloads in the shared cache; npm\'s name for the pnpm store only in a pnpm project', () => {
  const mk = (name: string, files: Record<string, string>) => {
    const dir = path.join(tmp, name)
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
    return dir
  }
  const pnpmOnes = [mk('b455lock', { 'pnpm-lock.yaml': '' }), mk('b455ws', { 'pnpm-workspace.yaml': 'packages:\n  - web\n' }),
    mk('b455pin', { 'package.json': '{"packageManager":"pnpm@10.34.9"}' }), mk('b455part', { 'package.json': '{}', 'web/pnpm-lock.yaml': '' }),
    mk('b455partpin', { 'web/package.json': '{"packageManager":"pnpm@12.23.0"}' })]
  const others = [mk('b455npm', { 'package.json': '{"packageManager":"npm@11.7.0"}', 'package-lock.json': '{}', 'web/package-lock.json': '{}' }),
    mk('b455yarn', { 'package.json': '{"packageManager":"yarn@4.19.0"}', 'yarn.lock': '' }), mk('b455deep', { 'a/b/pnpm-lock.yaml': '' }),
    mk('b455dep', { 'package.json': '{}', 'node_modules/x/pnpm-lock.yaml': '', 'node_modules/x/package.json': '{"packageManager":"pnpm@9.0.0"}' }),
    mk('b455hidden', { '.cache/pnpm-lock.yaml': '' }), mk('b455broken', { 'package.json': '{ not json' }), path.join(tmp, 'b455none')]
  for (const d of pnpmOnes) assert.equal(usesPnpm(d), true, d)
  for (const d of others) assert.equal(usesPnpm(d), false, d)
  assert.equal(usesPnpm(undefined), false)
  const store = path.join(ENGINEER_CACHE, 'pnpm-store')
  for (const role of ['engineer', 'launcher'] as const) {
    for (const repoPath of [...pnpmOnes, ...others, undefined]) {
      const env = (buildSettings(role, 'tok', { agentDir: tmp, repoPath }) as any).env
      assert.equal(env.YARN_CACHE_FOLDER, path.join(ENGINEER_CACHE, 'yarn')); assert.equal(env.YARN_GLOBAL_FOLDER, path.join(ENGINEER_CACHE, 'yarn-berry'))
      assert.equal(env.BUN_INSTALL_CACHE_DIR, path.join(ENGINEER_CACHE, 'bun')); assert.equal(env.pnpm_config_store_dir, store) // pnpm 11 and 12
      assert.equal(env.npm_config_store_dir, repoPath && pnpmOnes.includes(repoPath) ? store : undefined, `${role} ${repoPath}`) // pnpm 10 and older
      assert.equal(env.npm_config_cache, path.join(ENGINEER_CACHE, 'npm')) // the rest stays
    }
  }
  assert.equal((buildSettings('tpm', 'tok', { agentDir: tmp, repoPath: pnpmOnes[0] }) as any).env, undefined)
  // pnpm 12's lock folders, by the fixed names it uses in /tmp (real path), and nothing else of /tmp
  const t = fs.realpathSync('/tmp'), uid = process.getuid!()
  assert.deepEqual(pnpmLockDirs(), [`pnpm-store-operation-locks-${uid}`, `pnpm-dir-locks-${uid}`, `pnpm-verify-deps-install-locks-${uid}`].map((n) => path.join(t, n)))
  for (const role of ['engineer', 'launcher'] as const) {
    const w: string[] = (buildSettings(role, 'tok', { agentDir: tmp }) as any).sandbox.filesystem.allowWrite
    for (const d of pnpmLockDirs()) assert.ok(w.includes(d), `${role} ${d}`)
    assert.ok(!w.includes(t) && !w.includes('/tmp'), role)
  }
})
