// How HQ runs a repo's app for the live preview: the launch recipe (which parts, folders, installs, commands, ports), whether a
// part needs installing, which ports, where it answers and whether it may be shown inside HQ. Fixed rules, no agent turns. No
// DB access here. The recipe itself is worked out once by the Launch helper (launchhelper.ts) or is the user's own ⚙ command.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { shq } from './util.ts'
import { cantListen } from './ports.ts'
import { lockedInstalls, npmInstalls, uvVenvs, type LockedInstall, type NpmInstall } from './npminstalls.ts'

/** The ports HQ hands out to previews, from HQ_PREVIEW_PORTS ("3090-3099", the default; engineers get ports of their own, slotports.ts).
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
  const lock = at('package-lock.json') ?? at('npm-shrinkwrap.json'), record = at('node_modules/.package-lock.json') // npm ci follows either (Bug 343)
  if (lock === null) return at('node_modules') === null || (record !== null && record < pkg) ? NO_LOCK_INSTALL : null
  return record === null || record < lock ? 'npm ci' : null
}

/** Is `tool` a program on this PATH (HQ's own, which the app's run inherits)? */
export function onPath(tool: string, PATH: string = process.env.PATH ?? ''): boolean {
  return PATH.split(path.delimiter).filter(Boolean).some((d) => {
    try { const f = path.join(d, tool); fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile() } catch { return false }
  })
}
type NodeTool = 'npm' | 'yarn' | 'pnpm' | 'bun'
/** Bug 343: the package manager a Node project uses: the one its package.json's `packageManager` names (what Corepack follows), else the
 *  one whose lockfile it has (npm's first, as before; then yarn.lock, pnpm-lock.yaml, bun.lock or bun.lockb: Bug 358), else npm. `lock`: that tool's lockfile, if there is
 *  one; `why`: how HQ can tell, in the user's words; `major`: the version `packageManager` names. */
