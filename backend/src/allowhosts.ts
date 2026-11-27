// Bug 425: the extra hosts a project's agents may download from (repos.network_allowlist), which only the user sets: Allow on a "Download refused"
// notice, or + Project → Downloads on the page (POST /api/repos/:id/allowed-hosts). Claude Code reads an agent's sandbox list once, when the session
// starts (real 2.1.322, 2026-11-26: a host added to a running session's --settings file stays refused; a new session with the same file downloads),
// so a change reaches each agent at its next start: an engineer's Fresh start, the next helper. A refusal notice whose hosts are all allowed goes
// once its agent has ended (nothing is left for the user to do), or at once when it already had.
import { one, q, run } from './db.ts'
import { emit, patch } from './events.ts'
import { j } from './util.ts'
import { resolveAttention, type Attention } from './attention.ts'
import { getRepo, liveTpm, repoOfAgent, type Repo } from './records.ts'
import { sendMessage } from './delivery.ts'
import { certIn, hostProblem, normalHost, ownHosts, refusedHosts } from './downloads.ts'
import { PACKAGE_REGISTRIES } from './roles.ts'
import type { Agent } from './agents.ts'

/** How many extra hosts one project may have: enough for a project's odd downloads, not a way to switch the list off. */
export const MAX_HOSTS = 30
/** A refusal HQ makes in the user's words (the API answers 400 with them). */
export class HostRefused extends Error {}
/** The project's extra hosts as HQ uses them: ones saved some other way that break the rules are left out (roles.ts filters the same way). */
export const projectHosts = (repo: Pick<Repo, 'network_allowlist'> | undefined): string[] => ownHosts(repo?.network_allowlist)

/** Allow `host` for the project's agents (`allow` false: take it off). Twice is once. Returns the project's list as it is now. */
export function setAllowedHost(repoId: string, host0: string, allow: boolean): { hosts: string[] } {
  const repo = getRepo(repoId); if (!repo) throw new HostRefused('That project is no longer in HQ.')
  const host = normalHost(host0), cur = j<unknown[]>(repo.network_allowlist, []).filter((h): h is string => typeof h === 'string')
  if (allow) {
    const bad = hostProblem(host); if (bad) throw new HostRefused(bad)
    if (PACKAGE_REGISTRIES.includes(host)) throw new HostRefused(`${host} is already allowed for every project.`)
    if (!cur.includes(host) && cur.length >= MAX_HOSTS) throw new HostRefused(`A project can have ${MAX_HOSTS} extra hosts at most: remove one first.`)
  }
  const next = allow ? [...new Set([...cur, host])].sort() : cur.filter((h) => h !== host)
  if (next.length === cur.length) return { hosts: projectHosts(repo) } // already so (a double click, a second tab)
  const value = JSON.stringify(next)
  run('UPDATE repos SET network_allowlist = ? WHERE id = ?', value, repoId)
  patch('repo', repoId, { network_allowlist: value })
  emit({ agentId: null, source: 'ui', kind: allow ? 'repo.host_allowed' : 'repo.host_removed', payload: { repo: repoId, host } })
  if (allow) { const asked = refusals(repoId).filter((a) => refusedHosts(a.detail).includes(host)); settleRepo(repoId); tellTpm(repoId, host, asked) }
  return { hosts: projectHosts({ network_allowlist: value }) }
}

/** Open refusal notices about agents of this project. */
function refusals(repoId: string): Attention[] {
  return q<Attention>("SELECT * FROM needs_attention WHERE kind = 'download_refused' AND resolved_at IS NULL")
    .filter((a) => { const ag = a.agent_id ? agentRow(a.agent_id) : undefined; return !!ag && repoOfAgent(ag) === repoId })
}
const agentRow = (agentId: string): Agent | undefined => one<Agent>('SELECT * FROM agents WHERE id = ?', agentId)
/** Every host the notice names is allowed now, and it says nothing else the user must deal with (a certificate check). */
const allAllowed = (a: Attention, hosts: string[]): boolean => {
  const named = refusedHosts(a.detail); return named.length > 0 && !certIn(a.detail) && named.every((h) => hosts.includes(h))
}
/** A notice nothing is left to do about: every host allowed, and its agent gone (the next one starts with them). */
function settle(a: Attention, hosts: string[]): void {
  const ag = a.agent_id ? agentRow(a.agent_id) : undefined
  if ((!ag || ag.status === 'exited') && allAllowed(a, hosts)) resolveAttention(a.id)
}
function settleRepo(repoId: string): void { const hosts = projectHosts(getRepo(repoId)); for (const a of refusals(repoId)) settle(a, hosts) }
/** An agent has ended (agents.ts update): its refusal notice goes if the user has allowed everything it names. */
export function settleEnded(agentId: string): void {
  const ag = agentRow(agentId), repoId = ag ? repoOfAgent(ag) : null; if (!repoId) return
  const hosts = projectHosts(getRepo(repoId))
  for (const a of q<Attention>("SELECT * FROM needs_attention WHERE kind = 'download_refused' AND agent_id = ? AND resolved_at IS NULL", agentId)) settle(a, hosts)
}
/** The TPM hears it once, when it's done, if an agent was refused that host (`asked`: those notices): so it doesn't keep telling the user that
 *  agent is stuck on it, or offer something else. A host the user adds before anything needed it tells it nothing (nothing to act on). */
function tellTpm(repoId: string, host: string, asked: Attention[]): void {
  const tpm = liveTpm(repoId); if (!tpm || !asked.length) return
  const who = asked.map((a) => agentRow(a.agent_id!)).filter((x): x is Agent => !!x && x.status !== 'exited').map((x) => x.display_name ?? x.id)
  const late = who.length ? ` ${who.join(', ')} started before that, so ${who.length > 1 ? 'they get' : 'it gets'} it only after a Fresh start, which the user presses on its box.` : ''
  sendMessage({ repoId, channel: 'dm', from: 'hq', to: tpm.id, reason: 'fyi',
    body: `HQ: the user allowed downloads from ${host} for this project. Agents started from now on can download from it.${late}` })
}
