// New project against a temp HQ_HOME and throwaway folders, with GitHub faked (the real flow is covered by e2e/new-project):
// the name rules, refusing a folder in use, the empty first commit on main, and undoing everything when a step fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-newproject-'))
const { migrate } = await import('./db.ts')
migrate()
const { createProject, RepoHere } = await import('./newproject.ts')
const { projectSlug } = await import('./projectname.ts')
const { addRepo, defaultParent } = await import('./repos.ts')

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hq-np-'))
const fakes = (over: Partial<Parameters<typeof createProject>[3]> = {}) => {
  const calls: string[] = []
  return { calls, d: {
    createRepo: async (name: string) => { calls.push(`create ${name}`); return { slug: `hq-bot/${name}`, ownerId: 42 } },
    deleteRepo: async (slug: string) => { calls.push(`delete ${slug}`); return '' },
    push: async (_p: string, slug: string, branch: string) => { calls.push(`push ${slug} ${branch}`) },
    add: addRepo, ...over,
  } }
}

test('projectSlug: spaces to dashes, GitHub characters only, never empty', () => {
  assert.equal(projectSlug('  Budget tracker  '), 'Budget-tracker')
  assert.equal(projectSlug('my app!! v2.0'), 'my-app-v2.0')
  assert.equal(projectSlug('--.weird..name.-'), 'weird..name')
  assert.equal(projectSlug('  !!!  '), '')
})

test('local project: main with one empty commit, added to HQ as empty and local', async () => {
  const parent = tmp(); const { calls, d } = fakes()
  const r = await createProject('Budget tracker', parent, false, d)
  const dir = path.join(fs.realpathSync(parent), 'Budget-tracker')
  assert.equal(r.path, dir); assert.equal(r.name, 'Budget tracker'); assert.equal(r.kind, 'local'); assert.equal(r.empty, 1)
  assert.equal(sh(dir, 'symbolic-ref', '--short', 'HEAD'), 'main'); assert.equal(sh(dir, 'rev-list', '--count', 'HEAD'), '1')
  assert.equal(sh(dir, 'ls-tree', 'HEAD'), ''); assert.deepEqual(calls, [])
})

test('a folder that exists and has files is refused; an empty one is used', async () => {
  const parent = tmp(); fs.mkdirSync(path.join(parent, 'taken')); fs.writeFileSync(path.join(parent, 'taken', 'x'), 'x')
  const { calls, d } = fakes()
  await assert.rejects(createProject('taken', parent, true, d), /already exists and isn't empty/); assert.deepEqual(calls, []) // nothing asked of GitHub
  fs.mkdirSync(path.join(parent, 'blank')); assert.equal((await createProject('blank', parent, false, d)).empty, 1)
  await assert.rejects(createProject('x', path.join(parent, 'nope'), false, d), /does not exist/)
  await assert.rejects(createProject('!!!', parent, false, d), /letters or digits/)
})

/** A repo with a file in it, as a clone would be. */
const clone = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true }); sh(dir, 'init', '-q', '-b', 'master'); fs.writeFileSync(path.join(dir, 'app.js'), 'x')
  sh(dir, 'add', '.'); sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'app'); return dir
}
const refused = async (run: Promise<unknown>) => {
  const e = await run.then(() => assert.fail('it was made'), (x: unknown) => x as InstanceType<typeof RepoHere>)
  assert.ok(e instanceof RepoHere, String(e)); return e
}
const real = (p: string): string => fs.realpathSync(p)

test('Bug 65: Where is a repo, or a folder in one: nothing is made, the repo is offered', async () => {
  const repo = clone(path.join(tmp(), 'photo-site')); fs.mkdirSync(path.join(repo, 'src'))
  for (const where of [repo, path.join(repo, 'src')]) {
    const { calls, d } = fakes(); const before = fs.readdirSync(where)
    const e = await refused(createProject('photo site', where, true, d))
    assert.deepEqual(e.existing, { path: real(repo), name: 'photo-site', repoId: null, inside: true }); assert.match(e.message, /already part of the repo photo-site/)
    assert.deepEqual(calls, []); assert.deepEqual(fs.readdirSync(where), before) // nothing on GitHub, nothing on disk
  }
})

