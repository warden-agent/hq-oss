// Other programs on this machine: which one holds a port, and stopping what still runs inside a folder. Uses lsof and ps.
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { sleep } from './util.ts'

const out = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? '')))) // lsof exits 1 when nothing matches

/** lsof's program name for people: on Linux it gives node's thread name. */
const program = (c: string): string => c.replace(/-MainThread$/, '')
/** The program listening on this TCP port, e.g. "python3.1 (pid 55557)", or null. */
export async function portHolder(port: number): Promise<string | null> {
  const lines = (await out('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])).split('\n')
  const pid = lines.find((l) => l.startsWith('p'))?.slice(1), cmd = lines.find((l) => l.startsWith('c'))?.slice(1)
  return pid ? `${cmd ? program(cmd) : 'a program'} (pid ${pid})` : null
}

/** A process listening on a port: its id, process group, program name and working folder (null when lsof can't see it). */
export type Holder = { pid: number; pgid: number | null; cmd: string; cwd: string | null }
/** Every process listening on this TCP port (a `--reload` server has two: the watcher and its worker). */
export async function portHolders(port: number): Promise<Holder[]> {
  const found: { pid: number; cmd: string }[] = []
  for (const l of (await out('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])).split('\n')) {
    if (l.startsWith('p')) found.push({ pid: Number(l.slice(1)), cmd: 'a program' })
    else if (l.startsWith('c') && found.length) found.at(-1)!.cmd = program(l.slice(1))
  }
  const ps = [...new Map(found.filter((x) => x.pid > 0).map((x) => [x.pid, x])).values()]; if (!ps.length) return []
  const cwds = new Map<number, string>(); let pid = 0
  for (const l of (await out('lsof', ['-a', '-p', ps.map((x) => x.pid).join(','), '-d', 'cwd', '-Fpn'])).split('\n')) {
    if (l.startsWith('p')) pid = Number(l.slice(1)); else if (l.startsWith('n') && pid) cwds.set(pid, l.slice(1))
  }
  return Promise.all(ps.map(async (x) => ({ ...x, pgid: await pgidOf(x.pid), cwd: cwds.get(x.pid) ?? null })))
}

/** Bug 44: may the preview show what answers on its port? `group` is the preview's process group (its supervisor's). `show`:
 *  this app listens there and nothing else does, or lsof sees nobody. `clash`: another program listens on the same port too (one
 *  on 127.0.0.1 and one on all addresses can share it, and localhost may reach either), so the page could be the wrong app.
 *  `wait`: only something else is there so far, and this app may still be starting; after `patience` ms that is shown anyway
 *  (a port Docker forwards is never in the preview's group). */
export function whoAnswers(holders: Holder[], group: number | null, waited: number, patience = 15_000): { kind: 'show' } | { kind: 'wait' } | { kind: 'clash'; others: Holder[] } {
  const mine = holders.filter((h) => group !== null && h.pgid === group), others = holders.filter((h) => !mine.includes(h))
  if (!others.length) return { kind: 'show' }
  if (mine.length) return { kind: 'clash', others }
  return waited < patience ? { kind: 'wait' } : { kind: 'show' }
}

/** Whose a port holder is, from its working folder (Bug 42). `hq`: a Launch helper's leftover in this repo's launch-*
 *  worktree, which HQ may stop on one click; `project`: anything else in this repo's folder (the user's own dev server, say);
 *  `repo`: another repo HQ knows; `other`: anywhere else. `name` is what the user reads. */
export type Whose = { kind: 'hq' | 'project' | 'repo' | 'other'; name: string }
export function whose(cwd: string | null, repos: { id: string; name: string; path: string }[], repoId: string, home = os.homedir()): Whose {
  const inside = (dir: string) => !!cwd && (cwd === dir || cwd.startsWith(dir + path.sep))
  const r = repos.filter((x) => inside(x.path)).sort((a, b) => b.path.length - a.path.length)[0]
  if (!r) return { kind: 'other', name: !cwd ? 'an unknown folder' : inside(home) ? `~${cwd.slice(home.length)}` : cwd }
  if (r.id !== repoId) return { kind: 'repo', name: r.name }
  const rel = path.relative(r.path, cwd!)
  if (/^\.claude\/worktrees\/launch-[^/]+(\/|$)/.test(rel)) return { kind: 'hq', name: `an old Launch helper run of ${r.name}` }
  return { kind: 'project', name: rel ? `${r.name}/${rel}` : r.name }
}

/** Each process's working folder from lsof's `-d cwd -Fpn` listing. A folder since removed still names its old path (Linux adds
 *  " (deleted)", which is dropped). */
export function cwdsOf(listing: string): Map<number, string> {
  const cwds = new Map<number, string>(); let pid = 0
  for (const l of listing.split('\n')) {
    if (l.startsWith('p')) pid = Number(l.slice(1))
    else if (l.startsWith('n') && pid) cwds.set(pid, l.slice(1).replace(/ \(deleted\)$/, ''))
  }
  return cwds
}
/** Process ids whose working folder is `dir` or inside it, from lsof's `-d cwd -Fpn` listing. */
export function pidsUnder(listing: string, dir: string): number[] {
  return [...cwdsOf(listing)].filter(([, cwd]) => cwd === dir || cwd.startsWith(dir + path.sep)).map(([pid]) => pid)
}
/** The processes still in process group `pgid` (pgrep -g leaves some out, so this reads ps). */
export const groupPids = async (pgid: number): Promise<number[]> =>
  (await out('ps', ['-axo', 'pid=,pgid='])).split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([p, g]) => p && g === pgid).map(([p]) => p!)
/** The process group of `pid`, or null when it's gone. */
export const pgidOf = async (pid: number): Promise<number | null> => { const g = Number((await out('ps', ['-o', 'pgid=', '-p', String(pid)])).trim()); return g > 0 ? g : null }

/** Stops every process group with a process working inside `dir`, except `spare` groups (and HQ's own): SIGTERM, then SIGKILL
 *  after 2 s. The Launch helper's test servers outlive it this way: its sandbox won't let it kill them, and they're orphaned
 *  when its shell ends (spike 2026-10-30), so they'd hold the ports HQ's real run needs. Returns the groups signalled. */
export async function killUnder(dir: string, spare: number[] = []): Promise<number[]> {
  const keep = new Set([...spare, (await pgidOf(process.pid)) ?? -1])
  const groups = new Set<number>()
  for (const p of pidsUnder(await out('lsof', ['-d', 'cwd', '-Fpn']), dir)) { const g = await pgidOf(p); if (g && g > 1 && !keep.has(g)) groups.add(g) }
  for (const g of groups) { try { process.kill(-g, 'SIGTERM') } catch { /* gone */ } }
  if (groups.size) {
    await sleep(2000)
    for (const g of groups) { try { process.kill(-g, 'SIGKILL') } catch { /* stopped */ } }
  }
  return [...groups]
}
