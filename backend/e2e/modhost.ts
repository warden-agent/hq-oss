// Stand-in for the part of Claude Code that runs HQ's mod: it loads the real plugin/hooks/register.js (a fresh copy each time, since
// the mod keeps its state in the module's own variables) and gives it a `$`. The network calls are real; the clock and the prompt
// box are the test's, so a test decides when the mod's 1.5 s clock ticks and when a prompt goes in. No Claude Code, no tokens.
import fs from 'node:fs'
import path from 'node:path'

const SOURCE = fs.readFileSync(path.resolve(import.meta.dirname, '../../plugin/hooks/register.js'), 'utf8')
let copies = 0

export type ModHost = Awaited<ReturnType<typeof startMod>>
/** Starts the mod as a session's start does. `backend`: HQ's hooks server. `submit`: what `$.prompt.submit` does with a batch's
 *  text; like Claude Code's it resolves once the prompt has gone in (which waits for the agent to be idle), or rejects. */
export async function startMod(o: { backend: string; agentId: string; tokenFile: string; submit: (text: string) => Promise<unknown> }) {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(`${SOURCE}\n// copy ${++copies}`).toString('base64')}`)
  const hooks = new Map<string, (...a: any[]) => any>(); mod.register((event: string, hook: (...a: any[]) => any) => hooks.set(event, hook))
  const ticks: (() => void)[] = [], over = new AbortController()
  let asks = 0, ended = 0, unanswered = 0
  const env: Record<string, string> = { HQ_BACKEND: o.backend, HQ_AGENT_ID: o.agentId, HQ_TOKEN_FILE: o.tokenFile, HOME: path.dirname(o.tokenFile) }
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: { read: async (file: string) => fs.readFileSync(file, 'utf8') },
    session: { id: async () => 'fake', model: async () => 'fake', cwd: async () => process.cwd(), usage: async () => ({}) },
    ui: { log: () => {} },
    clock: { every: (_ms: number, fn: () => void) => { ticks.push(fn); return { cancel: () => {} } } },
    prompt: { submit: (input: { text: string }) => o.submit(input.text) },
    http: { fetch: async (url: string, init?: RequestInit) => {
      const next = /\/next\?/.test(url); if (next) asks++ // counted as the mod calls, before anything goes over the network
      try { const r = await fetch(url, { ...init, signal: over.signal }); return { status: r.status, ok: r.ok, headers: {}, text: await r.text() } }
      catch (e) { unanswered++; throw e }
      finally { if (next) ended++ }
    } },
  }
  await hooks.get('session.start')!($, {}, async (e: unknown) => e)
  return {
    /** One tick of the mod's clock. */
    tick: (): void => { for (const f of ticks) f() },
    /** How many `next` requests the mod has sent so far. */
    asks: (): number => asks,
    /** How many of them have ended: answered, refused or failed. */
    ended: (): number => ended,
    /** How many of the mod's requests of any kind got no answer (HQ away). */
    unanswered: (): number => unanswered,
    /** One of Claude Code's events, as the mod's hooks get it (e.g. `turn.complete`). */
    fire: (event: string, e: object): Promise<unknown> => hooks.get(event)!($, e, async (x: unknown) => x),
    /** A model request of a turn (`turn.step`, a streaming hook), answered with `result` (e.g. `{ toolUses: [{ name: 'Read' }] }`). */
    step: async (e: object, result: object): Promise<void> => {
      const g = hooks.get('turn.step')!($, e, async function* () { yield* []; return result }); while (!(await g.next()).done) { /* to its end */ }
    },
    /** The session is over: its open requests end. */
    stop: (): void => over.abort(),
  }
}
