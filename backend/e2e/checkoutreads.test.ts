// Bug 423 end to end (see harness.ts): an engineer's worktree sits in <repo>/.claude/worktrees/<ticket>, and pytest's and uv's config searches
// walk up out of it into the main checkout, which its sandbox can't read. The settings HQ writes for the engineer let it read the main
// checkout's config files those searches look for (pyproject.toml, setup.cfg, ...), and nothing else of the checkout.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startHq, sh, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

test('Bug 423: an engineer\'s sandbox may read the main checkout\'s pyproject.toml and setup.cfg, and not the rest of the checkout', async () => {
  const dir = hq.repo('b423py')
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "b423py"\nversion = "0.1.0"\n') // no pytest section
  fs.writeFileSync(path.join(dir, 'setup.cfg'), '[metadata]\nname = b423py\n'); fs.writeFileSync(path.join(dir, 'test_b423.py'), 'def test_ok():\n    pass\n')
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'python')
  fs.writeFileSync(path.join(dir, '.env'), 'B423=1\n') // the user's own, not committed
  const repo = (await hq.api('repos', { path: dir })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'b423py', request: 'Build it' })).json
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json
  const r = await hq.api(`tickets/${t.id}/launch`, {}); assert.equal(r.status, 200, `launch refused: ${JSON.stringify(r.json)}`)
  const reads: string[] = JSON.parse(fs.readFileSync(path.join(hq.hqHome, 'agents', r.json.id, 'settings.json'), 'utf8')).sandbox.filesystem.allowRead
  const at = (f: string) => [path.join(dir, f), path.join(fs.realpathSync(dir), f)]
  for (const p of [...at('pyproject.toml'), ...at('setup.cfg')]) assert.ok(reads.includes(p), `${p} in ${JSON.stringify(reads)}`)
  for (const p of [...at(''), ...at('.env'), ...at('test_b423.py'), ...at('server.js'), ...at('.git'), ...at('.claude')]) assert.ok(!reads.includes(p), p)
})
