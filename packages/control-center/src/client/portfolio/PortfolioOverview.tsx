import type { ReactElement } from "react"
import { Navigate, useLocation, useViewTransitionState } from "react-router"
import { BrowserSessionStatus } from "../BrowserSessionStatus.js"
import { useBrowserSession } from "../BrowserSession.js"
import { releaseParentPath, releaseTransitionNames } from "../releases/releaseRoutes.js"
import { useWorkspaceDefaultLandingPath } from "../settings/useWorkspaceDefaultLanding.js"
import { presentPortfolio, type PortfolioReleasePresentation } from "./presentPortfolio.js"
import { type PortfolioSnapshotLoadState, usePortfolioSnapshot } from "./usePortfolioSnapshot.js"
import {
  PortfolioOverviewView as ControlledPortfolioOverviewView,
  PortfolioReleaseDossier,
  type PortfolioReleaseDossierProps,
  type PortfolioOverviewState,
  type PortfolioOverviewViewProps as ControlledPortfolioOverviewViewProps
} from "./PortfolioOverviewView.js"

export { portfolioSessionBoundaryPresentation } from "./PortfolioOverviewView.js"
export type { PortfolioOverviewState } from "./PortfolioOverviewView.js"

export interface PortfolioOverviewViewProps extends Omit<
  ControlledPortfolioOverviewViewProps,
  "sessionStatus" | "renderRelease" | "transitionNamesForRelease"
> {
  readonly previewPathForRelease?: (releaseId: PortfolioReleasePresentation["id"]) => string
}

export interface PortfolioOverviewController {
  readonly onRetry: () => void
  readonly state: PortfolioOverviewState
}

const TransitioningReleaseDossier = ({
  onPreview,
  originPath,
  previewPath,
  release
}: PortfolioReleaseDossierProps & { readonly originPath: string; readonly previewPath: string }): ReactElement => {
  const location = useLocation()
  const isTransitioning = useViewTransitionState(previewPath)
  return (
    <PortfolioReleaseDossier
      onPreview={onPreview}
      release={release}
      {...(isTransitioning && location.pathname === originPath
        ? { transitionNames: releaseTransitionNames(release.id) }
        : {})}
    />
  )
}

/** Keep application session and router transition ownership outside the controlled view. */
export const PortfolioOverviewView = ({
  previewPathForRelease,
  state,
  ...props
}: PortfolioOverviewViewProps): ReactElement => (
  <ControlledPortfolioOverviewView
    {...props}
    state={state}
    sessionStatus={
      state._tag === "session" && state.reason === "storage-unavailable" ? null : (
        <BrowserSessionStatus anonymousAction="status" />
      )
    }
    {...(previewPathForRelease === undefined || state._tag !== "ready"
      ? {}
      : {
          renderRelease: (release: PortfolioReleasePresentation, onPreview: () => void) => (
            <TransitioningReleaseDossier
              onPreview={onPreview}
              originPath={releaseParentPath(state.portfolio.workspaceId)}
              previewPath={previewPathForRelease(release.id)}
              release={release}
            />
          )
        })}
  />
)

const overviewState = (loadState: PortfolioSnapshotLoadState): PortfolioOverviewState => {
  switch (loadState._tag) {
    case "idle":
      return { _tag: "session", reason: "anonymous" }
    case "loading":
      return { _tag: "loading" }
    case "failed":
      return { _tag: "failed", failure: loadState.failure }
    case "loaded":
      return {
        _tag: "ready",
        connection: loadState.connection,
        isSnapshotStale: loadState.isSnapshotStale,
        portfolio: presentPortfolio(loadState.snapshot)
      }
  }
}

/** Prevent a prior browser session's snapshot from crossing an authentication transition. */
export const selectPortfolioOverviewState = (
  loadState: PortfolioSnapshotLoadState,
  sessionKey: string | null,
  sessionReason: Extract<PortfolioOverviewState, { readonly _tag: "session" }>["reason"] = "anonymous"
): PortfolioOverviewState => {
  if (sessionKey === null) return { _tag: "session", reason: sessionReason }
  if (loadState._tag === "idle" || loadState.sessionKey !== sessionKey) return { _tag: "loading" }
  return overviewState(loadState)
}

/** Read the authenticated live portfolio through one shared route-level controller. */
export const usePortfolioOverviewController = (): PortfolioOverviewController => {
  const { invalidateSession, state: browserSession } = useBrowserSession()
  const readableSession =
    browserSession._tag === "authenticated"
      ? browserSession.session
      : browserSession._tag === "storage-unavailable"
        ? browserSession.session
        : null
  const controller = usePortfolioSnapshot(readableSession?.sessionId ?? null, invalidateSession)
  return {
    onRetry: controller.retry,
    state: selectPortfolioOverviewState(
      controller.state,
      readableSession?.sessionId ?? null,
      browserSession._tag === "authenticated" ? "checking" : browserSession._tag
    )
  }
}

/** Load and present the authenticated server portfolio at the root application route. */
export const PortfolioOverview = (): ReactElement => {
  const controller = usePortfolioOverviewController()
  const { state } = controller
  const workspaceId = state._tag === "ready" ? state.portfolio.workspaceId : null
  const defaultLandingPath = useWorkspaceDefaultLandingPath(workspaceId)
  if (state._tag === "ready" && defaultLandingPath !== null) {
    return <Navigate replace to={defaultLandingPath} />
  }
  return <PortfolioOverviewView onPreviewRelease={() => undefined} onRetry={controller.onRetry} state={state} />
}