test('Bug 65: the folder the project would be is a repo, or a wrapper around one: it is offered', async () => {
  const parent = tmp(); const repo = clone(path.join(parent, 'photo-site')); const { calls, d } = fakes()
  const here = await refused(createProject('photo site', parent, true, d))
  assert.deepEqual(here.existing, { path: real(repo), name: 'photo-site', repoId: null, inside: false }); assert.match(here.message, /^There's already a repo at .*photo-site\.$/)
  const inner = clone(path.join(parent, 'wrapper', 'inner'))
  const wrapped = await refused(createProject('wrapper', parent, true, d))
  assert.deepEqual(wrapped.existing, { path: real(inner), name: 'inner', repoId: null, inside: false }); assert.match(wrapped.message, /^There's already a repo in .*wrapper: inner\.$/)
  assert.deepEqual(calls, []); assert.deepEqual(fs.readdirSync(path.join(parent, 'wrapper')), ['inner'])
})

test('Bug 65: several repos in that folder, or none: no offer', async () => {
  const parent = tmp(); clone(path.join(parent, 'two', 'a')); clone(path.join(parent, 'two', 'b'))
  fs.mkdirSync(path.join(parent, 'files')); fs.writeFileSync(path.join(parent, 'files', 'x'), 'x'); fs.writeFileSync(path.join(parent, 'afile'), 'x')
  const { calls, d } = fakes(); const offered = (e: Error) => assert.equal(e instanceof RepoHere, false, 'no offer')
  await assert.rejects(createProject('two', parent, true, d), (e: Error) => { offered(e); return /holds several repos: use Add repo/.test(e.message) })
  await assert.rejects(createProject('files', parent, true, d), (e: Error) => { offered(e); return /already exists and isn't empty/.test(e.message) })
  await assert.rejects(createProject('afile', parent, true, d), (e: Error) => { offered(e); return /already exists and isn't empty/.test(e.message) })
  assert.deepEqual(calls, [])
})

test('Bug 65: a repo HQ already has comes back with its id and its HQ name', async () => {
  const repo = clone(path.join(tmp(), 'folder-name')); const known = await addRepo(repo, 'My app'); const { d } = fakes()
  assert.deepEqual((await refused(createProject('x', repo, false, d))).existing, { path: real(repo), name: 'My app', repoId: known.id, inside: true })
})

test('Bug 65: Create here anyway makes it, and can never get the same offer again', async () => {
  const repo = clone(path.join(tmp(), 'big')); fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'x'), 'x')
  const { d } = fakes(); const r = await createProject('Sub app', repo, false, d, true)
  assert.equal(r.path, path.join(real(repo), 'Sub-app')); assert.equal(r.empty, 1); assert.equal(sh(r.path, 'rev-parse', '--show-toplevel'), r.path)
  // src is a plain folder inside the repo: the repo above it is not "already there", or the box would ask the same thing forever
  await assert.rejects(createProject('src', repo, false, d, true), (e: Error) => !(e instanceof RepoHere) && /already exists and isn't empty/.test(e.message))
  const own = await refused(createProject('Sub app', repo, false, d, true)) // a repo of its own there is still offered, with no way to force it
  assert.deepEqual([own.existing.path, own.existing.inside], [r.path, false])
})

test('Bug 65: a new project next to a clone in a plain wrapper folder is fine', async () => {
  const parent = tmp(); clone(path.join(parent, 'wrapper', 'inner')); const { d } = fakes()
  assert.equal((await createProject('Other', path.join(parent, 'wrapper'), false, d)).empty, 1)
})

test('Bug 65: the default place is never inside a repo, and a repo home folder does not count', async () => {
  const saved = process.env.HOME
  try {
    const home = real(tmp()); process.env.HOME = home; const stamp = Date.now() // repos() is shared with earlier tests: these come last
    const outer = clone(path.join(home, 'work', `outer-${stamp}`)); const inner = clone(path.join(outer, 'inner'))
    await addRepo(inner); assert.equal(await defaultParent(), path.join(home, 'work'))
    await addRepo(clone(path.join(home, 'plain', 'app'))); assert.equal(await defaultParent(), path.join(home, 'plain')) // as before
    sh(home, 'init', '-q'); await addRepo(clone(path.join(home, 'code', 'app'))); assert.equal(await defaultParent(), path.join(home, 'code')) // not /Users
  } finally { process.env.HOME = saved }
})

test('GitHub project: made first, then origin + push of main', async () => {
  const parent = tmp(); const { calls, d } = fakes({ add: async (p: string) => ({ path: p }) as never })
  await createProject('Shop', parent, true, d)
  const dir = path.join(parent, 'Shop')
  assert.deepEqual(calls, ['create Shop', 'push hq-bot/Shop main']); assert.equal(sh(dir, 'remote', 'get-url', 'origin'), 'https://github.com/hq-bot/Shop.git')
})

test('a failed push removes the folder and the GitHub repo it just made', async () => {
  const parent = tmp(); const { calls, d } = fakes({ push: async () => { throw new Error('push refused') } })
  await assert.rejects(createProject('Shop', parent, true, d), /^Error: push refused$/)
  assert.deepEqual(calls, ['create Shop', 'delete hq-bot/Shop']); assert.equal(fs.existsSync(path.join(parent, 'Shop')), false)
  fs.mkdirSync(path.join(parent, 'kept')) // an empty folder that was already there stays, without the .git HQ made
  const f = fakes({ push: async () => { throw new Error('push refused') }, deleteRepo: async () => { throw new Error('HTTP 403') } })
  await assert.rejects(createProject('kept', parent, true, f.d), /couldn't delete the GitHub repo hq-bot\/kept.*HTTP 403/)
  assert.deepEqual(fs.readdirSync(path.join(parent, 'kept')), [])
})

test('a taken GitHub name stops it before anything is made', async () => {
  const parent = tmp(); const { d } = fakes({ createRepo: async () => { throw new Error('hq-bot already has a GitHub repo called Shop: pick another name') } })
  await assert.rejects(createProject('Shop', parent, true, d), /already has a GitHub repo/); assert.deepEqual(fs.readdirSync(parent), [])
})

test('Add repo on a repo with no commits gives it an empty first commit, keeping what was staged', async () => {
  const d = tmp(); sh(d, 'init', '-b', 'trunk'); fs.writeFileSync(path.join(d, 'a'), 'a'); sh(d, 'add', 'a')
  const r = await addRepo(d)
  assert.equal(r.empty, 1); assert.equal(sh(d, 'rev-list', '--count', 'trunk'), '1'); assert.equal(sh(d, 'status', '--porcelain'), 'A  a')
})
