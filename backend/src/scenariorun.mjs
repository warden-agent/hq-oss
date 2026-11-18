// A scripted scenario (scenario.ts): starts the app on its clean seed with the recorder in front (recorder.mjs), opens HQ's headless browser on the
// recorder's address, and does the steps one by one, each one stamped, settled and snapshotted. No model: the steps are given. HQ runs `node scenariorun.mjs
// <spec json>` inside its test sandbox, in a throwaway checkout. What each step did goes to spec.out/result.json; the recordings stay next to it.
// Plain Node with no imports from HQ; the browser is HQ's own playwright-core, whose folder is in the spec.
// spec: recorder.mjs's spec + { pwCore, steps, stepMs, expect? }   (expect: what should or shouldn't be on the page after the last step; see steps.mjs holds)
// A step: { action: 'navigate'|'click'|'fill'|'press'|'select'|'check'|'back'|'reset', role?, name?, text?, value?, url?, label? }
import fs from 'node:fs'
import path from 'node:path'
import { startRecording } from './recorder.mjs'
import { holds, runStep, stepLabel } from './steps.mjs'

const spec = JSON.parse(process.argv[2])
const result = { started: null, why: null, output: null, steps: [], ms: 0 }
const write = () => { try { fs.writeFileSync(path.join(spec.out, 'result.json'), JSON.stringify(result)) } catch { /* the checkout is gone */ } }
const cut = (s, n = 300) => String(s).split('\n')[0].slice(0, n)
let rec = null, browser = null, ended = false
/** Writes the result and ends. Always exit 0: a result was written, whatever it says. */
async function finish() {
  if (ended) return; ended = true
  write(); await browser?.close().catch(() => {}); await rec?.stop().catch(() => {})
  process.exit(0)
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { void finish() })

try {
  const t0 = Date.now(), started = await startRecording(spec)
  if (!started.rec) { result.started = false; result.why = started.why; result.output = started.output ?? null; await finish() }
  rec = started.rec
  const { chromium } = await import(path.join(spec.pwCore, 'index.mjs'))
  try { browser = await chromium.launch({ headless: true }) } catch (e) { result.started = false; result.why = `HQ's browser didn't start (${cut(e.message, 200)})`; await finish() }
  const page = await (await browser.newContext()).newPage()
  rec.attach(page); result.started = true; write()
  // The page is opened first when the steps don't open it themselves; that step is HQ's, and has no result: results line up with the steps given
  const steps = spec.steps[0]?.action === 'navigate' || spec.steps[0]?.action === 'reset' ? spec.steps : [{ action: 'navigate', url: '/', hq: true }, ...spec.steps]
  for (const s of steps) {
    if (s.action === 'reset') { // HQ's own step, not a person's: the app back on its seed
      try { await rec.reset(); result.steps.push({ ok: true }) } catch (e) { result.steps.push({ ok: false, why: cut(e.message) }); break }
      write(); continue
    }
    let r = { ok: true }
    try { await rec.action(stepLabel(s), () => runStep(page, s, rec.url, spec.stepMs ?? 5000)) } catch (e) {
      r = { ok: false, why: /Timeout .* exceeded/.test(e.message) ? `${s.role || s.name ? 'no such element on the page' : 'it timed out'} (${cut(e.message, 120)})` : cut(e.message) }
    }
    if (!s.hq) result.steps.push(r)
    write()
  }
  // What the page should show now: looked for only when every step could be done (after one that couldn't, the page is somewhere else)
  if (spec.expect?.length && result.steps.every((r) => r.ok)) {
    result.expect = []; for (const e of spec.expect) result.expect.push(await holds(page, e, spec.stepMs ?? 5000))
  }
  result.ms = Date.now() - t0
  await finish()
} catch (e) { result.started ??= false; result.why ??= `the scenario broke off (${cut(e?.message ?? e, 200)})`; await finish() }
