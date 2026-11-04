#!/usr/bin/env node
// Stand-in for the gh CLI in HQ's GitHub e2e test: the few calls HQ makes, answered from a JSON file the test edits
// (FAKE_GH_STATE: { prs: { <branch>: [{ number, url, state, mergeable }] }, next, push?, bares?, refuseMerge? }; push: false = HQ can't push;
// bares: { <slug>: <bare repo> } where a PR merge makes its merge commit; refuseMerge: GitHub's reason for a 405). Pushes and fetches go to a local bare
// repo through git's url.insteadOf, so no network is used. New projects: `login` (null = logged out), `repos` (made with
// POST user/repos, each a bare repo under FAKE_GH_BARE/<owner>/<name>.git unless `noBare`, so the push fails).
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
const args = process.argv.slice(2), file = process.env.FAKE_GH_STATE
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { prs: {}, next: 1 } } }
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const field = (k) => args.filter((a, i) => args[i - 1] === '-f').map((a) => a.split('=')).find(([x]) => x === k)?.slice(1).join('=')
fs.appendFileSync(`${file}.log`, `${JSON.stringify(args)}\n`)
const save = (s) => fs.writeFileSync(file, JSON.stringify(s))
if (args[0] === 'api' && args[1] === 'user') {
  const l = load().login; if (l === null) { console.error('gh: Bad credentials (HTTP 401)'); process.exit(1) }
  console.log(l ?? 'warden-agent'); process.exit(0)
}
if (args[0] === 'api' && args.includes('user/repos')) {
  const s = load(), name = field('name'), slug = `${s.login ?? 'warden-agent'}/${name}`
  if (!s.noBare) execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(process.env.FAKE_GH_BARE, `${slug}.git`)])
  s.repos = [...(s.repos ?? []), slug]; save(s); console.log(JSON.stringify({ slug, ownerId: 7 })); process.exit(0)
}
if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
  const s = load(), slug = args[3].replace(/^repos\//, ''); s.repos = (s.repos ?? []).filter((r) => r !== slug); s.deleted = [...(s.deleted ?? []), slug]; save(s)
  fs.rmSync(path.join(process.env.FAKE_GH_BARE, `${slug}.git`), { recursive: true, force: true }); process.exit(0)
}
if (args[0] === 'api' && args.includes('.full_name')) { // does the repo exist?
  const slug = args[1].replace(/^repos\//, ''); if ((load().repos ?? []).includes(slug)) { console.log(slug); process.exit(0) }
  console.error('gh: Not Found (HTTP 404)'); process.exit(1)
}
if (args[0] === 'pr' && args[1] === 'list') { console.log(JSON.stringify(load().prs[flag('--head')] ?? [])); process.exit(0) }
if (args[0] === 'api' && args[1] === '-X' && args[2] === 'PUT' && /\/pulls\/\d+\/merge$/.test(args[3])) { // merge a PR (Bug 45)
  const s = load(), n = Number(args[3].split('/').at(-2)), slug = args[3].split('/').slice(1, 3).join('/')
  const head = Object.keys(s.prs).find((b) => s.prs[b].some((p) => p.number === n && p.state === 'OPEN'))
  if (!head) { console.error('gh: Pull Request is not mergeable (HTTP 405)'); process.exit(1) }
  if (s.refuseMerge) { console.error(`gh: ${s.refuseMerge} (HTTP 405)`); process.exit(1) }
  let sha = 'f'.repeat(40); const bare = (s.bares ?? {})[slug]
  if (bare) { // what GitHub does: a merge commit on main, in the bare repo HQ pushes to
    const g = (...a) => execFileSync('git', ['-C', bare, '-c', 'user.name=gh', '-c', 'user.email=gh@e2e', ...a], { encoding: 'utf8' }).trim()
    const tree = g('merge-tree', '--write-tree', 'main', head); sha = g('commit-tree', tree, '-p', 'main', '-p', head, '-m', `Merge pull request #${n}`); g('update-ref', 'refs/heads/main', sha)
  }
  s.prs[head] = s.prs[head].map((p) => p.number === n ? { ...p, state: 'MERGED' } : p); s.merged = [...(s.merged ?? []), n]; save(s); console.log(sha); process.exit(0)
}
if (args[0] === 'api' && args.includes('POST')) {
  const s = load(), head = field('head'), list = s.prs[head] ?? []
  if (list.some((p) => p.state === 'OPEN')) { console.error('gh: A pull request already exists (HTTP 422)'); process.exit(1) }
  const pr = { number: s.next, url: `https://github.com/${args.find((a) => a.startsWith('repos/')).split('/').slice(1, 3).join('/')}/pull/${s.next}`, state: 'OPEN', mergeable: 'MERGEABLE' }
  s.prs[head] = [...list, pr]; s.next++; fs.writeFileSync(file, JSON.stringify(s)); console.log(JSON.stringify({ number: pr.number, url: pr.url })); process.exit(0)
}
if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[1] ?? '')) { console.log(load().push === false ? 'false' : 'true'); process.exit(0) } // .permissions.push
console.error(`fake gh: unhandled ${args.join(' ')}`); process.exit(1)
