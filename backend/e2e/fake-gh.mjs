#!/usr/bin/env node
// Stand-in for the gh CLI in HQ's GitHub e2e test: the few calls HQ makes, answered from a JSON file the test edits
// (FAKE_GH_STATE: { prs: { <branch>: [{ number, url, state, mergeable }] }, next }). Pushes and fetches go to a local bare
// repo through git's url.insteadOf, so no network is used.
import fs from 'node:fs'
const args = process.argv.slice(2), file = process.env.FAKE_GH_STATE
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { prs: {}, next: 1 } } }
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const field = (k) => args.filter((a, i) => args[i - 1] === '-f').map((a) => a.split('=')).find(([x]) => x === k)?.slice(1).join('=')
fs.appendFileSync(`${file}.log`, `${JSON.stringify(args)}\n`)
if (args[0] === 'pr' && args[1] === 'list') { console.log(JSON.stringify(load().prs[flag('--head')] ?? [])); process.exit(0) }
if (args[0] === 'api' && args.includes('POST')) {
  const s = load(), head = field('head'), list = s.prs[head] ?? []
  if (list.some((p) => p.state === 'OPEN')) { console.error('gh: A pull request already exists (HTTP 422)'); process.exit(1) }
  const pr = { number: s.next, url: `https://github.com/${args.find((a) => a.startsWith('repos/')).split('/').slice(1, 3).join('/')}/pull/${s.next}`, state: 'OPEN', mergeable: 'MERGEABLE' }
  s.prs[head] = [...list, pr]; s.next++; fs.writeFileSync(file, JSON.stringify(s)); console.log(JSON.stringify({ number: pr.number, url: pr.url })); process.exit(0)
}
if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[1] ?? '')) { console.log('true'); process.exit(0) } // .permissions.push
console.error(`fake gh: unhandled ${args.join(' ')}`); process.exit(1)
