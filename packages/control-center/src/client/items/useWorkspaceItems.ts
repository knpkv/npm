import * as Predicate from "effect/Predicate"
import { useCallback, useEffect, useState } from "react"

import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import type { WorkspaceId } from "../../domain/identifiers.js"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import {
  aggregateReleaseWorksetInspections,
  browserReleaseWorksetTransport,
  loadReleaseWorksetInspections,
  type ReleaseWorksetTransport
} from "../releases/useReleaseWorkset.js"
import { presentWorkspaceItems, type WorkspaceItemPresentation } from "./presentWorkspaceItems.js"

export const MAXIMUM_WORKSPACE_ITEMS = 500
export const MAXIMUM_WORKSPACE_RELEASES = 25

export type WorkspaceItemsState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading"; readonly scopeKey: string; readonly sessionKey: string }
  | { readonly _tag: "failed"; readonly scopeKey: string; readonly sessionKey: string }
  | {
    readonly _tag: "ready"
    readonly items: ReadonlyArray<WorkspaceItemPresentation>
    readonly scopeKey: string
    readonly sessionKey: string
    readonly truncated: boolean
  }

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

export const EMPTY_WORKSPACE_RELEASES: ReadonlyArray<PortfolioReleasePresentation> = []

const releaseScopeKey = (releases: ReadonlyArray<PortfolioReleasePresentation>): string =>
  releases.map((release) => `${release.id}:${release.targetEnvironmentIds.join(",")}`).join(";")

const loadWorkspaceInspections = async (
  releases: ReadonlyArray<PortfolioReleasePresentation>,
  signal: AbortSignal,
  transport: ReleaseWorksetTransport
): Promise<ReadonlyArray<ReleaseDeliveryGraphInspection>> => {
  const inspections: Array<ReleaseDeliveryGraphInspection> = []
  for (const release of releases) {
    const slices = await loadReleaseWorksetInspections(
      release.id,
      release.targetEnvironmentIds,
      signal,
      transport
    )
    inspections.push(aggregateReleaseWorksetInspections(release.id, slices))
  }
  return inspections
}

/** Load one bounded normalized item index from current release graph slices. */
export const useWorkspaceItems = (
  workspaceId: WorkspaceId,
  releases: ReadonlyArray<PortfolioReleasePresentation>,
  refreshKey: string,
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  transport: ReleaseWorksetTransport = browserReleaseWorksetTransport
): { readonly retry: () => void; readonly state: WorkspaceItemsState } => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<WorkspaceItemsState>({ _tag: "idle" })
  const scopeKey = `${workspaceId}|${releaseScopeKey(releases)}|${refreshKey}`
  const boundedReleases = releases.slice(0, MAXIMUM_WORKSPACE_RELEASES)

  useEffect(() => {
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState({ _tag: "loading", scopeKey, sessionKey })
    loadWorkspaceInspections(boundedReleases, abort.signal, transport).then(
      (inspections) => {
        if (abort.signal.aborted) return
        const allItems = presentWorkspaceItems(workspaceId, inspections)
        setState({
          _tag: "ready",
          items: allItems.slice(0, MAXIMUM_WORKSPACE_ITEMS),
          scopeKey,
          sessionKey,
          truncated: releases.length > MAXIMUM_WORKSPACE_RELEASES ||
            inspections.some(({ truncated }) => truncated) ||
            allItems.length > MAXIMUM_WORKSPACE_ITEMS
        })
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
        setState({ _tag: "failed", scopeKey, sessionKey })
      }
    )
    return () => abort.abort()
  }, [onSessionExpired, requestRevision, scopeKey, sessionKey, transport, workspaceId])

  const currentState: WorkspaceItemsState = sessionKey === null
    ? { _tag: "idle" }
    : state._tag === "idle" || state.scopeKey !== scopeKey || state.sessionKey !== sessionKey
    ? { _tag: "loading", scopeKey, sessionKey }
    : state

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state: currentState
  }
}
