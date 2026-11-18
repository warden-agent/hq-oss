// A stand-in for HQ's scripted scenario runner (src/scenariorun.mjs) in tests, which have no browser: HQ runs this instead when HQ_SCENARIO_RUNNER names it,
// in the same sandbox and the same throwaway checkout. Everything but the browser is real: the recorder seeds, starts, proxies, snapshots and resets the app.
// A `navigate` step fetches the page through the recorder and then each script and stylesheet it names, as a browser would; other steps do nothing.
import fs from 'node:fs'
import path from 'node:path'
import { startRecording } from '../src/recorder.mjs'

const spec = JSON.parse(process.argv[2]), result = { started: null, why: null, output: null, steps: [], ms: 0 }
const write = () => fs.writeFileSync(path.join(spec.out, 'result.json'), JSON.stringify(result))
const started = await startRecording(spec)
if (!started.rec) { result.started = false; result.why = started.why; result.output = started.output ?? null; write(); process.exit(0) }
const rec = started.rec; result.started = true
for (const s of spec.steps) {
  try {
    if (s.action === 'reset') await rec.reset()
    else await rec.action(s.label ?? `${s.action} ${s.url ?? s.name ?? ''}`.trim(), async () => {
      if (s.action !== 'navigate') return
      const html = await (await fetch(rec.url + (s.url ?? '/'))).text()
      for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) await fetch(rec.url + m[1]).then((r) => r.text()).catch(() => {})
    })
    result.steps.push({ ok: true })
  } catch (e) { result.steps.push({ ok: false, why: String(e.message ?? e) }) }
}
write(); await rec.stop(); process.exit(0)
