// The UI tester's scenario tools (uitester.ts): a small MCP server Claude Code starts beside the browser tools. start_scenario has HQ reset the app and says its
// address; finish_scenario hands HQ what the tester saw. Both go to the tester's host (uitesthost.mjs) on localhost; nothing here reads or writes a file.
// Bug 453: before the app is reset, start_scenario has the tester's browser closed (uitestbrowser.mjs, asked on its socket), so the scenario starts in a new
// one that remembers nothing. A browser that can't be closed is a reset that failed: the tester stops, and HQ's summary says why (the host's /cant).
// Plain Node, no imports from HQ. spec: { sdk, zod, ctrl, ask?, askMs? }   (sdk, zod: where HQ's own @modelcontextprotocol/sdk and zod are; ctrl: the host's
// port; ask: the browser relay's socket, when there is one; askMs: how long it has to answer)
import net from 'node:net'
import path from 'node:path'

const spec = JSON.parse(process.argv[2])
const { McpServer } = await import(path.join(spec.sdk, 'dist/esm/server/mcp.js'))
const { StdioServerTransport } = await import(path.join(spec.sdk, 'dist/esm/server/stdio.js'))
const { z } = await import(path.join(spec.zod, 'index.js'))

const host = async (what, body) => {
  try {
    const r = await fetch(`http://127.0.0.1:${spec.ctrl}/${what}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
    return await r.json()
  } catch (e) { return { ok: false, why: `HQ didn't answer (${String(e.message).slice(0, 100)})` } }
}
const ASK_MS = Number(spec.askMs) || 20_000
/** Asks the browser relay once. `nobody`: its socket isn't there (yet), or nothing listens on it. */
const askOnce = (left) => new Promise((resolve) => {
  let said = ''
  const c = net.connect(spec.ask, () => c.write('fresh\n'))
  const done = (o) => { clearTimeout(timer); c.destroy(); resolve(o) }
  const timer = setTimeout(() => done({ ok: false, why: `it didn't answer within ${Math.round(ASK_MS / 1000)} s` }), left)
  c.on('data', (d) => { said += d })
  c.on('end', () => done(/^ok\b/.test(said) ? { ok: true } : { ok: false, why: said.trim().replace(/^failed\s*/, '') || 'it gave no answer' }))
  c.on('error', (e) => done(['ENOENT', 'ECONNREFUSED'].includes(e.code) ? { ok: false, nobody: true, why: 'its browser tools aren\'t running' } : { ok: false, why: e.message }))
})
/** A browser that remembers nothing, for the scenario about to start. The relay may still be starting when a session's first scenario begins (Claude Code
 *  starts both servers at once): its socket is waited for, within the same limit. */
async function fresh() {
  if (!spec.ask) return { ok: true }
  for (const t0 = Date.now(); ;) {
    const r = await askOnce(Math.max(ASK_MS - (Date.now() - t0), 1))
    if (!r.nobody || Date.now() - t0 >= ASK_MS) return r
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const text = (s, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) })
const s = new McpServer({ name: 'uitest', version: '0.1.0' })
s.registerTool('start_scenario', { description: 'Begin a scenario: HQ resets the app to a clean start and tells you its address.', inputSchema: { id: z.string() } },
  async (a) => {
    const f = await fresh()
    if (!f.ok) { const why = `the tester's browser couldn't be closed (${f.why})`; await host('cant', { id: a.id, why }); return text(`HQ couldn't reset the app: ${why}. Stop now.`, true) }
    const r = await host('start', a); if (r.ok) return text(`The app is reset. Its address is ${r.url} — open it with browser_navigate.`)
    return text(/isn't finished/.test(r.why ?? '') ? r.why : `HQ couldn't reset the app: ${r.why}. Stop now.`, true)
  })
const looked = z.object({ role: z.string().optional(), name: z.string().optional(), text: z.string().optional() })
const finding = z.object({
  kind: z.enum(['stuck', 'confusing', 'unclear_label', 'no_feedback', 'broken', 'missing']),
  at_step: z.number().describe('the action it happened at: your page opens, clicks, typing and key presses in this scenario, counted from 1 (looks don\'t count)'),
  what: z.string().describe('what you saw'), expected: z.string().describe('what you expected to see or be able to do'),
  criterion: z.string().optional().describe('the what\'s-new [id] it is about, if any'),
  looked_for: looked.optional().describe('the element you were looking for, as the page text names it'),
})
s.registerTool('finish_scenario', {
  description: 'End a scenario: its outcome, your notes on each hesitation, wrong click or backtrack, its findings, and what you couldn\'t check. Call it once per scenario.',
  inputSchema: { id: z.string(), outcome: z.enum(['ok', 'problem', 'unspecified', 'couldnt_test']), notes: z.array(z.string()), findings: z.array(finding),
    couldnt_test: z.string().optional().describe('what the scenario needed that you can\'t do from this browser (change the clock, wait hours, get an email, reach an outside service), '
      + 'so you couldn\'t check it. Never a finding: a finding is about what the app did') },
}, async (a) => { const r = await host('finish', { id: a.id, report: a }); return r.ok ? text('Recorded. Go on to the next scenario, or stop if this was the last.') : text(r.why, true) })
await s.connect(new StdioServerTransport())
