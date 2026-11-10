// node-pty 1.1.0 ships its macOS spawn-helper without the execute permission and its own install step doesn't set it, so after any
// reinstall every terminal view fails with "posix_spawnp failed" (Bug 60). Runs as the root package's postinstall, so it must never fail
// an install. Linux compiles node-pty, so there's nothing to do there. `node scripts/fix-pty-helper.mjs [folder]`: the folder holding node_modules.
import fs from 'node:fs'
import path from 'node:path'

const prebuilds = path.join(process.argv[2] ?? path.join(import.meta.dirname, '..'), 'node_modules', 'node-pty', 'prebuilds')
try {
  for (const d of fs.readdirSync(prebuilds).filter((x) => x.startsWith('darwin-'))) {
    const helper = path.join(prebuilds, d, 'spawn-helper')
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
} catch { /* no prebuilds, or a folder we can't change: the terminal says what's wrong when it's opened */ }