export function packageManager(repoPath: string): { tool: NodeTool; lock: string | null; why: string; major: number | null } {
  const lockOf = (t: NodeTool) => LOCKS[t].files.find((f) => fs.existsSync(path.join(repoPath, f))) ?? null
  let named: unknown; try { named = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'))?.packageManager } catch { /* none */ }
  const m = typeof named === 'string' ? /^(npm|yarn|pnpm|bun)@(\d+)/.exec(named) : null
  if (m) {
    const tool = m[1] as NodeTool
    return { tool, lock: lockOf(tool), why: `its package.json names ${String(named).split('+')[0]} as its packageManager`, major: Number(m[2]) }
  }
  for (const tool of ['npm', 'yarn', 'pnpm', 'bun'] as const) { const lock = lockOf(tool); if (lock) return { tool, lock, why: `it has a ${lock}`, major: null } }
  return { tool: 'npm', lock: null, why: 'it has no lockfile', major: null }
}
/** Bug 343: what HQ does about the packages before the user's own ⚙ command: an install by the project's own package manager (npm's as
 *  installStep says; Yarn's, pnpm's and Bun's (Bug 358) follow their lockfile, or write none when there is none, and run again when it changes or what they
 *  made is gone, as Claude's steps do), nothing, or `stop`: why HQ can't install them (the tool isn't installed; Yarn 2+ with no yarn.lock
 *  would write one), in words for the user (plain text: the App tab shows it as it is). It never falls back to npm, which ignores the
 *  others' lockfiles (and with none, writes a package-lock.json). A project whose packages
 *  are installed already (node_modules, .pnp.cjs) runs as it is when HQ can't install them, as before. `again`: what the user does once it's
 *  fixed (HQ's own test runs use the same rule, Bug 392). */
export function ownInstall(repoPath: string, has: (tool: string) => boolean = onPath, again = 'press Start again'): { install?: string; install_when?: string
  stop?: string } {
  const pkg = path.join(repoPath, 'package.json'); if (!fs.existsSync(pkg) || !listsPackages(pkg)) return {}
  const pm = packageManager(repoPath)
  if (pm.tool === 'npm') { const install = installStep(repoPath); return install ? { install } : {} }
  const berry = pm.tool === 'yarn' && (pm.major !== null ? pm.major >= 2 : yarnBerry(repoPath))
  const install = pm.tool === 'pnpm' ? `pnpm install ${pm.lock ? '--frozen-lockfile' : '--no-lockfile'}`
    : pm.tool === 'bun' ? `bun install ${pm.lock ? '--frozen-lockfile' : '--no-save'}` // Bug 358: --no-save writes no bun.lock (bun 1.4.5)
    : pm.lock ? `yarn install ${berry ? '--immutable' : '--frozen-lockfile'}` : berry ? null : 'yarn install --pure-lockfile'
  if (install && has(pm.tool)) return { install, install_when: pm.lock ?? 'package.json' }
  const made = install ? installOutputs(install, repoPath) : ['node_modules', '.pnp.cjs'].filter((f) => fs.existsSync(path.join(repoPath, f)))
  if (made.length && made.every((f) => fs.existsSync(path.resolve(repoPath, f)))) return {}
  const name = ({ yarn: 'Yarn', pnpm: 'pnpm', bun: 'Bun' } as const)[pm.tool]
  if (!install) {
    return { stop: `it uses Yarn ${pm.major ?? 2} (${pm.why}) and has no yarn.lock. Yarn 2 and later always write one, and HQ doesn't add files to `
      + `your project, so it installed nothing. Run yarn install in the project yourself (and commit the yarn.lock it writes), then ${again}.` }
  }
  return { stop: `it uses ${name} (${pm.why}), and ${pm.tool} isn't installed on this computer (HQ looked in its PATH), so HQ can't install its packages. `
    + `HQ won't install them with npm instead: ${pm.lock ? `npm ignores the ${pm.lock} and could install other versions` : `the project asks for ${name}`}. `
    + `Install ${name}, then ${again}.` }
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
/** Does the uv workspace root `ws` (its pyproject.toml's [tool.uv.workspace]) have `member` as one of its members, and not in
 *  its `exclude`? A light reading of the TOML: the two lists of quoted globs. Checked on uv 0.12.9: a member follows the root's
 *  uv.lock; an excluded or unlisted project inside it gets its own. */
function uvLists(ws: string, member: string): boolean {
  let toml: string
  try { toml = fs.readFileSync(path.join(ws, 'pyproject.toml'), 'utf8') } catch { return false }
  const at = /^\[tool\.uv\.workspace\][ \t]*$/m.exec(toml); if (!at) return false
  const table = toml.slice(at.index + at[0].length).split(/^\[/m)[0]!
  const globs = (key: string) => [...(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(table)?.[1] ?? '').matchAll(/"([^"]*)"|'([^']*)'/g)]
    .map((m) => (m[1] ?? m[2]!).replace(/^\.\//, '').replace(/\/+$/, ''))
  const rel = path.relative(ws, member).split(path.sep).join('/'), hit = (g: string) => path.matchesGlob(rel, g)
  return globs('members').some(hit) && !globs('exclude').some(hit)
}
/** Each install tool: the file that makes a folder its project, its lockfiles, and whether a folder above is the workspace
 *  root whose lockfile a project follows (npm, yarn and bun: listed in the root package.json's workspaces; pnpm: any folder with a
 *  pnpm-workspace.yaml, as pnpm does; uv: a member of its [tool.uv.workspace]). Bun 1.2 and later write a bun.lock, older ones a bun.lockb (Bug 358). */
const LOCKS = {
  npm: { manifest: 'package.json', files: ['package-lock.json', 'npm-shrinkwrap.json'], root: lists },
  yarn: { manifest: 'package.json', files: ['yarn.lock'], root: lists },
  pnpm: { manifest: 'package.json', files: ['pnpm-lock.yaml'], root: (ws: string) => fs.existsSync(path.join(ws, 'pnpm-workspace.yaml')) },
  bun: { manifest: 'package.json', files: ['bun.lock', 'bun.lockb'], root: lists },
  uv: { manifest: 'pyproject.toml', files: ['uv.lock'], root: uvLists },
}
/** The lockfile an install of `tool` in `dirPath` follows (Bugs 156, 240): its project's own (the nearest folder with the tool's
 *  manifest, up to the repo root), else its workspace root's, as the tool does. `lock` null: none applies, and a plain install
 *  would write one. `project` null: no manifest anywhere up to the root. */
function lockOf(tool: keyof typeof LOCKS, dirPath: string, root: string): { lock: string | null; project: string | null } {
  const k = LOCKS[tool], up = upTo(dirPath, root), i = up.findIndex((d) => fs.existsSync(path.join(d, k.manifest))), project = up[Math.max(0, i)]!
  const lock = (d: string) => k.files.map((f) => path.join(d, f)).find((f) => fs.existsSync(f)) ?? null
  const own = lock(project); if (own) return { lock: own, project: i < 0 ? null : project }
  const ws = up.slice(Math.max(0, i) + 1).find((d) => k.root(d, project))
  return { lock: ws ? lock(ws) : null, project: i < 0 ? null : project }
}
/** The package-lock.json an npm install in `dirPath` follows (Bug 156). Null: none applies, and an `npm install` would write one. */
export const npmLock = (dirPath: string, root: string): string | null => lockOf('npm', dirPath, root).lock
/** An install that would rewrite the lockfile instead of following it, which would leave changes behind in a worktree (Try
 *  it) and drift from what the repo pins, or that would write a lockfile into a project that has none (Bugs 156, 239).
 *  `dirPath`: the part's folder in the checkout `root`. Null when fine. */
export function lockfileProblem(install: string, dirPath: string, root: string = dirPath, installWhen?: string): string | null {
  return installProblem(install, dirPath, root, installWhen)?.why ?? null
}
/** Why HQ refused a recipe's steps, and the lockfile the refused install would write or not follow (Bug 238: the user's words name it). */
export type Refusal = { why: string; lock: string }
/** What the user reads about refused steps: they'd write `lock` into the project, or not follow the one it has. */
export const refusedWords = (lock: string): string => `would write a ${lock} into the project, or not follow the one it has`
/** The first install in `cmd` that the lockfile check refuses, and why. Each is found anywhere in the command and checked in the
 *  folder it runs in: `cd web && npm install` (Bug 191), `cd server && uv sync` (Bug 211). `run`: a `uv run`, not an install. */
function installProblem(cmd: string, dirPath: string, root: string, installWhen?: string): Refusal & { text: string; run: boolean } | null {
  for (const n of npmInstalls(cmd)) {
    const why = npmProblem(n, dirPath, root, installWhen); if (why) return { text: n.text, why, lock: 'package-lock.json', run: false }
  }
  for (const n of lockedInstalls(cmd)) { const why = lockedProblem(n, dirPath, root, installWhen); if (why) return { text: n.text, why, lock: lockName(n, dirPath, root), run: n.run } }
  return null
}
/** The lockfile a refused install follows, by name (a project's older bun.lockb, Bug 358), else the one it would write. */
function lockName(n: LockedInstall, dirPath: string, root: string): string {
  const { at } = placed(n, dirPath, root), lock = at && fs.existsSync(at) ? lockOf(n.tool, at, root).lock : null; return lock ? path.basename(lock) : n.lock
}
/** Where an install runs: its folder, whether that's inside the checkout, and the words that name it when it isn't the part's own. */
function placed(n: { text: string; dir: string | null }, dirPath: string, root: string) {
  const at = n.dir === null ? null : path.resolve(dirPath, n.dir), inRepo = at !== null && !path.relative(path.resolve(root), at).startsWith('..')
  return { at: inRepo ? at : null, where: n.dir && at ? `\`${n.text}\` runs in ${path.relative(root, at) || '.'}: ` : '' }
}
/** ` at uv.lock, which this folder follows` when the lockfile is its workspace root's, not the folder's own (Bugs 156, 240). */
const above = (lock: string, at: string, root: string) => path.dirname(lock) !== at ? ` at ${path.relative(root, lock)}, which this folder follows` : ''
/** A uv, yarn, pnpm or bun install that would rewrite the lockfile it follows (its own, or its workspace root's, Bug 240), or write
 *  one where there is none (Bug 239). A `uv run` too: with no `--locked`/`--frozen` it rewrites an out-of-date uv.lock (Bug 262). */
function lockedProblem(n: LockedInstall, dirPath: string, root: string, installWhen?: string): string | null {
  const { at, where } = placed(n, dirPath, root)
  if (!at) return n.frozen || n.noLock ? null // writes nothing wherever it runs (a plain `uv run` rewrites an out-of-date uv.lock, Bug 262)
    : `HQ can't tell which folder of the repo \`${n.text}\` runs in: use ${n.fix}, or give the part that folder as its dir`
  if (!fs.existsSync(at)) return `${where}that folder doesn't exist`
  const { lock, project } = lockOf(n.tool, at, root)
  if (lock) return n.frozen || n.noLock ? null // Bug 262: a plain `uv run` follows a uv.lock only while it's up to date, and rewrites it after a pyproject.toml change
    : `${where}use ${n.fix} (there is a ${path.basename(lock)}${above(lock, at, root)}${n.run ? `, and \`${n.text}\` rewrites it when it is out of date` : ''})`
  if (n.tool === 'uv' && !project) return null // no pyproject.toml: uv makes no project and no uv.lock (a plain script)
  if (!n.noLock) return `${where}there is no ${n.lock}`
    + `${n.frozen ? ` for \`${n.text}\` to follow` : `, and \`${n.text}\` would write one into the user's project`}: use ${n.bare}`
  return n.run || installWhen === undefined || path.basename(installWhen) === LOCKS[n.tool].manifest ? null
    : `${where}install_when must be a \`${LOCKS[n.tool].manifest}\` with \`${n.text}\` (there is no lockfile to watch)`
}
/** One npm install of a part's command, checked in the folder it runs in (the part's, or where its `cd`/`--prefix` takes it). */
function npmProblem(n: NpmInstall, dirPath: string, root: string, installWhen?: string): string | null {
  const { at, where } = placed(n, dirPath, root) // where: named when it isn't the part's own folder
  if (!at) return `HQ can't tell which folder of the repo \`${n.text}\` runs in: give the part that folder as its dir instead of a \`cd\` or \`--prefix\``
  if (!fs.existsSync(at)) return `${where}that folder doesn't exist`
  const lock = npmLock(at, root)
  if (lock) { // npm ci follows it; --no-package-lock writes nothing (a git-ignored lockfile may be in one checkout only)
    return n.ci || n.noLock ? null : `${where}use \`npm ci\` (there is a ${path.basename(lock)}${above(lock, at, root)})`
  }
  if (!n.noLock) return `${where}use \`${NO_LOCK_INSTALL}\` with install_when \`package.json\` (there is no package-lock.json`
    + `${n.ci ? ' for `npm ci` to follow' : ', and `npm install` would write one into the user\'s project'})`
  return installWhen === undefined || path.basename(installWhen) === 'package.json' ? null // its own or a workspace member's (web/package.json)
    : `${where}install_when must be a \`package.json\` with \`${NO_LOCK_INSTALL}\` (there is no lockfile to watch)`
}
/** The first part of a saved recipe whose install (or run) the lockfile check refuses in this checkout, and why (Bug 156: recipes saved
 *  before the check, or a lockfile added or removed since). Null when every part is fine. */
export function recipeProblem(r: Recipe, root: string): Refusal | null {
  for (const p of r.parts) { const bad = partProblem(p, path.join(root, p.dir), root); if (bad) return { why: `${p.name}: ${bad.why}`, lock: bad.lock } }
  return null
}
/** A part's install, and any install in its run command (it would run on every start, Bugs 191, 211), checked in this checkout.
 *  A `uv run` is checked as itself: it writes a uv.lock where there is none (Bug 239). */
function partProblem(p: RecipePart, dir: string, root: string): Refusal | null {
  const bad = p.install ? installProblem(p.install, dir, root, p.install_when) : null; if (bad) return bad
  if (p.install && /\buv\s+pip\s+install\b/.test(p.install) && p.install_when && path.basename(p.install_when) !== 'pyproject.toml'
    && !lockOf('uv', dir, root).lock) { // Bug 239's no-lockfile uv route: a missing install_when means it never installs again
    return { why: `install_when must be a \`pyproject.toml\` with \`uv pip install\` (there is no uv.lock to watch)`, lock: 'uv.lock' }
  }
  const run = installProblem(p.run, dir, root); if (!run || run.run) return run
  return { why: `run has an install that would run on every start (\`${run.text}\`; put installs in install): ${run.why}`, lock: run.lock }
}

/** What an install leaves in the project besides its lockfile (Bug 263): node_modules, and Yarn 2+'s Plug'n'Play files, install
 *  state and cache (Yarn 4.5.3 writes `.pnp.cjs` and `.yarn/install-state.gz` even with `--immutable`). uv's .venv ignores itself. */
const LEFTOVERS = { npm: ['node_modules/'], pnpm: ['node_modules/'], bun: ['node_modules/'],
  yarn: ['node_modules/', '.pnp.cjs', '.pnp.loader.mjs', '.pnp.data.json', '.yarn/install-state.gz', '.yarn/cache/', '.yarn/unplugged/', '.yarn/__virtual__/'] }
/** Where the installs in a recipe's steps (install and run) leave those files, relative to the checkout `root`: the folder each runs in,
 *  and the project whose lockfile it follows (a Yarn workspace's .pnp.cjs is at its root). A folder HQ can't follow is left out. */
export function installLeftovers(r: Recipe, root: string): string[] {
  const out = new Set<string>()
  const add = (dirs: (string | null)[], names: string[]) => { for (const d of dirs) if (d) for (const f of names) out.add(path.join(path.relative(root, d), f).split(path.sep).join('/')) }
  for (const p of r.parts) for (const cmd of [p.install, p.run]) {
    if (!cmd) continue
    const dirPath = path.join(root, p.dir), lockDir = (lock: string | null) => lock && path.dirname(lock)
    for (const n of npmInstalls(cmd)) { const { at } = placed(n, dirPath, root); if (at) add([at, lockDir(npmLock(at, root))], LEFTOVERS.npm) }
    for (const n of lockedInstalls(cmd)) {
      const { at } = placed(n, dirPath, root); if (at && n.tool !== 'uv') add([at, lockDir(lockOf(n.tool, at, root).lock)], LEFTOVERS[n.tool])
    }
  }
  return [...out]
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
    const bad = partProblem(p, dir, root); if (bad) return { error: `${p.name}: ${bad.why}` }
  }
  return { recipe }
}

/** What the user OKs: the commands and files, not the notes. A saved recipe whose commands are unchanged needs no new OK. */
export function recipeCommands(r: Recipe): string {
  return JSON.stringify({ parts: r.parts.map((p) => [p.name, p.dir, p.install ?? null, p.install_when ?? null, p.run, p.port]), files: r.worktree_files })
}
export const sameCommands = (a: Recipe | null, b: Recipe | null): boolean => !!a && !!b && recipeCommands(a) === recipeCommands(b)

/** The user's own ⚙ command as a one-part recipe (no OK needed: they typed it). Its install is the project's own package manager's (ownInstall). */
export function commandRecipe(command: string, repoPath: string): Recipe {
  const { install, install_when } = ownInstall(repoPath)
  return { parts: [{ name: 'app', dir: '.', run: command, port: 'auto', ...(install ? { install } : {}), ...(install_when ? { install_when } : {}) }],
    show: 'app', worktree_files: [], notes: '' }
}

/** Bug 316: what the user's own ⚙ command would do to the project's lockfile, as a warning, not a refusal (they typed it, and HQ runs it as
 *  written): the same check as Claude's steps (an own `uv run app.py` rewrote an out-of-date uv.lock), in plain words. Null when fine, and for
 *  an install HQ can't place (`cd $X && npm i`): a guess about a folder isn't worth a warning. */
export function commandWarning(command: string, root: string): string | null {
  const bad = installProblem(command, root, root); if (!bad || /^HQ can't tell /.test(bad.why)) return null
  const fix = bad.why.replace(/ with install_when `[^`]*`/g, '') // a recipe's field, not something the user's command has
  // Bug 343: the advice follows the lockfile as it is, so an out-of-date one stops the command (`uv run --locked`: code 2): the user updates it first
  const update = /\(there is a /.test(fix) ? UPDATE_LOCK[bad.lock] : undefined
  return `\`${bad.text}\` ${refusedWords(bad.lock)}: ${fix}.${update ? ` If it then says the ${bad.lock} needs to be updated, run \`${update}\``
    + ` yourself first, where the command runs, and commit the new ${bad.lock}.` : ''}`
}
/** How the user updates each lockfile by hand (Bug 343). */
const UPDATE_LOCK: Record<string, string> = { 'uv.lock': 'uv lock', 'package-lock.json': 'npm install', 'yarn.lock': 'yarn install', 'pnpm-lock.yaml': 'pnpm install',
  'bun.lock': 'bun install', 'bun.lockb': 'bun install' }

/** Ports for every part: fixed ones as written, auto ones from the preview range (the show part keeps `saved` when it's free).
 *  `taken`: fixed ports something else already holds, so HQ won't start an app that would talk to the wrong server. `avoid`: ports
 *  a Launch helper was given for its test runs (Bug 226), taken only when nothing else in the range is free. `given`: ports this HQ handed to another
 *  app that is starting or running (Bug 354: one that hasn't bound its port yet looks free), never taken: a fixed one is in `taken` (Bug 362). */
export async function assignPorts(r: Recipe, saved: number | null, busy: (port: number) => Promise<boolean> = portBusy, avoid: number[] = [],
  given: number[] = []): Promise<{ ports: Record<string, number>; taken: { part: string; port: number }[] } | null> {
  const ports: Record<string, number> = {}, taken: { part: string; port: number }[] = []
  for (const p of r.parts) if (p.port !== 'auto') { ports[p.name] = p.port; if (given.includes(p.port) || await busy(p.port)) taken.push({ part: p.name, port: p.port }) }
  const order = (p: RecipePart) => p.name === r.show ? 0 : 1 // the page the user sees gets the saved port first
  for (const p of [...r.parts].filter((x) => x.port === 'auto').sort((a, b) => order(a) - order(b))) {
    const prefer = p.name === r.show && saved && PREVIEW_PORTS.includes(saved) && !avoid.includes(saved) ? [saved] : []
    const tryIn = [...prefer, ...PREVIEW_PORTS.filter((c) => !avoid.includes(c)), ...PREVIEW_PORTS.filter((c) => avoid.includes(c))]
    let got: number | null = null
    for (const c of tryIn) if (!Object.values(ports).includes(c) && !given.includes(c) && !(await busy(c))) { got = c; break }
    if (got === null) return null
    ports[p.name] = got
  }
  return { ports, taken }
}

/** Bug 226: the Launch helper's test runs use ports HQ gives it, from the preview range, never a port of its own choosing (it once ran an app on
 *  3180, outside its HQ's 4080–4089, where another HQ's app could answer). Up to `n` free ports, from the top of the range (previews take theirs
 *  from the bottom), in order: ones no other helper holds first, then (a busy HQ with many helpers) free ones another helper was given too, since
 *  they are still HQ's own. `given`: ports this HQ gave an app that is starting or running (Bug 363: one that hasn't bound its port yet looks free, and
 *  a test server there would take it from the app or answer in its place), never taken. [] when no port in the range is free. */
export async function testPorts(held: number[], busy: (port: number) => Promise<boolean> = portBusy, n = 3, range: number[] = PREVIEW_PORTS,
  given: number[] = []): Promise<number[]> {
  const got: number[] = [], top = [...range].reverse().filter((x) => !given.includes(x))
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
 *  checkout, that file changed since (marks from the supervisor, keyed by the folder), or what the install made is gone (Bug 303:
 *  node_modules or .pnp.cjs deleted, the lockfile unchanged). Without it (the user's own command, whose install installStep
 *  already chose from npm's own record): every time it's there. */
export function needsInstall(p: RecipePart, dirPath: string, marks: Record<string, string>, root: string = dirPath): boolean {
  if (!p.install) return false
  if (!p.install_when) return true
  const done = marks[dirPath]; if (done === undefined) return true
  const now = installMark(dirPath, p.install_when, root); if (now !== null && now !== done) return true
  return installOutputs(p.install, dirPath, root).some((f) => !fs.existsSync(f))
}
/** Is the Yarn project in `dir` a Yarn 2+ one that installs Plug'n'Play (its default: a .pnp.cjs, no node_modules)? Yarn 2+ has a
 *  .yarnrc.yml or a yarn.lock with `__metadata`; its `nodeLinker: node-modules` (or `pnpm`) makes a node_modules instead. */
function yarnPnp(dir: string): boolean {
  if (!yarnBerry(dir)) return false
  const linker = /^nodeLinker:\s*["']?([\w-]+)/m.exec(readIn(dir, '.yarnrc.yml') ?? '')?.[1]; return !linker || linker === 'pnp'
}
const readIn = (dir: string, f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }
/** A Yarn 2+ project: a .yarnrc.yml, or a yarn.lock with `__metadata` (Yarn 1's has none). */
const yarnBerry = (dir: string): boolean => readIn(dir, '.yarnrc.yml') !== null || /^__metadata:/m.test(readIn(dir, 'yarn.lock') ?? '')
/** What the installs in a part's `install` make that its app needs (Bug 303), as absolute paths: npm's, pnpm's and Bun's node_modules, Yarn's
 *  .pnp.cjs or node_modules, uv's .venv, each where the tool puts it (the project whose lockfile it follows). None for a package.json
 *  that lists no packages (npm makes no node_modules then), nor for installs HQ can't read (go build, pip) or follow (`cd $X`). */
export function installOutputs(install: string, dirPath: string, root: string = dirPath): string[] {
  const out: string[] = []
  const node = (lock: string | null, at: string, made: (d: string) => string) => {
    const d = lock ? path.dirname(lock) : at; if (listsPackages(path.join(d, 'package.json'))) out.push(path.join(d, made(d)))
  }
  for (const n of npmInstalls(install)) { const { at } = placed(n, dirPath, root); if (at) node(npmLock(at, root), at, () => 'node_modules') }
  for (const n of lockedInstalls(install)) {
    const { at } = placed(n, dirPath, root); if (!at || n.run) continue
    const { lock, project } = lockOf(n.tool, at, root)
    if (n.tool === 'uv') out.push(path.join(lock ? path.dirname(lock) : project ?? at, '.venv'))
    else node(lock, at, (d) => n.tool === 'yarn' && yarnPnp(d) ? '.pnp.cjs' : 'node_modules')
  }
  for (const v of uvVenvs(install)) { const at = v === null ? null : path.resolve(dirPath, v); if (at && !path.relative(path.resolve(root), at).startsWith('..')) out.push(at) }
  return out
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

/** Where portBusy tries to listen (Bug 322). Linux refuses a listener on a port another socket is bound to: the local end of an outgoing connection, or one
 *  closed under a minute ago, though nothing answers there. Its own end may be any address of the machine (an agent's connection to its API) and apps often
 *  listen on all of them, so Linux tries those (`::` covers IPv4 too, unless the machine says otherwise). macOS lets a listener on all addresses through
 *  whatever holds one, and HQ's own previews are reached on loopback, so it tries those two (and never shows the firewall's "accept connections?"). */
const LISTEN_HOSTS = process.platform === 'linux' ? ['0.0.0.0', '::'] : ['127.0.0.1', '::1']
/** Codes that mean a program couldn't listen there either. Any other (EADDRNOTAVAIL: no IPv6 on this machine, say) tells nothing about the port. */
const REFUSED = new Set(['EADDRINUSE', 'EACCES'])
/** Bug 340: on macOS a connect to a port a socket is bound to but not listening on gets no answer at all (Linux refuses it at once), so it waited its
 *  whole 500 ms, once per port tried. A connect with no answer after this long (counted from when it went out; loopback answers in a few ms) asks
 *  then whether a program could listen on that same address: if not, the port is busy, as the listens below would say. If it could, the connect waits
 *  on as before. Not before: a listen next to a program listening on all addresses would take the connections meant for it. Null: Linux, as before. */
const QUIET_MS: number | null = process.platform === 'darwin' ? 50 : null
/** Something accepts connections on this port (IPv4 or IPv6 loopback), or nothing does but a program couldn't listen there (Bug 322: the app would end with
 *  EADDRINUSE, and Launch would pick the same port again). The listens come after the connects (a connect would reach HQ's own listener) and one at a time,
 *  each closed before the next and before this answers: nothing of HQ's still holds the port when the app starts. */
export const portBusy = (port: number): Promise<boolean> => portBusyWith(port, LISTEN_HOSTS) // one argument: callers pass it to map()
/** portBusy, trying to listen on `listenOn` (a test's choice); `quietMs`, when a connect with no answer yet tries a listen on its own address. */
export async function portBusyWith(port: number, listenOn: readonly string[], quietMs = QUIET_MS): Promise<boolean> {
  const one = (host: string) => new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port }); let quiet: NodeJS.Timeout | undefined, over = false
    const done = (busy: boolean) => { over = true; clearTimeout(quiet); s.destroy(); resolve(busy) }
    s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(500, () => done(false))
    if (quietMs !== null) { // after Node's own next tick, which sends the connect
      process.nextTick(() => {
        quiet = setTimeout(() => setImmediate(() => { // an answer that came while HQ's loop was held up is read first
          if (!over) void cantListen(port, host).then((code) => { if (REFUSED.has(code ?? '')) done(true) })
        }), quietMs)
      })
    }
  })
  if ((await Promise.all([one('127.0.0.1'), one('::1')])).some(Boolean)) return true
  for (const host of listenOn) if (REFUSED.has((await cantListen(port, host)) ?? '')) return true
  return false
}
