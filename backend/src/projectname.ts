// A new project's name → its folder and GitHub repo name. Pure (no node imports), so the UI shows the same folder HQ will make.

/** GitHub's characters only (letters, digits, - _ .), spaces → dashes; '' when nothing is left. */
export const projectSlug = (name: string): string =>
  name.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100)
