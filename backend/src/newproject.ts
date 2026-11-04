// New project: make the folder and its git repo (main, one empty commit), and on request a private GitHub repo under the HQ
// account with main pushed to it, then add it like Add repo… does. Deterministic, no agents. All or nothing: a step that fails
// undoes what this call made (the folder, the GitHub repo) before the error goes back to the user.
import fs from 'node:fs'
import path from 'node:path'
import { git } from './reposync.ts'
import { createGithubRepo, deleteGithubRepo, githubLogin, pushBranch } from './github.ts'
import { addRepo, ghOpts, startCommit } from './repos.ts'
import { projectSlug } from './projectname.ts'
import type { Repo } from './records.ts'

/** Whether HQ can make GitHub repos: gh is logged in, in HQ's config dir, as the HQ account. */
export async function githubReady(): Promise<boolean> { const o = ghOpts(); return (await githubLogin(o)) === o.account }

export type ProjectDeps = { createRepo: typeof createGithubRepo; deleteRepo: typeof deleteGithubRepo; push: typeof pushBranch; add: typeof addRepo }
const realDeps: ProjectDeps = { createRepo: createGithubRepo, deleteRepo: deleteGithubRepo, push: pushBranch, add: addRepo }

export async function createProject(name: string, parent: string, github: boolean, d: ProjectDeps = realDeps): Promise<Repo> {
  const slug = projectSlug(name), label = name.trim()
  if (!slug) throw new Error('Give the project a name with some letters or digits')
  const base = path.resolve(parent.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? ''))
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error(`${base} does not exist or is not a folder`)
  const dir = path.join(base, slug), existed = fs.existsSync(dir)
  if (existed && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new Error(`${dir} already exists and isn't empty: pick another name or place`)
  const o = ghOpts()
  const gh = github ? await d.createRepo(slug, o) : null // first, so a taken name stops it before anything is made
  try {
    if (!existed) fs.mkdirSync(dir)
    await git(dir, ['init', '-b', 'main'])
    await startCommit(dir, `Start ${label}`, gh ? `${gh.ownerId}+${o.account}@users.noreply.github.com` : undefined)
    if (gh) { await git(dir, ['remote', 'add', 'origin', `https://github.com/${gh.slug}.git`]); await d.push(dir, gh.slug, 'main', o) }
    return await d.add(dir, label)
  } catch (e) {
    if (existed) fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true }); else fs.rmSync(dir, { recursive: true, force: true })
    const undo = gh ? await d.deleteRepo(gh.slug, o).then(() => '', (x: Error) => ` HQ couldn't delete the GitHub repo ${gh.slug} it just made (${x.message}); delete it on GitHub.`) : ''
    throw new Error(`${(e as Error).message}${undo}`)
  }
}
