// Bug 174: a stopped engineer's Agent tab still offered "Message eng T-01 (delivered when idle)" with Send and Urgent, though nothing
// may ever read it. messageRoute says where a message to a stopped agent goes (the session handOver moves it to), or that it can't go anywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageRoute } from './msgroute.ts'

const eng = { id: 'eng-1', role: 'engineer', status: 'exited', ticket_id: 'tk-1', repo_id: 'repo-1' }
const tk = { id: 'tk-1', key: 'T-01', status: 'implementing', assignee_agent_id: 'eng-1' }
const tpm = { id: 'tpm-1', role: 'tpm', status: 'exited', ticket_id: null, repo_id: 'repo-1' }
const repo = { id: 'repo-1', name: 'shop', tpm_agent_id: 'tpm-1' }

test('a running agent of any role gets the message itself', () => {
  for (const status of ['working', 'idle', 'blocked', 'paused', 'plan_review', 'launching']) {
    assert.deepEqual(messageRoute({ ...eng, status }, tk, repo), { live: true })
    assert.deepEqual(messageRoute({ ...tpm, status }, undefined, repo), { live: true })
    assert.deepEqual(messageRoute({ id: 'l-1', role: 'launcher', status, repo_id: 'repo-1' }, undefined, repo), { live: true })
  }
})

test("a stopped engineer still on its open ticket: the ticket's next engineer gets it", () => {
  for (const status of ['queued', 'planning', 'implementing', 'awaiting_answer', 'escalated', 'pr_ready', 'pr_open', 'resolving']) {
    assert.deepEqual(messageRoute(eng, { ...tk, status }, repo), { next: 'the next engineer on T-01' })
  }
})

test('a stopped engineer whose ticket is merged or cancelled, or that a newer engineer replaced: nowhere to go', () => {
  assert.match((messageRoute(eng, { ...tk, status: 'merged' }, repo) as { none: string }).none, /T-01 is merged/)
  assert.match((messageRoute(eng, { ...tk, status: 'cancelled' }, repo) as { none: string }).none, /T-01 is cancelled/)
  assert.match((messageRoute(eng, { ...tk, assignee_agent_id: 'eng-2' }, repo) as { none: string }).none, /newer engineer has taken over T-01/)
  assert.ok('none' in messageRoute(eng, undefined, repo)) // the ticket is gone (a Clear)
})

test("a stopped TPM: the project's next TPM gets it, unless a newer one has its place", () => {
  assert.deepEqual(messageRoute(tpm, undefined, repo), { next: 'the next TPM of shop' })
  assert.match((messageRoute(tpm, undefined, { ...repo, tpm_agent_id: 'tpm-2' }) as { none: string }).none, /newer TPM has taken over shop/)
  assert.ok('none' in messageRoute(tpm, undefined, undefined)) // the project was removed
})

test('a stopped agent no session replaces (a launch helper, a tester): nowhere to go', () => {
  for (const role of ['launcher', 'tester', 'architect']) assert.ok('none' in messageRoute({ id: 'x-1', role, status: 'exited', repo_id: 'repo-1' }, undefined, repo))
})
