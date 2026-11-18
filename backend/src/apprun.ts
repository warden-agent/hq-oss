// How HQ runs a repo's app for the live preview: the launch recipe (which parts, folders, installs, commands, ports), whether a
// part needs installing, which ports, where it answers and whether it may be shown inside HQ. Fixed rules, no agent turns. No
// DB access here. The recipe itself is worked out once by the Launch helper (launchhelper.ts) or is the user's own ⚙ command.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { shq } from './util.ts'
import { lockedInstalls, npmInstalls, type LockedInstall, type NpmInstall } from './npminstalls.ts'

/** The ports HQ hands out to previews, from HQ_PREVIEW_PORTS ("3090-3099", the default; engineers' slots use 3101+ and 3110+).
 *  A test HQ gets a range of its own (Bug 44): two HQs that share one can both pick the same free port before either app is up. */
export function portRange(spec: string | undefined): number[] {
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(spec ?? '3090-3099'), lo = Number(m?.[1]), hi = Number(m?.[2])
  if (!m || lo < 1024 || hi > 65535 || hi < lo || hi - lo > 99) throw new Error(`HQ_PREVIEW_PORTS must look like 3090-3099 (at most 100 ports above 1023), not "${spec}"`)
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
}
export const PREVIEW_PORTS = portRange(process.env.HQ_PREVIEW_PORTS)

/** `npm run dev`, else `npm start`, from the repo's package.json; null when HQ can't tell how to start the app. */
export function detectCommand(repoPath: string): string | null {
  try {
    const scripts = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')).scripts ?? {}
    return scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : null
  } catch { return null }
}

/** Does this package.json give npm anything to install? A package with none still gets a package-lock.json written by
 *  `npm install` and no node_modules, so every later start would run `npm ci` again (Bug 90). Unreadable: assume it does. */
export function listsPackages(pkgPath: string): boolean {
  let pkg: Record<string, unknown>
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) } catch { return true }
  if (!pkg || typeof pkg !== 'object' || pkg.workspaces) return true // a workspace root: its packages list their own
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((k) => {
    const v = pkg[k]; return !!v && typeof v === 'object' && Object.keys(v).length > 0
  })
}

/** The install for a project with packages but no lockfile: npm would write a package-lock.json into it (Bug 116). */
export const NO_LOCK_INSTALL = 'npm install --no-package-lock'
/** Install first when npm's own record of what's installed (node_modules/.package-lock.json) is missing or older than the
 *  lockfile, e.g. after a merge changed dependencies. Without a lockfile: when nothing is installed yet, or npm's record is
 *  older than package.json (npm rewrites it on every install, even one with nothing to do), and never a lockfile written
 *  (Bug 116). A node_modules with no npm record (yarn's, pnpm's) is left alone. Never for a package.json that lists no
 *  packages, so Launch adds no file to the user's project (Bug 90). */
export function installStep(repoPath: string): 'npm ci' | typeof NO_LOCK_INSTALL | null {
  const at = (f: string) => { try { return fs.statSync(path.join(repoPath, f)).mtimeMs } catch { return null } }
  const pkg = at('package.json')
  if (pkg === null || !listsPackages(path.join(repoPath, 'package.json'))) return null
  const lock = at('package-lock.json'), record = at('node_modules/.package-lock.json')
  if (lock === null) return at('node_modules') === null || (record !== null && record < pkg) ? NO_LOCK_INSTALL : null
  return record === null || record < lock ? 'npm ci' : null
}

/** One part of an app: a folder of the repo, how to install it (optional) and run it, and its port. `auto`: HQ picks a free
 *  preview port and sets $PORT; a number is a port the project hard-wires (a proxy target, say). */
export type RecipePart = { name: string; dir: string; install?: string; install_when?: string; run: string; port: number | 'auto' }
/** How to start an app: its parts, the one whose page the user sees (`show`), the git-ignored files a ticket's worktree needs
 *  from the main checkout to run with the user's own settings and data (Try it), and the helper's notes for the user. */
export type Recipe = { parts: RecipePart[]; show: string; worktree_files: string[]; notes: string }

