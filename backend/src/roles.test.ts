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
const { buildSettings } = await import('./roles.ts')
const { ENGINEER_CACHE } = await import('./config.ts')

test('engineers\' package caches (npm, Go, Python) sit outside home; PyPI is reachable, github.com stays blocked', () => {
  const s = buildSettings('engineer', 'tok', { agentDir: tmp }) as any
  const domains: string[] = s.sandbox.network.allowedDomains
  for (const d of ['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org']) assert.ok(domains.includes(d), d)
  assert.ok(!domains.some((d) => d.includes('github')))
  assert.equal(ENGINEER_CACHE, fs.realpathSync(path.join(tmp, 'cache')))
  assert.deepEqual(s.sandbox.filesystem.allowWrite, [ENGINEER_CACHE])
  assert.equal(s.env.UV_CACHE_DIR, path.join(ENGINEER_CACHE, 'uv')); assert.equal(s.env.PIP_CACHE_DIR, path.join(ENGINEER_CACHE, 'pip'))
  assert.equal(s.env.UV_PYTHON_INSTALL_DIR, path.join(ENGINEER_CACHE, 'python')); assert.equal(s.env.UV_PYTHON_DOWNLOADS, 'never')
  assert.equal(s.env.npm_config_cache, path.join(ENGINEER_CACHE, 'npm')) // npm writes its _logs there too, not under ~/.npm
  for (const k of ['GOCACHE', 'GOMODCACHE', 'GOPATH', 'CARGO_HOME']) assert.ok(String(s.env[k]).startsWith(ENGINEER_CACHE), k)
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

test('Bug 76: a Bash command\'s hook can be held until its turn, so it outlasts that wait; other tools\' hooks, and the TPM\'s, stay short', async () => {
  const { TURN_WAIT_S } = await import('./config.ts')
  for (const role of ['engineer', 'launcher'] as const) {
    const pre = (buildSettings(role, 'tok', { agentDir: tmp }) as any).hooks.PreToolUse
    assert.deepEqual(pre.map((g: any) => [g.matcher, g.hooks[0].timeout]), [['Bash', TURN_WAIT_S + 60], ['^(?!Bash$).*', 10]], role)
    assert.ok(new RegExp(pre[1].matcher).test('Read') && !new RegExp(pre[1].matcher).test('Bash')); assert.match(pre[0].hooks[0].url, /\/hooks\/tok$/)
  }
  const tpm = (buildSettings('tpm', 'tok', { agentDir: tmp }) as any).hooks.PreToolUse
  assert.equal(tpm.length, 1); assert.equal(tpm[0].matcher, undefined); assert.equal(tpm[0].hooks[0].timeout, 10)
})

test("Bug 96: the engineer prompt says what a Bash timeout really does, and never tells engineers to lean on it for a long suite", async () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'roles', 'engineer.prompt.md'), 'utf8') // what ensureAssets copies to ~/.hq/roles
  assert.doesNotMatch(text, /Give a long suite a time limit with the Bash tool's own `timeout`/)
  assert.match(text, /`timeout` setting doesn't stop a command: when it runs out, the command moves to the background and keeps going/)
  assert.match(text, /run only the test files for what you changed, with the test runner's own force-exit and per-test time limit/)
  assert.match(text, /never end your turn to wait on a run that is still going/)
  const { testCmdNote } = await import('./tickets.ts')
  assert.match(testCmdNote('npm test'), /^While you work, run only the tests for what you changed\. .*run it once, just before open_pr: .*: npm test$/)
})
