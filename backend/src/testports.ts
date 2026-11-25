// Bug 374: a project that hard-wires a port (a Vite proxy that sends /api to 127.0.0.1:8000, say) couldn't be opened by HQ's own tests while anything held
// that port, and nearly always something did: HQ's preview of the same app. HQ's look and its UI tester run the app in a throwaway checkout, so on a Mac HQ
// now runs that copy on another port. It gives the part a free one, rewrites the old one where the copy's files write it as an address on this machine
// (localhost:8000, 127.0.0.1:8000) and in the start commands, and its sandbox refuses the copy the old port altogether (testrun.ts sandboxProfile): a place
// HQ missed fails there, and never reaches the preview's server and the user's own data. The project's folder, its code and the preview are never touched.
// HQ only moves a port when it can tell where it is written. Any other mention of the number that could be the port (`port: 8000`, `":8000"`, a line
// about a host, a URL or a proxy) is one HQ can't change safely, and then nothing is moved: the look is skipped, saying who holds the port and what to do.
// One mention is known not to be read at all: a fallback for the PORT variable (`process.env.PORT || 8000`, `PORT=8000` in a .env). HQ gives every part its
// port in PORT, so the copy never takes the number from there. And when a moved copy doesn't start (its server took its port from somewhere HQ didn't see,
// a tool's own default say), the step says so, with the same advice (smokerules.ts movedNoStart). Bug 382: two such places HQ sees before it starts anything,
// and then it doesn't move: a script's short flag (`next dev -p 3001`), and a start command that runs a tool that picks its own port and never reads PORT
// (Vite, uvicorn, Django's runserver) without naming one.
// Linux needs none of this: bubblewrap gives each run a network of its own, where the port is free.
// Spikes on macOS, 2026-11-23: a later `(deny network-outbound (remote ip "localhost:N"))` wins over the profile's `localhost:*`, for 127.0.0.1, localhost
// and ::1 (node: EPERM), every other localhost port still answering; `(deny network-bind (local ip "*:N"))` refuses a listen on any address. macOS's log
// says nothing of either refusal, so HQ can't hear a place it missed: hence the strict rule above.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { PATHS } from './config.ts'
import { q } from './db.ts'
import { emit } from './events.ts'
import { portBusy, type Recipe } from './apprun.ts'
import { portHolders, whose } from './procs.ts'
import { repos } from './records.ts'
import type { MovedPort } from './smokerules.ts'

/** What HQ needs of a look's plan (smoke.ts LookPlan): the start steps, the user's checkout, and the ports already moved. */
type Plan = { recipe: Recipe; repoPath: string; moved?: MovedPort[] }

// --- The rules: where a port is written, and what HQ may change -----------------------------------------------------------------------------------------
const HOST = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])`
/** The port written as an address on this machine: the one way of writing it HQ changes in a file. */
const addressOf = (port: number): RegExp => new RegExp(`(${HOST}:)${port}(?![\\w]|\\.\\d)`, 'g')
/** The number by itself: not inside a longer number or a word (18000, 8000ms, 1.8000). */
const tokenOf = (port: number): RegExp => new RegExp(`(?<![\\w.])${port}(?![\\w]|\\.\\d)`, 'g')
/** A line that is about where something listens or is reached: the number on it could be the port. Wide on purpose (a wrong yes only means HQ doesn't
 *  move), but a word counts at its start or as a camelCase part only: `export const MAX = 8000` has no "port" in it, nor "during" a "uri". */
const WORDS = ['port', 'host', 'url', 'uri', 'proxy', 'origin', 'listen', 'server', 'backend', 'upstream', 'api', 'endpoint', 'target', 'addr', 'socket', 'bind']
const ADDRESSY = /localhost|127\.0\.0\.1|0\.0\.0\.0|::1|https?:|wss?:/i
const ABOUT = [new RegExp(`(?<![a-z])(?:${WORDS.join('|')})`, 'i'), new RegExp(`[a-z](?:${WORDS.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('|')})`), ADDRESSY]
const portish = (line: string): boolean => ABOUT.some((re) => re.test(line))
/** Bug 382: the number right after a short flag (`next dev -p 3001`, `serve -l 3001`) or Django's `runserver 8000`: the port, written as a plain number on a
 *  line with no word about ports. HQ rewrites the number only in the start command itself, so in a script that command runs it stops the move. */
const FLAGGED = /(?:(?:^|[\s"'`(])-[pl]|\brunserver)(?:\s+|\s*=\s*)$/
/** The number as a fallback for the variable PORT, which a run of HQ's never uses: HQ gives every part its port in PORT (appstart.mjs), as its preview does.
 *  So `process.env.PORT || 8000` is no place the copy reads its port from, and doesn't stop a move. Only the variable named exactly PORT (not API_PORT), and
 *  only these ways of writing it: JavaScript, Python, Ruby, a shell's `${PORT:-8000}`. */
