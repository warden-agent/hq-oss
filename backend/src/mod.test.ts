// Bug 135: HQ's mod (plugin/hooks/register.js) asks for its next batch as soon as the last ask is dealt with, not at the next tick
// of its 1.5 s clock, and never in a loop. The real mod runs here against a stand-in for HQ's hooks server that answers each
// `next` when the test says so. The clock is the test's (e2e/modhost.ts): an ask that comes with no tick is the mod's own doing.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startMod, type ModHost } from '../e2e/modhost.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-mod-'))
const tokenFile = path.join(tmp, 'token'); fs.writeFileSync(tokenFile, 'tok-1\n')
const ends: (() => void)[] = []
after(() => { for (const f of ends) f(); fs.rmSync(tmp, { recursive: true, force: true }) })

const until = async <T>(what: string, fn: () => T | undefined | false, ms = 5000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)) }
}
type Ask = { answer: (body: object, status?: number) => void; drop: () => void }
/** A stand-in for HQ's hooks server. Each `next` waits in `asks` until the test answers or drops it; the mod's events land in `events`. */
async function hqStub() {
  const asks: Ask[] = [], events: any[] = []
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      const json = (b: object, status = 200): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
      if (req.url === '/mod/tok-1/next?wait=15000') { asks.push({ answer: json, drop: () => req.socket.destroy() }); return }
      if (req.url === '/mod/tok-1/event') { events.push(JSON.parse(body)); return json({ ok: true }) }
      json({}, 404)
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const close = (): void => { srv.closeAllConnections(); srv.close() }; ends.push(close)
  return { url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, events, close,
    /** The mod's nth `next`, once it has arrived. */
    ask: (n: number): Promise<Ask> => until(`the mod's ask ${n}`, () => asks[n - 1]) }
}
async function modOn(url: string, submit: (text: string) => Promise<unknown> = async () => {}): Promise<ModHost> {
  const mod = await startMod({ backend: url, agentId: 'eng-1', tokenFile, submit }); ends.push(mod.stop); return mod
}
/** Once the mod has dealt with `n` asks: how many it has sent. Anything it does about an answer, it does before this returns. */
async function asksAfter(mod: ModHost, n: number): Promise<number> {
  await until(`ask ${n} to end`, () => mod.ended() >= n); await new Promise((r) => setImmediate(r)); return mod.asks()
}

test('once a batch has gone in, the mod asks for the next one by itself', async () => {
  const hq = await hqStub(), prompts: string[] = []; let goesIn = (): void => {}
  const mod = await modOn(hq.url, (text) => new Promise<void>((r) => { prompts.push(text); goesIn = r }))
  mod.tick(); (await hq.ask(1)).answer({ batch: { id: 'B-1', text: 'First.' } })
  await until('the mod to say it got the batch', () => hq.events.some((e) => e.kind === 'batch_received' && e.id === 'B-1'))
  mod.tick(); assert.equal(mod.asks(), 1, 'no ask while the batch waits for the agent to be idle')
  goesIn() // the agent is idle: the prompt goes in. No tick from here on.
  ;(await hq.ask(2)).answer({ batch: { id: 'B-2', text: 'Second.', raw: true } })
  await until('the second prompt', () => prompts.length === 2)
  assert.deepEqual(prompts, ['HQ message batch B-1:\nFirst.', 'Second.'])
  assert.ok(hq.events.some((e) => e.kind === 'batch_submitted' && e.id === 'B-1'))
})

test('a wait that ends with nothing is followed by the next one at once', async () => {
  const hq = await hqStub(), mod = await modOn(hq.url)
  mod.tick(); (await hq.ask(1)).answer({}) // HQ held it for its 15 s and nothing came
  await hq.ask(2) // no tick
  assert.equal(mod.asks(), 2)
})

test('empty answers that come at once make no loop: one ask more, then the clock', async () => {
  const hq = await hqStub(), mod = await modOn(hq.url)
  mod.tick(); (await hq.ask(1)).answer({}); (await hq.ask(2)).answer({})
  assert.equal(await asksAfter(mod, 2), 2)
  mod.tick(); (await hq.ask(3)).answer({}); (await hq.ask(4)).answer({})
  assert.equal(await asksAfter(mod, 4), 4)
})

test('with HQ refusing, failing or cutting the line, the mod asks once per tick', async () => {
  const hq = await hqStub(), mod = await modOn(hq.url)
  mod.tick(); (await hq.ask(1)).answer({ error: 'bad token' }, 403)
  assert.equal(await asksAfter(mod, 1), 1)
  mod.tick(); (await hq.ask(2)).answer({ error: 'HQ error' }, 500)
  assert.equal(await asksAfter(mod, 2), 2)
  mod.tick(); (await hq.ask(3)).drop()
  assert.equal(await asksAfter(mod, 3), 3)
  mod.tick(); (await hq.ask(4)).answer({}); await hq.ask(5) // and a held wait that ends empty is followed up again
})

test('with HQ away, the mod asks once per tick', async () => {
  const hq = await hqStub(), mod = await modOn(hq.url)
  hq.close() // nothing listens on its port any more
  mod.tick(); assert.equal(await asksAfter(mod, 1), 1)
  mod.tick(); assert.equal(await asksAfter(mod, 2), 2)
})

test('a batch the prompt box refused waits for the clock', async () => {
  const hq = await hqStub(), mod = await modOn(hq.url, () => Promise.reject(new Error('boom')))
  mod.tick(); (await hq.ask(1)).answer({ batch: { id: 'B-1', text: 'First.' } })
  await until('the mod to say it failed', () => hq.events.some((e) => e.kind === 'batch_submit_failed' && e.id === 'B-1'))
  await new Promise((r) => setImmediate(r)); assert.equal(mod.asks(), 1) // HQ gives up after three tries: they must not all go in one second
  mod.tick(); await hq.ask(2)
})
