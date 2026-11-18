// The tester's browser tools, for real (testermcp.mjs): the MCP server started exactly as Claude Code would start it (tester.ts serverCommand: HQ's test
// sandbox around it, a clean environment), driven here by the MCP SDK's own client in place of an agent. A small app, a real headless browser. Like
// smoke.test.ts these need HQ's browser on the machine: they run when it is already there, or with HQ_TEST_BROWSER=1; otherwise they are skipped, and say so.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testermcp-'))
process.env.HQ_LOOK_START_S = '4'; process.env.HQ_TESTER_ACTIONS = '5'
const { migrate } = await import('./db.ts'); migrate()
const { browserHere, ensureBrowser, lookHow } = await import('./smoke.ts')
const { sandboxProblem, ownTmp } = await import('./testrun.ts')
const { serverCommand } = await import('./tester.ts')

const cant = !browserHere() && process.env.HQ_TEST_BROWSER !== '1' ? "HQ's browser isn't on this machine yet (HQ_TEST_BROWSER=1 downloads it)" : await sandboxProblem()
const opts = { skip: cant ?? false, timeout: 120_000 }
const SERVER = `const http = require('node:http'), items = ['Dune']
if (process.env.DIE) { console.error('Error: no database'); process.exit(1) }
http.createServer((q, s) => {
  const add = (b) => { const n = new URLSearchParams(b).get('name'); if (n) items.push(n); s.writeHead(303, { location: '/' }); s.end() }
  if (q.method === 'POST') { let b = ''; q.on('data', (c) => b += c); return q.on('end', () => add(b)) }
  s.writeHead(200, { 'content-type': 'text/html' })
  s.end('<!doctype html><title>Library</title><h1>Library</h1><form method="post" action="/add"><label>Name <input name="name"></label><button>Add item</button></form><ul>'
    + items.map((i) => '<li>' + i + '</li>').join('') + '</ul><script>if (location.search === "?boom") console.error("boom from the page")</script>')
}).listen(Number(process.env.PORT), '127.0.0.1')
`
/** The tools, connected: an app in a folder as a checkout would have it, the server started as tester.ts starts it. */
async function tools(run = 'node server.js', more: Record<string, unknown> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-testermcp-app-'))); fs.writeFileSync(path.join(dir, 'server.js'), SERVER)
  const recipe = { parts: [{ name: 'app', dir: '.', run, port: 'auto' as const }], show: 'app', worktree_files: [], notes: '' }
  const out = path.join(dir, '.hq-tester.json'), own = ownTmp(), cmd = serverCommand(dir, { recipe, repoPath: dir, how: lookHow(recipe) }, out, own.tmp, more)
  const client = new Client({ name: 'hq-test', version: '0.0.1' }); await client.connect(new StdioClientTransport({ ...cmd, stderr: 'pipe' }))
  const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean }
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError } }
  return { call, client, read: () => JSON.parse(fs.readFileSync(out, 'utf8')), close: async () => { await client.close(); await own.done() } }
}

