// GitHub plumbing as the HQ account (warden-agent): push a ticket branch, open, find and merge its PR, build the "Create PR" link
// (the fallback when opening fails), check push access. Same credential setup as reposync (gh's credential helper with the HQ account's GH_CONFIG_DIR). No DB access here.
import { execFile } from 'node:child_process'
import { git, explain, type SyncOpts } from './reposync.ts'

/** `mergeable`: GitHub's word on an open PR (CONFLICTING, MERGEABLE, or UNKNOWN while it works it out). */
export type Pr = { number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeable?: string }

function gh(args: string[], o: SyncOpts): Promise<string> {
  return new Promise((resolve, reject) => execFile('gh', args, { env: { ...process.env, GH_CONFIG_DIR: o.ghConfigDir, GH_PROMPT_DISABLED: '1' }, timeout: o.timeoutMs ?? 30_000 }, (err, out, errOut) =>
    err ? reject(new Error(String(errOut || err.message).trim().split('\n')[0])) : resolve(String(out).trim())))
}

/** Push `branch` to GitHub as the HQ account. Never forced. `pushUrl` stands in for github.com (tests). */
export async function pushBranch(repoPath: string, slug: string, branch: string, o: SyncOpts & { pushUrl?: string }): Promise<void> {
  try { await git(repoPath, ['push', o.pushUrl ?? `https://github.com/${slug}.git`, `refs/heads/${branch}:refs/heads/${branch}`], { net: o }) } catch (e) {
    const s = String((e as { stderr?: string }).stderr || e)
    if (/permission .*denied|error: 403|write access/i.test(s)) throw new Error(`${o.account} can't push to ${slug}: give it Write access (GitHub → ${slug} → Settings → Collaborators)`)
    if (/non-fast-forward|fetch first/i.test(s)) throw new Error(`GitHub already has a different ${branch}; HQ won't overwrite it`)
    throw new Error(explain(e, slug, o.account))
  }
}

/** PRs whose head is `branch`. Asking GitHub, not git ancestry, also catches squash and rebase merges. */
export async function prsForBranch(slug: string, branch: string, o: SyncOpts): Promise<Pr[]> {
  return parsePrs(await gh(['pr', 'list', '--repo', slug, '--head', branch, '--state', 'all', '--json', 'number,url,state,mergeable'], o))
}
export function parsePrs(json: string): Pr[] {
  const rows = JSON.parse(json || '[]') as Partial<Pr>[]
  return rows.filter((r): r is Pr => typeof r.number === 'number' && typeof r.url === 'string' && ['OPEN', 'MERGED', 'CLOSED'].includes(String(r.state))).sort((a, b) => b.number - a.number)
}
/** The PR that decides the ticket: a merged one, else an open one, else the newest. */
export const decidingPr = (prs: Pr[]): Pr | null => prs.find((p) => p.state === 'MERGED') ?? prs.find((p) => p.state === 'OPEN') ?? prs[0] ?? null

const CUT_NOTE = '\n\n…(cut to fit; the full text is in the ticket handoff)'
/** `body`, cut (with a note) until `fits` accepts it; '' when nothing fits. */
export function fitBody(body: string, fits: (s: string) => boolean): string {
  if (fits(body)) return body
  let b = body
  while (b && !fits(b + CUT_NOTE)) b = b.slice(0, Math.floor(b.length * 0.9))
  return b ? b + CUT_NOTE : ''
}

/** GitHub's "Open a pull request" page for `branch`, pre-filled. The body is cut so the link stays a safe length. */
export function compareUrl(slug: string, base: string, branch: string, title: string, body: string, maxLen = 7000): string {
  const seg = (s: string) => s.split('/').map(encodeURIComponent).join('/')
  const head = `https://github.com/${slug}/compare/${seg(base)}...${seg(branch)}?expand=1&title=${encodeURIComponent(title)}`
  const b = fitBody(body, (s) => head.length + '&body='.length + encodeURIComponent(s).length <= maxLen)
  return b ? `${head}&body=${encodeURIComponent(b)}` : head
}

