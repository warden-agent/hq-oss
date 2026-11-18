// A stand-in for HQ's look at the app (src/smokerun.mjs) in e2e tests, which have no browser: HQ runs this instead when HQ_LOOK_RUNNER names it, in the same
// sandbox and the same throwaway checkout. What it "sees" is whatever the checkout's look.json says (a smokerules.ts Seen), so a test decides what the app
// looks like on main and on a ticket's branch by committing that file; with none, one clean page. `wait`: a file in the checkout it waits for first, so a
// test can hold a look where it is.
import fs from 'node:fs'
const spec = JSON.parse(process.argv[2])
const page = (o = {}) => ({ path: '/', title: 'App', text: 20, things: 1, console: [], errors: [], failed: [], bad: [], outside: [], ...o })
let seen = { kind: 'looked', pages: [page()], ms: 5 }, wait = null
try {
  const own = JSON.parse(fs.readFileSync('look.json', 'utf8')); wait = own.wait ?? null
  seen = own.kind ? { ...own, wait: undefined } : { kind: 'looked', ms: 5, pages: (own.pages ?? [{}]).map(page) }
} catch { /* none: a clean app */ }
while (wait && !fs.existsSync(wait)) await new Promise((r) => setTimeout(r, 100))
fs.writeFileSync(spec.out, JSON.stringify(seen))
