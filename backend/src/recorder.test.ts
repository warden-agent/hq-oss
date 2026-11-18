// The recorder over plain HTTP (no browser, no sandbox): seed, proxy, streams, settle, snapshots, reset behind the same address, and nothing left running.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error plain JS module, no types
import { startRecording } from './recorder.mjs'

/** A tiny app: reads data/items.json once, at start; POST adds one; GET /events is a Server-Sent Events stream; GET /slow waits. */
const APP = `const http=require('http'),fs=require('fs');let items=JSON.parse(fs.readFileSync('data/items.json','utf8'));
console.log('app up, '+items.length+' items');
http.createServer((q,r)=>{
 if(q.url==='/events'){r.writeHead(200,{'content-type':'text/event-stream'});r.write('retry: 1000\\n\\n');return}
 if(q.url==='/slow'){return setTimeout(()=>r.end('ok'),150)}
 if(q.method==='POST'){let b='';q.on('data',c=>b+=c);q.on('end',()=>{items.push(JSON.parse(b));fs.writeFileSync('data/items.json',JSON.stringify(items));
  r.writeHead(201,{'content-type':'application/json'});r.end(b)});return}
 if(q.url==='/boom'){console.error('Error: boom');r.writeHead(500);return r.end()}
 r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify(items))
}).listen(process.env.PORT,'127.0.0.1')`
function project(): { root: string; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-rec-')); fs.writeFileSync(path.join(root, 'server.js'), APP)
  fs.mkdirSync(path.join(root, 'data')); fs.writeFileSync(path.join(root, 'data', 'items.json'), JSON.stringify([{ id: 'u1', name: 'the user\'s own' }]))
  return { root, out: path.join(root, '.hq-scenario') }
}
const seed = `mkdir -p data && printf '[{"id":"s1","name":"rice"}]' > data/items.json`
const spec = (root: string, out: string, run = 'node server.js') =>
  ({ parts: [{ name: 'app', cwd: root, run: `bash -c ${JSON.stringify(run)}`, port: 'auto' }], show: 'app', startMs: 20_000, root, out, snapshot: ['data'], seed })
const jsonl = (f: string) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
/** The app's processes, by the tag each test gives its command line. */
const running = (tag: string) => (spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout ?? '').split('\n').filter((l) => l.includes(tag) && !l.includes('ps -axo'))

test('recorder: seed, proxy, stream, settle, snapshots, reset, stop', async () => {
  const { root, out } = project()
  const tag = `hq-rec-test-${process.pid}-${Date.now()}`
  const { rec } = await startRecording(spec(root, out, `node server.js ${tag}`))
  assert.equal(running(tag).filter((l) => l.startsWith('node')).length, 1, 'the app runs under a shell, as `npm start` would')
  assert.ok(rec, 'it started')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'items.json'), 'utf8')), [{ id: 's1', name: 'rice' }], 'the seed, never the user\'s data')
  const events = await fetch(`${rec.url}/events`) // a stream stays open the whole time: settling never waits for it
  const post = (name: string) => fetch(`${rec.url}/add`, { method: 'POST', body: JSON.stringify({ id: name, name }) }).then((r) => r.text())
  const t0 = Date.now()
  await rec.action('add Dune twice', async () => { await post('Dune'); await post('Dune') })
  assert.ok(Date.now() - t0 < 5000, 'settled with the stream still open')
  await rec.action('slow and broken', async () => { void fetch(`${rec.url}/slow`); await fetch(`${rec.url}/boom`) }) // settle waits for the slow one
  const apiRows = jsonl(path.join(out, 'api.jsonl'))
  const slow = apiRows.find((r) => r.path === '/slow'), snaps = jsonl(path.join(out, 'snaps.jsonl'))
  assert.ok(slow && slow.end <= snaps.at(-1).at, 'the snapshot came after the slow call ended')
  assert.deepEqual(apiRows.filter((r) => r.method === 'POST').map((r) => [r.status, r.action]), [[201, 1], [201, 1]])
  assert.equal(apiRows.filter((r) => r.method === 'POST')[0].body, apiRows.filter((r) => r.method === 'POST')[1].body, 'the same body, the same hash')
  assert.equal(apiRows.find((r) => r.path === '/boom').status, 500)
  assert.deepEqual(snaps.map((s) => [s.label, s.changed]), [['start', true], ['add Dune twice', true], ['slow and broken', false]])
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'snapshots', '0001', 'data', 'items.json'), 'utf8')).length, 3)
  const url = rec.url
  await rec.reset()
  assert.equal(rec.url, url, 'the same address after a reset')
  assert.deepEqual(await (await fetch(`${rec.url}/list`)).json(), [{ id: 's1', name: 'rice' }], 'the app started again on the seed (it reads its file only at start)')
  const after = jsonl(path.join(out, 'snaps.jsonl')).at(-1)
  assert.equal(after.label, 'reset'); assert.equal(after.hash, snaps[0].hash, 'the same state as the start')
  void events.body?.cancel().catch(() => {})
  const log = fs.readFileSync(path.join(out, 'server.log'), 'utf8').trim().split('\n')
  assert.ok(log.every((l) => /^\d{13}\tapp\t/.test(l)), 'every server line is stamped'); assert.ok(log.some((l) => l.endsWith('Error: boom')))
  assert.deepEqual(jsonl(path.join(out, 'actions.jsonl')).map((m) => `${m.phase} ${m.label}`),
    ['start add Dune twice', 'end add Dune twice', 'start slow and broken', 'end slow and broken', 'start reset', 'end reset'])
  // A folder of its own from here on (the UI tester's host gives each scenario one): its actions and snapshots count from the start, and a stream the
  // last page left open, which this one's reset ends, isn't written into it
  const before = jsonl(path.join(out, 'api.jsonl')).length, own = path.join(out, 'rec', 's-02')
  const left = await fetch(`${rec.url}/events`); rec.cut(own); await rec.reset(); void left.body?.cancel().catch(() => {})
  await rec.action('add Emma', () => post('Emma'))
  assert.deepEqual(jsonl(path.join(own, 'api.jsonl')).map((r) => [r.method, r.path, r.action]), [['POST', '/add', 2]])
  assert.deepEqual(jsonl(path.join(own, 'actions.jsonl')).map((m) => `${m.phase} ${m.label} ${m.action}`), ['start reset 1', 'end reset 1', 'start add Emma 2', 'end add Emma 2'])
  assert.deepEqual(jsonl(path.join(own, 'snaps.jsonl')).map((x) => [x.n, x.label, x.changed]), [[0, 'reset', true], [1, 'add Emma', true]])
  assert.equal(JSON.parse(fs.readFileSync(path.join(own, 'snapshots', '0001', 'data', 'items.json'), 'utf8')).length, 2, 'the seed and Emma')
  assert.equal(jsonl(path.join(out, 'api.jsonl')).length, before, 'nothing more in the first folder'); assert.ok(fs.existsSync(path.join(out, 'seed', 'data', 'items.json')))
  await rec.stop()
  assert.deepEqual(running(tag), [], 'the app and its shell are gone, through two starts')
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }), 'and the proxy too')
})

test('recorder: a seed command that fails, or writes nothing, stops it before the app starts', async () => {
  const a = project(), b = project()
  const bad = await startRecording({ ...spec(a.root, a.out), seed: 'exit 3' })
  assert.equal(bad.kind, 'no_seed'); assert.match(bad.why, /code 3/)
  const none = await startRecording({ ...spec(b.root, b.out), seed: 'true' })
  assert.equal(none.kind, 'no_seed'); assert.match(none.why, /wrote none of data/)
})
