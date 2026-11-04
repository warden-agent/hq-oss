// Bug 48: a tab left open across an HQ update kept the old UI and quietly did the old thing (the old merge button opened GitHub).
// The state names the frontend build HQ serves, so a tab running another one reloads itself; the page is never cached, its
// content-named scripts are. Needs a built frontend (frontend/dist).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq } from './harness.ts'

const INDEX = path.resolve(import.meta.dirname, '../../frontend/dist/index.html')

test('Bug 48: the state names the build HQ serves; the page is checked every load, its scripts are kept', async (t) => {
  if (!fs.existsSync(INDEX)) return t.skip('frontend not built')
  const script = /\/assets\/(index-[\w-]+\.js)/.exec(fs.readFileSync(INDEX, 'utf8'))![1]!
  const hq = await startHq()
  try {
    assert.equal((await hq.state()).build, script)
    const token = fs.readFileSync(path.join(hq.hqHome, 'ui-token'), 'utf8').trim(), base = `http://127.0.0.1:${hq.ports.ui}`
    const page = await fetch(`${base}/?token=${token}`)
    assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-cache')
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!
    const js = await fetch(`${base}/assets/${script}`, { headers: { cookie } })
    assert.equal(js.status, 200); assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    const missing = await fetch(`${base}/assets/index-gone.js`, { headers: { cookie } }) // an old tab's script after a rebuild: the page, not cached
    assert.equal(missing.headers.get('cache-control'), 'no-cache')
  } finally { await hq.stop() }
})
