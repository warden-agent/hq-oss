// The rules for HQ's look at the built app (smokerules.ts): what counts as a problem on a page, what is the ticket's doing and what main already had, when HQ
// says it couldn't look instead of blaming the ticket, and the words for each.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allProblems, judge, lookReport, lookWords, movedNoStart, movedWords, needsBase, newProblems, problemsOf, type PageSeen, type Seen } from './smokerules.ts'

const page = (o: Partial<PageSeen> = {}): PageSeen => ({ path: '/', title: 'Library', text: 40, things: 2, console: [], errors: [], failed: [], bad: [], outside: [], ...o })
const looked = (...pages: PageSeen[]): Seen => ({ kind: 'looked', pages, ms: 1200 })
const BROKEN = page({ path: '/list', console: ['boom from the page'], errors: ["Cannot read properties of null (reading 'x')"], bad: [{ status: 404, method: 'GET', url: '/api/missing' }],
  failed: [{ url: 'POST /api/save', why: 'ERR_CONNECTION_REFUSED' }] })

test('what is wrong with a page: its server\'s bad answers, requests with no answer, errors, and a blank page', () => {
  assert.deepEqual(problemsOf(page()), [])
  assert.deepEqual(problemsOf(BROKEN).map((x) => x.text), ['GET /api/missing answered 404', 'POST /api/save got no answer (ERR_CONNECTION_REFUSED)',
    "error on the page: Cannot read properties of null (reading 'x')", 'error in the console: boom from the page'])
  assert.deepEqual(problemsOf(page({ path: '/blank', text: 0, things: 0 })), [{ page: '/blank', text: 'the page is blank: no text, and nothing to see or press' }])
  assert.deepEqual(problemsOf(page({ text: 0, things: 3 })), []) // a page of pictures and buttons isn't blank
  assert.deepEqual(problemsOf(page({ path: '/x', load: 'Timeout 15000ms exceeded', console: ['later'] })).map((x) => x.text), ["didn't load: Timeout 15000ms exceeded"])
  assert.equal(problemsOf(page({ console: [`a${' very'.repeat(100)} long line`] }))[0]!.text.length, 240) // one line each, cut
})
test('a page that loads from another site is judged by its own server\'s answers only: HQ\'s browser has no internet', () => {
  const cdn = page({ outside: ['unpkg.com'], text: 0, things: 0, errors: ['React is not defined'], console: ['x'], bad: [{ status: 500, method: 'GET', url: '/api/items' }] })
  assert.deepEqual(problemsOf(cdn).map((x) => x.text), ['GET /api/items answered 500']) // not the blank page or the errors the missing library caused
})
test('only what main doesn\'t already have counts: the port HQ picked and long numbers don\'t make a problem new', () => {
  const before = [{ page: '/', text: 'GET http://localhost:51234/api/items?t=1794893715000 answered 500' }, { page: '/', text: 'error in the console: old' }]
  const now = [{ page: '/', text: 'GET http://localhost:60111/api/items?t=1794893999123 answered 500' }, { page: '/', text: 'error in the console: new' },
    { page: '/about', text: 'error in the console: old' }]
  assert.deepEqual(newProblems(now, before).map((x) => `${x.page} ${x.text}`), ['/ error in the console: new', '/about error in the console: old']) // the same words on another page are new
  assert.deepEqual(newProblems(now, []), now)
})

