/**
 * Pull-request decision queue.
 *
 * Owns the complete home-page composition while preserving the URL-backed
 * filter contract: summary facets, text and structured filters, review mode,
 * date bounds, grouping, loading, empty, and SSO-recovery states all operate
 * on the same pull-request collection.
 *
 * @module
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { useCallback } from "react"
import { useNavigate, useSearchParams } from "react-router"
import { appStateAtom, notificationsSsoLoginAtom } from "../atoms/app.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { streamConnectionAtom, streamRetryAtom, streamSnapshotSeenAtom } from "../connection.js"
import { FilterSidebar } from "./filter-sidebar.js"
import { PRListView } from "./pr-list-view.js"
import type { QueueFacet } from "./review-queue-state.js"
import { SearchBar } from "./search-bar.js"

const replaceStatusFacet = (params: URLSearchParams, status: "approved" | "open" | "pending"): void => {
  const retained = params.getAll("f").filter((raw) => !raw.startsWith("status:") && raw !== "")
  params.delete("f")
  for (const raw of retained) params.append("f", raw)
  params.append("f", `status:${status}`)
}

export function PRList() {
  const appState = useAtomValue(appStateAtom)
  const connection = useAtomValue(streamConnectionAtom)
  const snapshotSeen = useAtomValue(streamSnapshotSeenAtom)
  const setRetry = useAtomSet(streamRetryAtom)
  const navigate = useNavigate()
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const { state: filterState, toggleFilter } = useFilterParams()
  const [, setSearchParams] = useSearchParams()

  const applyFacet = useCallback(
    (facet: QueueFacet) => {
      setSearchParams(
        (previous) => {
          previous.delete("groupBy")
          previous.delete("mine")
          previous.delete("mineScope")
          previous.delete("review")
          previous.set("sortBy", "updated")

          if (appState.currentUser !== undefined && appState.currentUser !== "") {
            const retained = previous
              .getAll("f")
              .filter((raw) => raw !== `author:${appState.currentUser}` && raw !== "")
            previous.delete("f")
            for (const raw of retained) previous.append("f", raw)
          }

          replaceStatusFacet(previous, facet === "review" ? "open" : facet)
          if (facet === "review") previous.set("review", "1")
          return previous
        },
        { preventScrollReset: true, replace: true }
      )
    },
    [appState.currentUser, setSearchParams]
  )

  return (
    <PRListView
      snapshot={{
        pullRequests: appState.pullRequests,
        accounts: appState.accounts,
        enabledProfiles: appState.enabledProfiles,
        status: appState.status,
        currentUser: appState.currentUser,
        notifications: appState.notifications,
        permissionPrompt: appState.permissionPrompt
      }}
      connection={connection}
      snapshotSeen={snapshotSeen}
      filterState={filterState}
      now={new Date()}
      actions={{
        onFacetChange: applyFacet,
        onToggleFilter: toggleFilter,
        onRetryConnection: () => setRetry((count) => count + 1),
        onOpenSettings: () => {
          void navigate("/settings")
        },
        onSsoLogin: (profile) => ssoLogin({ payload: { profile } })
      }}
      renderControls={() => (
        <>
          <SearchBar />
          <FilterSidebar />
        </>
      )}
    />
  )
}
