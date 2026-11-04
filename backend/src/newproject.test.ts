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
const { createProject } = await import('./newproject.ts')
const { projectSlug } = await import('./projectname.ts')
const { addRepo } = await import('./repos.ts')

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
