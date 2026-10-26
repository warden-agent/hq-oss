// Native macOS folder picker for "Add repo…". A web page can't get a real path out of a dialog, so the backend (local, same
// login session) shows the standard "Choose a Folder" panel via osascript. Fixed script; the start folder is passed as argv.
import { execFile } from 'node:child_process'

const SCRIPT = ['on run argv', 'activate', 'POSIX path of (choose folder with prompt "Choose a repo folder for HQ" default location (POSIX file (item 1 of argv)))', 'end run']
export type PickRun = (defaultDir: string) => Promise<string | null>

/** osascript result → chosen folder (no trailing slash), null when the user cancelled; anything else throws. */
export function parsePick(err: (Error & { killed?: boolean }) | null, stdout: string, stderr: string): string | null {
  if (!err) { const p = stdout.trim(); return p.length > 1 ? p.replace(/\/+$/, '') : p }
  if (/\(-128\)/.test(stderr)) return null
  if (err.killed) throw new Error('folder picker timed out')
  throw new Error(`folder picker failed: ${stderr.trim().split('\n')[0] || err.message}`)
}

export const runOsascript: PickRun = (defaultDir) => new Promise((resolve, reject) => execFile('osascript', [...SCRIPT.flatMap((l) => ['-e', l]), '--', defaultDir], { timeout: 10 * 60_000 }, (err, out, errOut) => {
  try { resolve(parsePick(err, String(out), String(errOut))) } catch (e) { reject(e) }
}))

let pending: Promise<string | null> | null = null
/** Show the picker. One at a time: a second call while the dialog is open waits on that same dialog. */
export function pickFolder(defaultDir: string, run: PickRun = runOsascript): Promise<string | null> {
  if (run === runOsascript && process.platform !== 'darwin') return Promise.reject(new Error('folder picker needs macOS'))
  if (!pending) pending = run(defaultDir).finally(() => { pending = null })
  return pending
}