test('the verdict: clean passes with one look; something wrong is compared with main, and only the ticket\'s own problems send it back', () => {
  assert.equal(needsBase(looked(page(), page({ path: '/about' }))), false) // a clean app is opened once
  assert.deepEqual(judge(looked(page(), page({ path: '/about' })), null, 'main'), { ran: 'pass', pages: 2, ms: 1200, known: 0, offline: [] })
  assert.equal(needsBase(looked(BROKEN)), true)
  assert.deepEqual(judge(looked(page(), BROKEN), looked(page(), BROKEN), 'main'), { ran: 'pass', pages: 2, ms: 1200, known: 4, offline: [] }) // all of it was there before
  const fail = judge(looked(page(), BROKEN), looked(page(), page({ path: '/list', console: ['boom from the page'] })), 'main')
  assert.equal(fail.ran, 'fail'); assert.ok(fail.ran === 'fail')
  assert.equal(fail.why, "The app has 3 problems with it merged in that main doesn't have."); assert.equal(fail.problems.length, 3)
  assert.doesNotMatch(JSON.stringify(fail.problems), /boom/)
  assert.equal(judge(looked(page({ errors: ['x'] })), looked(page()), 'origin/main').ran === 'fail' && 'x', 'x')
  assert.match((judge(looked(page({ errors: ['x'] })), looked(page()), 'origin/main') as { why: string }).why, /^The app has a problem with it merged in that origin\/main doesn't have\.$/)
  assert.deepEqual(judge(looked(page({ outside: ['fonts.googleapis.com', 'unpkg.com'] }), page({ path: '/b', outside: ['unpkg.com'] })), null, 'main'),
    { ran: 'pass', pages: 2, ms: 1200, known: 0, offline: ['fonts.googleapis.com', 'unpkg.com'] })
})
test('an app that doesn\'t start: the ticket\'s doing only if it starts on main; and what HQ couldn\'t look at is never held against the ticket', () => {
  const dead: Seen = { kind: 'no_start', why: 'its web part stopped (1) while the app was starting', output: 'Error: Cannot find module ./routes' }
  assert.equal(needsBase(dead), true)
  assert.deepEqual(judge(dead, looked(page()), 'main'), { ran: 'fail', why: "The app doesn't start with it merged in: its web part stopped (1) while the app was starting.", problems: [],
    output: 'Error: Cannot find module ./routes' })
  assert.deepEqual(judge(dead, { ...dead, why: 'nothing answered on port 3000 within 60 s' }, 'main'),
    { ran: 'skipped', why: "the app doesn't start on main either (nothing answered on port 3000 within 60 s)", dead: true })
  const none: Seen = { kind: 'skipped', why: 'port 5173, which its web part always uses, is taken (the app may be running in the preview)' }
  assert.deepEqual(judge(none, null, 'main'), { ran: 'skipped', why: none.why }); assert.equal(needsBase(none), false)
  assert.deepEqual(judge(looked(BROKEN), none, 'main'), { ran: 'skipped', why: none.why }) // nothing to compare with: not blamed
  assert.equal(judge(looked(BROKEN), dead, 'main').ran, 'fail') // main had no app to open and this has one with problems: they are its own
  assert.deepEqual(allProblems(dead), []); assert.deepEqual(allProblems(none), [])
})

test('the report for the engineer, and the words for the page and the summary', () => {
  const fail = judge(looked(page(), BROKEN), looked(page()), 'main'); assert.ok(fail.ran === 'fail')
  assert.equal(lookReport(fail, 'npm run dev'), ['HQ started the app the way its preview does (npm run dev) and opened its pages in a headless browser.',
    "The app has 4 problems with it merged in that main doesn't have.", '- /list: GET /api/missing answered 404', '- /list: POST /api/save got no answer (ERR_CONNECTION_REFUSED)',
    "- /list: error on the page: Cannot read properties of null (reading 'x')", '- /list: error in the console: boom from the page'].join('\n'))
  const dead = judge({ kind: 'no_start', why: 'nothing answered on port 3000 within 60 s', output: 'listening on 8080' }, looked(page()), 'main'); assert.ok(dead.ran === 'fail')
  const report = lookReport(dead, 'api: node api.js + web: npm run dev')
  assert.match(report, /\(api: node api\.js \+ web: npm run dev\)[\s\S]*doesn't start with it merged in[\s\S]*\n\nWhat the app printed:\nlistening on 8080$/)
  const many = { ran: 'fail' as const, why: 'x', problems: Array.from({ length: 23 }, (_, i) => ({ page: '/', text: `p${i}` })) }
  assert.match(lookReport(many, 'x'), /- \/: p19\n- and 3 more$/)
  assert.equal(lookWords(null), null); assert.equal(lookWords(undefined), null) // merged before HQ looked: nothing is said, never "not opened"
  assert.deepEqual(lookWords({ ran: 'pass', pages: 1, ms: 5, known: 0, offline: [] }),
    { short: 'app opened, 1 page', long: 'HQ opened the app with it merged in: 1 page, nothing new wrong.', tone: 'ok' })
  assert.deepEqual(lookWords({ ran: 'pass', pages: 5, ms: 5, known: 2, offline: ['unpkg.com'] }), { short: 'app opened, 5 pages', tone: 'look',
    long: "HQ opened the app with it merged in: 5 pages, nothing new wrong; 2 problems it shares with what was there before; pages that load from unpkg.com weren't judged by what they "
      + "logged (HQ's browser has no internet)." })
  assert.deepEqual(lookWords({ ran: 'skipped', why: 'HQ couldn\'t download its browser (offline)' }),
    { short: "app not opened: HQ couldn't download its browser (offline)", long: "HQ didn't open the app before it merged: HQ couldn't download its browser (offline).", tone: 'look' })
})

test('Bug 374: a look that ran on another port, because the project\'s own was in use, says so where the user reads it, and is kept with the result', () => {
  const moved = [{ part: 'api', from: 8000, to: 50123, by: "HQ's preview of shop" }]
  const pass = judge({ kind: 'looked', pages: [page()], ms: 1200, moved }, null, 'main')
  assert.deepEqual(pass, { ran: 'pass', pages: 1, ms: 1200, known: 0, offline: [], moved })
  assert.deepEqual(lookWords(pass), { short: 'app opened, 1 page', tone: 'ok',
    long: "HQ opened the app with it merged in: 1 page, nothing new wrong. HQ ran its own copy of the app on port 50123 instead of 8000 (in use by HQ's preview of shop)." })
  assert.equal(movedWords([...moved, { part: 'jobs', from: 3001, to: 50124, by: 'node in ~/x (pid 7)' }]),
    "port 50123 instead of 8000 (in use by HQ's preview of shop) and port 50124 instead of 3001 (in use by node in ~/x (pid 7))")
  // a look on the project's own port says nothing of ports, and keeps none
  const plain = judge(looked(page()), null, 'main'); assert.equal('moved' in plain, false); assert.doesNotMatch(lookWords(plain)!.long, /port/)
})

test('Bug 374: a moved copy that didn\'t start is about the port, not the code: who has it and what to do, unless main alone started on a moved port', () => {
  const moved = [{ part: 'api', from: 8000, to: 50123, by: "HQ's preview of shop", fix: 'Stop the app in the preview, then test again' }]
  const dead = (m?: typeof moved): Seen => ({ kind: 'no_start', why: 'its api part stopped (1) while the app was starting', output: 'EPERM', ...(m ? { moved: m } : {}) })
  const words = "port 8000, which its api part always uses, is in use by HQ's preview of shop. HQ ran its own copy on port 50123 instead, and the app didn't start there "
    + '(its api part stopped (1) while the app was starting). Stop the app in the preview, then test again'
  assert.equal(movedNoStart('its api part stopped (1) while the app was starting', moved), words)
  assert.equal(movedNoStart("the app didn't start: its api part stopped (1) while the app was starting", moved), words) // a caller's own lead-in isn't said twice
  assert.equal(movedNoStart("the app couldn't be started", moved), words.replace(/ \(its api.*starting\)/, ''))
  // neither started on another port: the move may be why, so nobody is blamed and the app isn't written off for the run
  assert.deepEqual(judge(dead(moved), dead(moved), 'main'), { ran: 'skipped', why: words })
  assert.deepEqual(judge(dead(moved), null, 'main'), { ran: 'skipped', why: words })
  assert.deepEqual(judge(dead(moved), looked(page()), 'main'), { ran: 'skipped', why: words }) // main ran on its own port: no proof the move works
  assert.deepEqual(judge(dead(), dead(moved), 'main'), { ran: 'skipped', why: words }) // main alone was the moved one
  assert.equal(lookWords(judge(dead(moved), dead(moved), 'main'))!.long, `HQ didn't open the app before it merged: ${words}.`)
  // main alone started on a moved port: the move works for this app, so the ticket broke the start, and the words still say where it ran
  const blamed = judge(dead(moved), { kind: 'looked', pages: [page()], ms: 1200, moved }, 'main')
  assert.deepEqual(blamed, { ran: 'fail', problems: [], output: 'EPERM', why: "The app doesn't start with it merged in: its api part stopped (1) while the app was starting; "
    + "HQ ran its own copy of the app on port 50123 instead of 8000 (in use by HQ's preview of shop)." })
  // no port was moved: as before
  assert.deepEqual(judge(dead(), dead(), 'main'), { ran: 'skipped', why: "the app doesn't start on main either (its api part stopped (1) while the app was starting)", dead: true })
  assert.equal(judge(dead(), looked(page()), 'main').ran, 'fail')
  // two ports, two holders
  assert.equal(movedNoStart('x', [...moved, { part: 'jobs', from: 3001, to: 50124, by: 'node in ~/x (pid 7)' }]), "port 8000, which its api part always uses, is in use by HQ's preview of shop; "
    + "port 3001, which its jobs part always uses, is in use by node in ~/x (pid 7). HQ ran its own copy on ports 50123 and 50124 instead, and the app didn't start there (x). "
    + 'Stop the app in the preview, then test again. Stop it, then test again')
})
