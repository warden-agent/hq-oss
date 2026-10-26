// Where the live preview sits, remembered per repo in localStorage: open or not, Desktop/Phone, dock, sizes.
import { useState } from 'react'

export type Device = 'desktop' | 'phone'
export type Dock = 'bottom' | 'right'
export type Prefs = { open: boolean; device: Device; dock: Dock; h: number; w: number }
export const PHONE = { w: 390, h: 844 }
export const DOCK_FOR: Record<Device, Dock> = { desktop: 'bottom', phone: 'right' }
/** Starting width when the preview docks right: a phone frame plus its margin, or half the window for a desktop app. */
export const rightWidth = (d: Device) => d === 'phone' ? PHONE.w + 40 : Math.round(window.innerWidth * 0.5)
export const clampH = (h: number) => Math.round(Math.max(160, Math.min(h, window.innerHeight * 0.85)))
export const clampW = (w: number) => Math.round(Math.max(300, Math.min(w, window.innerWidth * 0.7)))
const fresh = (): Prefs => ({ open: false, device: 'desktop', dock: 'bottom', h: Math.round(window.innerHeight * 0.45), w: rightWidth('desktop') })
const key = (repoId: string) => `hq.preview.${repoId}`
const read = (repoId: string | null): Prefs => { if (!repoId) return fresh(); try { return { ...fresh(), ...JSON.parse(localStorage.getItem(key(repoId)) ?? '{}') } } catch { return fresh() } }

/** The preview's place on screen, remembered per repo (open, Desktop/Phone, dock, sizes). `save: false` while dragging. */
export function usePreviewPrefs(repoId: string | null): [Prefs, (p: Partial<Prefs>, save?: boolean) => void] {
  const [state, setState] = useState(() => ({ repoId, prefs: read(repoId) }))
  const prefs = state.repoId === repoId ? state.prefs : read(repoId) // another repo picked: its own prefs
  const set = (p: Partial<Prefs>, save = true) => {
    const next = { ...prefs, ...p }; setState({ repoId, prefs: next })
    if (save && repoId) { try { localStorage.setItem(key(repoId), JSON.stringify(next)) } catch { /* private window: just not remembered */ } }
  }
  return [prefs, set]
}