test('the tools an agent gets: open, type, click and done, each answering with the page as text, and everything it did kept for HQ', opts, async () => {
  assert.equal(await ensureBrowser(), null)
  const t = await tools()
  assert.deepEqual((await t.client.listTools()).tools.map((x) => x.name).sort(), ['click', 'done', 'open', 'type'])
  const home = await t.call('open', { path: '/' })
  assert.match(home.text, /^Page \/ "Library"\n- heading "Library" \[level=1\]\n[\s\S]*- textbox "Name"\n[\s\S]*- button "Add item"\n[\s\S]*- listitem: Dune\n\(4 actions left\)$/)
  assert.ok(home.text.length < 400, `a page is a few hundred characters of text: ${home.text.length}`)
  await t.call('type', { role: 'textbox', name: 'Name', text: 'Emma' })
  assert.match((await t.call('click', { role: 'button', name: 'Add item' })).text, /- listitem: Dune\n\s+- listitem: Emma\n\(2 actions left\)$/)
  const missing = await t.call('click', { role: 'button', name: 'Delete everything' }) // a step that can't be done says so, with the page as it is, and still counts
  assert.match(missing.text, /^That didn't work: .*\nPage \/ "Library"[\s\S]*\(1 action left\)$/)
  assert.match((await t.call('open', { path: '/?boom' })).text, /\nErrors the page logged: boom from the page\n\(0 actions left\)$/)
  const over = await t.call('open', { path: '/' }); assert.equal(over.isError, true); assert.equal(over.text, 'No actions left. Call done now with what you found.')
  assert.equal((await t.call('done', { tried: ['Added Emma'], problems: [{ criterion: 'T-01 A2', what: 'No label on Dune.', steps: ['Open /'] }] })).text, 'Recorded. Stop now.')
  const kept = t.read(); assert.equal(kept.started, true); assert.deepEqual(kept.actions.map((a: any) => `${a.tool}${a.ok ? '' : ' (failed)'}`), ['open', 'type', 'click', 'click (failed)', 'open'])
  assert.deepEqual(kept.report, { tried: ['Added Emma'], problems: [{ criterion: 'T-01 A2', what: 'No label on Dune.', steps: ['Open /'] }] })
  await t.close()
})
test('an app that doesn\'t start: every tool says so and nothing is tried', opts, async () => {
  const t = await tools('DIE=1 node server.js'), r = await t.call('open', { path: '/' })
  assert.equal(r.isError, true); assert.match(r.text, /^the app didn't start: its app part stopped \(1\) while the app was starting\. There is nothing to try: call done and say so\.$/)
  const kept = t.read(); assert.equal(kept.started, false); assert.deepEqual(kept.actions, []); assert.match(kept.output, /no database/)
  await t.close()
})
test('map mode (the first-map session, firstmap.ts): write_map in place of done, the map checked with HQ\'s rules, a refused one sent back to fix', opts, async () => {
  const rules = path.join(import.meta.dirname, 'featuremap.ts')
  const t = await tools('node server.js', { mode: 'map', rules, cap: 3 })
  assert.deepEqual((await t.client.listTools()).tools.map((x) => x.name).sort(), ['click', 'open', 'type', 'write_map'])
  assert.match((await t.call('open', { path: '/' })).text, /- button "Add item"/)
  await t.call('open', { path: '/' }); await t.call('open', { path: '/' })
  const over = await t.call('open', { path: '/' }); assert.equal(over.isError, true); assert.equal(over.text, 'No actions left. Call write_map now with the map of what you saw.')
  const code = await t.call('write_map', { map: '## Books (page)\n- "Add item": calls addItem' }); assert.equal(code.isError, true)
  assert.match(code.text, /^Not taken: Books \(page\): "addItem" is code/)
  const layout = await t.call('write_map', { map: 'Books\n- Add item' }); assert.equal(layout.isError, true); assert.match(layout.text, /Not taken: Line 1/)
  assert.equal((await t.call('write_map', { map: '## Books (page)\n* "Name" box + "Add item": puts it on the list\n' })).text, 'Taken. Stop now.')
  const kept = t.read(); assert.equal(kept.refused, 2); assert.deepEqual(kept.report, { map: '## Books (page)\n- "Name" box + "Add item": puts it on the list\n' })
  await t.close()
})
test('map mode with an app that doesn\'t start: the tools say to stop without a map, not to call a tool it doesn\'t have', opts, async () => {
  const t = await tools('node nowhere.js', { mode: 'map', rules: path.join(import.meta.dirname, 'featuremap.ts'), cap: 3 })
  const r = await t.call('open', { path: '/' }); assert.equal(r.isError, true); assert.match(r.text, /There is nothing to look at: stop now, without a map\.$/)
  assert.doesNotMatch(r.text, /done/); assert.equal(t.read().started, false)
  await t.close()
})
