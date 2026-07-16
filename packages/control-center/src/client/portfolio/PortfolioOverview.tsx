import { ReleaseRow, StageRail, type RlyReleaseTransitionNames } from "@knpkv/rly/patterns"
import { Button, Skeleton, StateLabel, StatePanel, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { Link, Navigate, useLocation, useViewTransitionState } from "react-router"

import { BrowserSessionStatus } from "../BrowserSessionStatus.js"
import { useBrowserSession } from "../BrowserSession.js"
import { presentPortfolio, type PortfolioPresentation, type PortfolioReleasePresentation } from "./presentPortfolio.js"
import {
  filterPortfolioReleases,
  type PortfolioFilter,
  portfolioFilterFromSearch,
  portfolioFilterLabel,
  portfolioFilterOptions,
  portfolioFilterSearch
} from "./portfolioFilters.js"
import {
  type PortfolioConnectionState,
  type PortfolioLoadFailure,
  type PortfolioSnapshotLoadState,
  usePortfolioSnapshot
} from "./usePortfolioSnapshot.js"
import { releaseParentPath, releaseTransitionNames } from "../releases/releaseRoutes.js"
import styles from "./PortfolioOverview.module.css"

export type PortfolioOverviewState =
  | {
      readonly _tag: "session"
      readonly reason: "anonymous" | "blocked" | "checking" | "storage-unavailable" | "unavailable"
    }
  | { readonly _tag: "loading" }
  | {
      readonly _tag: "ready"
      readonly connection: PortfolioConnectionState
      readonly isSnapshotStale: boolean
      readonly portfolio: PortfolioPresentation
    }
  | { readonly _tag: "failed"; readonly failure: PortfolioLoadFailure }

export interface PortfolioOverviewViewProps {
  readonly onPreviewRelease: (releaseId: PortfolioReleasePresentation["id"]) => void
  readonly onRetry: () => void
  readonly previewPathForRelease?: (releaseId: PortfolioReleasePresentation["id"]) => string
  readonly state: PortfolioOverviewState
}

export interface PortfolioOverviewController {
  readonly onRetry: () => void
  readonly state: PortfolioOverviewState
}

interface ReleaseDossierProps {
  readonly onPreview: () => void
  readonly release: PortfolioReleasePresentation
  readonly transitionNames?: RlyReleaseTransitionNames
}

const connectionPresentation = (
  connection: PortfolioConnectionState,
  isSnapshotStale: boolean
): { readonly detail: string; readonly label: string; readonly tone: "caution" | "positive" | "progress" } => {
  switch (connection._tag) {
    case "connecting":
      return { detail: "Connecting to live updates.", label: "Connecting", tone: "progress" }
    case "reconnecting":
      return {
        detail: "Showing the last snapshot; it may be stale.",
        label: "Reconnecting",
        tone: "caution"
      }
    case "offline":
      return { detail: "Showing the last snapshot; it may be stale.", label: "Offline", tone: "caution" }
    case "connected":
      return isSnapshotStale
        ? { detail: "Refreshing the authoritative snapshot.", label: "Updating", tone: "progress" }
        : { detail: "Snapshot up to date.", label: "Live", tone: "positive" }
  }
}

const PortfolioLiveStatus = ({
  connection,
  isSnapshotStale
}: {
  readonly connection: PortfolioConnectionState
  readonly isSnapshotStale: boolean
}): ReactElement => {
  const presentation = connectionPresentation(connection, isSnapshotStale)
  return (
    <div aria-atomic="true" aria-live="polite" className={styles.liveStatus} role="status">
      <StateLabel label={presentation.label} size="compact" tone={presentation.tone} />
      <Text tone="tertiary" variant="meta">
        {presentation.detail}
      </Text>
    </div>
  )
}

const EmptyPortfolio = (): ReactElement => (
  <StatePanel
    className={styles.statePanel}
    description="Sync a connected service. The first normalized release will appear here with its people and source facts."
    title="No releases yet"
  />
)

const LoadingPortfolio = (): ReactElement => (
  <div className={styles.loading}>
    <Skeleton decorative={false} height="1.25rem" label="Loading releases" width="10rem" />
    <Skeleton decorative height="8rem" variant="block" />
    <div className={styles.loadingRail}>
      <Skeleton decorative height="3rem" variant="block" />
      <Skeleton decorative height="3rem" variant="block" />
      <Skeleton decorative height="3rem" variant="block" />
    </div>
  </div>
)

const SessionBoundary = ({ reason }: Extract<PortfolioOverviewState, { readonly _tag: "session" }>): ReactElement => {
  switch (reason) {
    case "anonymous":
      return (
        <StatePanel
          action={
            <Link className={styles.pairAction} to="/pair">
              Pair this browser
            </Link>
          }
          className={styles.statePanel}
          description="Pair this browser to read the workspace portfolio. Release facts never load before authentication."
          title="Release facts stay private"
        />
      )
    case "checking":
      return (
        <StatePanel
          className={styles.statePanel}
          description="Control Center is confirming whether this browser can read the workspace portfolio."
          title="Checking this browser"
        />
      )
    case "blocked":
      return (
        <StatePanel
          announce="assertive"
          className={styles.statePanel}
          description="This connection cannot read private release facts. Use an allowed Control Center address."
          title="Portfolio access blocked"
          tone="critical"
        />
      )
    case "storage-unavailable":
      return (
        <StatePanel
          announce="assertive"
          className={styles.statePanel}
          description="This browser cannot retain the private session proof. Check storage permissions or space, then reload."
          title="Session storage unavailable"
          tone="caution"
        />
      )
    case "unavailable":
      return (
        <StatePanel
          announce="assertive"
          className={styles.statePanel}
          description="Control Center could not check this browser session. Check the server, then reload this page."
          title="Control Center unavailable"
          tone="critical"
        />
      )
  }
}

const FailedPortfolio = ({
  failure,
  onRetry
}: {
  readonly failure: PortfolioLoadFailure
  readonly onRetry: () => void
}): ReactElement => {
  if (failure === "session-expired") {
    return (
      <StatePanel
        action={
          <Link className={styles.pairAction} to="/pair">
            Pair this browser
          </Link>
        }
        announce="assertive"
        className={styles.statePanel}
        description="Pair this browser again to read the workspace portfolio."
        title="Pairing expired"
        tone="caution"
      />
    )
  }
  if (failure === "blocked") {
    return (
      <StatePanel
        announce="assertive"
        className={styles.statePanel}
        description="This connection cannot read private release facts. Use an allowed Control Center address."
        title="Portfolio access blocked"
        tone="critical"
      />
    )
  }
  return (
    <StatePanel
      action={<Button onClick={onRetry}>Try again</Button>}
      announce="assertive"
      className={styles.statePanel}
      description="Control Center could not read the saved portfolio. Check the server, then try again."
      title="Overview unavailable"
      tone="critical"
    />
  )
}

const ReleaseDossier = ({ onPreview, release, transitionNames }: ReleaseDossierProps): ReactElement => (
  <div className={styles.releaseEntry} data-portfolio-release-id={release.id}>
    <ReleaseRow
      onPreview={onPreview}
      previewLabel={`Preview ${release.relay.codename}`}
      release={release.release}
      {...(transitionNames === undefined ? {} : { transitionNames })}
    />
    <StageRail className={styles.stageRail} heading="Delivery" size="compact" stages={release.stages} />
    {release.source.warning === null ? null : (
      <StatePanel
        announce="polite"
        className={styles.sourceWarning}
        description={release.source.warning}
        title="Showing preserved source facts"
        tone="caution"
      />
    )}
  </div>
)

const PortfolioFilters = ({
  activeFilter,
  portfolio
}: {
  readonly activeFilter: PortfolioFilter
  readonly portfolio: PortfolioPresentation
}): ReactElement => {
  const location = useLocation()
  return (
    <nav aria-label="Release filters" className={styles.filters}>
      {portfolioFilterOptions(portfolio.releases).map((option) => (
        <Link
          aria-current={option.id === activeFilter ? "page" : undefined}
          className={styles.filter}
          data-active={option.id === activeFilter ? "true" : "false"}
          key={option.id}
          to={{ pathname: location.pathname, search: portfolioFilterSearch(location.search, option.id) }}
        >
          <span>{option.label}</span>
          <span
            aria-label={`${String(option.count)} ${option.count === 1 ? "release" : "releases"}`}
            className={styles.filterCount}
          >
            {option.count}
          </span>
        </Link>
      ))}
    </nav>
  )
}

const EmptyFilter = ({ filter }: { readonly filter: PortfolioFilter }): ReactElement => {
  const location = useLocation()
  return (
    <StatePanel
      action={
        <Link
          className={styles.pairAction}
          to={{ pathname: location.pathname, search: portfolioFilterSearch(location.search, "all") }}
        >
          Show all releases
        </Link>
      }
      className={styles.statePanel}
      description={`No releases currently match ${portfolioFilterLabel(filter)}. Live updates may change this view.`}
      title="Nothing here right now"
    />
  )
}

const TransitioningReleaseDossier = ({
  onPreview,
  originPath,
  previewPath,
  release
}: ReleaseDossierProps & { readonly originPath: string; readonly previewPath: string }): ReactElement => {
  const location = useLocation()
  const isTransitioning = useViewTransitionState(previewPath)
  return (
    <ReleaseDossier
      onPreview={onPreview}
      release={release}
      {...(isTransitioning && location.pathname === originPath
        ? { transitionNames: releaseTransitionNames(release.id) }
        : {})}
    />
  )
}

const ReadyPortfolio = ({
  onPreviewRelease,
  portfolio,
  previewPathForRelease
}: {
  readonly onPreviewRelease: (releaseId: PortfolioReleasePresentation["id"]) => void
  readonly portfolio: PortfolioPresentation
  readonly previewPathForRelease?: (releaseId: PortfolioReleasePresentation["id"]) => string
}): ReactElement => {
  if (portfolio.releases.length === 0) return <EmptyPortfolio />
  const location = useLocation()
  const activeFilter = portfolioFilterFromSearch(location.search)
  const releases = filterPortfolioReleases(portfolio.releases, activeFilter)
  return (
    <div className={styles.readyPortfolio}>
      <PortfolioFilters activeFilter={activeFilter} portfolio={portfolio} />
      {releases.length === 0 ? (
        <EmptyFilter filter={activeFilter} />
      ) : (
        <div className={styles.releaseList}>
          {releases.map((release) =>
            previewPathForRelease === undefined ? (
              <ReleaseDossier key={release.id} onPreview={() => onPreviewRelease(release.id)} release={release} />
            ) : (
              <TransitioningReleaseDossier
                key={release.id}
                onPreview={() => onPreviewRelease(release.id)}
                originPath={releaseParentPath(portfolio.workspaceId)}
                previewPath={previewPathForRelease(release.id)}
                release={release}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

/** Render every Overview outcome from an explicit controlled state. */
export const PortfolioOverviewView = ({
  onPreviewRelease,
  onRetry,
  previewPathForRelease,
  state
}: PortfolioOverviewViewProps): ReactElement => (
  <section aria-labelledby="portfolio-title" className={styles.root}>
    <header className={styles.hero}>
      <div className={styles.heroCopy}>
        <Text as="h1" className={styles.title} id="portfolio-title" tabIndex={-1} variant="verdict">
          Every release. One view.
        </Text>
        <Text className={styles.lede} tone="secondary" variant="body-large">
          One factual view of releases, people, source health, and every handoff still to prove.
        </Text>
      </div>
      <div className={styles.session}>
        {state._tag === "session" && state.reason === "storage-unavailable" ? null : (
          <BrowserSessionStatus anonymousAction="status" />
        )}
        {state._tag === "ready" ? (
          <>
            <PortfolioLiveStatus connection={state.connection} isSnapshotStale={state.isSnapshotStale} />
            <Text as="time" dateTime={state.portfolio.generatedAt} tone="tertiary" variant="meta">
              Snapshot {state.portfolio.generatedTime}
            </Text>
          </>
        ) : null}
      </div>
    </header>

    <div className={styles.content}>
      {state._tag === "session" ? <SessionBoundary {...state} /> : null}
      {state._tag === "loading" ? <LoadingPortfolio /> : null}
      {state._tag === "failed" ? <FailedPortfolio failure={state.failure} onRetry={onRetry} /> : null}
      {state._tag === "ready" ? (
        <ReadyPortfolio
          onPreviewRelease={onPreviewRelease}
          portfolio={state.portfolio}
          {...(previewPathForRelease === undefined ? {} : { previewPathForRelease })}
        />
      ) : null}
    </div>
  </section>
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
  if (state._tag === "ready") return <Navigate replace to={releaseParentPath(state.portfolio.workspaceId)} />
  return <PortfolioOverviewView onPreviewRelease={() => undefined} onRetry={controller.onRetry} state={state} />
}