/** GitHub's PR body limit is 65,536 characters. */
export const PR_BODY_MAX = 65_000
/** Open a ready (not draft) PR for `branch` as the HQ account. If one is already open (a retry), that one is returned. */
export async function createPr(slug: string, base: string, branch: string, title: string, body: string, o: SyncOpts): Promise<Pr> {
  const b = fitBody(body, (s) => s.length <= PR_BODY_MAX)
  try {
    const r = JSON.parse(await gh(['api', '-X', 'POST', `repos/${slug}/pulls`, '-f', `title=${title}`, '-f', `head=${branch}`, '-f', `base=${base}`, '-f', `body=${b}`, '--jq', '{number, url: .html_url}'], o)) as { number: number; url: string }
    return { number: r.number, url: r.url, state: 'OPEN' }
  } catch (e) {
    const s = (e as Error).message
    if (/HTTP 422|already exists/i.test(s)) { const open = (await prsForBranch(slug, branch, o).catch(() => [])).find((p) => p.state === 'OPEN'); if (open) return open }
    if (/HTTP 403|HTTP 404|permission|not accessible/i.test(s)) throw new Error(`${o.account} can't open PRs on ${slug}: give it Write access (GitHub → ${slug} → Settings → Collaborators)`)
    throw new Error(`GitHub refused the PR: ${s.replace(/^gh: /, '')}`)
  }
}
/** Merge PR `number` on GitHub as the HQ account, with a normal merge commit (what GitHub's Merge button does by default).
 *  Returns the merge commit. GitHub's refusals come back in plain words (Bug 45: the user merges from HQ). */
export async function mergePr(slug: string, number: number, o: SyncOpts): Promise<string> {
  try { return await gh(['api', '-X', 'PUT', `repos/${slug}/pulls/${number}/merge`, '-f', 'merge_method=merge', '--jq', '.sha'], o) } catch (e) {
    const s = (e as Error).message.replace(/^gh: /, ''), why = s.replace(/\s*\(HTTP \d+\)\s*$/, '')
    if (/HTTP 405/.test(s)) throw new Error(`GitHub won't merge PR #${number}: ${why}. A required check, a review rule or a conflict is in the way; see the PR on GitHub.`)
    if (/HTTP 409/.test(s)) throw new Error(`PR #${number}'s branch changed while it was being merged; try again.`)
    if (/HTTP 403|HTTP 404|permission|not accessible/i.test(s)) throw new Error(`${o.account} can't merge PRs on ${slug}: give it Write access (GitHub → ${slug} → Settings → Collaborators)`)
    throw new Error(`GitHub refused the merge: ${s}`)
  }
}
/** Open the PR; if GitHub refuses, hand back the pre-filled "Create PR" link and the reason instead, so the user is never stuck. */
export async function openOrLink(slug: string, base: string, branch: string, title: string, body: string, o: SyncOpts, create = createPr): Promise<{ pr: Pr } | { link: string; error: string }> {
  try { return { pr: await create(slug, base, branch, title, body, o) } } catch (e) { return { link: compareUrl(slug, base, branch, title, body), error: (e as Error).message } }
}

/** Whether the HQ account may push to `slug`; null when GitHub couldn't be asked. */
export async function canPush(slug: string, o: SyncOpts): Promise<boolean | null> {
  try { return (await gh(['api', `repos/${slug}`, '--jq', '.permissions.push'], o)) === 'true' } catch { return null }
}

/** The login gh is using in the HQ account's config dir; null when it isn't logged in (or GitHub can't be reached). */
export async function githubLogin(o: SyncOpts): Promise<string | null> {
  try { return (await gh(['api', 'user', '--jq', '.login'], { ...o, timeoutMs: o.timeoutMs ?? 10_000 })) || null } catch { return null }
}
/** New project: a private, empty repo `name` under the HQ account. A name already taken there is refused before asking GitHub
 *  to make it (GitHub's own answer is just "creation failed"). */
export async function createGithubRepo(name: string, o: SyncOpts): Promise<{ slug: string; ownerId: number }> {
  if ((await githubLogin(o)) !== o.account) throw new Error(`HQ isn't logged in to GitHub as ${o.account}, so it can't make the repo`)
  const taken = await gh(['api', `repos/${o.account}/${name}`, '--jq', '.full_name'], o).then(() => true, (e: Error) => /HTTP 404/.test(e.message) ? false : Promise.reject(e))
    .catch((e: Error) => { throw new Error(`couldn't ask GitHub whether ${o.account}/${name} exists: ${e.message.replace(/^gh: /, '')}`) })
  if (taken) throw new Error(`${o.account} already has a GitHub repo called ${name}: pick another name`)
  try {
    const made = await gh(['api', '-X', 'POST', 'user/repos', '-f', `name=${name}`, '-F', 'private=true', '-F', 'auto_init=false', '--jq', '{slug: .full_name, ownerId: .owner.id}'], o)
    return JSON.parse(made) as { slug: string; ownerId: number }
  } catch (e) { throw new Error(`GitHub didn't make the repo: ${(e as Error).message.replace(/^gh: /, '')}`) }
}
/** Undo createGithubRepo when the rest of a new project fails (only ever a repo HQ made moments ago, still empty). */
export function deleteGithubRepo(slug: string, o: SyncOpts): Promise<string> { return gh(['api', '-X', 'DELETE', `repos/${slug}`], o) }
