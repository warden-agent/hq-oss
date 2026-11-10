// node-pty ships its macOS spawn-helper with no execute permission and its install step doesn't set it, so a reinstall broke every
// terminal view with "posix_spawnp failed" (Bug 60). The root package's postinstall sets it, and must never fail an install.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = path.join(import.meta.dirname, '..', '..'), script = path.join(repo, 'scripts', 'fix-pty-helper.mjs')
const run = (root: string) => execFileSync(process.execPath, [script, root], { encoding: 'utf8' })
const helper = (root: string, platform: string) => {
  const f = path.join(root, 'node_modules', 'node-pty', 'prebuilds', platform, 'spawn-helper'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x', { mode: 0o644 }); return f
}
const executable = (f: string) => (fs.statSync(f).mode & 0o111) === 0o111

test('Bug 60: the postinstall makes every macOS helper executable and leaves anything else alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-pty-')), arm = helper(root, 'darwin-arm64'), x64 = helper(root, 'darwin-x64'), other = helper(root, 'win32-x64')
  run(root)
  assert.ok(executable(arm)); assert.ok(executable(x64)); assert.equal(fs.statSync(other).mode & 0o111, 0)
})

test('with no prebuilds at all (Linux compiles node-pty) it does nothing and doesn\'t fail the install', () => {
  assert.doesNotThrow(() => run(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-pty-'))))
})

test('the root package really runs it after an install', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.match(pkg.scripts.postinstall ?? '', /scripts\/fix-pty-helper\.mjs/)
})
