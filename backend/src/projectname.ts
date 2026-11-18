// A new project's name → its folder and GitHub repo name. Pure (no node imports), so the UI shows the same folder HQ will make.

/** GitHub's characters only (letters, digits, - _ .), spaces → dashes; '' when nothing is left. */
export const projectSlug = (name: string): string =>
  name.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100)

/** The folder a project's Clear or Remove lands in under HQ's archive (clear.ts `safe`), so the dialogs name the folder HQ writes (Bug 224). */
export const archiveName = (name: string): string => name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
/** A path with the home folder shown as `~`, as HQ's notices write it. */
export const homeShort = (p: string, home: string | undefined): string => home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p
