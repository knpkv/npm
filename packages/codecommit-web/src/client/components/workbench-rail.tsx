/** Workbench queue route wired to application state. @module */
import { useAtomValue } from "@effect/atom-react"
import { useMemo } from "react"
import { appStateAtom } from "../atoms/app.js"
import type { CodeCommitPullRequestRouteCoordinates } from "../codecommit-route.js"
import { queuePullRequests } from "../utils/queuePullRequests.js"
import { selectCodeCommitPullRequest } from "./pr-detail-helpers.js"
import { prListKey } from "./pr-list-links.js"
import { callerOf, workbenchQueue } from "./workbench-queue.js"
import { WorkbenchRailView } from "./workbench-rail-view.js"

/**
 * The queue rail. `route` is the pull-request URL open beside it; it is resolved against the whole
 * cache exactly as the PR page resolves it, so an ambiguous route marks no row.
 */
export function WorkbenchRail({ route }: { readonly route?: CodeCommitPullRequestRouteCoordinates | undefined }) {
  const appState = useAtomValue(appStateAtom)
  // Ages are measured when the queue data changes, which the server pushes on every refresh.
  const queue = useMemo(() => workbenchQueue(queuePullRequests(appState), callerOf(appState), new Date()), [appState])
  const open = route === undefined ? null : selectCodeCommitPullRequest(appState.pullRequests, route).pullRequest
  return (
    <WorkbenchRailView
      currentKey={open === null ? undefined : prListKey(open)}
      currentUser={appState.currentUser}
      queue={queue}
    />
  )
}
