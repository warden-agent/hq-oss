// How HQ runs a repo's app for the live preview: which command, whether packages need installing, which port, where it
// answers and whether it may be shown inside HQ. Fixed rules, no agent turns. No DB access here.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { shq } from './util.ts'

export const PREVIEW_PORTS = Array.from({ length: 10 }, (_, i) => 3090 + i) // engineers' slots use 3101+ and 3110+

/** `npm run dev`, else `npm start`, from the repo's package.json; null when HQ can't tell how to start the app. */
export function detectCommand(repoPath: string): string | null {
  try {
    const scripts = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')).scripts ?? {}
    return scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : null
  } catch { return null }
}

/** Install first when npm's own record of what's installed (node_modules/.package-lock.json) is missing or older than the
 *  lockfile, e.g. after a merge changed dependencies. Without a lockfile: only when nothing is installed yet. */
export function installStep(repoPath: string): 'npm ci' | 'npm install' | null {
  const at = (f: string) => { try { return fs.statSync(path.join(repoPath, f)).mtimeMs } catch { return null } }
  if (at('package.json') === null) return null
  const lock = at('package-lock.json'), record = at('node_modules/.package-lock.json')
  if (lock === null) return at('node_modules') === null ? 'npm install' : null
  return record === null || record < lock ? 'npm ci' : null
}

/** The script the preview's tmux session runs: one header line, an install if needed, then the command. Not `exec`, so a
 *  command of the user's like `PORT=4000 node server.js` or `cd web && npm run dev` works; Stop signals the whole process group. */
export function runScript(o: { repoPath: string; command: string; port: number; install: string | null; label: string }): string {
  return ['#!/bin/bash', `cd ${shq(o.repoPath)} || exit 1`, `export PORT=${o.port} BROWSER=none`,
    `echo ${shq(`HQ preview: ${o.command} · port ${o.port} · ${o.label}`)}`,
    ...(o.install ? [`echo ${shq(`Installing packages (${o.install})…`)}`, `${o.install} || exit 1`] : []),
    o.command].join('\n') + '\n'
}

/** Loopback ports the app printed (`http://localhost:5173/`), for apps such as Vite that pick their own port. */
export function printedPorts(text: string): number[] {
  const ports = [...text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/g)].map((m) => Number(m[1]))
  return [...new Set(ports)].filter((p) => p > 0 && p < 65536)
}

/** True when the app's reply forbids being shown inside HQ's page (another origin): X-Frame-Options DENY/SAMEORIGIN, or a
 *  CSP frame-ancestors that allows neither any origin nor a loopback one. */
export function frameBlocked(get: (name: string) => string | null): boolean {
  const xfo = (get('x-frame-options') ?? '').toLowerCase()
  if (/\b(deny|sameorigin)\b/.test(xfo)) return true
  const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(get('content-security-policy') ?? '')
  if (!fa) return false
  const sources = fa[1]!.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return !sources.some((s) => s === '*' || s === 'http:' || /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::(?:\d+|\*))?\/?$/.test(s))
}

/** Something accepts connections on this port (IPv4 or IPv6 loopback). */
export function portBusy(port: number): Promise<boolean> {
  const one = (host: string) => new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port }); const done = (busy: boolean) => { s.destroy(); resolve(busy) }
    s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(500, () => done(false))
  })
  return Promise.all([one('127.0.0.1'), one('::1')]).then(([a, b]) => a || b)
}

/** The repo's saved port if it's free, else the first free preview port; null when all ten are taken. */
export async function pickPort(saved: number | null, busy: (port: number) => Promise<boolean> = portBusy): Promise<number | null> {
  for (const p of saved && PREVIEW_PORTS.includes(saved) ? [saved, ...PREVIEW_PORTS.filter((x) => x !== saved)] : PREVIEW_PORTS) if (!(await busy(p))) return p
  return null
}
