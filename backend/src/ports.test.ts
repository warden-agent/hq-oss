// Bug 118: HQ stops at start-up when one of its ports is taken, and says which port and who holds it. Bug 434: or is one browsers refuse.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { cantListen, refusedMessage, refusedPorts, takenMessage, takenPorts } from './ports.ts'

const listen = (port: number, host: string): Promise<net.Server> => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject); s.listen(port, host, () => resolve(s))
})
const close = (s: net.Server) => new Promise((r) => s.close(r))
const portOf = (s: net.Server) => (s.address() as net.AddressInfo).port

test('takenPorts: a port another program listens on is taken; once it is gone the port is free, and checking leaves it free', { timeout: 10_000 }, async () => {
  const other = await listen(0, '127.0.0.1'), held = portOf(other)
  try {
    assert.deepEqual(await takenPorts({ ui: held, hooks: held, mcp: held }), ['ui', 'hooks', 'mcp'].map((name) => ({ name, port: held, code: 'EADDRINUSE' })))
  } finally { await close(other) }
  assert.equal(await cantListen(held), null, 'once the other program is gone')
  const again = await listen(held, '127.0.0.1'); await close(again) // the check closed its own listener
})

test('takenMessage: names each port, what it is for, its variable and its holder; says so when lsof could not tell', () => {
  const m = takenMessage([{ name: 'mcp', port: 4782, code: 'EADDRINUSE', holder: 'python3.1 (pid 55557)' }])
  assert.match(m, /^HQ can't start: one of its ports is not free\.\n  port 4782 \(agents' tools \(MCP\), HQ_MCP_PORT\) is in use by python3\.1 \(pid 55557\)\n/)
  assert.match(m, /If that is another HQ backend, this HQ is already running\./)
  const two = takenMessage([{ name: 'ui', port: 4780, code: 'EADDRINUSE', holder: null }, { name: 'hooks', port: 80, code: 'EACCES', holder: null }])
  assert.match(two, /^HQ can't start: its ports are not free\./)
  assert.match(two, /port 4780 \(the page and its API, HQ_UI_PORT\) is in use by another program \(lsof could not say which\)/)
  assert.match(two, /port 80 \(agents' hooks, HQ_HOOKS_PORT\) can't be used: EACCES/)
})

test('Bug 434: refusedPorts finds each of HQ\'s ports browsers and fetch refuse, and none of the usual ones', () => {
  assert.deepEqual(refusedPorts({ ui: 4780, hooks: 4781, mcp: 4782 }), [], 'the defaults')
  assert.deepEqual(refusedPorts({ ui: 8080, hooks: 5999, mcp: 6001 }), [], 'next to a refused one')
  assert.deepEqual(refusedPorts({ ui: 6000, hooks: 4781, mcp: 4782 }), [{ name: 'ui', port: 6000 }])
  assert.deepEqual(refusedPorts({ ui: 4780, hooks: 6665, mcp: 10080 }), [{ name: 'hooks', port: 6665 }, { name: 'mcp', port: 10080 }])
})

test('Bug 434: refusedMessage names each port, what it is for and its variable, and what to do', () => {
  const m = refusedMessage([{ name: 'ui', port: 6000 }])
  assert.match(m, /^HQ can't start: web browsers and fetch refuse to connect to one of its ports\.\n  port 6000 \(the page and its API, HQ_UI_PORT\)\n/)
  assert.match(m, /^Start HQ with that variable set to another port, or unset to use the default\.$/m)
  const two = refusedMessage([{ name: 'hooks', port: 6665 }, { name: 'mcp', port: 5060 }])
  assert.match(two, /refuse to connect to some of its ports\.\n  port 6665 \(agents' hooks, HQ_HOOKS_PORT\)\n  port 5060 \(agents' tools \(MCP\), HQ_MCP_PORT\)\n/)
  assert.match(two, /^Start HQ with those variables set/m)
})