const Q = '[\'"`]?'
const fallbackOf = (port: number): RegExp => new RegExp([
  String.raw`(?:process\.env|Bun\.env)(?:\.PORT|\[['"]PORT['"]\])(?:\s*,\s*10)?\s*\)?\s*(?:\|\||\?\?)\s*${Q}${port}${Q}(?![\w]|\.\d)`,
  String.raw`Deno\.env\.get\(\s*['"]PORT['"]\s*\)\s*\)?\s*(?:\|\||\?\?)\s*${Q}${port}${Q}(?![\w]|\.\d)`,
  String.raw`(?:environ\.get|getenv|ENV\.fetch)\(\s*['"]PORT['"]\s*,\s*${Q}${port}${Q}\s*\)`,
  String.raw`(?:environ\.get|getenv)\(\s*['"]PORT['"]\s*\)\s*\)?\s*or\s+${Q}${port}${Q}(?![\w]|\.\d)`,
  String.raw`ENV\[['"]PORT['"]\]\s*\|\|\s*${Q}${port}${Q}(?![\w]|\.\d)`,
  String.raw`ENV\.fetch\(\s*['"]PORT['"]\s*\)\s*\{\s*${Q}${port}${Q}\s*\}`,
  String.raw`\$\{PORT:?-${port}\}`,
].join('|'), 'g')
/** A settings file of the .env kind (.env, .env.local, .env.example, example.env; not env.ts): what it sets is a default, which the run's own environment
 *  wins over in nearly every loader (dotenv, python-dotenv, node --env-file, Next, Rails, Laravel). So its `PORT=8000` line is a fallback too. */
export const dotenv = (file: string): boolean => /^\.env|\.env$|^env\.(example|sample|template|dist)$/i.test(path.basename(file))
const dotenvPort = (port: number): RegExp => new RegExp(`^\\s*(?:export\\s+)?PORT\\s*=\\s*['"]?${port}['"]?\\s*(?:#.*)?$`)

/** A file's mentions of `port`: how many are addresses (HQ rewrites those), and the lines, from 1, with another mention that could be the port (HQ can't
 *  tell `port: 8000` or `":8000"` from the port it is moving, so one of these stops the move). A plain number (`MAX_CHARS = 8000`) is neither, nor is a
 *  fallback for PORT, unless its line builds an address with it (a caller's, which may run where PORT isn't set: in the browser). `file`: its name, for the
 *  .env kind. */
export function mentions(text: string, port: number, file = ''): { addresses: number; unsure: number[] } {
  const unsure: number[] = []; let addresses = 0; const env = dotenv(file)
  text.split('\n').forEach((line, i) => {
    if (!line.includes(String(port))) return
    if (env && dotenvPort(port).test(line)) return
    const moved = line.replace(addressOf(port), () => { addresses++; return ' ' }), rest = ADDRESSY.test(moved) ? moved : moved.replace(fallbackOf(port), ' ')
    for (const m of rest.matchAll(tokenOf(port))) {
      if (portish(line) || rest[m.index - 1] === ':' || FLAGGED.test(rest.slice(0, m.index))) { unsure.push(i + 1); break }
    }
  })
  return { addresses, unsure }
}
/** `text` with the port's addresses on this machine moved to `to`. */
export const moveAddresses = (text: string, from: number, to: number): string => text.replace(addressOf(from), (_all, host: string) => `${host}${to}`)
/** A start command with each moved port's number replaced (`--port 8000`, `localhost:8000`). */
export const moveLine = (line: string, moved: { from: number; to: number }[]): string => moved.reduce((s, m) => s.replace(tokenOf(m.from), String(m.to)), line)

const DOCS = /\.(md|mdx|mdc|markdown|txt|rst|adoc)$/i
const LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum',
  'Gemfile.lock', 'composer.lock'])
/** Docker and CI files: nothing in HQ's sandbox runs them (it has no Docker), so what they say about a port is not this run's. */
const NOT_RUN = new RegExp(String.raw`(^|/)(Dockerfile[^/]*|[^/]*\.dockerfile|(docker-)?compose[^/]*\.ya?ml|Jenkinsfile[^/]*`
  + String.raw`|\.(gitlab-ci|travis|drone|appveyor)\.ya?ml|(appveyor|azure-pipelines|bitbucket-pipelines)\.ya?ml)$|(^|/)\.(github|circleci|buildkite)/`, 'i')
