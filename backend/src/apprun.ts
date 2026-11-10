// How HQ runs a repo's app for the live preview: the launch recipe (which parts, folders, installs, commands, ports), whether a
// part needs installing, which ports, where it answers and whether it may be shown inside HQ. Fixed rules, no agent turns. No
// DB access here. The recipe itself is worked out once by the Launch helper (launchhelper.ts) or is the user's own ⚙ command.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { shq } from './util.ts'

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

/** Install first when npm's own record of what's installed (node_modules/.package-lock.json) is missing or older than the
 *  lockfile, e.g. after a merge changed dependencies. Without a lockfile: only when nothing is installed yet. */
export function installStep(repoPath: string): 'npm ci' | 'npm install' | null {
  const at = (f: string) => { try { return fs.statSync(path.join(repoPath, f)).mtimeMs } catch { return null } }
  if (at('package.json') === null) return null
  const lock = at('package-lock.json'), record = at('node_modules/.package-lock.json')
  if (lock === null) return at('node_modules') === null ? 'npm install' : null
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

/** An install that would rewrite the lockfile instead of following it, which would leave changes behind in a worktree (Try
 *  it) and drift from what the repo pins. Null when fine. */
export function lockfileProblem(install: string, dirPath: string): string | null {
  const has = (f: string) => fs.existsSync(path.join(dirPath, f))
  const cmd = install.trim()
  if (/^npm (install|i)\b/.test(cmd) && has('package-lock.json')) return 'use `npm ci` (there is a package-lock.json)'
  if (/^uv sync\b/.test(cmd) && has('uv.lock') && !/--(locked|frozen)\b/.test(cmd)) return 'use `uv sync --locked` (there is a uv.lock)'
  if (/^yarn( install)?\s*$/.test(cmd) && has('yarn.lock')) return 'use `yarn install --frozen-lockfile` (or --immutable) (there is a yarn.lock)'
  if (/^pnpm (install|i)\b/.test(cmd) && has('pnpm-lock.yaml') && !/--frozen-lockfile\b/.test(cmd)) return 'use `pnpm install --frozen-lockfile` (there is a pnpm-lock.yaml)'
  return null
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
    const bad = p.install ? lockfileProblem(p.install, dir) : null; if (bad) return { error: `${p.name}: ${bad}` }
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
 *  `taken`: fixed ports something else already holds, so HQ won't start an app that would talk to the wrong server. */
export async function assignPorts(r: Recipe, saved: number | null, busy: (port: number) => Promise<boolean> = portBusy):
  Promise<{ ports: Record<string, number>; taken: { part: string; port: number }[] } | null> {
  const ports: Record<string, number> = {}, taken: { part: string; port: number }[] = []
  for (const p of r.parts) if (p.port !== 'auto') { ports[p.name] = p.port; if (await busy(p.port)) taken.push({ part: p.name, port: p.port }) }
  const order = (p: RecipePart) => p.name === r.show ? 0 : 1 // the page the user sees gets the saved port first
  for (const p of [...r.parts].filter((x) => x.port === 'auto').sort((a, b) => order(a) - order(b))) {
    const prefer = p.name === r.show && saved && PREVIEW_PORTS.includes(saved) ? [saved] : []
    let got: number | null = null
    for (const c of [...prefer, ...PREVIEW_PORTS]) if (!Object.values(ports).includes(c) && !(await busy(c))) { got = c; break }
    if (got === null) return null
    ports[p.name] = got
  }
  return { ports, taken }
}

/** Fingerprint of a part's `install_when` file (null when it has none or the file is missing). */
export function installMark(dirPath: string, file: string | undefined): string | null {
  if (!file) return null
  try { return createHash('sha256').update(fs.readFileSync(path.join(dirPath, file))).digest('hex').slice(0, 16) } catch { return null }
}
/** Should this part install before it runs? With install_when (the helper's recipes): when it never installed in this
 *  checkout, or that file changed since (marks from the supervisor, keyed by the folder). Without it (the user's own command,
 *  whose install installStep already chose from npm's own record): every time it's there. */
export function needsInstall(p: RecipePart, dirPath: string, marks: Record<string, string>): boolean {
  if (!p.install) return false
  if (!p.install_when) return true
  const done = marks[dirPath]; if (done === undefined) return true
  const now = installMark(dirPath, p.install_when); return now !== null && now !== done
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
      const cwd = path.join(o.root, p.dir), install = needsInstall(p, cwd, o.marks) ? p.install! : null
      return { name: p.name, cwd, install, mark: install ? installMark(cwd, p.install_when) ?? 'installed' : null, run: p.run, env: { ...shared, PORT: String(o.ports[p.name]), BROWSER: 'none' } }
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
