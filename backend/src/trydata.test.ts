// Try it's data copy (Bug 22) against a throwaway repo: main's ignored data replaces the worktree's; packages, HQ's folders and
// build output stay put; tracked files are never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { copyMainData } from './trydata.ts'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
const put = (p: string, text: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }

test('copyMainData: main\'s data/ and .env replace the worktree\'s; the worktree\'s packages and main\'s build output are left alone', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-try-')))
  sh(dir, 'init', '-q', '-b', 'main'); put(path.join(dir, '.gitignore'), 'node_modules/\ndata/\ndist/\n.env\nlogs/*.log\n'); put(path.join(dir, 'app.js'), 'main')
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base')
  const wt = path.join(dir, '.claude', 'worktrees', 'T1'); sh(dir, 'worktree', 'add', '-q', '-b', 'hq/f/T1', wt)
  put(path.join(dir, 'data', 'stock.json'), '["apples","pears"]'); put(path.join(dir, '.env'), 'X=1'); put(path.join(dir, 'node_modules', 'p.js'), 'main pkg')
  put(path.join(dir, 'dist', 'app.js'), 'built from main'); put(path.join(dir, 'logs', 'a.log'), 'nested')
  put(path.join(wt, 'data', 'stock.json'), '["test item"]'); put(path.join(wt, 'data', 'old.json'), 'engineer only'); put(path.join(wt, 'node_modules', 'p.js'), 'wt pkg')
  put(path.join(wt, 'app.js'), 'ticket')
  assert.deepEqual((await copyMainData(dir, wt)).sort(), ['.env', 'data', 'logs']) // logs/ holds only ignored files: git lists it whole
  assert.equal(fs.readFileSync(path.join(wt, 'data', 'stock.json'), 'utf8'), '["apples","pears"]')
  assert.ok(!fs.existsSync(path.join(wt, 'data', 'old.json')), "the worktree's own data is replaced, not merged")
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'X=1')
  assert.equal(fs.readFileSync(path.join(wt, 'node_modules', 'p.js'), 'utf8'), 'wt pkg', 'its own packages are kept')
  fs.rmSync(path.join(wt, 'node_modules'), { recursive: true }); assert.deepEqual((await copyMainData(dir, wt)).sort(), ['.env', 'data', 'logs', 'node_modules'])
  assert.equal(fs.readFileSync(path.join(wt, 'node_modules', 'p.js'), 'utf8'), 'main pkg', 'none: main\'s are copied, so the preview needs no install')
  assert.ok(!fs.existsSync(path.join(wt, 'dist')), 'build output belongs to the code it was built from')
  assert.equal(fs.readFileSync(path.join(wt, 'app.js'), 'utf8'), 'ticket')
  put(path.join(wt, 'data', 'stock.json'), '["changed while trying"]')
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'stock.json'), 'utf8'), '["apples","pears"]', "main's copy never changes")
})

test('copyMainData: the recipe\'s deeper files (an app in subfolders, Bug 38) come too, only when git ignores them', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-try-')))
  sh(dir, 'init', '-q', '-b', 'main'); put(path.join(dir, '.gitignore'), 'backend/.env\nbackend/*.db\nfrontend/node_modules/\n')
  put(path.join(dir, 'backend', 'app.py'), 'main'); put(path.join(dir, 'backend', 'config.toml'), 'tracked'); put(path.join(dir, 'frontend', 'index.html'), 'x')
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base')
  const wt = path.join(dir, '.claude', 'worktrees', 'T1'); sh(dir, 'worktree', 'add', '-q', '-b', 'hq/f/T1', wt)
  put(path.join(dir, 'backend', '.env'), 'KEY=secret'); put(path.join(dir, 'backend', 'chats.db'), 'my chats')
  put(path.join(dir, 'backend', 'config.toml'), 'edited in main'); put(path.join(wt, 'backend', 'chats.db'), 'test chats')
  const got = await copyMainData(dir, wt, ['backend/.env', 'backend/chats.db', 'backend/config.toml', 'backend/missing.db'])
  assert.deepEqual(got.sort(), ['backend/.env', 'backend/chats.db'])
  assert.equal(fs.readFileSync(path.join(wt, 'backend', '.env'), 'utf8'), 'KEY=secret')
  assert.equal(fs.readFileSync(path.join(wt, 'backend', 'chats.db'), 'utf8'), 'my chats')
  assert.equal(fs.readFileSync(path.join(wt, 'backend', 'config.toml'), 'utf8'), 'tracked') // tracked: never copied over
  assert.equal(sh(wt, 'status', '--porcelain'), '')
})
