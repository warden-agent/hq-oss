// Live preview rules: which command, when to install, which port, where the app answers, whether HQ may frame it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectCommand, frameBlocked, installStep, pickPort, printedPorts, runScript } from './apprun.ts'

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

test('run script: header, optional install, then the command as written', () => {
  const s = runScript({ repoPath: "/tmp/it's here", command: 'npm start', port: 3090, install: 'npm ci', label: 'main@9d059d7' })
  assert.match(s, /^#!\/bin\/bash\ncd '\/tmp\/it'\\''s here' \|\| exit 1\nexport PORT=3090 BROWSER=none\n/)
  assert.match(s, /npm ci \|\| exit 1\nnpm start\n$/)
  assert.doesNotMatch(runScript({ repoPath: '/r', command: 'npm run dev', port: 3091, install: null, label: 'main@x' }), /Installing/)
})

test('printed ports: loopback URLs only, colours stripped, each once', () => {
  assert.deepEqual(printedPorts('  VITE ready\n  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: http://192.168.1.4:5173/'), [5173])
  assert.deepEqual(printedPorts('Pantry listening on http://localhost:3090\napi at http://127.0.0.1:4000/api and http://localhost:3090/'), [3090, 4000])
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

test('port: the saved one if free, else the first free from 3090; null when all are taken', async () => {
  const busy = (taken: number[]) => async (p: number) => taken.includes(p)
  assert.equal(await pickPort(null, busy([])), 3090)
  assert.equal(await pickPort(null, busy([3090])), 3091)
  assert.equal(await pickPort(3094, busy([3090])), 3094)
  assert.equal(await pickPort(3094, busy([3094])), 3090)
  assert.equal(await pickPort(8080, busy([])), 3090) // outside the preview range: not reused
  assert.equal(await pickPort(null, busy(Array.from({ length: 10 }, (_, i) => 3090 + i))), null)
})
