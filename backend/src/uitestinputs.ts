// What the UI tester (uitester.ts) reads that other parts of HQ keep: the project's feature map (Part 2, the map store). One place, so the tester's own code
// never changes when they do. A project with no map yet gets '': the tester plans from what's new and finds its way from the start page.
import { currentMap } from './mapstore.ts'

/** The project's feature map in a user's words ('' when it has none). */
export const featureMap = (repoId: string): string => currentMap(repoId)
