// Bug 97: which Claude Code is which, what HQ tells the user about it, and HQ's own copy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHECKED_VERSION, installedBin, newer, notices, ownCopy, parseVersion, readVersion, versionOf, type ClaudeInfo } from './claudeversion.ts'

const dir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-claude-')))
/** A stand-in binary that answers --version as Claude Code does. */
function fake(file: string, version: string): string { fs.writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 }); return file }

test('parseVersion: what `claude --version` prints, and nothing else', () => {
  assert.equal(parseVersion('2.1.322 (Claude Code)\n'), '2.1.322')
  assert.equal(parseVersion('  2.1.300 (Claude Code)'), '2.1.300')
  for (const s of ['', 'claude: command not found', 'Claude Code 2.1.322', '2.1 (Claude Code)', '2.1.322.4 (Claude Code)']) assert.equal(parseVersion(s), null, s)
})
test('newer: by its numbers, not as text', () => {
  assert.equal(newer('2.1.323', '2.1.322'), true)
  assert.equal(newer('2.1.1000', '2.1.322'), true) // "1000" sorts before "322" as text
  assert.equal(newer('2.2.0', '2.1.999'), true)
  assert.equal(newer('3.0.0', '2.9.9'), true)
  for (const [a, b] of [['2.1.322', '2.1.322'], ['2.1.300', '2.1.322'], ['2.0.999', '2.1.0'], ['1.9.9', '2.0.0']]) assert.equal(newer(a!, b!), false, `${a} > ${b}`)
})

