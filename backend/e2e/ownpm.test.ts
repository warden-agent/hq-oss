// Bug 343: the user's own ⚙ command in a Yarn or pnpm project with nothing installed. HQ installs with the project's own package manager
// (it used `npm install --no-package-lock`, ignoring yarn.lock / pnpm-lock.yaml), and when that tool isn't installed it says so and starts
// nothing, never npm in its place. Stand-ins play yarn and pnpm, so the test doesn't depend on either being on the machine: the test HQ's
// PATH starts with the stand-ins' folder and leaves out any folder holding a real one (its other programs are linked in a folder of their own).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHq, waitFor, sh, type Hq } from './harness.ts'

const TOOLS = ['yarn', 'pnpm', 'yarnpkg', 'pnpx', 'corepack']
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b343-')), bin = path.join(scratch, 'bin'), calls = path.join(scratch, 'calls.log')
/** PATH with every folder that holds a real yarn or pnpm swapped for a folder of links to its other programs. */
function pathWithout(): string {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d, i) => {
    if (!TOOLS.some((t) => fs.existsSync(path.join(d, t)))) return d
    const farm = path.join(scratch, `path${i}`); fs.mkdirSync(farm)
    for (const f of fs.readdirSync(d)) if (!TOOLS.includes(f)) fs.symlinkSync(path.join(d, f), path.join(farm, f))
    return farm
  }).join(path.delimiter)
}
/** A stand-in for `tool`: `install` logs its words and installs ms (by copying a tiny one), anything else runs the app's start script. */
function standIn(tool: string): void {
  fs.writeFileSync(path.join(bin, tool), ['#!/bin/sh', `echo "${tool} $*" >> '${calls}'`,
    'if [ "$1" = install ]; then mkdir -p node_modules/ms && echo "module.exports = () => \'ms is here\'" > node_modules/ms/index.js && exit 0; fi',
    'exec node server.js', ''].join('\n'), { mode: 0o755 })
}
let hq: Hq
before(async () => { fs.mkdirSync(bin); hq = await startHq({ env: { PATH: `${bin}${path.delimiter}${pathWithout()}` } }) })
after(async () => { await hq?.stop(); fs.rmSync(scratch, { recursive: true, force: true }) })

const preview = async (repoId: string) => (await hq.state()).previews.find((p: any) => p.id === repoId)
const log = (tool: string) => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []).filter((l) => l.startsWith(`${tool} `))
/** A project whose app needs its one package: package.json lists ms, nothing installed, and `extra` (its lockfile). */
function project(name: string, extra: Record<string, string>): string {
  const dir = hq.repo(name); fs.rmSync(path.join(dir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { start: 'node server.js' }, dependencies: { ms: '2.1.3' } }))
  fs.writeFileSync(path.join(dir, 'server.js'), "require('http').createServer((q, s) => s.end(require('ms')())).listen(process.env.PORT)\n")
  for (const [f, t] of Object.entries(extra)) fs.writeFileSync(path.join(dir, f), t)
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'needs ms'); return dir
}

for (const [tool, lock, install] of [['yarn', 'yarn.lock', 'yarn install --frozen-lockfile'], ['pnpm', 'pnpm-lock.yaml', 'pnpm install --frozen-lockfile']]) {
  test(`Bug 343: ${tool} start in a project with a ${lock} and nothing installed installs with ${tool}, or says ${tool} isn't installed`, async () => {
    const name = `b343${tool[0]}`, dir = project(name, { [lock]: '# a lockfile\n' }), repo = (await hq.api('repos', { path: dir })).json
    fs.rmSync(path.join(bin, tool), { force: true }) // not installed
    assert.equal((await hq.api(`previews/${repo.id}/command`, { command: `${tool} start` })).status, 200)
    const r = await hq.api(`previews/${repo.id}/start`, {}); assert.notEqual(r.status, 200)
    const p = await preview(repo.id); assert.equal(p.status, 'stopped')
    assert.match(p.detail, new RegExp(`^HQ didn't start ${name}: it uses \\S+ \\(it has a ${lock.replace('.', '\\.')}\\), and ${tool} isn't installed on this computer`))
    assert.match(p.detail, /HQ won't install them with npm instead/); assert.ok(!fs.existsSync(path.join(dir, 'node_modules'))) // npm never ran
    const ev = (await hq.api('events?limit=50')).json.find((e: any) => e.kind === 'preview.error' && JSON.parse(e.payload).repo === name)
    assert.match(JSON.parse(ev.payload).error, /isn't installed on this computer/)

    standIn(tool) // installed now: Start installs with it, following the lockfile, and the app gets its package
    assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
    await waitFor('the app', async () => (await preview(repo.id)).status === 'running', 20_000)
    assert.equal(await (await fetch((await preview(repo.id)).url)).text(), 'ms is here')
    assert.deepEqual(log(tool), [`${tool} install --frozen-lockfile`, `${tool} start`])
    const started = (await hq.api('events?limit=50')).json.filter((e: any) => e.kind === 'preview.started').map((e: any) => JSON.parse(e.payload))
      .filter((e: any) => e.repo === name)
    assert.equal(started[0].install, install)
    assert.equal(sh(dir, 'status', '--porcelain'), '') // no lockfile written, node_modules kept out of git status

    // what it must not catch: a restart with everything installed installs nothing; with the tool gone again, the installed app still runs
    const before = log(tool).length
    assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
    await waitFor('the restart', async () => (await preview(repo.id)).status === 'running', 20_000)
    assert.deepEqual(log(tool).slice(before), [`${tool} start`])
    fs.rmSync(path.join(bin, tool)); fs.writeFileSync(path.join(dir, 'start.sh'), 'exec node server.js\n')
    assert.equal((await hq.api(`previews/${repo.id}/command`, { command: 'sh start.sh' })).status, 200)
    assert.equal((await hq.api(`previews/${repo.id}/start`, {})).status, 200)
    await waitFor('the app without its tool', async () => (await preview(repo.id)).status === 'running', 20_000)
    assert.equal((await hq.api(`previews/${repo.id}/stop`, {})).status, 200)
  })
}