const rel = z.string().min(1).max(200).refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'), 'must be a path inside the repo')
export const recipePart = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,19}$/i, 'a short name: letters, digits, - or _'),
  dir: rel.describe('folder relative to the repo root, "." for the root'),
  install: z.string().min(1).max(300).optional().describe('lockfile-respecting install, e.g. npm ci, uv sync --locked, go build ./...'),
  install_when: rel.optional().describe('file (relative to dir) whose change means install again, e.g. package-lock.json, uv.lock'),
  run: z.string().min(1).max(500),
  port: z.union([z.number().int().min(1024).max(65535), z.literal('auto')]),
})
export const recipeShape = {
  parts: z.array(recipePart).min(1).max(6), show: z.string().describe('name of the part whose page the user sees'),
  worktree_files: z.array(rel).max(20).default([]), notes: z.string().max(2000).default(''),
}
const recipeSchema = z.object(recipeShape)

/** The folders from `dirPath` up to `root` (both included; just `dirPath` when it isn't inside `root`). */
function upTo(dirPath: string, root: string): string[] {
  const out = [dirPath], top = path.resolve(root)
  for (let d = path.resolve(dirPath); d !== top && path.dirname(d) !== d && !path.relative(top, d).startsWith('..');) { d = path.dirname(d); out.push(d) }
  return out
}
/** Does the workspace root `ws` (its package.json) list `member` as one of its npm workspaces? */
function lists(ws: string, member: string): boolean {
  let pkg: { workspaces?: unknown }
  try { pkg = JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8')) } catch { return false }
  const w = pkg?.workspaces, globs = Array.isArray(w) ? w : Array.isArray((w as { packages?: unknown })?.packages) ? (w as { packages: unknown[] }).packages : []
  const rel = path.relative(ws, member).split(path.sep).join('/')
  return globs.some((g) => typeof g === 'string' && !g.startsWith('!') && path.matchesGlob(rel, g.replace(/^\.\//, '').replace(/\/+$/, '')))
}
/** The package-lock.json an npm install in `dirPath` follows (Bug 156): its project's own (the nearest folder with a
 *  package.json, up to the repo root), else, for a workspace member, the workspace root's, as npm does. Null: none applies,
 *  and an `npm install` would write one. */
export function npmLock(dirPath: string, root: string): string | null {
  const up = upTo(dirPath, root), i = Math.max(0, up.findIndex((d) => fs.existsSync(path.join(d, 'package.json'))))
  const lock = (d: string) => ['package-lock.json', 'npm-shrinkwrap.json'].map((f) => path.join(d, f)).find((f) => fs.existsSync(f)) ?? null
  const own = lock(up[i]!); if (own) return own
  const ws = up.slice(i + 1).find((d) => lists(d, up[i]!))
  return ws ? lock(ws) : null
}
/** An install that would rewrite the lockfile instead of following it, which would leave changes behind in a worktree (Try
 *  it) and drift from what the repo pins, or that would write a package-lock.json into a project that has none (Bug 156).
 *  `dirPath`: the part's folder in the checkout `root`. Null when fine. */
export function lockfileProblem(install: string, dirPath: string, root: string = dirPath, installWhen?: string): string | null {
  return installProblem(install, dirPath, root, installWhen)?.why ?? null
}
/** The first install in `cmd` that the lockfile check refuses, and why. Each is found anywhere in the command and checked in the
 *  folder it runs in: `cd web && npm install` (Bug 191), `cd server && uv sync` (Bug 211). */
function installProblem(cmd: string, dirPath: string, root: string, installWhen?: string): { text: string; why: string } | null {
  for (const n of npmInstalls(cmd)) { const why = npmProblem(n, dirPath, root, installWhen); if (why) return { text: n.text, why } }
  for (const n of lockedInstalls(cmd)) { const why = lockedProblem(n, dirPath, root); if (why) return { text: n.text, why } }
  return null
}
/** Where an install runs: its folder, whether that's inside the checkout, and the words that name it when it isn't the part's own. */
function placed(n: { text: string; dir: string | null }, dirPath: string, root: string) {
  const at = n.dir === null ? null : path.resolve(dirPath, n.dir), inRepo = at !== null && !path.relative(path.resolve(root), at).startsWith('..')
  return { at: inRepo ? at : null, where: n.dir && at ? `\`${n.text}\` runs in ${path.relative(root, at) || '.'}: ` : '' }
}
/** A uv, yarn or pnpm install that would rewrite the lockfile of the folder it runs in instead of following it. */
function lockedProblem(n: LockedInstall, dirPath: string, root: string): string | null {
  if (n.frozen) return null // follows the lockfile wherever it runs
  const { at, where } = placed(n, dirPath, root)
  if (!at) return `HQ can't tell which folder of the repo \`${n.text}\` runs in: use ${n.fix}, or give the part that folder as its dir`
  if (!fs.existsSync(at)) return `${where}that folder doesn't exist`
  return fs.existsSync(path.join(at, n.lock)) ? `${where}use ${n.fix} (there is a ${n.lock})` : null
}
/** One npm install of a part's command, checked in the folder it runs in (the part's, or where its `cd`/`--prefix` takes it). */
function npmProblem(n: NpmInstall, dirPath: string, root: string, installWhen?: string): string | null {
  const { at, where } = placed(n, dirPath, root) // where: named when it isn't the part's own folder
  if (!at) return `HQ can't tell which folder of the repo \`${n.text}\` runs in: give the part that folder as its dir instead of a \`cd\` or \`--prefix\``
  if (!fs.existsSync(at)) return `${where}that folder doesn't exist`
  const lock = npmLock(at, root)
  if (lock) { // npm ci follows it; --no-package-lock writes nothing (a git-ignored lockfile may be in one checkout only)
    const above = path.dirname(lock) !== at ? ` at ${path.relative(root, lock)}, which this folder follows` : ''
    return n.ci || n.noLock ? null : `${where}use \`npm ci\` (there is a ${path.basename(lock)}${above})`
  }
  if (!n.noLock) return `${where}use \`${NO_LOCK_INSTALL}\` with install_when \`package.json\` (there is no package-lock.json`
    + `${n.ci ? ' for `npm ci` to follow' : ', and `npm install` would write one into the user\'s project'})`
  return installWhen === undefined || path.basename(installWhen) === 'package.json' ? null // its own or a workspace member's (web/package.json)
    : `${where}install_when must be a \`package.json\` with \`${NO_LOCK_INSTALL}\` (there is no lockfile to watch)`
}
/** The first part of a saved recipe whose install (or run) the lockfile check refuses in this checkout, and why (Bug 156: recipes saved
 *  before the check, or a lockfile added or removed since). Null when every part is fine. */
export function recipeProblem(r: Recipe, root: string): string | null {
  for (const p of r.parts) { const bad = partProblem(p, path.join(root, p.dir), root); if (bad) return `${p.name}: ${bad}` }
  return null
}
/** A part's install, and any install in its run command (it would run on every start, Bugs 191, 211), checked in this checkout. */
function partProblem(p: RecipePart, dir: string, root: string): string | null {
  const bad = p.install ? lockfileProblem(p.install, dir, root, p.install_when) : null; if (bad) return bad
  const run = installProblem(p.run, dir, root)
  return run && `run has an install that would run on every start (\`${run.text}\`; put installs in install): ${run.why}`
}

/** The recipe if it's one HQ can run in `root` (a checkout), else what's wrong, in words the helper can act on. */
export function checkRecipe(input: unknown, root: string): { recipe: Recipe } | { error: string } {
  const r = recipeSchema.safeParse(input)
  if (!r.success) return { error: r.error.issues.map((i) => `${i.path.join('.') || 'recipe'}: ${i.message}`).join('; ') }
  const recipe = r.data as Recipe, names = recipe.parts.map((p) => p.name)
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return { error: 'part names must be different' }
  if (!names.includes(recipe.show)) return { error: `show must be one of the parts (${names.join(', ')})` }
  const fixed = recipe.parts.flatMap((p) => p.port === 'auto' ? [] : [p.port])
  if (new Set(fixed).size !== fixed.length) return { error: 'two parts use the same fixed port' }
  const clash = fixed.find((p) => PREVIEW_PORTS.includes(p)); if (clash) return { error: `port ${clash} is one HQ hands out (${PREVIEW_PORTS[0]}–${PREVIEW_PORTS.at(-1)}); use "auto"` }
  for (const p of recipe.parts) {
    const dir = path.join(root, p.dir)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: `${p.name}: folder ${p.dir} doesn't exist` }
    if (p.install && !p.install_when) return { error: `${p.name}: install_when is required with install (the lockfile, so HQ installs again only when it changes)` }
    const bad = partProblem(p, dir, root); if (bad) return { error: `${p.name}: ${bad}` }
  }
  return { recipe }
}

/** What the user OKs: the commands and files, not the notes. A saved recipe whose commands are unchanged needs no new OK. */
export function recipeCommands(r: Recipe): string {
  return JSON.stringify({ parts: r.parts.map((p) => [p.name, p.dir, p.install ?? null, p.install_when ?? null, p.run, p.port]), files: r.worktree_files })
}
export const sameCommands = (a: Recipe | null, b: Recipe | null): boolean => !!a && !!b && recipeCommands(a) === recipeCommands(b)

/** The user's own ⚙ command as a one-part recipe (no OK needed: they typed it). Installs follow npm's own record (installStep). */
export function commandRecipe(command: string, repoPath: string): Recipe {
  const install = installStep(repoPath)
  return { parts: [{ name: 'app', dir: '.', run: command, port: 'auto', ...(install ? { install } : {}) }], show: 'app', worktree_files: [], notes: '' }
}

/** Ports for every part: fixed ones as written, auto ones from the preview range (the show part keeps `saved` when it's free).
 *  `taken`: fixed ports something else already holds, so HQ won't start an app that would talk to the wrong server. `avoid`: ports
 *  a Launch helper was given for its test runs (Bug 226), taken only when nothing else in the range is free. */
export async function assignPorts(r: Recipe, saved: number | null, busy: (port: number) => Promise<boolean> = portBusy, avoid: number[] = []):
  Promise<{ ports: Record<string, number>; taken: { part: string; port: number }[] } | null> {
  const ports: Record<string, number> = {}, taken: { part: string; port: number }[] = []
  for (const p of r.parts) if (p.port !== 'auto') { ports[p.name] = p.port; if (await busy(p.port)) taken.push({ part: p.name, port: p.port }) }
  const order = (p: RecipePart) => p.name === r.show ? 0 : 1 // the page the user sees gets the saved port first
  for (const p of [...r.parts].filter((x) => x.port === 'auto').sort((a, b) => order(a) - order(b))) {
    const prefer = p.name === r.show && saved && PREVIEW_PORTS.includes(saved) && !avoid.includes(saved) ? [saved] : []
    const tryIn = [...prefer, ...PREVIEW_PORTS.filter((c) => !avoid.includes(c)), ...PREVIEW_PORTS.filter((c) => avoid.includes(c))]
    let got: number | null = null
    for (const c of tryIn) if (!Object.values(ports).includes(c) && !(await busy(c))) { got = c; break }
    if (got === null) return null
    ports[p.name] = got
  }
  return { ports, taken }
}

/** Bug 226: the Launch helper's test runs use ports HQ gives it, from the preview range, never a port of its own choosing (it once ran an app on
 *  3180, outside its HQ's 4080–4089, where another HQ's app could answer). Up to `n` free ports, from the top of the range (previews take theirs
 *  from the bottom), in order: ones no other helper holds first, then (a busy HQ with many helpers) free ones another helper was given too, since
 *  they are still HQ's own. [] when no port in the range is free. */
export async function testPorts(held: number[], busy: (port: number) => Promise<boolean> = portBusy, n = 3, range: number[] = PREVIEW_PORTS): Promise<number[]> {
  const got: number[] = [], top = [...range].reverse()
  for (const c of [...top.filter((x) => !held.includes(x)), ...top.filter((x) => held.includes(x))]) {
    if (got.length >= n) break; if (!(await busy(c))) got.push(c)
  }
  return got.sort((a, b) => a - b)
}
/** The first port of the OS's own range (macOS 49152, Linux 32768): a dev server's internal workers listen there on whatever the OS hands them. */
export const EPHEMERAL_FROM = 32768
/** Ports a helper's test servers listen on that it wasn't given and that aren't a fixed port of its recipe (the project hard-wires those), in order.
 *  Ports the OS picked (EPHEMERAL_FROM and up) aren't the helper's choice. */
export function strayPorts(listening: number[], given: number[], r: Recipe): number[] {
  const fixed = r.parts.flatMap((p) => p.port === 'auto' ? [] : [p.port])
  return [...new Set(listening)].filter((p) => p < EPHEMERAL_FROM && !given.includes(p) && !fixed.includes(p)).sort((a, b) => a - b)
}

/** Fingerprint of a part's `install_when` file: in its folder, else the nearest one above it in the checkout `root` (a workspace
 *  member's lockfile is the root's, Bug 156). Null when it has none or the file is missing. */
export function installMark(dirPath: string, file: string | undefined, root: string = dirPath): string | null {
  if (!file) return null
  const at = upTo(dirPath, root).map((d) => path.join(d, file)).find((f) => fs.existsSync(f)); if (!at) return null
  try { return createHash('sha256').update(fs.readFileSync(at)).digest('hex').slice(0, 16) } catch { return null }
}
/** Should this part install before it runs? With install_when (the helper's recipes): when it never installed in this
 *  checkout, or that file changed since (marks from the supervisor, keyed by the folder). Without it (the user's own command,
 *  whose install installStep already chose from npm's own record): every time it's there. */
export function needsInstall(p: RecipePart, dirPath: string, marks: Record<string, string>, root: string = dirPath): boolean {
  if (!p.install) return false
  if (!p.install_when) return true
  const done = marks[dirPath]; if (done === undefined) return true
  const now = installMark(dirPath, p.install_when, root); return now !== null && now !== done
}

/** What the supervisor (supervise.mjs) runs: per part its folder, install (only if needed), command and environment. */
export type SupervisorSpec = {
  header: string; marksFile: string
  parts: { name: string; cwd: string; install: string | null; mark: string | null; run: string; env: Record<string, string> }[]
}
export function supervisorSpec(o: { recipe: Recipe; root: string; ports: Record<string, number>; marks: Record<string, string>; marksFile: string; header: string }): SupervisorSpec {
  const shared = Object.fromEntries(Object.entries(o.ports).map(([n, p]) => [`HQ_PORT_${n.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, String(p)]))
  return {
    header: o.header, marksFile: o.marksFile,
    parts: o.recipe.parts.map((p) => {
      const cwd = path.join(o.root, p.dir), install = needsInstall(p, cwd, o.marks, o.root) ? p.install! : null
      return { name: p.name, cwd, install, mark: install ? installMark(cwd, p.install_when, o.root) ?? 'installed' : null, run: p.run,
        env: { ...shared, PORT: String(o.ports[p.name]), BROWSER: 'none' } }
    }),
  }
}
/** Bug 77: every program a preview run starts carries this variable (they inherit it from the run's script), so HQ can tell what a run left behind from the
 *  user's own programs in the same folder. Its value names the HQ (two can run on one machine), the repo and the start. */
export const RUN_MARK = 'HQ_PREVIEW_RUN'
export const runMark = (hqHome: string, repoId: string, startedAt: number): string => `${createHash('sha256').update(hqHome).digest('hex').slice(0, 8)}.${repoId}.${startedAt}`
export function parseRunMark(mark: string): { hq: string; repoId: string; startedAt: number } | null {
  const m = /^([0-9a-f]{8})\.(.+)\.(\d+)$/.exec(mark); return m ? { hq: m[1]!, repoId: m[2]!, startedAt: Number(m[3]) } : null
}
/** The script the preview's tmux session runs: the supervisor, with the spec file HQ wrote next to it and the run's mark. */
export function runScript(o: { cwd: string; node: string; supervisor: string; spec: string; mark?: string }): string {
  return ['#!/bin/bash', `cd ${shq(o.cwd)} || exit 1`, ...(o.mark ? [`export ${RUN_MARK}=${shq(o.mark)}`] : []),
    `exec ${shq(o.node)} ${shq(o.supervisor)} ${shq(o.spec)}`].join('\n') + '\n'
}

/** Loopback ports the app printed (`http://localhost:5173/`), for apps such as Vite that pick their own port. */
export function printedPorts(text: string): number[] {
  const ports = [...text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/g)].map((m) => Number(m[1]))
  return [...new Set(ports)].filter((p) => p > 0 && p < 65536)
}

/** True when the app's reply forbids being shown inside HQ's page (another origin): X-Frame-Options DENY/SAMEORIGIN, or a
 *  CSP frame-ancestors that allows neither any origin nor a loopback one. */
export function frameBlocked(get: (name: string) => string | null): boolean {
  const xfo = (get('x-frame-options') ?? '').toLowerCase()
  if (/\b(deny|sameorigin)\b/.test(xfo)) return true
  const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(get('content-security-policy') ?? '')
  if (!fa) return false
  const sources = fa[1]!.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return !sources.some((s) => s === '*' || s === 'http:' || /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::(?:\d+|\*))?\/?$/.test(s))
}

/** Something accepts connections on this port (IPv4 or IPv6 loopback). */
export function portBusy(port: number): Promise<boolean> {
  const one = (host: string) => new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port }); const done = (busy: boolean) => { s.destroy(); resolve(busy) }
    s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(500, () => done(false))
  })
  return Promise.all([one('127.0.0.1'), one('::1')]).then(([a, b]) => a || b)
}
