import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkSetup, mergeSetup, type TestSetup } from './testsetupstore.ts'
import type { Recipe } from './apprun.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-setup-')); fs.mkdirSync(path.join(root, 'data')); fs.mkdirSync(path.join(root, 'web'))
const recipe: Recipe = { parts: [{ name: 'api', dir: '.', run: 'node server.js', port: 'auto' }, { name: 'web', dir: 'web', run: 'npx vite --port $PORT', port: 'auto' }],
  show: 'web', worktree_files: [], notes: '' }
const good = { start: [{ part: 'api', run: 'node server.js' }, { part: 'web', build: 'npm run build', run: 'npx vite preview --port $PORT --strictPort' }],
  snapshot: ['data'], seed: 'mkdir -p data && echo [] > data/items.json', endpoints: [{ method: 'GET', path: '/api/items', kind: 'instant' }, { method: 'POST', path: '/api/import', kind: 'heavy' }] }
const err = (o: unknown) => { const r = checkSetup(o, recipe, root); return 'error' in r ? r.error : null }

test('a setup covering every part with production starts passes', () => {
  assert.equal(err(good), null)
  assert.equal(err({ ...good, snapshot: ['app.db'] }), null) // a file at the root
  assert.equal(err({ ...good, start: [good.start[0], { part: 'web', run: 'node web/dist/server.js' }] }), null)
})
test('dev servers are refused, but not their build or preview commands', () => {
  for (const run of ['npx vite --port $PORT', 'npm run dev', 'next dev -p $PORT', 'nodemon server.js', 'uvicorn app:app --reload', 'python manage.py runserver $PORT']) {
    assert.match(err({ ...good, start: [good.start[0], { part: 'web', run }] }) ?? '', /dev server/, run)
  }
  for (const run of ['npx vite preview --port $PORT', 'next start -p $PORT', 'node server.js --dev-mode-off', 'npx serve -s dist -l $PORT']) {
    assert.equal(err({ ...good, start: [good.start[0], { part: 'web', build: 'npx vite build', run }] }), null, run)
  }
})
test('every part of the start steps needs a start, once, and only those parts', () => {
  assert.match(err({ ...good, start: [good.start[0]] }) ?? '', /built web part runs/)
  assert.match(err({ ...good, start: [...good.start, { part: 'worker', run: 'x' }] }) ?? '', /"worker" isn't a part/)
  assert.match(err({ ...good, start: [...good.start, good.start[0]] }) ?? '', /one entry per part/)
})
test('snapshot paths a reset would wreck are refused', () => {
  for (const p of ['.', '.git', 'node_modules', '.claude/x', '.hq-scenario']) assert.match(err({ ...good, snapshot: [p] }) ?? '', /isn't the app's data/, p)
  assert.match(err({ ...good, snapshot: ['../elsewhere'] }) ?? '', /inside the repo/)
  assert.match(err({ ...good, snapshot: ['nowhere/data.json'] }) ?? '', /doesn't exist/)
  assert.equal(err({ ...good, snapshot: ['data/', 'web/local.db'] }), null) // not caught: real data paths, a trailing slash
})
test('endpoint labels: known methods and kinds, a path, no repeats', () => {
  assert.match(err({ ...good, endpoints: [{ method: 'GET', path: 'api/x', kind: 'instant' }] }) ?? '', /starts with \//)
  assert.match(err({ ...good, endpoints: [{ method: 'GET', path: '/x', kind: 'quick' }] }) ?? '', /kind/)
  assert.match(err({ ...good, endpoints: [good.endpoints[0], good.endpoints[0]] }) ?? '', /listed twice/)
  assert.equal(err({ ...good, endpoints: undefined }), null) // none labelled yet: slow then only compares calls with their own
})
test('an engineer\'s change replaces only the fields it gives', () => {
  const base = { ...good, notes: '' } as unknown as TestSetup
  const next = mergeSetup(base, { endpoints: [{ method: 'DELETE', path: '/api/items/:id', kind: 'instant' }] })
  assert.deepEqual(next.start, base.start); assert.deepEqual(next.endpoints.map((e) => e.method), ['DELETE'])
  assert.deepEqual(mergeSetup(base, { seed: undefined }).seed, base.seed)
})