/** Does HQ read this file for the port? Not what only people read (docs), lockfiles, nor what this run never runs. */
export const scanned = (file: string): boolean => !DOCS.test(file) && !LOCKS.has(path.basename(file)) && !NOT_RUN.test(file)

/** HQ's words for why it didn't move a port: the first place that names it another way, and how many more. */
export function unsureWords(port: number, at: { file: string; line: number }[]): string {
  const first = at[0]!, more = at.length - 1
  return `${first.file}${first.line ? ` line ${first.line}` : ''}${more ? ` and ${more} more place${more === 1 ? '' : 's'}` : ''} ${more ? 'name' : 'names'} ${port} `
    + 'in a way HQ can\'t safely change'
}

/** Bug 382: tools that pick a port of their own and never read PORT, so a copy started without naming its port asks for the old one whatever HQ gives it.
 *  Each checked in its own source (2026-11-24): Vite 8 (5173), uvicorn 0.54 (8000; it reads UVICORN_PORT), Django 6's runserver (8000), Flask 3's
 *  `flask run` (5000; FLASK_RUN_PORT), python's http.server (8000). Not here because they do read PORT: Next, fastapi-cli 0.0.34 (`fastapi dev`), gunicorn.
 *  A tool missing from this list is moved as before, and a copy that then doesn't start says so (smokerules.ts movedNoStart). */
export const OWN_PORT: readonly (readonly [string, RegExp])[] = [['vite', /(?<![\w@-])vite(?![\w.-])(?!\s+build\b)/], ['uvicorn', /\buvicorn(?![\w.-])/],
  ['runserver', /\brunserver\b/], ['flask run', /\bflask\b[^&|;]*\srun\b/], ['http.server', /\bhttp\.server\b/]]
/** The scripts a start command runs through its package manager (`npm run dev`, `npm start`, `yarn dev`, `pnpm dev`, `bun run dev`), and theirs in turn. */
export function scriptsOf(run: string, scripts: Record<string, unknown>, seen = new Set<string>()): string[] {
  const out: string[] = []
  for (const m of run.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g)) {
    const name = m[1]!, body = scripts[name]; if (typeof body !== 'string' || seen.has(name)) continue
    seen.add(name); out.push(body, ...scriptsOf(body, scripts, seen))
  }
  return out
}
const NAMES_PORT = /\$\{?PORT\b|%PORT%|\benv\b[^\n]{0,15}\bPORT\b/
/** Code that reads the variable PORT (`process.env.PORT`, `os.environ["PORT"]`, `getenv("PORT")`, `ENV["PORT"]`, `$PORT`): a tool's config may pass it on. */
const READS_PORT = /(?:\benv(?:iron)?\b|getenv|\bENV\b)[^\n]{0,15}\bPORT\b|\$\{?PORT\b/
/** Bug 382: the tool a part's start command runs that would take its own port in HQ's copy (OWN_PORT), when neither the command nor a script it runs names the
 *  port or PORT: then HQ has no way to tell the copy another port, and moving it would only start an app that can't start. Null when HQ can tell it. */
export function ownPort(run: string, port: number, scripts: Record<string, unknown>): string | null {
  if (tokenOf(port).test(run) || NAMES_PORT.test(run)) return null // moveLine gives it the new number, or HQ's PORT reaches it
  const called = scriptsOf(run, scripts); if (called.some((s) => NAMES_PORT.test(s))) return null
  return OWN_PORT.find(([, re]) => [run, ...called].some((c) => re.test(c)))?.[0] ?? null
}

// --- The copy's files -----------------------------------------------------------------------------------------------------------------------------------
const MAX_FILE = 2 * 1024 * 1024
/** Folders of copied data HQ doesn't read through: installed packages and the like. */
const HEAVY = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'target', 'vendor', '.git', '.claude'])
/** The tracked files of the checkout that mention the number at all (git grep: text files only, whole words). */
const tracked = (wt: string, port: number): Promise<string[] | { error: string }> => new Promise((resolve) => {
  execFile('git', ['-C', wt, 'grep', '-I', '-l', '-z', '-w', '-F', '-e', String(port), '--', '.'], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
    if (!err) return resolve(String(out).split('\0').filter(Boolean))
    if ((err as { code?: unknown }).code === 1) return resolve([]) // no file mentions it
    resolve({ error: String(err.message).split('\n').find((l) => l.startsWith('fatal:'))?.slice(7).trim() || 'git grep failed' })
  })
})
/** The copied files (the user's own settings and data, which git doesn't track): each one, and those directly inside a copied folder. */
function copiedFiles(wt: string, copied: string[]): string[] {
  const out: string[] = []
  for (const name of copied) {
    const at = path.join(wt, name); let st: fs.Stats; try { st = fs.lstatSync(at) } catch { continue }
    if (st.isFile()) out.push(name)
    else if (st.isDirectory() && !HEAVY.has(path.basename(name))) {
      for (const f of fs.readdirSync(at).slice(0, 200)) { try { if (fs.lstatSync(path.join(at, f)).isFile()) out.push(path.join(name, f)) } catch { /* gone */ } }
    }
  }
  return out
}
type Found = { files: string[]; unsure: { file: string; line: number }[] }
/** Where the checkout writes `port`: the files with an address to rewrite, and every place that names it another way. Only real files inside the checkout
 *  are read (a link could lead out of it), and nothing of a file's text is kept: a copied .env holds the user's keys. */
