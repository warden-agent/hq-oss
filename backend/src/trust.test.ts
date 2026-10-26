// Trust pre-acceptance against a temp HOME: no write when Claude Code already trusts the folder (itself, or a plain folder
// under a trusted one), a write under Claude Code's own lock otherwise that keeps every other key, and a held lock is waited
// for, a stale one taken over.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-trust-')))
process.env.HQ_HOME = path.join(root, 'hq'); process.env.HOME = path.join(root, 'home'); fs.mkdirSync(process.env.HOME)
const { migrate } = await import('./db.ts'); migrate()
const { ensureTrusted, withConfigLock } = await import('./trust.ts')

const CFG = path.join(root, 'home', '.claude.json'), LOCK = CFG + '.lock'
const dir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d }
const write = (projects: Record<string, unknown>) => fs.writeFileSync(CFG, JSON.stringify({ userID: 'u', oauthAccount: { a: 1 }, projects }), { mode: 0o600 })
const read = () => JSON.parse(fs.readFileSync(CFG, 'utf8'))
const mtime = () => fs.statSync(CFG).mtimeMs

test('already trusted (itself, or a plain folder under a trusted one): nothing is written', async () => {
  const ws = dir('ws'), tpm = dir('ws', 'feat-1', 'tpm') // two levels down, like a TPM workspace (checked on 2.1.300)
  write({ [ws]: { hasTrustDialogAccepted: true } }); fs.utimesSync(CFG, 1000, 1000)
  await ensureTrusted(ws); await ensureTrusted(tpm)
  assert.equal(mtime(), 1000 * 1000)
  assert.equal(fs.existsSync(path.join(root, 'home', '.claude', 'backups')), false)
})

test('a git repo under a trusted folder still gets its own entry, written under the lock, keeping every other key', async () => {
  const ws = dir('ws'), repo = dir('ws', 'repo'); dir('ws', 'repo', '.git')
  write({ [ws]: { hasTrustDialogAccepted: true }, '/other': { allowedTools: ['x'] } })
  await ensureTrusted(repo)
  const cfg = read()
  assert.equal(cfg.projects[repo].hasTrustDialogAccepted, true)
  assert.deepEqual(cfg.projects['/other'], { allowedTools: ['x'] }); assert.equal(cfg.userID, 'u'); assert.deepEqual(cfg.oauthAccount, { a: 1 })
  assert.equal(fs.statSync(CFG).mode & 0o777, 0o600) // the file keeps its permissions
  assert.equal(fs.existsSync(LOCK), false) // released
  assert.equal(fs.readdirSync(path.join(root, 'home', '.claude', 'backups')).length, 1)
  await ensureTrusted(dir('elsewhere')) // a second write the same day doesn't add a second backup
  assert.equal(fs.readdirSync(path.join(root, 'home', '.claude', 'backups')).length, 1)
})

test('a live lock is waited for (without blocking) and then refused; a stale one (a crashed holder) is taken over', async () => {
  write({}); fs.mkdirSync(LOCK)
  const t = Date.now()
  let ticks = 0; const timer = setInterval(() => ticks++, 20) // the event loop keeps running while it waits
  await assert.rejects(withConfigLock(() => 1, 300), /locked by another Claude Code process/)
  clearInterval(timer); assert.ok(Date.now() - t >= 300); assert.ok(ticks >= 5, `event loop ran ${ticks} times`)
  await assert.rejects(ensureTrusted(dir('blocked'), 200), /locked/) // and a launch into it fails instead of waiting at a dialog
  fs.utimesSync(LOCK, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000))
  await ensureTrusted(dir('blocked'))
  assert.equal(read().projects[path.join(root, 'blocked')].hasTrustDialogAccepted, true); assert.equal(fs.existsSync(LOCK), false)
})

test('an unreadable ~/.claude.json fails the launch rather than starting into the trust dialog', async () => {
  fs.writeFileSync(CFG, '{ not json')
  await assert.rejects(ensureTrusted(dir('broken')), /can't read ~\/.claude.json/)
})
