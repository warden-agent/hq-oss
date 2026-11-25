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
const { migrate } = await import('./db.ts'); migrate() // who has a port (Bug 374) is read from HQ's own records first
const { browserHere, ensureBrowser, lookIn, lookHow } = await import('./smoke.ts')
const { runSandboxed, sandboxProblem } = await import('./testrun.ts')
const { allProblems, judge } = await import('./smokerules.ts')

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
})

// Bug 374: a port the project hard-wires, held by something else while HQ looks (its own preview of the same app, nearly always). A look-alike of the
// project it was found on: an api part started on a fixed port, and a web part whose config sends /api to that port's address. `holder` stands for the
// preview: it answers "preview" on the fixed port, outside the sandbox, and counts the requests it gets (HQ's own "is this port in use?" connects and
// says nothing, so it isn't one).
const API = `const http = require('node:http'), port = Number(process.argv[process.argv.indexOf('--port') + 1])
http.createServer((q, s) => s.end('copy')).listen(port, '127.0.0.1', () => console.log('api on', port))
`
const WEB = (target: string) => `const http = require('node:http'), api = ${target}
const PAGE = '<!doctype html><title>loading</title><h1>Library</h1><script>fetch("/api/who").then((r) => r.text()).then((t) => { document.title = "who: " + t })</script>'
http.createServer((q, s) => {
  if (!q.url.startsWith('/api/')) { s.writeHead(200, { 'content-type': 'text/html' }); return s.end(PAGE) }
  http.get(api + q.url, (r) => r.pipe(s)).on('error', (e) => { s.writeHead(502); s.end('no api: ' + e.code) })
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('web on', process.env.PORT))
`
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'ignore' })
async function holder() {
  let asked = 0; const s = net.createServer((c) => { c.on('error', () => {})
    c.once('data', () => { asked++; c.end('HTTP/1.1 200 OK\r\ncontent-length: 7\r\nconnection: close\r\n\r\npreview') }) })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return { port: (s.address() as net.AddressInfo).port, asked: () => asked, close: () => new Promise((r) => s.close(r)) } // resolved once the port is free again
}
/** The split app as a test run's checkout has it (a git checkout), its api part hard-wired to `port`. `target`: how web.js writes where the api is.
 *  `api`: another api.js, started with a plain `node api.js` (the port is not in its start command then). */
function split(port: number, target: (port: number) => string, api?: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-smoke-split-')))
  fs.writeFileSync(path.join(dir, 'api.js'), api ?? API); fs.writeFileSync(path.join(dir, 'web.js'), WEB(target(port))); fs.writeFileSync(path.join(dir, 'limits.js'), `exports.MAX_CHARS = ${port}\n`)
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'app')
  const recipe = { parts: [{ name: 'api', dir: '.', run: api ? 'node api.js' : `node api.js --port ${port}`, port: port as number | 'auto' },
    { name: 'web', dir: '.', run: 'node web.js', port: 'auto' as number | 'auto' }], show: 'web', worktree_files: [], notes: '' }
  return { dir, plan: { recipe, repoPath: dir, how: lookHow(recipe) } }
}
const SERVE = "http.createServer((q, s) => s.end('copy'))"
/** An api that takes its port from PORT, with the project's own as the fallback: HQ gives every part PORT, so the fallback is never read. */
const API_FALLBACK = (port: number) => `const http = require('node:http')\nconst port = process.env.PORT || ${port}\n${SERVE}.listen(port, '127.0.0.1', () => console.log('api on', port))\n`
/** An api that takes its port from somewhere HQ can't see (a tool's own default, in real life): it asks for the old port whatever HQ does. `alive`: under a
 *  watcher, which keeps the part running after its server failed. */
const API_UNSEEN = (port: number, alive = false) => `const http = require('node:http'), mine = ${port - 1} + 1\nconst s = ${SERVE}\n`
  + (alive ? "s.on('error', (e) => console.error('listen failed:', e.code)); setInterval(() => {}, 1000)\n" : '') + "s.listen(mine, '127.0.0.1', () => console.log('api on', mine))\n"