const info = (runs: string | null, installed: string | null = null): ClaudeInfo => ({ checked: '2.1.322', runs, installed })
test('notices: the checked version, with the same one or none installed, says nothing', () => {
  for (const i of [info('2.1.322'), info('2.1.322', '2.1.322'), info('2.1.322', '2.1.300')]) { // an older one installed is the user's business
    assert.deepEqual(notices(i, {}, 'claude'), { say: { claude_unchecked: undefined, claude_newer: undefined }, told: {} })
  }
})
test('notices: agents on a version HQ was not checked on are told once per version', () => {
  const first = notices(info('2.1.340', '2.1.340'), {}, 'claude')
  assert.match(first.say.claude_unchecked!, /now run Claude Code 2\.1\.340, but HQ has only been checked on 2\.1\.322/)
  assert.equal(first.say.claude_newer, undefined) // the agents already run it: one notice, not two
  assert.deepEqual(first.told, { unchecked: '2.1.340' })
  assert.deepEqual(notices(info('2.1.340', '2.1.340'), first.told, 'claude').say, { claude_unchecked: undefined, claude_newer: undefined }) // ticked away or not, not said again
  assert.match(notices(info('2.1.341'), first.told, 'claude').say.claude_unchecked!, /2\.1\.341/) // another version: said again
  assert.match(notices(info('2.1.300'), {}, 'claude').say.claude_unchecked!, /2\.1\.300/) // an older one wasn't checked either
  const back = notices(info('2.1.322'), first.told, 'claude') // back on the checked one: the notice goes, and a later change is told afresh
  assert.deepEqual(back, { say: { claude_unchecked: null, claude_newer: undefined }, told: {} })
})
test("notices: a binary that won't say its version is told too, with its path", () => {
  const r = notices(info(null), {}, '/opt/claude')
  assert.match(r.say.claude_unchecked!, /can't tell which Claude Code its agents run: "\/opt\/claude --version" gave no version/)
  assert.deepEqual(r.told, { unchecked: 'unknown' })
  assert.equal(notices(info(null), r.told, '/opt/claude').say.claude_unchecked, undefined)
})
test("notices: a newer Claude Code installed here is information, once per version, and goes when it's no longer newer", () => {
  const first = notices(info('2.1.322', '2.1.340'), {}, 'claude')
  assert.match(first.say.claude_newer!, /Claude Code 2\.1\.340 is installed on this computer\. HQ's agents stay on 2\.1\.322/)
  assert.equal(first.say.claude_unchecked, undefined)
  assert.deepEqual(first.told, { newer: '2.1.340' })
  assert.equal(notices(info('2.1.322', '2.1.340'), first.told, 'claude').say.claude_newer, undefined)
  assert.match(notices(info('2.1.322', '2.1.341'), first.told, 'claude').say.claude_newer!, /2\.1\.341/)
  for (const installed of ['2.1.322', null]) assert.deepEqual(notices(info('2.1.322', installed), first.told, 'claude'), { say: { claude_unchecked: undefined, claude_newer: null }, told: {} })
})
test('notices: HQ moving onto the newer version swaps one notice for the other', () => {
  const r = notices(info('2.1.340', '2.1.340'), { newer: '2.1.340' }, 'claude')
  assert.match(r.say.claude_unchecked!, /2\.1\.340/); assert.equal(r.say.claude_newer, null); assert.deepEqual(r.told, { unchecked: '2.1.340' })
})

test('readVersion and versionOf: asks the binary, and again only once its file has changed', async () => {
  const d = dir(), bin = fake(path.join(d, 'claude'), '2.1.322'), link = path.join(d, 'link'); fs.symlinkSync(bin, link)
  assert.equal(await readVersion(bin), '2.1.322')
  assert.equal(await readVersion(path.join(d, 'missing')), null)
  assert.equal(await versionOf(link), '2.1.322')
  const other = fake(path.join(d, 'claude-next'), '2.1.340'); fs.rmSync(link); fs.symlinkSync(other, link) // an update moves the link
  assert.equal(await versionOf(link), '2.1.340')
  fs.writeFileSync(other, '#!/bin/sh\necho "2.1.341 (Claude Code)"\n# rewritten in place\n') // or writes the file again
  assert.equal(await versionOf(link), '2.1.341')
  fs.rmSync(link); assert.equal(await versionOf(link), null)
  fs.rmSync(d, { recursive: true, force: true })
})
test("installedBin: the user's own `claude` on PATH, unless HQ_INSTALLED_CLAUDE names one or says there is none", () => {
  const d = dir(), a = path.join(d, 'a'), b = path.join(d, 'b'); fs.mkdirSync(a); fs.mkdirSync(b); fake(path.join(b, 'claude'), '2.1.322')
  fs.mkdirSync(path.join(a, 'claude')) // a folder of that name isn't it
  assert.equal(installedBin({ PATH: [a, b].join(path.delimiter) }), path.join(b, 'claude'))
  assert.equal(installedBin({ PATH: a }), null)
  assert.equal(installedBin({ PATH: b, HQ_INSTALLED_CLAUDE: '/somewhere/claude' }), '/somewhere/claude')
  assert.equal(installedBin({ PATH: b, HQ_INSTALLED_CLAUDE: '' }), null)
  fs.rmSync(d, { recursive: true, force: true })
})
test("ownCopy: takes HQ's copy from the first place that really is that version, and leaves one that's there alone", async () => {
  const d = dir(), bin = path.join(d, 'hq', 'bin', 'claude-2.1.322')
  const wrong = fake(path.join(d, 'named-2.1.322-but-older'), '2.1.300'), right = fake(path.join(d, 'installed'), '2.1.322'), link = path.join(d, 'claude'); fs.symlinkSync(right, link)
  assert.equal(await ownCopy(bin, '2.1.322', [path.join(d, 'missing'), wrong]), null) // nothing here is 2.1.322
  assert.equal(fs.existsSync(bin), false)
  assert.equal(await ownCopy(bin, '2.1.322', [wrong, link]), link)
  assert.equal(fs.lstatSync(bin).isFile(), true) // the file itself, not a link to one the updater may delete
  assert.equal(await readVersion(bin), '2.1.322'); assert.deepEqual(fs.readdirSync(path.dirname(bin)), ['claude-2.1.322']) // and nothing half-copied beside it
  fs.rmSync(right) // Claude Code moved on and deleted its old version: HQ's copy still runs
  assert.equal(await readVersion(bin), '2.1.322')
  assert.equal(await ownCopy(bin, '2.1.322', []), '') // there already
  fs.rmSync(d, { recursive: true, force: true })
})
test('CHECKED_VERSION is a plain version', () => { assert.equal(parseVersion(CHECKED_VERSION), CHECKED_VERSION) })
