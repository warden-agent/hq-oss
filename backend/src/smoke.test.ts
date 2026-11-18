// HQ's look at a built app, for real (smoke.ts, smokerun.mjs): a small app started from a launch recipe inside HQ's test sandbox, its pages opened in HQ's own
// headless browser. These need that browser on the machine: they run when it is already there (HQ downloads it at its first look), or with HQ_TEST_BROWSER=1,
// which downloads it (about 180 MB, once). Without it they are skipped, and say so; the rules are tested without a browser in smokerules.test.ts, and auto
// mode's use of the look end to end in e2e/auto.test.ts with a stand-in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-smoke-'))
process.env.HQ_LOOK_START_S = '4' // an app that never answers is given up on after this long here
const { browserHere, ensureBrowser, lookIn, lookHow } = await import('./smoke.ts')
const { runSandboxed, sandboxProblem } = await import('./testrun.ts')
const { allProblems } = await import('./smokerules.ts')

const cant = !browserHere() && process.env.HQ_TEST_BROWSER !== '1' ? "HQ's browser isn't on this machine yet (HQ_TEST_BROWSER=1 downloads it)" : await sandboxProblem()
const opts = { skip: cant ?? false, timeout: 120_000 }
const SERVER = `const http = require('node:http')
const pages = {
  '/': '<title>Library</title><h1>Library</h1><a href="/about">About</a> <a href="/broken">Broken</a> <a href="/logout">Log out</a>'
    + '<a href="https://example.invalid/away">Away</a>',
  '/about': '<title>About</title><p>A library app.</p><a href="/deep">Deeper</a>',
  '/broken': '<title>Broken</title><h1>Broken</h1><script>fetch("/api/missing"); console.error("boom from the page"); null.x</script>',
  '/deep': '<title>Deep</title><p>Two steps from the start.</p>',
  '/logout': '<title>Bye</title><p>Logged out.</p>',
}
if (process.env.DIE) { console.error('Error: Cannot find module ./routes'); process.exit(1) }
if (!process.env.SILENT) http.createServer((q, s) => {
  const p = pages[q.url]; if (!p) { s.writeHead(404); return s.end('no') }
  const cdn = '<script src="https://cdn.example.invalid/lib.js"></script><div id="root"></div>' // a page that is nothing without its library
  s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html>' + (process.env.CDN && q.url === '/' ? cdn : p))
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening on', process.env.PORT))
else setInterval(() => {}, 1000)
`
/** A folder with the app in it, as a test run's checkout would have, and a one-part recipe that runs it. */
function app(run = 'node server.js', port: number | 'auto' = 'auto') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-smoke-app-'))); fs.writeFileSync(path.join(dir, 'server.js'), SERVER)
  const recipe = { parts: [{ name: 'app', dir: '.', run, port }], show: 'app', worktree_files: [], notes: '' }
  return { dir, plan: { recipe, repoPath: dir, how: lookHow(recipe) } }
}
const named = (word: string) => execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(word))
async function waitGone(word: string): Promise<void> {
  for (const end = Date.now() + 5000; Date.now() < end;) { if (!named(word).length) return; await new Promise((r) => setTimeout(r, 100)) }
  assert.deepEqual(named(word), [])
}
const look = (a: ReturnType<typeof app>) => lookIn(a.dir, a.plan, { signal: new AbortController().signal, run: runSandboxed })

test('the browser is fetched once, and found without a download after that', opts, async () => {
  assert.equal(await ensureBrowser(), null); assert.equal(browserHere(), true)
})
test('a look at a running app: its pages one link deep, what each showed, and nothing left running or written outside the checkout', opts, async () => {
  const a = app(), seen = await look(a); assert.ok(seen.kind === 'looked', JSON.stringify(seen))
  assert.deepEqual(seen.pages.map((p) => p.path), ['/', '/about', '/broken']) // not /logout (it reads like it ends something), not another site, not two steps deep
  const [home, about, broken] = seen.pages
  assert.deepEqual({ ...home, text: home!.text > 0 }, { path: '/', title: 'Library', text: true, things: 0, console: [], errors: [], failed: [], bad: [], outside: [] })
  assert.equal(about!.title, 'About'); assert.deepEqual(allProblems({ ...seen, pages: [home!, about!] }), [])
  assert.deepEqual(broken!.console, ['boom from the page']); assert.match(broken!.errors[0]!, /Cannot read properties of null/)
  assert.deepEqual(broken!.bad, [{ status: 404, method: 'GET', url: '/api/missing' }])
  assert.deepEqual(fs.readdirSync(a.dir).sort(), ['.hq-look.json', 'server.js']) // its one file, in the checkout that is thrown away
  // the app, the runner and the browser went with the run: nothing still has the checkout's name on its command line (the runner's spec names it)
  await waitGone(path.basename(a.dir))
})
test('a page that loads from another site says which, so what it logged isn\'t held against it', opts, async () => {
  const seen = await look(app('CDN=1 node server.js')); assert.ok(seen.kind === 'looked', JSON.stringify(seen))
  assert.deepEqual(seen.pages[0]!.outside, ['cdn.example.invalid']); assert.equal(seen.pages[0]!.text, 0); assert.deepEqual(allProblems(seen), [])
})
test('an app that stops as it starts, or never answers, is told apart from one HQ couldn\'t look at', opts, async () => {
  const died = await look(app('DIE=1 node server.js')); assert.ok(died.kind === 'no_start', JSON.stringify(died))
  assert.equal(died.why, 'its app part stopped (1) while the app was starting'); assert.match(died.output, /Cannot find module \.\/routes/)
  const silent = await look(app('SILENT=1 node server.js')); assert.ok(silent.kind === 'no_start', JSON.stringify(silent))
  assert.match(silent.why, /^nothing answered on port \d+ within 4 s$/)
  const held = net.createServer(); await new Promise<void>((r) => held.listen(0, '127.0.0.1', r)) // a port the project hard-wires, held by something else
  const port = (held.address() as net.AddressInfo).port, busy = await look(app('node server.js', port)); held.close()
  assert.deepEqual(busy, { kind: 'skipped', why: `port ${port}, which its app part always uses, is taken (the app may be running in the preview)` })
})
test('a look that auto mode stops says nothing', opts, async () => {
  const a = app('SILENT=1 node server.js'), c = new AbortController(); setTimeout(() => c.abort(), 700)
  assert.deepEqual(await lookIn(a.dir, a.plan, { signal: c.signal, run: runSandboxed }), { kind: 'stopped' })
})
