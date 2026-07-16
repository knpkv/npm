import { StatePanel } from "@knpkv/rly/primitives"
import { type ReactElement, useEffect, useRef, useState } from "react"
import { Link, Outlet, useLocation, useMatch, useNavigate, useParams } from "react-router"

import {
  PortfolioOverviewView,
  type PortfolioOverviewController,
  type PortfolioOverviewState,
  usePortfolioOverviewController
} from "../portfolio/PortfolioOverview.js"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import {
  decodeReleaseRouteId,
  decodeWorkspaceRouteId,
  makeReleaseRouteState,
  releaseOriginFromLocation,
  releaseParentPath,
  releasePreviewPath
} from "./releaseRoutes.js"
import styles from "./WorkspaceReleaseLayout.module.css"
import { usePrefersReducedReleaseMotion } from "./useCompactReleasePreview.js"

export interface WorkspaceReleaseOutletContext {
  readonly controller: PortfolioOverviewController
  readonly requestReleaseFocus: (releaseId: PortfolioReleasePresentation["id"]) => void
  readonly workspaceId: NonNullable<ReturnType<typeof decodeWorkspaceRouteId>>
}

const WorkspaceNotFound = (): ReactElement => (
  <section className={styles.state}>
    <StatePanel
      action={<Link to="/">Return to Control Center</Link>}
      description="This workspace is unavailable to the current browser session. Check the address or return home."
      title="Workspace not found"
    />
  </section>
)

const isMatchingWorkspace = (
  state: PortfolioOverviewState,
  workspaceId: NonNullable<ReturnType<typeof decodeWorkspaceRouteId>>
): boolean => state._tag !== "ready" || state.portfolio.workspaceId === workspaceId

/** Keep the canonical workspace overview mounted behind route-owned release previews. */
export const WorkspaceReleaseLayout = (): ReactElement => {
  const controller = usePortfolioOverviewController()
  const location = useLocation()
  const navigate = useNavigate()
  const prefersReducedMotion = usePrefersReducedReleaseMotion()
  const overviewRef = useRef<HTMLDivElement>(null)
  const params = useParams()
  const [pendingReleaseFocus, setPendingReleaseFocus] = useState<PortfolioReleasePresentation["id"] | null>(null)
  const workspaceId = decodeWorkspaceRouteId(params.workspaceId)
  const isOverview = useMatch("/w/:workspaceId/overview") !== null
  const previewMatch = useMatch("/w/:workspaceId/releases/:releaseId/preview")

  const previewReleaseId = decodeReleaseRouteId(previewMatch?.params.releaseId)
  const isKnownPreview =
    workspaceId !== null &&
    previewReleaseId !== null &&
    controller.state._tag === "ready" &&
    controller.state.portfolio.releases.some((release) => release.id === previewReleaseId)
  const shouldRenderPortfolio = isOverview || isKnownPreview

  useEffect(() => {
    if (
      pendingReleaseFocus === null ||
      workspaceId === null ||
      controller.state._tag !== "ready" ||
      location.pathname !== releaseParentPath(workspaceId)
    ) {
      return
    }
    const releaseEntry = [
      ...(overviewRef.current?.querySelectorAll<HTMLElement>("[data-portfolio-release-id]") ?? [])
    ].find((entry) => entry.dataset.portfolioReleaseId === pendingReleaseFocus)
    releaseEntry?.querySelector<HTMLButtonElement>("button")?.focus()
    setPendingReleaseFocus(null)
  }, [controller.state, location.pathname, pendingReleaseFocus, workspaceId])

  if (workspaceId === null || !isMatchingWorkspace(controller.state, workspaceId)) return <WorkspaceNotFound />

  const onPreviewRelease = (releaseId: PortfolioReleasePresentation["id"]): void => {
    const state = makeReleaseRouteState(workspaceId, releaseId, releaseOriginFromLocation(location))
    navigate(releasePreviewPath(workspaceId, releaseId), {
      preventScrollReset: true,
      state,
      viewTransition: !prefersReducedMotion
    })
  }
  const outletContext = {
    controller,
    requestReleaseFocus: setPendingReleaseFocus,
    workspaceId
  } satisfies WorkspaceReleaseOutletContext

  return (
    <>
      {shouldRenderPortfolio ? (
        <div ref={overviewRef}>
          <PortfolioOverviewView
            onPreviewRelease={onPreviewRelease}
            onRetry={controller.onRetry}
            previewPathForRelease={(releaseId) => releasePreviewPath(workspaceId, releaseId)}
            state={controller.state}
          />
        </div>
      ) : null}
      <Outlet context={outletContext} />
    </>
  )
}

/** Render no extra content for the overview child because its layout owns the live view. */
export const WorkspaceOverviewRoute = (): null => null

/** Keep an unknown workspace child URL stable instead of substituting another route. */
export const WorkspaceNotFoundRoute = (): ReactElement => {
  const params = useParams()
  const workspaceId = decodeWorkspaceRouteId(params.workspaceId)
  return (
    <section className={styles.state}>
      <StatePanel
        action={
          workspaceId === null ? (
            <Link to="/">Return to Control Center</Link>
          ) : (
            <Link to={releaseParentPath(workspaceId)}>Open workspace overview</Link>
          )
        }
        description="The requested Control Center page does not exist."
        title="Page not found"
      />
    </section>
  )
}
