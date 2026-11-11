// Bug 97: HQ knows which Claude Code its agents run, and says so when it isn't the version HQ was checked on, or when a newer one is installed.
// Each "Claude Code" here answers --version itself and is the fake for everything else; an update is what it is on a real machine: the link moves.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startHq, waitFor, type Hq } from './harness.ts'
import { CHECKED_VERSION } from '../src/claudeversion.ts'

const FAKE = path.join(import.meta.dirname, 'fake-claude.mjs'), BACKEND = path.resolve(import.meta.dirname, '..')
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-cv-')))
const hqs: Hq[] = []
after(async () => { for (const h of hqs) await h.stop(); fs.rmSync(dir, { recursive: true, force: true }) })
async function start(env: NodeJS.ProcessEnv = {}): Promise<Hq> { const h = await startHq({ env }); hqs.push(h); return h }
let n = 0
/** One Claude Code of `version`. */
function claude(version: string): string {
  const f = path.join(dir, `claude-${version}-${++n}`)
  fs.writeFileSync(f, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 }); return f
}
/** The link people run, pointed at one version: an update moves it. */
function point(link: string, to: string): string { fs.rmSync(link, { force: true }); fs.symlinkSync(to, link); return link }
/** Launches an agent (a new project's TPM) and returns it once its session has started. */
async function launch(hq: Hq): Promise<any> {
  const repo = (await hq.api('repos', { path: hq.repo(`v${++n}`) })).json, a = (await hq.api(`repos/${repo.id}/message`, { body: 'hello' })).json.agent
  return waitFor('the TPM', async () => (await hq.state()).agents.find((x: any) => x.id === a.id && x.status === 'working'))
}
const open = async (hq: Hq, kind: string): Promise<any[]> => (await hq.state()).attention.filter((x: any) => x.kind === kind)
const events = async (hq: Hq, kind: string): Promise<any[]> => (await hq.api('events?limit=500')).json.filter((e: any) => e.kind === kind).map((e: any) => ({ ...e, payload: JSON.parse(e.payload) }))
const NEWER = '9.9.9', NEWEST = '9.9.10'

test('Bug 97: on the version HQ was checked on there is nothing to tell, and the page, the start and each launch say which one runs', async () => {
  const hq = await start()
  assert.deepEqual((await hq.state()).claude, { checked: CHECKED_VERSION, runs: CHECKED_VERSION, installed: null })
  assert.deepEqual((await hq.state()).attention, [])
  const a = await launch(hq)
  assert.equal((await events(hq, 'agent.launched')).find((e) => e.agent_id === a.id).payload.claude, CHECKED_VERSION)
  assert.equal((await events(hq, 'backend.started'))[0].payload.claude.runs, CHECKED_VERSION)
  assert.deepEqual((await hq.state()).attention, [])
})

test('Bug 97: Claude Code updated under HQ: the next launch says so once, a tick stays ticked, and going back clears it', async () => {
  const link = point(path.join(dir, 'claude-agents'), claude(CHECKED_VERSION))
  const hq = await start({ HQ_CLAUDE_BIN: link, HQ_CLAUDE_CHECK_S: '3600' }) // no timer here: the launch is what looks
  await launch(hq); assert.deepEqual(await open(hq, 'claude_unchecked'), [])
  point(link, claude(NEWER))
  const a = await launch(hq), [told] = await open(hq, 'claude_unchecked')
  assert.match(told.detail, new RegExp(`now run Claude Code ${NEWER}, but HQ has only been checked on ${CHECKED_VERSION}`))
  assert.equal((await hq.state()).claude.runs, NEWER)
  assert.equal((await events(hq, 'agent.launched')).find((e) => e.agent_id === a.id).payload.claude, NEWER)
  await launch(hq); assert.equal((await open(hq, 'claude_unchecked')).length, 1) // the same version again: not said twice
  await hq.api(`attention/${told.id}/resolve`, {})
  await launch(hq); assert.deepEqual(await open(hq, 'claude_unchecked'), []) // ticked away: it stays away
  await hq.restart(); await launch(hq); assert.deepEqual(await open(hq, 'claude_unchecked'), []) // also over a restart
  point(link, claude(NEWEST))
  await launch(hq); assert.match((await open(hq, 'claude_unchecked'))[0].detail, new RegExp(NEWEST.replaceAll('.', '\\.'))) // another version is news
  point(link, claude(CHECKED_VERSION))
  await launch(hq); assert.deepEqual(await open(hq, 'claude_unchecked'), []); assert.equal((await hq.state()).claude.runs, CHECKED_VERSION)
})

