// New project, with no network: a fake gh (fake-gh.mjs) makes "GitHub" repos as local bare repos, and git's url.insteadOf
// points github.com at them. A local and a GitHub project come out as empty repos HQ can work in; a taken name and a failed
// push leave nothing behind; the first request is kept as the project's CONTEXT.md and reaches the TPM.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

let hq: Hq, bin: string, state: string, bare: string, parent: string
before(async () => {
  bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-np-'))); state = path.join(bin, 'gh-state.json'); bare = path.join(bin, 'github')
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dirname, 'fake-gh.mjs'))} "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(state, JSON.stringify({ prs: {}, next: 1, login: 'hq-bot' }))
  hq = await startHq({ env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, FAKE_GH_BARE: bare, HQ_GITHUB_ACCOUNT: 'hq-bot' } })
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}/"]\n\tinsteadOf = https://github.com/\n`)
  parent = path.join(hq.root, 'projects'); fs.mkdirSync(parent)
})
after(async () => { await hq?.stop(); fs.rmSync(bin, { recursive: true, force: true }) })

const gh = { read: () => JSON.parse(fs.readFileSync(state, 'utf8')), set: (p: Record<string, unknown>) => fs.writeFileSync(state, JSON.stringify({ ...gh.read(), ...p })) }

test('setup: the folder next to the last repo, and whether GitHub is ready', async () => {
  const s = (await hq.api('repos/new-setup', {})).json
  assert.equal(s.account, 'hq-bot'); assert.equal(s.githubReady, true); assert.equal(s.parent, hq.home) // no repos yet, no ~/Documents
  gh.set({ login: null }); assert.equal((await hq.api('repos/new-setup', {})).json.githubReady, false)
  const r = await hq.api('repos/new', { name: 'Offline', parent, github: true })
  assert.equal(r.status, 400); assert.match(r.json.error, /isn't logged in to GitHub as hq-bot/); assert.deepEqual(fs.readdirSync(parent), [])
  gh.set({ login: 'hq-bot' })
})

test('local project: empty main, then the first message in the TPM box becomes CONTEXT.md and starts the TPM; a later one does not replace it', async () => {
  const r = await hq.api('repos/new', { name: 'Notes app', parent, github: false }); assert.equal(r.status, 200, JSON.stringify(r.json))
  const repo = r.json; assert.deepEqual([repo.name, repo.kind, repo.empty, repo.path], ['Notes app', 'local', 1, path.join(parent, 'Notes-app')])
  assert.equal((await hq.api('repos/new-setup', {})).json.parent, parent) // next project goes next to this one
  const first = (await hq.api(`repos/${repo.id}/message`, { body: 'A place to jot notes and find them later.' })).json
  const ctx = path.join(hq.hqHome, 'projects', repo.id, 'CONTEXT.md')
  assert.match(fs.readFileSync(ctx, 'utf8'), /^# Notes app\n\nWhat the user asked for when the project started:\n\nA place to jot notes and find them later\.\n$/)
  const s = await hq.state(); assert.equal(s.repos.find((x: any) => x.id === repo.id).context_doc_path, ctx)
  await waitFor('the TPM', async () => (await hq.state()).agents.find((a: any) => a.role === 'tpm' && a.id === first.agent.id && a.repo_id === repo.id))
  assert.equal(fs.readFileSync(path.join(hq.hqHome, 'workspaces', `repo-${repo.id}`, 'tpm', 'CONTEXT.md'), 'utf8'), fs.readFileSync(ctx, 'utf8'))
  await hq.api(`repos/${repo.id}/message`, { body: 'Let me tag notes.' })
  assert.match(fs.readFileSync(ctx, 'utf8'), /jot notes/)
})

test('GitHub project: a private repo under the HQ account with main pushed, synced and pushable', async () => {
  const r = await hq.api('repos/new', { name: 'Shop', parent, github: true }); assert.equal(r.status, 200, JSON.stringify(r.json))
  const dir = r.json.path, head = sh(dir, 'rev-parse', 'main')
  assert.equal(sh(dir, 'config', 'remote.origin.url'), 'https://github.com/hq-bot/Shop.git'); assert.equal(sh(path.join(bare, 'hq-bot', 'Shop.git'), 'rev-parse', 'main'), head)
  assert.match(sh(dir, 'log', '-1', '--format=%s'), /^Start Shop$/)
  // The insteadOf above also rewrites what `git remote get-url` shows, so HQ saw a file:// origin. With the ssh form (which only
  // this repo's https URL is pointed away from) it sees the GitHub repo, as it would for real:
  sh(dir, 'remote', 'set-url', 'origin', 'git@github.com:hq-bot/Shop.git')
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}/hq-bot/Shop.git"]\n\tinsteadOf = https://github.com/hq-bot/Shop.git\n`)
  const s = (await hq.api(`repos/${r.json.id}/sync`, {})).json
  assert.deepEqual([s.kind, s.sync_ok, s.can_push, s.empty, s.head], ['github', 1, 1, 1, head], JSON.stringify(s))
  fs.writeFileSync(path.join(hq.home, '.gitconfig'), `[url "file://${bare}/"]\n\tinsteadOf = https://github.com/\n`)
})

test('Bug 65: a project aimed at a clone is offered the clone, on GitHub too; Add opens it; a known one is opened; anyway still works', async () => {
  const site = path.join(parent, 'photo-site'); fs.mkdirSync(path.join(site, 'src'), { recursive: true }); sh(site, 'init', '-q', '-b', 'master')
  fs.writeFileSync(path.join(site, 'src', 'app.js'), 'x'); sh(site, 'add', '.'); sh(site, 'commit', '-q', '-m', 'app')
  const onGithub = () => fs.existsSync(path.join(bare, 'hq-bot')) ? fs.readdirSync(path.join(bare, 'hq-bot')) : []
  const hub = onGithub(), repos = (await hq.state()).repos.length
  const inside = await hq.api('repos/new', { name: 'photo site', parent: site, github: true })
  assert.equal(inside.status, 409); assert.deepEqual(inside.json.existing, { path: site, name: 'photo-site', repoId: null, inside: true })
  const next = await hq.api('repos/new', { name: 'photo-site', parent, github: true }) // the first step: the box's own Where, the clone's name
  assert.equal(next.status, 409); assert.deepEqual(next.json.existing, { path: site, name: 'photo-site', repoId: null, inside: false })
  assert.deepEqual(fs.readdirSync(site).sort(), ['.git', 'src']); assert.deepEqual(onGithub(), hub); assert.equal((await hq.state()).repos.length, repos)
  const added = await hq.api('repos', { path: inside.json.existing.path }); assert.equal(added.status, 200, JSON.stringify(added.json))
  assert.deepEqual([added.json.path, added.json.default_branch, added.json.empty], [site, 'master', 0])
  const again = await hq.api('repos/new', { name: 'photo site', parent: site, github: false })
  assert.equal(again.status, 409); assert.equal(again.json.existing.repoId, added.json.id)
  const anyway = await hq.api('repos/new', { name: 'Part of it', parent: site, github: false, nested: true })
  assert.equal(anyway.status, 200, JSON.stringify(anyway.json)); assert.equal(anyway.json.path, path.join(site, 'Part-of-it'))
  assert.equal((await hq.api('repos/new-setup', {})).json.parent, parent) // the next one starts outside the clone
})

test('a taken name and a failed push leave nothing behind', async () => {
  const other = path.join(hq.root, 'other'); fs.mkdirSync(other)
  const taken = await hq.api('repos/new', { name: 'Shop', parent: other, github: true })
  assert.equal(taken.status, 400); assert.match(taken.json.error, /hq-bot already has a GitHub repo called Shop/); assert.deepEqual(fs.readdirSync(other), [])
  gh.set({ noBare: true })
  const failed = await hq.api('repos/new', { name: 'Lost', parent: other, github: true })
  assert.equal(failed.status, 400); assert.deepEqual(fs.readdirSync(other), []); assert.deepEqual(gh.read().deleted, ['hq-bot/Lost'])
  assert.equal((await hq.state()).repos.some((x: any) => x.name === 'Lost'), false)
  gh.set({ noBare: false })
})
