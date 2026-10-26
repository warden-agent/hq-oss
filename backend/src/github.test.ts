// GitHub plumbing: body cutting, opening a PR (with its link fallback), the "Create PR" link, PR-list parsing, and pushing (a local bare repo stands in for GitHub).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { compareUrl, decidingPr, fitBody, openOrLink, parsePrs, PR_BODY_MAX, pushBranch } from './github.ts'

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hq-gh-'))

test('compareUrl: pre-filled, branch slashes kept, long bodies cut to fit', () => {
  const u = compareUrl('o/r', 'main', 'hq/ui-switch-up/UI-1-x', 'UI-1: tokens & fonts', 'Body\n## Deviations from approved plan\nNone')
  assert.ok(u.startsWith('https://github.com/o/r/compare/main...hq/ui-switch-up/UI-1-x?expand=1&title=UI-1%3A%20tokens%20%26%20fonts&body='))
  assert.match(decodeURIComponent(u.split('&body=')[1]!), /## Deviations from approved plan\nNone$/)
  const long = compareUrl('o/r', 'main', 'b', 't', 'x'.repeat(20_000))
  assert.ok(long.length <= 7000); assert.match(decodeURIComponent(long), /cut to fit/)
})

test('fitBody: bodies that fit are untouched; long ones are cut under the cap with a note', () => {
  const under = (s: string) => s.length <= PR_BODY_MAX
  assert.equal(fitBody('short\n## Deviations from approved plan\nNone', under), 'short\n## Deviations from approved plan\nNone')
  const cut = fitBody('y'.repeat(200_000), under)
  assert.ok(cut.length <= PR_BODY_MAX); assert.match(cut, /cut to fit; the full text is in the ticket handoff\)$/)
  assert.equal(fitBody('z'.repeat(50), (s) => s.length <= 5), '')
})

test('openOrLink: an opened PR is returned; a refusal falls back to the pre-filled link and the reason', async () => {
  const o = { ghConfigDir: '/nonexistent', account: 'warden-agent' }
  const ok = await openOrLink('o/r', 'main', 'hq/f/T-1-x', 'T-1: x', 'body', o, async () => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }))
  assert.deepEqual(ok, { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } })
  const no = await openOrLink('o/r', 'main', 'hq/f/T-1-x', 'T-1: x', 'body', o, async () => { throw new Error("warden-agent can't open PRs on o/r: give it Write access") })
  assert.ok('link' in no && no.link.startsWith('https://github.com/o/r/compare/main...hq/f/T-1-x?expand=1&title=T-1%3A%20x&body=body'))
  assert.ok('error' in no && /can't open PRs/.test(no.error))
})

test('parsePrs / decidingPr: merged beats open beats closed', () => {
  assert.deepEqual(parsePrs(''), [])
  const prs = parsePrs(JSON.stringify([{ number: 3, url: 'u3', state: 'CLOSED' }, { number: 5, url: 'u5', state: 'OPEN' }, { number: 4, url: 'u4', state: 'MERGED' }, { bogus: 1 }]))
  assert.deepEqual(prs.map((p) => p.number), [5, 4, 3])
  assert.equal(decidingPr(prs)?.number, 4)
  assert.equal(decidingPr(prs.filter((p) => p.state !== 'MERGED'))?.number, 5)
  assert.equal(decidingPr([{ number: 3, url: 'u3', state: 'CLOSED' }])?.state, 'CLOSED')
  assert.equal(decidingPr([]), null)
})

test('pushBranch pushes the ticket branch and never overwrites a different one', async () => {
  const root = tmp(); const bare = path.join(root, 'r.git'); const repo = path.join(root, 'repo')
  sh(root, 'init', '--bare', '-b', 'main', bare); sh(root, 'init', '-b', 'main', repo)
  fs.writeFileSync(path.join(repo, 'a'), '1'); sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'one'); sh(repo, 'checkout', '-b', 'hq/f/T-1-x')
  fs.writeFileSync(path.join(repo, 'a'), '2'); sh(repo, 'commit', '-am', 'two')
  const o = { ghConfigDir: '/nonexistent', account: 'warden-agent', pushUrl: bare }
  await pushBranch(repo, 'o/r', 'hq/f/T-1-x', o)
  assert.equal(sh(bare, 'rev-parse', 'refs/heads/hq/f/T-1-x'), sh(repo, 'rev-parse', 'HEAD'))
  sh(repo, 'commit', '--amend', '-m', 'rewritten')
  await assert.rejects(pushBranch(repo, 'o/r', 'hq/f/T-1-x', o), /won't overwrite/)
})
