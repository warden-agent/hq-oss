// The tester's browser tools (tester.ts): a small MCP server that HQ gives a one-shot Claude Code call at the end of an auto run. It starts the app as its
// launch recipe says (appstart.mjs), opens HQ's headless browser, and offers four tools: open a page, click, type, and done. Every answer is the page as
// text (its accessibility tree, as Playwright writes it), never a screenshot: a few hundred characters a page. Actions are counted and capped.
// The command HQ puts in the call's MCP config wraps this in the test sandbox (testrun.ts): localhost only, no credentials, the run's own throwaway checkout.
// What the agent did and reported is written to spec.out as it goes, for HQ to read when the call is over. Plain Node, no imports from HQ.
// spec: { parts, show, startMs, pwCore, sdk, zod, cap, out, mode?, rules?, pageMax? }   (sdk, zod: where HQ's own @modelcontextprotocol/sdk and zod are)
// mode 'map': the first-map session (firstmap.ts). Its last tool is write_map, not done, and the map is checked here with HQ's own rules (featuremap.ts,
// imported by path from `rules`), so a refused one goes back to the agent while the app is still open, for it to fix and send again.
import fs from 'node:fs'
import path from 'node:path'
import { allowPorts, startApp } from './appstart.mjs'

const spec = JSON.parse(process.argv[2])
const { McpServer } = await import(path.join(spec.sdk, 'dist/esm/server/mcp.js'))
const { StdioServerTransport } = await import(path.join(spec.sdk, 'dist/esm/server/stdio.js'))
const { z } = await import(path.join(spec.zod, 'index.js'))

const state = { started: null, why: null, output: null, actions: [], report: null } // started: null while the app is coming up
const save = () => { try { fs.writeFileSync(spec.out, JSON.stringify(state)) } catch { /* the checkout is gone: so is whoever would read this */ } }
let page = null, browser = null, kids = [], origin = ''
const logged = []
/** The app and the browser, once: every tool waits for this. Null when they're up, else why not. */
const ready = (async () => {
  const app = await startApp(spec); kids = app.kids
  if (!app.port) { state.started = false; state.why = app.kind === 'skipped' ? app.why : `the app didn't start: ${app.why}`; state.output = app.output ?? null; save(); return state.why }
  try {
    const { chromium } = await import(path.join(spec.pwCore, 'index.mjs'))
    browser = await chromium.launch({ headless: true, args: allowPorts([app.port, ...Object.values(app.ports)]) }) // even a port browsers refuse (Bug 433)
    page = await browser.newPage(); origin = `http://localhost:${app.port}`
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) logged.push(m.text().slice(0, 300)) })
    page.on('pageerror', (e) => logged.push(e.message.slice(0, 300)))
  } catch (e) { state.started = false; state.why = `HQ's browser didn't start (${String(e.message).split('\n')[0].slice(0, 200)})`; save(); return state.why }
  state.started = true; save(); return null
})()
const end = async () => { await browser?.close().catch(() => {}); for (const k of kids) { try { k.kill('SIGKILL') } catch { /* gone */ } } process.exit(0) }
process.stdin.on('close', end); for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, end)

const left = () => `(${spec.cap - state.actions.length} action${spec.cap - state.actions.length === 1 ? '' : 's'} left)`
/** The page as the agent reads it: where it is, its accessibility tree as text, and what the console logged since the last look. */
async function view() {
  const snap = await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '(the page has nothing to read)'), errors = logged.splice(0)
  const where = page.url().startsWith(origin) ? page.url().slice(origin.length) || '/' : page.url()
  const max = spec.pageMax ?? 4000
  return `Page ${where} "${(await page.title()).slice(0, 100)}"\n${snap.length > max ? `${snap.slice(0, max)}\n(the page goes on)` : snap}`
    + `${errors.length ? `\nErrors the page logged: ${errors.slice(0, 5).join(' | ')}` : ''}\n${left()}`
}
const text = (s, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) })
/** One action: counted, capped, and answered with the page as it is afterwards. A step that can't be done (no such button) still counts, and says so. */
const act = (tool, fn) => async (a) => {
  const down = await ready
  if (down) return text(spec.mode === 'map' ? `${down}. There is nothing to look at: stop now, without a map.` : `${down}. There is nothing to try: call done and say so.`, true)
  const over = spec.mode === 'map' ? 'No actions left. Call write_map now with the map of what you saw.' : 'No actions left. Call done now with what you found.'
  if (state.actions.length >= spec.cap) return text(over, true)
  const entry = { tool, ...a, ok: true }; state.actions.push(entry)
  try { await fn(a); await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}) } catch (e) { entry.ok = false; save()
    return text(`That didn't work: ${String(e.message).split('\n')[0].slice(0, 300)}\n${await view().catch(() => left())}`) }
  save(); return text(await view())
}
const s = new McpServer({ name: 'browse', version: '0.1.0' })
const target = { role: z.string().describe('the element\'s role as the page text shows it: button, link, textbox, checkbox, combobox…'),
  name: z.string().describe('its name as the page text shows it') }
s.registerTool('open', { description: 'Open a page of the app by its path ("/" is the start page). Answers with the page as text.', inputSchema: { path: z.string() } },
  act('open', (a) => page.goto(origin + (a.path.startsWith('/') ? a.path : `/${a.path}`), { timeout: 15_000 })))
s.registerTool('click', { description: 'Click a button, link or other element. Answers with the page as text afterwards.', inputSchema: target },
  act('click', (a) => page.getByRole(a.role, { name: a.name }).first().click({ timeout: 4000 })))
s.registerTool('type', { description: 'Type text into a field (it replaces what is there). Answers with the page as text afterwards.', inputSchema: { ...target, text: z.string() } },
  act('type', (a) => page.getByRole(a.role, { name: a.name }).first().fill(a.text, { timeout: 4000 })))
const problem = z.object({ criterion: z.string().describe('the criterion it is about, as written in your instructions (for example "T-03 A2")'),
  what: z.string().describe('what you saw, and what the criterion says should happen'), steps: z.array(z.string()).describe('the steps that show it, in order') })
if (spec.mode === 'map') {
  const { parseMap, mapProblem, mapText } = await import(spec.rules)
  s.registerTool('write_map', { description: 'Finish: the feature map you wrote, as markdown. HQ checks it; if it says what to fix, fix it and call write_map again.',
    inputSchema: { map: z.string() } }, async (a) => {
    const p = parseMap(a.map), bad = 'error' in p ? p.error : !p.map.length ? 'The map has no screens.' : mapProblem(p.map)
    if (bad) { state.refused = (state.refused ?? 0) + 1; save(); return text(`Not taken: ${bad}`, true) }
    state.report = { map: mapText(p.map) }; save(); return text('Taken. Stop now.')
  })
} else s.registerTool('done', { description: 'Finish. Say what you tried, and each problem you saw with the steps that show it. Call it once, last.',
  inputSchema: { tried: z.array(z.string()), problems: z.array(problem) } }, async (a) => { state.report = { tried: a.tried, problems: a.problems }; save(); return text('Recorded. Stop now.') })
save(); await s.connect(new StdioServerTransport())
