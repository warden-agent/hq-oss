// The board at three window widths, with each thing a user can open on it, checked for what the bug log keeps finding by eye: words cut off inside a
// button or a box, boxes on top of one another, a box whose content doesn't fit it, a page that scrolls sideways (Bugs 119, 120, 123, 175, 253, 270,
// 290). The notes had this as a script someone had to remember to run (a one-off script); here a cut-off button fails the suite.
// A real test HQ with fake agents (see harness.ts), the built page, HQ's own headless browser. Where the page isn't built or the browser isn't on
// the machine (the Docker image has none) every test skips and says why: the Mac's run is the one that counts for this file.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { headlessShell } from '../src/smoke.ts'
import { startHq, waitFor, exitPlanMode, sh, type Hq } from './harness.ts'

const WIDTHS = [1440, 1100, 820], HEIGHT = 900
const EXE = headlessShell()
const SKIP = !fs.existsSync(path.resolve(import.meta.dirname, '../../frontend/dist/index.html')) ? 'the page is not built (npm --workspace frontend run build)'
  : !EXE ? "HQ's browser is not on this machine" : false

let hq: Hq, browser: Browser, url = '', repoId = ''
before(async () => {
  if (SKIP) return
  hq = await startHq({ env: { HQ_FRESH_START_TIMEOUT_S: '600' } }); await hq.api('settings', { key: 'concurrency_cap', value: 20 })
  // A board with long names on it: a TPM, four tickets (one waiting on another), three engineers past their plans, one of them parked with a note
  const repo = (await hq.api('repos', { path: hq.repo('library-with-a-rather-long-repo-name') })).json; repoId = repo.id
  const f = (await hq.api('features', { repoId, title: 'Plan my week of meals so I never buy things twice', request: 'week plan' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const ticket = async (title: string, deps: string[] = []) => (await hq.api('tickets', { featureId: f.id, title, size: 'M', spec: `${title}.`, depends_on: deps })).json
  const building = async (t: any) => {
    const eng = (await hq.api(`tickets/${t.id}/launch`, {})).json
    await waitFor('its engineer', async () => (await hq.state()).agents.find((a: any) => a.id === eng.id)?.status === 'working')
    const b = (await hq.modNext(eng.id)).batch; await hq.modEvent(eng.id, { kind: 'batch_received', id: b.id }); await hq.hook(eng.id, { hook_event_name: 'UserPromptSubmit', prompt: b.text })
    const held = hq.hook(eng.id, exitPlanMode('Plan.'))
    const rv = await waitFor('its plan review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t.id && r.status === 'open'))
    await hq.api(`reviews/${rv.id}/answer`, { verdict: 'approve' }); await held; return eng
  }
  const t1 = await ticket('Pick books for each week of the term'); await ticket('Reading list from the term plan, minus what is already on the shelves', ['T-01'])
  const t3 = await ticket('Week view on the phone'), t4 = await ticket('Remember last week')
  const e1 = await building(t1), e3 = await building(t3), e4 = await building(t4)
  const measure = (id: string, tokens: number) => hq.modEvent(id, { kind: 'session.measure', usage: { context: { tokens, percent: 5 } } })
  await measure(tpm.id, 62_000); await measure(e1.id, 108_000); await measure(e3.id, 84_000); await measure(e4.id, 31_000)
  await hq.api(`agents/${e4.id}/fresh-start`, { then: 'park' })
  await hq.mcp(e4.id, 'write_handoff_note', { text: '## Where I stopped\n- Saving last week works; the list view is half done.\n## Left to do\n- Show it under the week plan.' })
  await waitFor('the parked ticket', async () => (await hq.state()).tickets.find((x: any) => x.id === t4.id).parked_at)
  // Something in the ⚠ menu: a plan waiting for the user's answer (its hook stays held to the end), and a turn that ended with an API error
  const t5 = await ticket('Let two people in one house share the same plan'), e5 = (await hq.api(`tickets/${t5.id}/launch`, {})).json
  await waitFor('its engineer', async () => (await hq.state()).agents.find((a: any) => a.id === e5.id)?.status === 'working')
  void hq.hook(e5.id, exitPlanMode('## Plan\n1. A shared plan has an owner and members.\n2. Whoever opens the week sees the same meals.')).catch(() => {})
  await waitFor('its plan review', async () => (await hq.state()).reviews.find((r: any) => r.ticket_id === t5.id && r.status === 'open'))
  await hq.hook(e3.id, { hook_event_name: 'StopFailure', error: 'overloaded_error: the model is overloaded, please try again in a few minutes' })
  await waitFor('the API error notice', async () => (await hq.state()).attention.some((a: any) => a.kind === 'api_error' && a.agent_id === e3.id))
  // The app, running, so the app pane has something to show
  await hq.api(`previews/${repoId}/command`, { command: 'npm start' }); assert.equal((await hq.api(`previews/${repoId}/start`, {})).status, 200)
  await waitFor('the app', async () => (await hq.state()).previews.find((p: any) => p.id === repoId)?.status === 'running', 20_000)
  url = `http://127.0.0.1:${hq.ports.ui}/?token=${fs.readFileSync(path.join(hq.hqHome, 'ui-token'), 'utf8').trim()}`
  browser = await (await import('playwright-core')).chromium.launch({ executablePath: EXE! })
})
after(async () => { await browser?.close(); await hq?.stop() })

/** What is wrong with the page as it stands, in words. Nothing: an empty list. */
const problems = (page: Page): Promise<string[]> => page.evaluate(() => {
  const out: string[] = [], words = (el: Element, n: number) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, n)
  for (const el of document.querySelectorAll<HTMLElement>('button, .react-flow__node .h-4, .pill')) {
    if (!el.offsetParent) continue // not shown
    if (el.scrollWidth > el.clientWidth + 1) out.push(`cut off: "${words(el, 50)}" (${el.scrollWidth} px of text in ${el.clientWidth})`)
  }
  const boxes = [...document.querySelectorAll('.react-flow__node')].map((n) => ({ t: words(n, 24), r: n.getBoundingClientRect() }))
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!.r, c = boxes[j]!.r
    if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) out.push(`boxes overlap: "${boxes[i]!.t}" and "${boxes[j]!.t}"`)
  }
  for (const n of document.querySelectorAll('.react-flow__node')) {
    const card = n.firstElementChild; if (card && card.scrollHeight > card.clientHeight + 1) out.push(`a box's content doesn't fit it: "${words(n, 30)}"`)
  }
  if (document.documentElement.scrollWidth > innerWidth) out.push(`the page scrolls sideways by ${document.documentElement.scrollWidth - innerWidth} px`)
  // A button outside the board (the header, a menu, a dialog, the side panel, the app pane) that hangs out of the window's side can't be clicked.
  // The board's own boxes may lie off its edge: it pans, and says how many are out of sight (Bug 284)
  for (const el of document.querySelectorAll<HTMLElement>('button')) {
    if (!el.offsetParent || el.closest('.react-flow')) continue
    const r = el.getBoundingClientRect(); if (!r.width || (r.left >= -1 && r.right <= innerWidth + 1)) continue
    out.push(`a button hangs out of the window: "${words(el, 40)}" (${Math.round(r.left)} to ${Math.round(r.right)} of ${innerWidth})`)
  }
  return out
})
/** The layout has stopped moving: the board's boxes, the panel and the header are where they were for ten frames in a row. The board glides
 *  to fit after every change (fit.ts), and a look before it has landed sees boxes that overlap or hang off the edge for a moment. */
const still = (page: Page) => page.waitForFunction(() => {
  const w = window as unknown as { hqSig?: string; hqSame?: number }
  const sig = [...document.querySelectorAll('.react-flow__node, header, main, aside, [role="dialog"], [role="menu"]')]
    .map((n) => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(',') }).join(';')
  if (w.hqSig === sig) w.hqSame = (w.hqSame ?? 0) + 1; else { w.hqSig = sig; w.hqSame = 0 }
  return w.hqSame >= 10
}, undefined, { polling: 'raf', timeout: 15_000 })