const onMac = { skip: opts.skip || (process.platform === 'darwin' ? false : 'macOS only: on Linux a run has a network of its own, where the port is free'), timeout: 120_000 }

test('Bug 374: an app whose hard-wired port is in use is opened on another port, in the checkout only, and its page talks to its own api', onMac, async () => {
  const h = await holder()
  try {
    const a = split(h.port, (p) => `'http://127.0.0.1:${p}'`), seen = await look(a); assert.ok(seen.kind === 'looked', JSON.stringify(seen))
    assert.equal(seen.pages[0]!.title, 'who: copy'); assert.deepEqual(allProblems(seen), []) // its own api answered, not whoever has the port
    assert.equal(h.asked(), 0, 'nothing of the run reached the program that has the port')
    const [m] = seen.moved!; assert.deepEqual({ ...m, by: '' }, { part: 'api', from: h.port, to: m!.to, by: '', fix: 'Stop it, then test again' }); assert.notEqual(m!.to, h.port)
    assert.match(m!.by, /^node in .+ \(pid \d+\)$/) // this test's own server: no preview of HQ's has the port here
    // in the checkout, the one address changed and nothing else; the plan the caller holds still names the project's own port
    assert.equal(fs.readFileSync(path.join(a.dir, 'web.js'), 'utf8'), WEB(`'http://127.0.0.1:${m!.to}'`))
    assert.equal(fs.readFileSync(path.join(a.dir, 'limits.js'), 'utf8'), `exports.MAX_CHARS = ${h.port}\n`)
    assert.equal(a.plan.recipe.parts[0]!.port, h.port); await waitGone(path.basename(a.dir))
  } finally { await h.close() }
})
test('Bug 374: a place HQ missed fails in the sandbox; it never reaches whoever has the port', onMac, async () => {
  const h = await holder()
  try { // the port in two halves no rule could find: HQ moves the api, and the page's calls to the old port are refused
    const a = split(h.port, (p) => `'http://127.0.0.1:' + (${p - 1} + 1)`), seen = await look(a); assert.ok(seen.kind === 'looked', JSON.stringify(seen))
    assert.equal(seen.pages[0]!.title, 'who: no api: EPERM'); assert.equal(h.asked(), 0)
    assert.deepEqual(seen.pages[0]!.bad, [{ status: 502, method: 'GET', url: '/api/who' }]) // and the look says so
  } finally { await h.close() }
})
test('Bug 374: a port written a way HQ can\'t rewrite safely is left where it is, and the look says who has it and what to do', onMac, async () => {
  const h = await holder()
  try {
    const a = split(h.port, (p) => `'http://' + host + ':${p}', host = '127.0.0.1'`), busy = await look(a); assert.ok(busy.kind === 'skipped', JSON.stringify(busy))
    assert.match(busy.why, new RegExp(`^port ${h.port}, which its api part always uses, is in use by node in .+ \\(pid \\d+\\)\\. HQ couldn't run its own copy on another port: `
      + `web\\.js line 1 names ${h.port} in a way HQ can't safely change\\. Stop it, then test again$`))
    assert.equal(h.asked(), 0); assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: a.dir, encoding: 'utf8' }), '')
  } finally { await h.close() }
})
test('Bug 374: a fallback for PORT doesn\'t stop a move: the api takes the port HQ gives it, and the page talks to it', onMac, async () => {
  const h = await holder()
  try {
    const a = split(h.port, (p) => `'http://127.0.0.1:${p}'`, API_FALLBACK(h.port)), seen = await look(a); assert.ok(seen.kind === 'looked', JSON.stringify(seen))
    assert.equal(seen.pages[0]!.title, 'who: copy'); assert.deepEqual(allProblems(seen), []); assert.equal(h.asked(), 0)
    assert.equal(seen.moved![0]!.from, h.port); assert.equal(fs.readFileSync(path.join(a.dir, 'api.js'), 'utf8'), API_FALLBACK(h.port)) // the fallback is left as written
  } finally { await h.close() }
})
// The copy's server took its port from somewhere HQ didn't see, so it asks for the old one and is refused it. Whether it then stops or a watcher keeps it
// alive, the app counts as not started, and the verdict is about the port (who has it, what to do), never about the code, and never "this app is dead".
test('Bug 374: a moved copy that doesn\'t take its new port counts as not started, and the look says who has the port and what to do', onMac, async () => {
  const h = await holder()
  try {
    for (const [alive, why] of [[false, 'its api part stopped \\(1\\) while the app was starting'], [true, "its api part wasn't listening on port \\d+ after 4 s"]] as const) {
      const a = split(h.port, (p) => `'http://127.0.0.1:${p}'`, API_UNSEEN(h.port, alive)), seen = await look(a); assert.ok(seen.kind === 'no_start', JSON.stringify(seen))
      assert.match(seen.why, new RegExp(`^${why}$`)); assert.equal(seen.moved![0]!.from, h.port); assert.equal(h.asked(), 0)
      const words = new RegExp(`^port ${h.port}, which its api part always uses, is in use by node in .+ \\(pid \\d+\\)\\. HQ ran its own copy on port ${seen.moved![0]!.to} instead, `
        + `and the app didn't start there \\(${why}\\)\\. Stop it, then test again$`)
      const verdict = judge(seen, seen, 'main'); assert.ok(verdict.ran === 'skipped' && !verdict.dead, JSON.stringify(verdict)); assert.match(verdict.why, words)
      await waitGone(path.basename(a.dir))
    }
  } finally { await h.close() }
})
test('Bug 374: with its port free the app runs on it, untouched', opts, async () => {
  const h = await holder(), port = h.port; await h.close()
  const a = split(port, (p) => `'http://127.0.0.1:${p}'`), seen = await look(a); assert.ok(seen.kind === 'looked', JSON.stringify(seen))
  assert.equal(seen.pages[0]!.title, 'who: copy'); assert.equal(seen.moved, undefined)
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: a.dir, encoding: 'utf8' }), '')
})
// Bug 388: a part HQ didn't move (its port free, or `auto`) that is slow to listen, as an api opening its database is. The look waited for the page alone
// and opened it while the api wasn't there yet: the page's calls got 502s, and the look could still pass.
const API_LATE = (ms: number | null) => `const http = require('node:http'), port = Number(process.env.PORT)
const s = ${SERVE}; ${ms === null ? 'setInterval(() => {}, 1000)' : `setTimeout(() => s.listen(port, '127.0.0.1', () => console.log('api on', port)), ${ms})`}
`
test('Bug 388: every part is listening before the look opens the page, not only the moved ones; one that never does is named', opts, async () => {
  const h = await holder(), port = h.port; await h.close()
  const late = split(port, (p) => `'http://127.0.0.1:${p}'`, API_LATE(1500))
  const seen = await look(late); assert.ok(seen.kind === 'looked', JSON.stringify(seen)); assert.equal(seen.moved, undefined)
  assert.equal(seen.pages[0]!.title, 'who: copy'); assert.deepEqual(allProblems(seen), []) // the api answered the page's first call
  const never = split(port, () => `'http://127.0.0.1:' + process.env.HQ_PORT_API`, API_LATE(null)); never.plan.recipe.parts[0]!.port = 'auto'
  const dead = await look(never); assert.ok(dead.kind === 'no_start', JSON.stringify(dead))
  assert.match(dead.why, /^its api part wasn't listening on port \d+ after 4 s$/); await waitGone(path.basename(never.dir))
})
test('a look that auto mode stops says nothing', opts, async () => {
  const a = app('SILENT=1 node server.js'), c = new AbortController(); setTimeout(() => c.abort(), 700)
  assert.deepEqual(await lookIn(a.dir, a.plan, { signal: c.signal, run: runSandboxed }), { kind: 'stopped' })
})
