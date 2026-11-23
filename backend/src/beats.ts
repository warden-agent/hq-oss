// Beats: a counter per timed look of HQ's, one higher each time that look ends. They are for tests. A test that must show HQ did NOT do something
// used to sleep for a while and hope a look had run in that time; with a beat it waits until one has, and then checks (GET /api/beats, behind the
// page token like the rest of the API). The page doesn't read them. Import-free, so any module can beat.
//   auto       one pass of the auto loop over every project (auto.ts)
//   stuck      the stuck look on its clock (stuck.ts)
//   finished   the clock look that stops engineers whose ticket is finished (listeners.ts)
//   leftovers  a look for leftover processes, whole or narrowed to one agent (leftovers.ts)
//   merges     one pass of the merge watcher: on its clock, after a sync, after a merge (mergewatch.ts)
export type Beat = 'auto' | 'stuck' | 'finished' | 'leftovers' | 'merges'
const counts: Record<Beat, number> = { auto: 0, stuck: 0, finished: 0, leftovers: 0, merges: 0 }
/** That look has just ended. */
export function beat(name: Beat): void { counts[name]++ }
/** How often each look has ended since this backend started. */
export const beats = (): Record<Beat, number> => ({ ...counts })
