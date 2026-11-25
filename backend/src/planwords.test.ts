// Bug 387: with auto mode off the user answers plans on the board and HQ sent the TPM nothing about them, so after a re-plan it told the user "I haven't seen
// a plan from the engineer". The plan rounds now show in list_tickets (planWords) and in HQ's "finished" notice, through the real plan gate here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerResponse } from 'node:http'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b387-'))
const { migrate, run, one, setSetting } = await import('./db.ts')
migrate()
setSetting('gate_timeout_s', 65) // a held call gives up after 5 s, so a failing test can't keep the run alive
const { onExitPlanMode, answerReview } = await import('./gate.ts')
const { planWords } = await import('./planwords.ts')
const { finishWords } = await import('./mergewatch.ts')

const hookCall = () => {
  const res = { writeHead: () => res, end: () => {}, on: () => res }
  return res as unknown as ServerResponse
}
const now = Date.now()
run("INSERT INTO repos(id, name, path, created_at) VALUES ('r1', 'b387a', '/tmp/b387a', ?)", now)
run("INSERT INTO features(id, repo_id, slug, title, request_text, status, created_at, updated_at) VALUES ('f1', 'r1', 'kl', 'tally', 'x', 'planning', ?, ?)", now, now)
run("INSERT INTO tickets(id, feature_id, key, slug, title, status, created_at, updated_at) VALUES ('t1', 'f1', 'B387-1', 'sub', 'Subtract', 'planning', ?, ?)", now, now)
run("INSERT INTO agents(id, role, feature_id, ticket_id, model_alias, token_hash, status, started_at) VALUES ('e1', 'engineer', 'f1', 't1', 'haiku', 'h', 'working', ?)", now)
const agent = () => one<any>("SELECT * FROM agents WHERE id = 'e1'")!
const ticket = () => one<any>("SELECT * FROM tickets WHERE id = 't1'")!
const repo = () => one<any>("SELECT * FROM repos WHERE id = 'r1'")!
const submit = (plan: string) => onExitPlanMode(agent(), { tool_input: { plan, planFilePath: null } }, hookCall())
const openReview = () => one<{ id: string }>("SELECT id FROM review_requests WHERE ticket_id = 't1' AND status = 'open'")!.id
const words = () => planWords(ticket(), 'r1')
const finished = (o: Partial<Parameters<typeof finishWords>[2]> = {}) =>
  finishWords(repo(), { ...ticket(), branch: 'hq/b/B387-1' }, { base: 'main', pushed: false, tests: false, changed: false, fixed: false, plans: words(), ...o }).tpm

test('Bug 387: auto off, a plan approved, the spec changed, a new plan sent back then approved: the TPM can read every round, and the plan still owed', () => {
  assert.equal(words(), null) // no plan handed in yet
  assert.equal(finished(), "HQ: B387-1 is finished (hq/b/B387-1). The user merges it into main from HQ; you'll be told when it merges. Its plans: none was handed in.")
  submit('Plan A'); assert.equal(words(), "R-1 waits for the user's review")
  answerReview(openReview(), 'approve', { by: 'user' }); assert.equal(words(), 'R-1 approved by the user')
  run("UPDATE tickets SET replan_after = 1 WHERE id = 't1'") // what update_ticket_spec does with auto off (Bug 371)
  assert.equal(words(), 'R-1 approved by the user; a new plan is owed: the spec changed, and R-1 came before its engineer read the change')
  submit('Plan B'); answerReview(openReview(), 'revise', { by: 'user', message: 'smaller' })
  submit('Plan C'); answerReview(openReview(), 'approve', { by: 'user' })
  assert.equal(ticket().replan_after, null) // settled by R-3
  assert.equal(words(), 'R-1 approved by the user; R-2 sent back by the user; R-3 approved by the user')
  assert.equal(finished({ changed: true }), "HQ: B387-1's engineer built the change to its spec (hq/b/B387-1). The user merges it from HQ; you'll be told when it merges. "
    + 'Its plans: R-1 approved by the user; R-2 sent back by the user; R-3 approved by the user.')
  assert.match(finished({ changed: true, fixed: true }), /built the change to its spec .* Its plans: R-1/) // a change that also merged main in
  submit('Plan D'); answerReview(openReview(), 'approve_with_edits', { by: 'user', plan: 'Plan D, edited' })
  submit('Plan E') // the newest round only shows the last four, and says how many came before
  assert.equal(words(), "1 earlier, then R-2 sent back by the user; R-3 approved by the user; R-4 approved with edits by the user; R-5 waits for the user's review")
})

test('Bug 387: what must not change: no plan words where the user does not answer plans or the notice is not about the ticket being built', () => {
  assert.doesNotMatch(finished({ fixed: true }), /Its plans/) // conflicts fixed
  assert.doesNotMatch(finished({ tests: true, fixed: true }), /Its plans/) // back from HQ's own check
  assert.doesNotMatch(finished({ plans: undefined }), /Its plans/) // a caller that passes none (the unit tests of finishWords)
  run("UPDATE repos SET auto_mode = 1 WHERE id = 'r1'")
  assert.doesNotMatch(finished(), /Its plans/) // auto mode going: HQ approves plans, and its notice says so already
  assert.match(words()!, /R-5 waits for HQ's plan check$/) // list_tickets still shows them, in auto mode's words
  run("UPDATE repos SET auto_mode = 0 WHERE id = 'r1'")
})
