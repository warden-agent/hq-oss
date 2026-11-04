// Engineer settings: PyPI is reachable, every package cache (npm, Go, uv, pip) sits in a writable folder outside home, and uv
// never downloads a Python (that needs github.com, which stays blocked). Other roles get no sandbox.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-roles-'))
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
  for (const k of ['GOCACHE', 'GOMODCACHE', 'GOPATH']) assert.ok(String(s.env[k]).startsWith(ENGINEER_CACHE), k)
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