async function find(wt: string, port: number, copied: string[]): Promise<Found | { error: string }> {
  const t = await tracked(wt, port); if ('error' in t) return t
  const found: Found = { files: [], unsure: [] }
  for (const f of [...new Set([...t, ...copiedFiles(wt, copied)])].filter(scanned)) {
    const at = path.resolve(wt, f); if (!at.startsWith(wt + path.sep)) continue
    let st: fs.Stats; try { st = fs.lstatSync(at) } catch { continue }
    if (!st.isFile()) continue
    if (st.size > MAX_FILE) { if (t.includes(f)) found.unsure.push({ file: f, line: 0 }); continue } // too big to read through: HQ can't say it's fine
    const text = fs.readFileSync(at, 'utf8'); if (text.includes('\0')) continue // a database, an image
    const m = mentions(text, port, f)
    if (m.addresses) found.files.push(f)
    found.unsure.push(...m.unsure.map((line) => ({ file: f, line })))
  }
  return found
}

/** The part's package.json scripts in the checkout ({} without one). */
function scriptsIn(dir: string): Record<string, unknown> {
  try { const s = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: unknown }).scripts; return s && typeof s === 'object' ? s as Record<string, unknown> : {} }
  catch { return {} }
}
/** Does code in the part's folder read the variable PORT (a Vite config's `port: Number(process.env.PORT)`)? Then the tool may get HQ's port after all.
 *  The files HQ reads for the port only (scanned): a Dockerfile's `ENV PORT` is no run of HQ's. */
const readsPort = (wt: string, dir: string): Promise<boolean> => new Promise((resolve) => {
  execFile('git', ['-C', wt, 'grep', '-I', '--null', '-w', '-F', '-e', 'PORT', '--', dir], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
    if (err) return resolve(false) // no match (1), or no checkout: nothing found that reads it
    resolve(String(out).split('\n').some((l) => { const [file = '', text = ''] = l.split('\0'); return scanned(file) && READS_PORT.test(text) }))
  })
})
/** Bug 382: why HQ can't tell a copy of `part` another port (its start command runs a tool that picks its own), or null. */
async function deaf(wt: string, part: { run: string; dir: string }, port: number): Promise<string | null> {
  const tool = ownPort(part.run, port, scriptsIn(path.join(wt, part.dir))); if (!tool) return null
  if (await readsPort(wt, part.dir)) return null
  return `its start command runs ${tool}, which uses its own port unless the command names one`
}

// --- Who has the port -----------------------------------------------------------------------------------------------------------------------------------
/** Every port of a preview this HQ runs: the page's, from its row, and each part's, from its run's spec.json (preview.ts writes both). */
function previewPorts(p: { id: string; port: number | null }): number[] {
  try {
    const spec = JSON.parse(fs.readFileSync(path.join(PATHS.home, 'previews', p.id, 'spec.json'), 'utf8')) as { parts: { env: Record<string, string> }[] }
    return [...(p.port ? [p.port] : []), ...spec.parts.map((x) => Number(x.env.PORT)).filter((n) => Number.isInteger(n) && n > 0)]
  } catch { return p.port ? [p.port] : [] }
}
/** The preview of this HQ's that was given `port`: one starting or running, whether or not its app listens there yet. A preview HQ restarts after a merge
 *  (preview.ts restartAfterMerge) reads "running" the whole time, and one starting may still be installing. */
const previewWith = (port: number) => q<{ id: string; port: number | null }>("SELECT id, port FROM previews WHERE status IN ('starting', 'running')")
  .find((p) => previewPorts(p).includes(port))
/** Bug 381: is `port` taken, for HQ's test copy of an app? When something listens there, and when one of this HQ's previews was given it: the preview's app
 *  may not listen yet (it is restarting after a merge, or still installing), and a copy that took the port then would leave the preview's start refused
 *  ("Can't start …: port N is being used by …hq-test-…") or its part unable to listen. So the copy moves off it, as it does when the preview listens. */