test("Bug 97: a newer Claude Code installed on this computer is told without any launch, once, and HQ's agents stay where they are", async () => {
  const mine = point(path.join(dir, 'claude-mine'), claude(CHECKED_VERSION))
  const hq = await start({ HQ_INSTALLED_CLAUDE: mine, HQ_CLAUDE_CHECK_S: '1' })
  assert.deepEqual((await hq.state()).claude, { checked: CHECKED_VERSION, runs: CHECKED_VERSION, installed: CHECKED_VERSION }); assert.deepEqual((await hq.state()).attention, [])
  point(mine, claude(NEWER))
  const [told] = await waitFor('the notice', async () => { const o = await open(hq, 'claude_newer'); return o.length ? o : null })
  assert.match(told.detail, new RegExp(`Claude Code ${NEWER} is installed on this computer\\. HQ's agents stay on ${CHECKED_VERSION}`))
  assert.deepEqual((await hq.state()).claude, { checked: CHECKED_VERSION, runs: CHECKED_VERSION, installed: NEWER })
  assert.deepEqual(await open(hq, 'claude_unchecked'), []) // nothing is wrong with what the agents run
  assert.equal((await events(hq, 'agent.launched')).length, 0); const a = await launch(hq)
  assert.equal((await events(hq, 'agent.launched')).find((e) => e.agent_id === a.id).payload.claude, CHECKED_VERSION)
  await hq.api(`attention/${told.id}/resolve`, {})
  point(mine, claude(NEWEST)) // the next update is news again, and the ticked one hasn't come back with it
  const again = await waitFor('the next notice', async () => { const o = await open(hq, 'claude_newer'); return o.length ? o : null })
  assert.equal(again.length, 1); assert.match(again[0].detail, new RegExp(NEWEST.replaceAll('.', '\\.')))
  point(mine, claude(CHECKED_VERSION))
  await waitFor('the notice to go', async () => !(await open(hq, 'claude_newer')).length)
})

test("Bug 97: HQ takes its own copy of the checked version from this computer's Claude Code, and its agents run the copy", async () => {
  const mine = point(path.join(dir, 'claude-first'), claude(CHECKED_VERSION))
  const hq = await start({ HQ_CLAUDE_BIN: '', HQ_INSTALLED_CLAUDE: mine })
  const own = path.join(hq.hqHome, 'bin', `claude-${CHECKED_VERSION}`)
  assert.equal(fs.lstatSync(own).isFile(), true)
  assert.deepEqual((await events(hq, 'claude.copied')).map((e) => e.payload), [{ version: CHECKED_VERSION, from: mine, to: own }])
  fs.rmSync(mine) // the user's Claude Code moves on: HQ's copy is its own
  const a = await launch(hq); assert.match(fs.readFileSync(path.join(hq.hqHome, 'agents', a.id, 'launch.sh'), 'utf8'), new RegExp(`exec '?${own.replaceAll('.', '\\.')}`))
  await hq.restart(); assert.equal((await events(hq, 'claude.copied')).length, 1) // there already: not copied again
  assert.deepEqual(await open(hq, 'claude_unchecked'), [])
})

test("Bug 97: with no copy and no such version on this computer, HQ doesn't start and says what to do", () => {
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  // Its own home, ports and tmux folder, like every test HQ: if it ever did start, it must not be on the live HQ's
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: home, HQ_HOME: path.join(home, 'hq'), HQ_UI_PORT: '0', HQ_HOOKS_PORT: '0', HQ_MCP_PORT: '0', TMUX_TMPDIR: home,
    HQ_INSTALLED_CLAUDE: '' }
  delete base.TMUX; delete base.TMUX_PANE
  const run = (bin: string) => spawnSync(process.execPath, ['--experimental-strip-types', 'src/index.ts'], { cwd: BACKEND, encoding: 'utf8', timeout: 30_000, env: { ...base, HQ_CLAUDE_BIN: bin } })
  const r = run('')
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, new RegExp(`its own copy of Claude Code ${CHECKED_VERSION.replaceAll('.', '\\.')}, and this computer doesn't have that version`))
  assert.match(r.stderr, /HQ_CLAUDE_BIN=<path to a claude binary>/)
  assert.doesNotMatch(r.stdout, /HQ backend up/)
  const gone = run(path.join(home, 'no-such-claude')) // a typo in the setting
  assert.equal(gone.status, 1, gone.stderr); assert.match(gone.stderr, /HQ_CLAUDE_BIN names a Claude Code binary that isn't there: .*no-such-claude/)
})

