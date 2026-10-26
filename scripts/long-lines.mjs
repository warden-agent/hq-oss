// Fails when the code has more lines over 200 characters than scripts/long-lines.baseline allows, so the count only goes
// down. Counts git-tracked .ts/.tsx/.mjs files. When the count drops, lower the baseline in the same commit.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const MAX = 200
const root = path.resolve(import.meta.dirname, '..')
const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
const perFile = files.map((f) => ({ f, n: fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => l.length > MAX).length })).filter((x) => x.n)
const total = perFile.reduce((s, x) => s + x.n, 0)
const baseline = Number(fs.readFileSync(path.join(import.meta.dirname, 'long-lines.baseline'), 'utf8').trim())

console.log(`Lines over ${MAX} characters: ${total} (baseline ${baseline})`)
for (const x of perFile.sort((a, b) => b.n - a.n).slice(0, 10)) console.log(`  ${String(x.n).padStart(3)}  ${x.f}`)
if (total > baseline) { console.error(`\n${total - baseline} more than the baseline: wrap the new long lines.`); process.exit(1) }
if (total < baseline) console.log(`\nBelow the baseline: set scripts/long-lines.baseline to ${total}.`)
