// What git says about the map a finished ticket's open_pr gave (criteria.ts): the test files it names are on the branch, each test's name is written in its
// file, the branch adds or changes at least one of them, and what its diff does to existing tests and to files outside the plan. Git only: no test runs here
// (auto mode's own run checks the names again as it tests the ticket), no model, no tokens.
import { git } from './reposync.ts'
import { flagsFor, proofProblem, tidyProof, type Changed, type Criterion, type Proof, type ProofEntry } from './criteria.ts'

const ok = (p: Promise<unknown>): Promise<boolean> => p.then(() => true, () => false)
const fields = (s: string): string[] => { const a = s.split('\0'); if (a.at(-1) === '') a.pop(); return a }
/** The files `branch` changed since it left `base`, with the lines each gained and lost (0 and 0 for a binary file). A renamed file counts as changed under
 *  its new name, so a test that only moved isn't listed as deleted. */
export async function changedSince(repoPath: string, base: string, branch: string): Promise<Changed[]> {
  const fork = await git(repoPath, ['merge-base', base, branch])
  const st = fields(await git(repoPath, ['diff', '-M', '--name-status', '-z', fork, branch])), num = fields(await git(repoPath, ['diff', '-M', '--numstat', '-z', fork, branch]))
  const lines = new Map<string, { added: number; removed: number }>()
  for (let i = 0; i < num.length; i++) {
    const [a, r, p] = num[i]!.split('\t'); let file = p ?? ''
    if (!file) { file = num[i + 2] ?? ''; i += 2 } // a rename: counts, an empty name, then the old path and the new one
    lines.set(file, { added: Number(a) || 0, removed: Number(r) || 0 })
  }
  const out: Changed[] = []
  for (let i = 0; i < st.length; i += 2) {
    const s = st[i]![0]!, moved = s === 'R' || s === 'C', file = st[moved ? i + 2 : i + 1] ?? ''; if (moved) i++
    if (file) out.push({ path: file, status: s === 'A' || s === 'C' ? 'A' : s === 'D' ? 'D' : 'M', ...(lines.get(file) ?? { added: 0, removed: 0 }) })
  }
  return out
}

/** Checks a finished ticket's map against its branch. `problem`: why open_pr is refused, in words the engineer can act on. Otherwise the record HQ keeps:
 *  the map, tidied, and what git flagged for the user. A ticket with no criteria (HQ's own repairs, tickets from before criteria were a list) needs no map
 *  and gets the flags alone. */
export async function checkProof(o: { repoPath: string; base: string; branch: string; criteria: Criterion[]; tests: ProofEntry[] | null; expected: string[]; at: number }):
  Promise<{ problem: string } | { proof: Proof }> {
  const rev = `refs/heads/${o.branch}`, changed = await changedSince(o.repoPath, o.base, rev)
  if (!o.criteria.length) return { proof: { at: o.at, tests: [], flags: flagsFor(changed, o.expected, []) } }
  if (!o.tests?.length) {
    return { problem: `This ticket has acceptance criteria (${o.criteria.map((c) => c.id).join(', ')}; get_ticket lists them), so open_pr needs \`tests\`: for each one, `
      + 'the test that proves it ({ criterion, file, name }), or { criterion, cant_test: "why nothing can test it" }.' }
  }
  const shape = proofProblem(o.criteria, o.tests); if (shape) return { problem: shape }
  const tests = tidyProof(o.criteria, o.tests), named = tests.filter((e) => !e.cant_test)
  for (const e of named) {
    if (!await ok(git(o.repoPath, ['cat-file', '-e', `${rev}:${e.file}`]))) {
      return { problem: `${e.criterion}: there's no ${e.file} on your branch. Commit the test, or fix the path (from the repo's root).` }
    }
    if (!await ok(git(o.repoPath, ['grep', '-q', '-F', '-e', e.name!, rev, '--', e.file!]))) {
      return { problem: `${e.criterion}: ${e.file} has no "${e.name}" in it. Give the test's name exactly as it's written in that file (a part of it that only this test has is enough).` }
    }
  }
  const files = [...new Set(named.map((e) => e.file!))]
  const touched = files.filter((f) => changed.some((c) => c.path === f && c.status !== 'D' && c.added > 0)) // a file that only moved has nothing new in it
  if (named.length && !touched.length) {
    return { problem: `Your branch adds or changes none of the test files you named (${files.join(', ')}): they are as they were before this ticket, so nothing new is `
      + 'tested. Write a test for what you built and name it; for a criterion that truly can\'t be tested, give cant_test and the reason.' }
  }
  return { proof: { at: o.at, tests, flags: flagsFor(changed, o.expected, files) } }
}
