// The UI tester's scenario tools (uitester.ts): a small MCP server Claude Code starts beside the browser tools. start_scenario has HQ reset the app and says its
// address; finish_scenario hands HQ what the tester saw. Both go to the tester's host (uitesthost.mjs) on localhost; nothing here reads or writes a file.
// Plain Node, no imports from HQ. spec: { sdk, zod, ctrl }   (sdk, zod: where HQ's own @modelcontextprotocol/sdk and zod are; ctrl: the host's port)
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
const text = (s, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) })
const s = new McpServer({ name: 'uitest', version: '0.1.0' })
s.registerTool('start_scenario', { description: 'Begin a scenario: HQ resets the app to a clean start and tells you its address.', inputSchema: { id: z.string() } },
  async (a) => {
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
  description: 'End a scenario: its outcome, your notes on each hesitation, wrong click or backtrack, and its findings. Call it once per scenario.',
  inputSchema: { id: z.string(), outcome: z.enum(['ok', 'problem', 'unspecified']), notes: z.array(z.string()), findings: z.array(finding) },
}, async (a) => { const r = await host('finish', { id: a.id, report: a }); return r.ok ? text('Recorded. Go on to the next scenario, or stop if this was the last.') : text(r.why, true) })
await s.connect(new StdioServerTransport())
