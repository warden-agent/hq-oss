// Bug 118: HQ never runs half-started. If another program holds one of HQ's ports, HQ stops at start-up and says which port and
// who holds it, instead of running on with no MCP or hooks server (agents' tools and hooks then reach the other program or nothing).
// Bug 434: the same for a port browsers and fetch refuse (badports.ts): the page there never opens, and fetch never reaches hooks or MCP there.
import fs from 'node:fs'
import net from 'node:net'
import type http from 'node:http'
import { badPort } from './badports.ts'
import { BIND, PORTS } from './config.ts'
import { portHolder } from './procs.ts'

export type PortName = keyof typeof PORTS
const ROLE: Record<PortName, string> = { ui: 'the page and its API', hooks: "agents' hooks", mcp: "agents' tools (MCP)" }
const ENV: Record<PortName, string> = { ui: 'HQ_UI_PORT', hooks: 'HQ_HOOKS_PORT', mcp: 'HQ_MCP_PORT' }
/** The exit code of a start-up stopped by a taken port, or one browsers refuse (the e2e harness tells it from other start-up failures by this). */
export const PORT_TAKEN_EXIT = 3

/** Why `port` can't be listened on (its error code, e.g. EADDRINUSE), or null when it can. Opens and closes a listener at once.
 *  On a Mac a program on all addresses (0.0.0.0, ::) doesn't stop a listen on 127.0.0.1, and 127.0.0.1 then reaches HQ, which is
 *  all HQ hands out, so that isn't a taken port. */
export function cantListen(port: number, host = BIND): Promise<string | null> {
  return new Promise((resolve) => {
    const s = net.createServer(); s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? String(e)))
    s.listen(port, host, () => s.close(() => resolve(null)))
  })
}
/** HQ's ports that can't be listened on now, with why. */
export async function takenPorts(ports: Record<PortName, number> = PORTS): Promise<{ name: PortName; port: number; code: string }[]> {
  const out = []
  for (const name of Object.keys(ports) as PortName[]) { const code = await cantListen(ports[name]); if (code) out.push({ name, port: ports[name], code }) }
  return out
}
/** What the user reads, one line per port. `holder` is lsof's answer ("node (pid 123)") or null. */
export function takenMessage(taken: { name: PortName; port: number; code: string; holder: string | null }[]): string {
  const lines = taken.map(({ name, port, code, holder }) => code === 'EADDRINUSE'
    ? `  port ${port} (${ROLE[name]}, ${ENV[name]}) is in use by ${holder ?? 'another program (lsof could not say which)'}`
    : `  port ${port} (${ROLE[name]}, ${ENV[name]}) can't be used: ${code}`)
  return [`HQ can't start: ${taken.length === 1 ? 'one of its ports is' : 'its ports are'} not free.`, ...lines,
    'If that is another HQ backend, this HQ is already running. Otherwise stop that program and start HQ again,',
    'or start HQ with the variable above set to a free port (agents that are already running keep the old port until they restart).'].join('\n')
}
/** Bug 434: HQ's ports that browsers and fetch refuse to connect to. All three count: the page is a browser's; hooks are reached by Claude Code's http
 *  hooks and its mod's `$.http.fetch` (fetch inside Claude Code), and both hooks and MCP by Node's fetch in HQ's own tests and tools. */
export function refusedPorts(ports: Record<PortName, number> = PORTS): { name: PortName; port: number }[] {
  return (Object.keys(ports) as PortName[]).filter((name) => badPort(ports[name])).map((name) => ({ name, port: ports[name] }))
}
/** What the user reads for those, one line per port. */
export function refusedMessage(refused: { name: PortName; port: number }[]): string {
  const one = refused.length === 1
  return [`HQ can't start: web browsers and fetch refuse to connect to ${one ? 'one of its ports' : 'some of its ports'}.`,
    ...refused.map(({ name, port }) => `  port ${port} (${ROLE[name]}, ${ENV[name]})`),
    `Start HQ with ${one ? 'that variable' : 'those variables'} set to another port, or unset to use the default.`,
    'Refused ports include 6000, 6665–6669 and 10080 (the Fetch standard\'s list of bad ports).'].join('\n')
}
/** Says why and ends the process. A sync write: the backend's output goes through `| tee`, and `process.exit` drops async writes. */
async function stop(taken: { name: PortName; port: number; code: string }[]): Promise<never> {
  const withHolder = await Promise.all(taken.map(async (t) => ({ ...t, holder: t.code === 'EADDRINUSE' ? await portHolder(t.port).catch(() => null) : null })))
  fs.writeSync(2, takenMessage(withHolder) + '\n')
  process.exit(PORT_TAKEN_EXIT)
}
/** Before HQ touches anything (database, agents, leftovers): a second HQ on the same home must not recover or sweep the first's agents. A refused port
 *  stops it first, without a listen. */
export async function stopIfPortsTaken(): Promise<void> {
  const refused = refusedPorts(); if (refused.length) { fs.writeSync(2, refusedMessage(refused) + '\n'); process.exit(PORT_TAKEN_EXIT) } // Bug 434
  const taken = await takenPorts(); if (taken.length) await stop(taken)
}
/** Waits until each server listens. A port taken since `stopIfPortsTaken` ends HQ the same way, before any loop starts. */
export async function listeningOrStop(servers: Record<PortName, http.Server>): Promise<void> {
  const results = await Promise.all((Object.keys(servers) as PortName[]).map((name) => new Promise<{ name: PortName; port: number; code: string } | null>((resolve) => {
    const srv = servers[name]; if (srv.listening) return resolve(null)
    const onError = (e: NodeJS.ErrnoException) => { srv.off('listening', onListening); resolve({ name, port: PORTS[name], code: e.code ?? String(e) }) }
    const onListening = () => { srv.off('error', onError); resolve(null) }
    srv.once('error', onError); srv.once('listening', onListening)
  })))
  const taken = results.filter((r) => r !== null); if (taken.length) await stop(taken)
}
