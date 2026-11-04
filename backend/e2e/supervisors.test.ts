// Bug 47: e2e runs left dozens of preview supervisors (supervise.mjs) running. When a test HQ's tmux server went, each one got
// stuck opening its hung-up terminal (Node opens stderr lazily) and never ran its signal handlers again. Now a supervisor ends
// with its tmux server, its app with it, and a test HQ's stop() leaves nothing that names the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { startHq, waitFor, type Hq } from './harness.ts'

const named = (root: string) => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(root))
const answers = (port: number) => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)
async function running(hq: Hq): Promise<{ id: string; port: number }> {
  const repo = (await hq.api('repos', { path: hq.repo('leftover') })).json
  await hq.api(`previews/${repo.id}/command`, { command: 'npm start' })
  assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
  return waitFor('the app', async () => { const p = (await hq.state()).previews.find((x: any) => x.id === repo.id); return p.status === 'running' ? { id: repo.id, port: p.port } : null }, 20_000)
}

test('Bug 47: when its tmux server goes, the preview supervisor ends, and its app with it', async () => {
  const hq = await startHq()
  try {
    const { port } = await running(hq)
    const sup = () => named(hq.root).filter((l) => l.includes('supervise.mjs'))
    assert.equal(sup().length, 1)
    hq.tmux('kill-server') // what the old stop() relied on: tmux hangs up the pane's terminal
    await waitFor('the supervisor to end', () => sup().length === 0, 8000)
    await waitFor('the app to stop answering', async () => !(await answers(port)), 5000)
  } finally { await hq.stop() }
})

test('Bug 47: a test HQ stopped with its preview running leaves nothing behind', async () => {
  const hq = await startHq(), root = hq.root
  const { port } = await running(hq)
  assert.ok(named(root).length > 0)
  await hq.stop()
  assert.deepEqual(named(root), []); assert.equal(await answers(port), false)
})