export const portTaken = async (port: number): Promise<boolean> => !!previewWith(port) || await portBusy(port)
export type Holding = { who: string; fix: string }
/** Who has `port`, in words for the user, and what they can do about it: this HQ's own preview (of this project or another), else whatever lsof names. */
export async function heldBy(port: number, repoId: string | null): Promise<Holding> {
  const all = repos()
  const mine = previewWith(port)
  if (mine) {
    const name = all.find((r) => r.id === mine.id)?.name ?? 'another project'
    return { who: `HQ's preview of ${name}`, fix: mine.id === repoId ? 'Stop the app in the preview, then test again' : `Stop ${name}'s app, then test again` }
  }
  const h = (await portHolders(port))[0]; if (!h) return { who: 'another program', fix: 'Stop it, then test again' }
  const w = whose(h.cwd, all, repoId ?? '')
  return { who: w.kind === 'hq' ? `${w.name} (${h.cmd}, pid ${h.pid})` : `${h.cmd} in ${w.name} (pid ${h.pid})`, fix: 'Stop it, then test again' }
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
})

/** The start steps as they run in the throwaway checkout `wt`. A port the project hard-wires that something holds (portTaken) is moved in that checkout, when HQ can
 *  tell where it is written: `plan` comes back with the part on a free port, its start commands saying so, and `moved`; the checkout's files have the new
 *  address. `skip`: it is held and HQ can't move it, in words for the user. `copied`: the user's own files HQ copied in (smoke.ts prepareApp), read too.
 *  Nothing is changed before every held port is known to be movable. `o`: a test's own answers. */
export async function placePorts<P extends Plan>(wt: string, plan: P, copied: string[] = [], o: { platform?: string; busy?: (port: number) => Promise<boolean>
  who?: (port: number) => Promise<Holding> } = {}): Promise<{ plan: P } | { skip: string }> {
  if ((o.platform ?? process.platform) !== 'darwin') return { plan } // a network of its own there: the port is free inside it
  const busy = o.busy ?? portTaken, held: { part: string; port: number; run: string; dir: string }[] = []
  for (const p of plan.recipe.parts) if (p.port !== 'auto' && await busy(p.port)) held.push({ part: p.name, port: p.port, run: p.run, dir: p.dir })
  if (!held.length) return { plan }
  const repo = repos().find((r) => r.path === plan.repoPath), root = fs.realpathSync(wt)
  const todo: { part: string; from: number; who: string; fix: string; files: string[] }[] = []
  for (const h of held) {
    const by = await (o.who ?? ((port) => heldBy(port, repo?.id ?? null)))(h.port), found = await find(root, h.port, copied)
    const cant = 'error' in found ? `it couldn't search the code (${found.error})` : found.unsure.length ? unsureWords(h.port, found.unsure) : await deaf(root, h, h.port)
    if (cant) return { skip: `port ${h.port}, which its ${h.part} part always uses, is in use by ${by.who}. HQ couldn't run its own copy on another port: ${cant}. ${by.fix}` }
    todo.push({ part: h.part, from: h.port, who: by.who, fix: by.fix, files: (found as Found).files })
  }
  const moved: MovedPort[] = [], taken = new Set<number>()
  for (const m of todo) {
    let to = await freePort(); for (let i = 0; taken.has(to) && i < 20; i++) to = await freePort()
    taken.add(to)
    for (const f of m.files) { const at = path.join(root, f); fs.writeFileSync(at, moveAddresses(fs.readFileSync(at, 'utf8'), m.from, to)) }
    moved.push({ part: m.part, from: m.from, to, by: m.who, fix: m.fix })
    emit({ agentId: null, source: 'system', kind: 'testrun.port_moved', payload: { repo: repo?.name ?? null, part: m.part, from: m.from, to, by: m.who, files: m.files } })
  }
  const port = (name: string, was: number | 'auto') => moved.find((m) => m.part === name)?.to ?? was
  const recipe: Recipe = { ...plan.recipe, parts: plan.recipe.parts.map((p) => ({ ...p, run: moveLine(p.run, moved), port: port(p.name, p.port) })) }
  return { plan: { ...plan, recipe, moved: [...(plan.moved ?? []), ...moved] } }
}
/** The ports HQ's sandbox refuses a run of this plan (testrun.ts): the ones its app was moved off, where somebody else's server answers. */
export const blocked = (plan: { moved?: MovedPort[] }): number[] => (plan.moved ?? []).map((m) => m.from)
