// Bug 409: ports browsers and Node's fetch refuse. HQ hands none out, and its preview probe still sees an app the user put on one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { BAD_PORTS, badPort } from './badports.ts'
import { httpReply, portRange } from './apprun.ts'
import { slotBases } from './slotports.ts'

/** Why this Node's fetch refused the port ("bad port"), or null when it tried to connect. Nothing listens on 127.0.0.1:1 or the neighbours asked here
 *  for long enough to matter: a reply or a refused connect both mean fetch tried. */
const fetchRefuses = async (port: number): Promise<boolean> => {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }); return false } catch (e) {
    return /bad port/.test(String((e as { cause?: unknown }).cause ?? '')) || /bad port/.test((e as Error).message)
  }
}
/** A listener on the first port of `ports` that can be listened on now (other programs may hold some), and its port. */
async function listenOnOne(ports: number[], handler: http.RequestListener): Promise<{ srv: http.Server; port: number }> {
  for (const port of ports) {
    const srv = http.createServer(handler)
    const ok = await new Promise<boolean>((resolve) => { srv.once('error', () => resolve(false)); srv.listen(port, '127.0.0.1', () => resolve(true)) })
    if (ok) return { srv, port }
  }
  throw new Error(`none of ${ports.join(', ')} could be listened on`)
}
const close = (srv: http.Server) => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()) })

test('BAD_PORTS (Bug 409) is the list this Node\'s fetch refuses: every one on it, and none of their neighbours off it', async () => {
  for (const p of BAD_PORTS) assert.equal(await fetchRefuses(p), true, `fetch should refuse ${p}`)
  const near = [...new Set([...BAD_PORTS].flatMap((p) => [p - 1, p + 1]))].filter((p) => p > 0 && p < 65536 && !BAD_PORTS.has(p))
  for (const p of [...near, 3090, 8080, 10000, 49152]) assert.equal(await fetchRefuses(p), false, `fetch should try ${p}`)
  assert.equal(badPort(6000), true); assert.equal(badPort(6665), true); assert.equal(badPort(3090), false)
})

test('portRange (Bug 409): HQ_PREVIEW_PORTS leaves out ports browsers refuse; one holding only those is refused', () => {
  assert.deepEqual(portRange('6660-6672'), [6660, 6661, 6662, 6663, 6664, 6670, 6671, 6672])
  assert.deepEqual(portRange('5059-5062'), [5059, 5062])
  assert.deepEqual(portRange('3090-3099'), Array.from({ length: 10 }, (_, i) => 3090 + i)) // must NOT catch: the default range is whole
  for (const only of ['6000-6000', '6665-6669']) assert.throws(() => portRange(only), /browsers refuse/, only)
})

test('slotBases (Bug 409): no engineer block holds a port browsers refuse', () => {
  assert.deepEqual(slotBases([10060, 10109]), [10060, 10070, 10090, 10100]) // 10080–10089 holds 10080
  assert.deepEqual(slotBases([6650, 6689]), [6650, 6680]) // 6660 (6665–6669) and 6670 (6679) are out
  for (const w of [[10000, 10199], [6000, 6199], [5000, 5199]] as [number, number][]) {
    for (const b of slotBases(w)) for (let i = 0; i < 10; i++) assert.equal(badPort(b + i), false, `${b}+${i}`)
  }
})

test('httpReply (Bug 409): an app on a port fetch refuses still answers; headers, redirects, nothing listening, no reply', async () => {
  const bad = [...BAD_PORTS].filter((p) => p > 1023)
  const { srv, port } = await listenOnOne(bad, (req, res) => {
    if (req.url === '/') { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Set-Cookie', ['a=1', 'b=2']); res.end('hi') } else res.end()
  })
  try {
    assert.equal(await fetchRefuses(port), true) // what the old probe did with it
    const get = await httpReply(port, 2000)
    assert.ok(get, `no reply seen on ${port}`)
    assert.equal(get('X-Frame-Options'), 'DENY'); assert.equal(get('set-cookie'), 'a=1, b=2'); assert.equal(get('content-security-policy'), null)
  } finally { await close(srv) }
  // a redirect is an answer, and isn't followed
  const r = await listenOnOne([0], (_q, res) => { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:1/'); res.end() })
  const rp = (r.srv.address() as net.AddressInfo).port
  try { assert.ok(await httpReply(rp, 2000)) } finally { await close(r.srv) }
  assert.equal(await httpReply(rp, 2000), null) // closed now: nothing listens
  // a server that takes the connection and never replies: null once the time is up
  const socks: net.Socket[] = [], mute = net.createServer((s) => { socks.push(s) })
  await new Promise<void>((res) => mute.listen(0, '127.0.0.1', () => res()))
  const mp = (mute.address() as net.AddressInfo).port, t0 = Date.now()
  try { assert.equal(await httpReply(mp, 300), null); assert.ok(Date.now() - t0 < 2000) } finally {
    for (const s of socks) s.destroy()
    await new Promise<void>((r) => mute.close(() => r()))
  }
})
