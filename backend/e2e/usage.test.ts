// Bug 160 end to end: Claude Code's usage report (`session.measure`) carries only the limits the account has, and the account HQ
// runs on only ever sent the weekly one. The "new launches paused" notice and a refused launch name only the figures that came, and
// setting the 5-hour pause says when Claude Code sends no 5-hour figure for this account.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHq, waitFor, type Hq } from './harness.ts'

let hq: Hq
before(async () => { hq = await startHq() })
after(async () => { await hq?.stop() })

const measure = (id: string, rateLimits: { kind: string; percentUsed: number }[]) => hq.modEvent(id, { kind: 'session.measure', usage: { rateLimits } })
const notice = async () => (await hq.state()).attention.find((a: any) => a.kind === 'rate_limit' && !a.resolved_at)
const samples = async (id: string) => (await hq.api(`events?agent=${id}&limit=500`)).json.filter((e: any) => e.kind === 'mod.session.measure').length

test('only the weekly figure comes: the notice and the refused launch name it alone; setting the 5-hour pause says it can\'t act', async () => {
  const repo = (await hq.api('repos', { path: hq.repo('usage-weekly') })).json
  const f = (await hq.api('features', { repoId: repo.id, title: 'usage', request: 'Build usage' })).json
  const tpm = await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.id === f.tpm_agent_id && a.status === 'working'))
  const t = (await hq.api('tickets', { featureId: f.id, title: 'One', size: 'S', spec: 'One.' })).json

  const before = await hq.api('settings', { key: 'pause_five_hour_pct', value: 75 })
  assert.equal(before.status, 200); assert.equal(before.json.note, undefined, 'no usage report yet: nothing to say')

  await measure(tpm.id, [{ kind: 'seven_day', percentUsed: 40 }]); await waitFor('the report', async () => await samples(tpm.id) === 1)
  assert.equal(await notice(), undefined, 'under the pause: no notice')
  const set = await hq.api('settings', { key: 'pause_five_hour_pct', value: 70 })
  assert.equal(set.status, 200); assert.match(set.json.note, /sends no 5-hour usage figure for this account/)
  assert.match(set.json.note, /only the weekly pause/)
  assert.equal((await hq.api('settings', { key: 'pause_seven_day_pct', value: 90 })).json.note, undefined, 'only the 5-hour pause gets the note')

  await measure(tpm.id, [{ kind: 'seven_day', percentUsed: 91 }])
  const n = await waitFor('the notice', notice)
  assert.equal(n.detail, 'Weekly usage at 91%: new launches paused')
  const launch = await hq.api(`tickets/${t.id}/launch`, {})
  assert.equal(launch.status, 409); assert.equal(launch.json.error, 'Weekly usage at 91%')

  await measure(tpm.id, [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 91 }]); await waitFor('the report', async () => await samples(tpm.id) === 3)
  assert.equal((await hq.api('settings', { key: 'pause_five_hour_pct', value: 80 })).json.note, undefined, 'a 5-hour figure came: no note')
})
