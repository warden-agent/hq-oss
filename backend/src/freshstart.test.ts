// Fresh start pieces against a real SQLite DB in a temp HQ_HOME: the context limits follow the user's one pick, notes are capped
// (refused, never cut), and the engineer taking over gets the note, git and the plan, but not the update_handoff log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-fresh-'))
const { migrate, setSetting } = await import('./db.ts')
migrate()
const { limitFor } = await import('./freshstart.ts')
const { noteProblem } = await import('./notes.ts')
const { engineerResumePrompt } = await import('./handover.ts')
const { validSetting } = await import('./config.ts')

test('the TPM limit is the pick; engineers get about two-thirds of it; only the presets are taken', () => {
  for (const [pick, eng] of [[100_000, 65_000], [150_000, 100_000], [200_000, 130_000]]) {
    setSetting('context_limit', pick); assert.equal(limitFor('tpm'), pick); assert.equal(limitFor('engineer'), eng)
  }
  assert.equal(limitFor('architect'), null)
  setSetting('context_limit', 5) // a value from before validation: the default stands in
  assert.equal(limitFor('tpm'), 150_000)
  assert.match(validSetting('context_limit', 120_000)!, /must be one of 100000, 150000, 200000/)
  assert.equal(validSetting('context_limit', 200_000), null)
})

test('a note over the cap is refused with both numbers; at the cap it is fine', () => {
  assert.equal(noteProblem('engineer', 'x'.repeat(2500)), null)
  assert.match(noteProblem('engineer', 'x'.repeat(2501))!, /2,501 characters; the limit is 2,500/)
  assert.equal(noteProblem('tpm', 'x'.repeat(5000)), null)
  assert.match(noteProblem('tpm', '   ')!, /empty/)
})

test("the engineer taking over gets the goal, the note, git and the plan, and not the handoff log", () => {
  const t = { key: 'UI-2', size: 'M', title: 'Menu stays put', branch: 'hq/ui/UI-2', spec: 'Keep the menu visible.', status: 'implementing' } as never
  const git = { status: ' M styles.css', log: 'abc1 tabs', diffStat: ' styles.css | 4 +' }
  const p = engineerResumePrompt(t, { feature: 'phone', worktree: '/wt', base: 'main', note: '## Where I stopped\n- mid-edit', git, plan: 'PLAN BODY', fix: null })
  for (const s of ['taking over ticket UI-2', 'Keep the menu visible.', '- mid-edit', ' M styles.css', 'abc1 tabs', '## Approved plan\nPLAN BODY', 'trust git']) assert.ok(p.includes(s), s)
  assert.doesNotMatch(p, /update_handoff|after_plan|milestone/)
  const none = { status: '', log: '', diffStat: '' }
  const planning = engineerResumePrompt({ ...(t as object), status: 'planning' } as never, { feature: 'phone', worktree: '/wt', base: 'main', note: null, git: none, plan: null, fix: null })
  assert.match(planning, /call ExitPlanMode/); assert.match(planning, /\(none\)/); assert.doesNotMatch(planning, /Approved plan/)
})
