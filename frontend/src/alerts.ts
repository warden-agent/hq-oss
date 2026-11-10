// Telling the user something needs them (Bug 24): the tab title counts it ("(2) HQ"), and with the browser's permission each new
// item pops up a notification while HQ's tab is in the background. Clicking one brings HQ forward and opens the box when it is in
// the repo on screen; it never switches repos, because switching parks the leaving repo's agents.
import { useEffect, useMemo, useRef } from 'react'
import type { State } from './api'
import { liveEngineer, mergeActs } from './board'
import { needsYou, newNeeds, titleFor, type Need } from './needs.ts'

const notifyOk = (): boolean => typeof Notification !== 'undefined' && Notification.permission === 'granted'
const away = (): boolean => document.visibilityState !== 'visible' || !document.hasFocus()

/** What a finished ticket waits for, in every repo (the ⚠ menu's rule). */
function mergeAct(all: State) {
  return (t: any): 'merge' | 'fix' | null => {
    const f = all.features.find((x) => x.id === t.feature_id), r = all.repos.find((x) => x.id === f?.repo_id), base = r?.default_branch ?? 'main'
    if (r?.auto_mode && !r.auto_stopped_why && !t.auto_parked_why) return null // auto mode handles it
    const acts = mergeActs(t, base, liveEngineer(t, all))
    return acts.some((a) => a.kind === 'fix') ? 'fix' : acts.length ? 'merge' : null
  }
}

/** `all`: everything HQ sends, every repo. `show`: open the item's box (the caller knows the board and the picked repo). */
export function useAlerts(all: State | null, show: (n: Need) => void): Need[] {
  const needs = useMemo(() => all ? needsYou(all, mergeAct(all)) : [], [all])
  const seen = useRef<Set<string> | null>(null), showRef = useRef(show), popped = useRef(new Map<string, Notification>())
  useEffect(() => { showRef.current = show })
  useEffect(() => { document.title = titleFor(needs.length) }, [needs.length])
  useEffect(() => {
    if (!all) return
    const { fresh, seen: next } = newNeeds(seen.current, needs); seen.current = next
    for (const [key, note] of popped.current) if (!next.has(key)) { note.close(); popped.current.delete(key) } // dealt with: its pop-up goes too
    if (!fresh.length || !notifyOk() || !away()) return
    const pop = (title: string, body: string, tag: string, n: Need | null) => {
      try {
        const note = new Notification(title, { body, tag })
        note.onclick = () => { window.focus(); if (n) showRef.current(n); note.close() }
        if (n) popped.current.set(n.key, note)
      } catch { /* some browsers only notify from a service worker: the tab title still counts it */ }
    }
    if (fresh.length <= 3) for (const n of fresh) pop('HQ needs you', n.text, n.key, n)
    else pop('HQ needs you', `${fresh.length} things are waiting for you`, 'hq-many', null)
  }, [needs, all])
  return needs
}