/** Bug 307: the board's zoom buttons lying over a box, in words (fit.ts keeps the view's boxes off them). */
const covered = (page: Page): Promise<string[]> => page.evaluate(() => {
  const zoom = document.querySelector('.react-flow__controls')?.getBoundingClientRect(); if (!zoom) return ['no zoom buttons found']
  return [...document.querySelectorAll('.react-flow__node')].filter((n) => { const r = n.getBoundingClientRect()
    return r.left < zoom.right - 1 && zoom.left < r.right - 1 && r.top < zoom.bottom - 1 && zoom.top < r.bottom - 1 })
    .map((n) => `the zoom buttons cover part of "${(n.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)}"`)
})
type Look = { panel: boolean; app: boolean; height?: number; then?: (page: Page) => Promise<void>; check?: (page: Page) => Promise<string[]> }
/** HQ_UISWEEP_SHOTS=<folder>: a picture of every view at every width goes there, for a person to look at what the checks looked at. */
const SHOTS = process.env.HQ_UISWEEP_SHOTS
let shot = 0
/** The page at one width with the side panel and the app pane as asked (the page remembers both in the browser's storage), `then` done, and
 *  the layout settled. The caller closes it. */
async function opened(width: number, look: Look): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: look.height ?? HEIGHT } })
  try {
    await page.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v) },
      { 'hq.panelOpen': look.panel ? '1' : '0', [`hq.preview.${repoId}`]: JSON.stringify({ open: look.app }) })
    await page.goto(url); await page.waitForSelector('.react-flow__node'); await still(page)
    if (look.then) { await look.then(page); await still(page) }
    return page
  } catch (e) { await page.close(); throw e }
}
/** Each width in turn: what is wrong with the page there, each line with its width. */
async function sweep(look: Look): Promise<string[]> {
  const found: string[] = []; shot++
  for (const width of WIDTHS) {
    const page = await opened(width, look)
    try {
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${String(shot).padStart(2, '0')}-${width}.png`) }) }
      for (const p of await (look.check ?? problems)(page)) found.push(`${width} px: ${p}`)
    } finally { await page.close() }
  }
  return found
}
const box = (page: Page, text: string) => page.locator('.react-flow__node', { hasText: text }).first()

test('each check sees a fault planted on the page, and the page as it is has none', { skip: SKIP }, async () => {
  const page = await opened(1100, { panel: true, app: false })
  try {
    assert.deepEqual(await problems(page), []); assert.deepEqual(await covered(page), [])
    const planted = async (what: RegExp, plant: () => void, check = problems) => {
      await page.evaluate(plant); const found = await check(page); assert.ok(found.some((p) => what.test(p)), `${what}: ${JSON.stringify(found)}`)
      await page.reload(); await page.waitForSelector('.react-flow__node'); await still(page)
    }
    await planted(/^cut off: "Sync" \(\d+ px of text in \d+\)$/, () => {
      const b = [...document.querySelectorAll<HTMLElement>('header button')].find((x) => x.textContent === 'Sync')!
      Object.assign(b.style, { width: '20px', padding: '0', overflow: 'hidden', whiteSpace: 'nowrap' })
    })
    await planted(/^boxes overlap: /, () => { const [a, b] = document.querySelectorAll<HTMLElement>('.react-flow__node'); b!.style.transform = a!.style.transform })
    await planted(/^a box's content doesn't fit it: /, () => {
      Object.assign((document.querySelector('.react-flow__node')!.firstElementChild as HTMLElement).style, { height: '20px', overflow: 'hidden' })
    })
    await planted(/^the page scrolls sideways by 300 px$/, () => {
      document.body.appendChild(Object.assign(document.createElement('div'), { style: `width: ${innerWidth + 300}px; height: 1px` }))
    })
    await planted(/^a button hangs out of the window: "×"/, () => { (document.querySelector('aside button[title="Close the panel"]') as HTMLElement).style.transform = 'translateX(60px)' })
    await planted(/^the zoom buttons cover part of /, () => {
      const zoom = document.querySelector<HTMLElement>('.react-flow__controls')!, r = document.querySelector('.react-flow__node')!.getBoundingClientRect()
      Object.assign(zoom.style, { position: 'fixed', left: `${r.left + 5}px`, top: `${r.top + 5}px`, bottom: 'auto', margin: '0' })
    }, covered)
  } finally { await page.close() }
})

test('the board by itself: nothing cut off, no boxes overlapping, no sideways scroll', { skip: SKIP }, async () => {
  assert.deepEqual(await sweep({ panel: false, app: false }), [])
})

test('the Sessions menu open', { skip: SKIP }, async () => {
  assert.deepEqual(await sweep({ panel: false, app: false, then: async (page) => { await page.getByRole('button', { name: /^Sessions/ }).click() } }), [])
})

test('the ⚠ menu open', { skip: SKIP }, async () => {
  const bell = 'header button[title="Plan reviews and things that need you"]' // its label changes with what is in it (⚠ 1, ℹ 2, ✓ 1)
  assert.deepEqual(await sweep({ panel: false, app: false, then: async (page) => { await page.locator(bell).click(); await page.getByText('overloaded_error').first().waitFor() } }), [])
})

test('the Fresh start dialog open', { skip: SKIP }, async () => {
  assert.deepEqual(await sweep({ panel: false, app: false, then: async (page) => { await page.locator('.react-flow__node button[title^="Fresh start"]').first().click() } }), [])
})

test('the side panel open on an engineer, each of its tabs in turn', { skip: SKIP }, async () => {
  for (const tab of [/^Agent: /, /^Ticket: /, /^Messages$/, /^Events$/]) {
    const found = await sweep({ panel: true, app: false, then: async (page) => { await box(page, 'Pick books').click(); await page.locator('aside').getByRole('button', { name: tab }).click() } })
    assert.deepEqual(found, [], String(tab))
  }
})

/** Picks the project's TPM from the Agents menu, as a user would with its box off the board: its name is the project's, the longest on this board. */
const pickTpm = async (page: Page) => { await page.getByRole('button', { name: /^Agents · / }).click(); await page.locator('button.card', { hasText: 'tpm · ' }).first().click() }

test('the side panel open on the agent with the longest name (Bug 290: its tab pushed "Ticket", "Messages" and "Events" into "Tick…")', { skip: SKIP }, async () => {
  assert.deepEqual(await sweep({ panel: true, app: false, then: pickTpm }), [], 'the side panel')
  assert.deepEqual(await sweep({ panel: true, app: true, then: pickTpm }), [], 'with the app pane open as well')
})

test('the app pane open, with and without the side panel', { skip: SKIP }, async () => {
  assert.deepEqual(await sweep({ panel: false, app: true }), [], 'the app pane alone')
  assert.deepEqual(await sweep({ panel: true, app: true, then: async (page) => { await box(page, 'Pick books').click() } }), [], 'with the side panel')
})

/** Bug 344: the zoom buttons anywhere but their usual bottom left corner of the board, in words. */
const moved = (page: Page): Promise<string[]> => page.evaluate(() => {
  const zoom = document.querySelector('.react-flow__controls')?.getBoundingClientRect(), pane = document.querySelector('.react-flow')?.getBoundingClientRect()
  if (!zoom || !pane) return ['no zoom buttons found']
  const left = Math.round(zoom.left - pane.left), up = Math.round(pane.bottom - zoom.bottom)
  return left < 40 && up < 40 ? [] : [`the zoom buttons left the bottom left corner (${left} px in, ${up} px up)`]
})

test('the zoom buttons cover no box, the side panel open (Bug 307), and stay in the bottom left corner (Bug 344)', { skip: SKIP }, async () => {
  assert.deepEqual(await sweep({ panel: true, app: false, check: async (page) => [...await covered(page), ...await moved(page)] }), [])
})

// Bug 344: at 820 px the app pane leaves the board 414×390 px, and the feature waiting on the user fills it at READABLE (Bug 119's floor), so no
// view keeps it whole and clear of the buttons in their bottom left corner: they move to a corner that is clear (fit.ts placeBoard, CROWDED).
// At 1440 and 1100 px they stay where they were.
test('the zoom buttons cover no box, with the board at its smallest (side panel and app pane open; Bug 344)', { skip: SKIP }, async () => {
  const check = async (page: Page) => [...await covered(page), ...(page.viewportSize()!.width > 820 ? await moved(page) : [])]
  assert.deepEqual(await sweep({ panel: true, app: true, check }), [])
})

/** Bug 365: the box with the plan waiting on the user not whole in the board, or its Approve out of sight, in words. */
const planShows = (page: Page): Promise<string[]> => page.evaluate(() => {
  const pane = document.querySelector('.react-flow')?.getBoundingClientRect(); if (!pane) return ['no board found']
  const n = [...document.querySelectorAll('.react-flow__node')].find((e) => /plan for you/.test(e.textContent ?? '')); if (!n) return ['no plan for you on the board']
  const inside = (r: DOMRect) => r.left >= pane.left - 0.5 && r.right <= pane.right + 0.5 && r.top >= pane.top - 0.5 && r.bottom <= pane.bottom + 0.5
  const approve = [...n.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Approve')
  return [...inside(n.getBoundingClientRect()) ? [] : [`the plan for you is cut or out of view (board ${Math.round(pane.width)}×${Math.round(pane.height)})`],
    ...approve && inside(approve.getBoundingClientRect()) ? [] : ['its Approve is out of sight']]
})

// Bug 365: a 700 px tall window with the side panel and the app pane open leaves the board about 280 px tall at 820 px. The feature waiting on the
// user doesn't fit there at the floor, and the view showed it from its top: T-05, the plan for you, was cut at the bottom with Approve out of sight.
test('the plan waiting on you shows whole, Approve in sight, with the board at its shortest (700 px window, side panel and app pane open; Bug 365)',
  { skip: SKIP }, async () => {
    assert.deepEqual(await sweep({ panel: true, app: true, height: 700, check: async (page) => [...await planShows(page), ...await problems(page)] }), [])
  })

// Bug 365 follow-up (the combined branch's UI tester): with finished work waiting to be merged above the plan, the view showed the first box waiting
// on the user in board order (T-01, to merge) and the plan, which holds an engineer up, sat below it. Runs last: it finishes T-01 on the board.
test('a plan waiting on you comes before finished work to merge, the board at its shortest (Bug 365 follow-up)', { skip: SKIP }, async () => {
  const s = await hq.state(), t1 = s.tickets.find((t: any) => t.key === 'T-01'), dir = s.repos.find((r: any) => r.id === repoId).path
  const eng = s.agents.find((a: any) => a.role === 'engineer' && a.ticket_id === t1.id && a.status === 'working')
  const wt = path.join(dir, '.claude', 'worktrees', 'T-01')
  fs.writeFileSync(path.join(wt, 'books.txt'), 'books\n'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'books')
  assert.equal((await hq.mcp(eng.id, 'update_handoff', { kind: 'before_pr', text: 'done' })).isError, false)
  const r = await hq.mcp(eng.id, 'open_pr', { title: 'Pick books', body: 'Picks books.\n\n## Deviations from approved plan\nNone' }); assert.equal(r.isError, false, r.text)
  await waitFor('T-01 ready to merge', async () => (await hq.state()).tickets.find((t: any) => t.id === t1.id).status === 'pr_ready')
  const check = async (page: Page) => [...await planShows(page), ...await problems(page)]
  for (const height of [700, 900]) assert.deepEqual(await sweep({ panel: true, app: true, height, check }), [], `${height} px tall`)
})
