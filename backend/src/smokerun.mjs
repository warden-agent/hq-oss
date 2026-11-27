// HQ's look at a built app (smoke.ts): starts the app's parts as its launch recipe says, opens its pages in a headless browser, and writes down what it saw.
// HQ runs `node smokerun.mjs <spec json>` inside its test sandbox (testrun.ts), in the run's own throwaway checkout: localhost only, no credentials, nothing
// writable outside that checkout and the run's temp folder. What's wrong with what it saw is decided by HQ (smokerules.ts), not here.
// Plain Node with no imports from HQ; the browser is HQ's own playwright-core, whose folder is in the spec.
// spec: { parts: [{ name, cwd, run, port: number | 'auto' }], show, out, pwCore, startMs, pageMs, maxPages, depth }
import fs from 'node:fs'
import path from 'node:path'
import { allowPorts, startApp } from './appstart.mjs'

const spec = JSON.parse(process.argv[2])
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const cut = (s, n = 300) => String(s).replace(ANSI, '').slice(0, n)
let ended = false, browser = null, kids = []
/** Writes the result where HQ reads it and ends. Always exit 0: a result was written, whatever it says. The app's parts are in this process's group, and
 *  whoever ran this ends the whole group once it has gone (testrun.ts runSandboxed), so what a part started goes too. */
async function finish(result) {
  if (ended) return; ended = true
  fs.writeFileSync(spec.out, JSON.stringify(result))
  await browser?.close().catch(() => {})
  for (const k of kids) { try { k.kill('SIGKILL') } catch { /* gone */ } }
  process.exit(0)
}

try {
  const t0 = Date.now(), app = await startApp(spec); kids = app.kids
  if (!app.port) await finish(app.kind === 'skipped' ? { kind: 'skipped', why: app.why } : { kind: 'no_start', why: app.why, output: app.output })
  const port = app.port
  const { chromium } = await import(path.join(spec.pwCore, 'index.mjs'))
  // The app's own ports, even one browsers refuse (Bug 433)
  try { browser = await chromium.launch({ headless: true, args: allowPorts([port, ...Object.values(app.ports)]) }) } catch (e) {
    await finish({ kind: 'skipped', why: `HQ's browser didn't start (${cut(String(e.message).split('\n')[0], 200)})` })
  }
  const origin = `http://localhost:${port}`, ctx = await browser.newContext()
  const local = (url) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) } catch { return true } } // the app's own parts
  const rel = (url) => url.startsWith(origin) ? url.slice(origin.length) || '/' : url
  const queue = [{ at: '/', depth: 0 }], seen = new Set(['/']), pages = []
  while (queue.length && pages.length < spec.maxPages) {
    const { at, depth } = queue.shift(), page = await ctx.newPage()
    const p = { path: at, title: '', text: 0, things: 0, console: [], errors: [], failed: [], bad: [], outside: [] }
    const add = (list, x) => { if (list.length < 10) list.push(x) }
    // The browser logs every failed request as a console error too: the request itself is what's kept, once.
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) add(p.console, cut(m.text())) })
    page.on('pageerror', (e) => add(p.errors, cut(e.message)))
    page.on('crash', () => add(p.errors, 'the page crashed'))
    page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? ''; if (/ERR_ABORTED/.test(why)) return // the page moved on before it finished
      if (!local(r.url())) { const host = new URL(r.url()).hostname; if (!p.outside.includes(host)) add(p.outside, host); return } // no internet in here
      add(p.failed, { url: `${r.method()} ${cut(rel(r.url()), 200)}`, why: why.replace(/^net::/, '') })
    })
    page.on('response', (r) => {
      if (r.status() < 400 || !local(r.url()) || /\/favicon\.ico$/.test(new URL(r.url()).pathname)) return // a missing favicon is no problem
      add(p.bad, { status: r.status(), method: r.request().method(), url: cut(rel(r.url()), 200) })
    })
    try {
      await page.goto(origin + at, { waitUntil: 'load', timeout: spec.pageMs })
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}) // a page that keeps a connection open never goes quiet: looked at as it is
      const looks = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? '').trim().length,
        things: document.body?.querySelectorAll('img,svg,canvas,video,input,button,select,textarea,iframe').length ?? 0,
        links: [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: a.textContent ?? '', download: a.hasAttribute('download') })) }))
      p.title = cut(looks.title, 100); p.text = looks.text; p.things = looks.things
      // The pages its links lead to, one step further each time. Never a link that reads like it ends or deletes something.
      if (depth < spec.depth) for (const l of looks.links) {
        if (l.download || !l.href.startsWith(`${origin}/`) || /log.?out|sign.?out|delete|remove/i.test(l.href + l.text)) continue
        const u = new URL(l.href), key = u.pathname + u.search
        if (!seen.has(key) && seen.size < 200) { seen.add(key); queue.push({ at: key, depth: depth + 1 }) }
      }
    } catch (e) { p.load = cut(String(e.message).split('\n')[0], 200) }
    pages.push(p); await page.close().catch(() => {})
  }
  await finish({ kind: 'looked', pages, ms: Date.now() - t0 })
} catch (e) { await finish({ kind: 'skipped', why: `HQ's look at the app broke off (${cut(String(e?.message ?? e).split('\n')[0], 200)})` }) }
