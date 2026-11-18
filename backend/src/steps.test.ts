// A replay's steps and its look at the page afterwards (steps.mjs), on a real page in HQ's headless browser: the steps as the UI tester kept them (from the
// code its browser tools ran), put through the loop's translation (loopparts.ts), are steps the scripted runner can do. Needs HQ's browser on the machine, as
// smoke.test.ts does: it runs when the browser is already there, or with HQ_TEST_BROWSER=1; otherwise it is skipped, and says so.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error plain JS module, no types
import { holds, runStep, stepLabel } from './steps.mjs'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-steps-'))
const { browserHere, ensureBrowser, headlessShell } = await import('./smoke.ts')
const { stepOf } = await import('./uitesterrules.ts')
const { loopExpect, loopStep } = await import('./loopparts.ts')
const cant = !browserHere() && process.env.HQ_TEST_BROWSER !== '1' ? "HQ's browser isn't on this machine yet (HQ_TEST_BROWSER=1 downloads it)" : null

const PAGE = `<!doctype html><title>Library</title><h1>Library</h1>
<label>Title <input id="t"></label> <input id="s" placeholder="Search books"> <label><input type="checkbox" id="c" checked> Due soon</label>
<select aria-label="Shelf" id="sh"><option>Fiction</option><option>History</option></select>
<button onclick="setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<div role=alert>' + document.getElementById('t').value + ' added</div>') }, 150)">Add</button>
<p id="h" onmouseover="this.textContent = 'pointed at'">Borrow</p>`

test('a replay does the tester\'s steps (typing into a field named by its label or placeholder, unticking, pointing, picking) and then looks for what should be on the page',
  { skip: cant ?? false, timeout: 120_000 }, async () => {
    assert.equal(await ensureBrowser(), null)
    const app = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(PAGE) }); await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`
    const { chromium } = await import('playwright-core'), browser = await chromium.launch({ headless: true, executablePath: headlessShell()! })
    try {
      const page = await (await browser.newContext()).newPage()
      // As the tester's browser tools ran them (Playwright MCP's own code), kept by HQ (stepOf), read by the loop (loopStep)
      const ran = [`await page.goto('http://localhost:1234/');`, `await page.getByLabel('Title').fill('Dune');`, `await page.getByPlaceholder('Search books').fill('emma');`,
        `await page.getByRole('checkbox', { name: 'Due soon' }).uncheck();`, `await page.getByRole('combobox', { name: 'Shelf' }).selectOption(['History']);`,
        `await page.getByText('Borrow').hover();`, `await page.getByRole('button', { name: 'Add' }).click();`]
      const steps = ran.map((c) => loopStep(stepOf(c, 'http://localhost:1234')!))
      assert.deepEqual(steps.map(stepLabel), ['open /', 'type "Dune" into "Title"', 'type "emma" into "Search books"', 'uncheck checkbox "Due soon"', 'choose "History" in combobox "Shelf"',
        'hover "Borrow"', 'click button "Add"'])
      const seen = [{ role: 'alert', visible: false }], want = loopExpect(seen)! // the tester found no alert: once fixed, there is one
      for (const s of steps.slice(0, -1)) await runStep(page, s, origin, 3000)
      assert.deepEqual(await page.evaluate(() => [(document.getElementById('t') as HTMLInputElement).value, (document.getElementById('s') as HTMLInputElement).value,
        (document.getElementById('c') as HTMLInputElement).checked, (document.getElementById('sh') as HTMLSelectElement).value, document.getElementById('h')!.textContent]),
      ['Dune', 'emma', false, 'History', 'pointed at'])
      assert.deepEqual(await holds(page, want[0], 300), { ok: false, why: 'it isn\'t on the page' }) // before the click: still broken
      await runStep(page, steps.at(-1), origin, 3000)
      assert.deepEqual(await holds(page, want[0], 3000), { ok: true }) // it shows a moment after the click: the look waits for it
      assert.deepEqual(await holds(page, { text: 'Dune added', visible: true }, 3000), { ok: true })
      assert.deepEqual(await holds(page, { role: 'alert', visible: false }, 300), { ok: false, why: 'it is still on the page' })
      assert.deepEqual(await holds(page, { role: 'button', name: 'Remove', visible: false }, 300), { ok: true }); assert.equal((await holds(page, { visible: true }, 300)).ok, false)
      await assert.rejects(runStep(page, { action: 'click', role: 'button', name: 'Gone' }, origin, 300), /Timeout/) // a step that no longer fits the app
    } finally { await browser.close(); app.close() }
  })

const LIST = `<!doctype html><title>Library</title><input id="n" aria-hidden="true"><ul id="l"><li>Dune <button>Remove</button></li><li>Emma <button>Remove</button></li>
<li>Ulysses <button>Remove</button></li></ul><script>document.getElementById('l').onclick = (e) => { if (e.target.tagName === 'BUTTON') e.target.parentElement.remove() }</script>`
test('Bug 173: a step the tester\'s browser ran through locator(\'<selector>\') is replayed on that selector and the match it took',
  { skip: cant ?? false, timeout: 120_000 }, async () => {
    assert.equal(await ensureBrowser(), null)
    const app = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(LIST) }); await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`
    const { chromium } = await import('playwright-core'), browser = await chromium.launch({ headless: true, executablePath: headlessShell()! })
    try {
      const page = await (await browser.newContext()).newPage()
      const ran = [`await page.goto('http://localhost:1234/');`, `await page.locator('button:has-text("Remove")').first().click();`,
        `await page.locator('#l').locator('button').last().click();`, `await page.locator('#n').fill('bread');`]
      const steps = ran.map((c) => loopStep(stepOf(c, 'http://localhost:1234')!))
      assert.deepEqual(steps.map(stepLabel), ['open /', 'click button:has-text("Remove")', 'click #l >> button (the last)', 'type "bread" into #n'])
      for (const s of steps) await runStep(page, s, origin, 3000)
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('li')].map((l) => l.firstChild!.textContent!.trim())), ['Emma']) // the first, then the last
      assert.equal(await page.evaluate(() => (document.getElementById('n') as HTMLInputElement).value), 'bread')
      await assert.rejects(runStep(page, { action: 'click' }, origin, 300), /needs a role and name, a text, or a selector/) // nothing to go by: says so, as before
    } finally { await browser.close(); app.close() }
  })

