// Finding what still runs inside a folder (the Launch helper's leftover test servers) from lsof's listing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pidsUnder, whoAnswers, whose } from './procs.ts'

test('pidsUnder: processes working in the folder or below it, each once; a sibling with the same prefix is not inside', () => {
  const listing = ['p10', 'fcwd', 'n/repo/.claude/worktrees/launch-1', 'p11', 'fcwd', 'n/repo/.claude/worktrees/launch-1/server',
    'p12', 'fcwd', 'n/repo/.claude/worktrees/launch-10', 'p13', 'fcwd', 'n/repo', 'p11', 'fcwd', 'n/repo/.claude/worktrees/launch-1/server'].join('\n')
  assert.deepEqual(pidsUnder(listing, '/repo/.claude/worktrees/launch-1'), [10, 11])
  assert.deepEqual(pidsUnder('', '/x'), [])
})

test('whose (Bug 42): a launch-* leftover is HQ\'s, the rest of the repo is the project, other repos by name, else the folder', () => {
  const repos = [{ id: 'r1', name: 'notes', path: '/u/me/code/notes' }, { id: 'r2', name: 'demo', path: '/u/me/code/demo' },
    { id: 'r3', name: 'inner', path: '/u/me/code/demo/inner' }]
  const w = (cwd: string | null) => whose(cwd, repos, 'r1', '/u/me')
  assert.deepEqual(w('/u/me/code/notes/.claude/worktrees/launch-abc/backend'), { kind: 'hq', name: 'an old Launch helper run of notes' })
  assert.deepEqual(w('/u/me/code/notes/.claude/worktrees/T-7'), { kind: 'project', name: 'notes/.claude/worktrees/T-7' })
  assert.deepEqual(w('/u/me/code/notes/backend'), { kind: 'project', name: 'notes/backend' })
  assert.deepEqual(w('/u/me/code/notes'), { kind: 'project', name: 'notes' })
  assert.deepEqual(w('/u/me/code/demo/src'), { kind: 'repo', name: 'demo' })
  assert.deepEqual(w('/u/me/code/demo/inner/x'), { kind: 'repo', name: 'inner' }) // the closest repo wins
  assert.deepEqual(w('/u/me/code/notes-old'), { kind: 'other', name: '~/code/notes-old' }) // same prefix, not inside
  assert.deepEqual(w('/tmp/srv'), { kind: 'other', name: '/tmp/srv' })
  assert.deepEqual(w(null), { kind: 'other', name: 'an unknown folder' })
})

test('whoAnswers (Bug 44): the app alone is shown; another listener beside it is a clash; another one alone is waited for, then shown', () => {
  const h = (pid: number, pgid: number | null) => ({ pid, pgid, cmd: 'node', cwd: null })
  assert.deepEqual(whoAnswers([h(5, 4), h(6, 4)], 4, 0), { kind: 'show' }) // a --reload server: watcher and worker
  assert.deepEqual(whoAnswers([], 4, 0), { kind: 'show' }) // lsof sees nobody
  assert.deepEqual(whoAnswers([h(5, 4), h(9, 9)], 4, 0), { kind: 'clash', others: [h(9, 9)] })
  assert.deepEqual(whoAnswers([h(9, 9)], 4, 1000), { kind: 'wait' }) // the app may still be starting
  assert.deepEqual(whoAnswers([h(9, 9)], 4, 16_000), { kind: 'show' }) // a port Docker forwards
  assert.deepEqual(whoAnswers([h(9, null)], null, 0), { kind: 'wait' })
})