const ROWS = `<!doctype html><title>Library</title><button onclick="document.getElementById('o').textContent = 'all'">Clear all</button>
<button onclick="document.getElementById('o').textContent = 'one'">Clear</button><output id="o"></output><input data-testid="note">
<ul id="l">${['Dune', 'Ulysses', 'Emma', 'Beloved', 'Walden'].map((n) => `<li>${n} <button>Edit</button> <button>Remove</button></li>`).join('')}</ul>
<script>document.getElementById('l').onclick = (e) => { if (e.target.textContent === 'Remove') e.target.parentElement.remove() }</script>`
test('Bug 198: a step on one of several same buttons is replayed on that one: inside the row it was in, or the match it took',
  { skip: cant ?? false, timeout: 120_000 }, async () => {
    assert.equal(await ensureBrowser(), null)
    const app = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(ROWS) }); await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`
    const { chromium } = await import('playwright-core'), browser = await chromium.launch({ headless: true, executablePath: headlessShell()! })
    const left = (page: import('playwright-core').Page) => page.evaluate(() => [...document.querySelectorAll('li')].map((l) => l.firstChild!.textContent!.trim()))
    try {
      const page = await (await browser.newContext()).newPage()
      const ran = [`await page.goto('http://localhost:1234/');`,
        `await page.getByRole('listitem').filter({ hasText: 'Ulysses' }).getByRole('button', { name: 'Remove' }).click();`, // as Playwright MCP's generator writes it
        `await page.getByRole('button', { name: 'Remove' }).nth(1).click();`, // the 2nd Remove now: Emma's
        `await page.getByRole('listitem').filter({ hasText: /^Walden/ }).locator('button').last().click();`,
        `await page.getByRole('button', { name: 'Remove' }).last().click();`, // Beloved's
        `await page.getByRole('button', { name: 'Clear', exact: true }).click();`, `await page.getByTestId('note').fill('hi');`]
      const steps = ran.map((c) => loopStep(stepOf(c, 'http://localhost:1234')!))
      assert.deepEqual(steps.map(stepLabel), ['open /', 'click button "Remove"', 'click button "Remove" (match 2)',
        'click internal:role=listitem >> internal:has-text=/^Walden/ >> button (the last)', 'click button "Remove" (the last)', 'click button "Clear"', 'type "hi" into "note"'])
      for (const s of steps.slice(0, 2)) await runStep(page, s, origin, 3000)
      assert.deepEqual(await left(page), ['Dune', 'Emma', 'Beloved', 'Walden']) // Ulysses's Remove, not the first row's
      await runStep(page, steps[2], origin, 3000); assert.deepEqual(await left(page), ['Dune', 'Beloved', 'Walden'])
      await runStep(page, steps[3], origin, 3000); assert.deepEqual(await left(page), ['Dune', 'Beloved'])
      await runStep(page, steps[4], origin, 3000); assert.deepEqual(await left(page), ['Dune'])
      for (const s of steps.slice(5)) await runStep(page, s, origin, 3000)
      assert.deepEqual(await page.evaluate(() => [document.getElementById('o')!.textContent, (document.querySelector('[data-testid=note]') as HTMLInputElement).value]),
        ['one', 'hi'])
    } finally { await browser.close(); app.close() }
  })
