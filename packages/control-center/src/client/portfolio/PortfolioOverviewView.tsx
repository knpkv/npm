import { ReleaseRow, ServiceMark, StageRail, type RlyReleaseTransitionNames } from "@knpkv/rly/patterns"
import { Button, type RlyStateTone, Skeleton, StateLabel, StatePanel, Text } from "@knpkv/rly/primitives"
import { Fragment, type ReactElement, type ReactNode } from "react"
import { Link, useLocation } from "react-router"
import { firstPartyServiceIdentities } from "../../domain/firstPartyServices.js"
import { serviceSetupPath } from "../services/serviceOnboarding.js"
import type {
  PortfolioPresentation,
  PortfolioReleasePresentation,
  PortfolioSourceRowPresentation
} from "./presentPortfolio.js"
import type { PortfolioConnectionState, PortfolioLoadFailure } from "./livePortfolioState.js"
import {
  filterPortfolioReleases,
  type PortfolioFilter,
  portfolioFilterFromSearch,
  portfolioFilterLabel,
  portfolioFilterOptions,
  portfolioFilterSearch
} from "./portfolioFilters.js"
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
  /** Optional host-rendered row; defaults to the controlled release dossier. */
  readonly renderRelease?: (release: PortfolioReleasePresentation, onPreview: () => void) => ReactNode
  /**
   * Defaults to no named transition surfaces. Names cover the relay, version and verdict in each
   * release row and are read on every render; the host
   * owns browser transition entry and exit and must clear the names after exit. Rly keeps reduced
   * motion free of spatial animation. The stage rail and status messages have no named surfaces.
   */
  readonly transitionNamesForRelease?: (
    releaseId: PortfolioReleasePresentation["id"]
  ) => RlyReleaseTransitionNames | undefined
  readonly state: PortfolioOverviewState
  /** Optional session badge supplied by the host; no session provider is read. */
  readonly sessionStatus?: ReactNode
}

export interface PortfolioReleaseDossierProps {
  readonly onPreview: () => void
  readonly release: PortfolioReleasePresentation
  readonly transitionNames?: RlyReleaseTransitionNames
}

interface ConnectionPresentation {
  readonly detail: string
  readonly label: string
  readonly tone: RlyStateTone
}

const connectionPresentation = (
  connection: PortfolioConnectionState,
  isSnapshotStale: boolean
): ConnectionPresentation => {
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

const serviceLauncher = (
  providers: ReadonlyArray<(typeof firstPartyServiceIdentities)[number]>,
  label: string
): ReactElement => (
  <nav aria-label={label} className={styles.serviceLauncher}>
    {providers.map((service) => (
      <Link
        className={styles.serviceChoice}
        data-service={service.providerId}
        key={service.providerId}
        to={serviceSetupPath(service.providerId)}
      >
        <ServiceMark service={service.providerId} />
        <span className={styles.serviceAction}>Enable</span>
      </Link>
    ))}
  </nav>
)

/**
 * The portfolio has no releases. With nothing connected that is a first run; otherwise it says what still
 * produces a release. Whether each source works is the Sources panel's job, so this copy never claims it.
 */
const EmptyPortfolio = ({
  connectedProviders
}: {
  readonly connectedProviders: PortfolioPresentation["connectedProviders"]
}): ReactElement => {
  if (connectedProviders.length === 0) {
    return (
      <section aria-labelledby="first-service-title" className={styles.firstService}>
        <div className={styles.firstServiceCopy}>
          <Text as="h2" id="first-service-title" variant="page-title">
            Choose your first service
          </Text>
          <Text tone="secondary" variant="body-large">
            Enable and verify one source. Its releases, people, and delivery evidence will appear here automatically.
          </Text>
        </div>
        {serviceLauncher(firstPartyServiceIdentities, "Services available to enable")}
      </section>
    )
  }
  const remaining = firstPartyServiceIdentities.filter(({ providerId }) => !connectedProviders.includes(providerId))
  const jiraConnected = connectedProviders.includes("jira")
  return (
    <section aria-labelledby="first-service-title" className={styles.firstService}>
      <div className={styles.firstServiceCopy}>
        <Text as="h2" id="first-service-title" variant="page-title">
          No releases yet
        </Text>
        <Text tone="secondary" variant="body-large">
          {jiraConnected
            ? "A release appears here once a Jira release version has items."
            : "Releases come from Jira release versions: connect Jira to start tracking them, and this evidence attaches automatically."}
        </Text>
      </div>
      {remaining.length === 0 ? null : serviceLauncher(remaining, "More services to enable")}
    </section>
  )
}

/** Every source connection with its health in words and either the reason or when it was last checked. */
const SourcesPanel = ({
  sources
}: {
  readonly sources: ReadonlyArray<PortfolioSourceRowPresentation>
}): ReactElement => (
  <section aria-labelledby="portfolio-sources-title" className={styles.sources}>
    <Text as="h2" className={styles.sourcesTitle} id="portfolio-sources-title" variant="card-title">
      Sources <span className={styles.sourcesCount}>{sources.length}</span>
    </Text>
    <ul className={styles.sourceList}>
      {sources.map((source) => (
        <li className={styles.sourceRow} key={source.id}>
          <span className={styles.sourceName}>
            <ServiceMark service={source.service} />
            <Text as="span" variant="label">
              {source.name}
            </Text>
          </span>
          <StateLabel label={source.healthLabel} size="compact" tone={source.healthTone} />
          {source.detail === null ? null : source.detailDateTime === null ? (
            <Text as="p" className={styles.sourceDetail} tone="secondary" variant="meta">
              {source.detail}
            </Text>
          ) : (
            <Text
              as="time"
              className={styles.sourceDetail}
              dateTime={source.detailDateTime}
              tone="secondary"
              variant="meta"
            >
              {source.detail}
            </Text>
          )}
        </li>
      ))}
    </ul>
  </section>
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

type PortfolioSessionReason = Extract<PortfolioOverviewState, { readonly _tag: "session" }>["reason"]

interface PortfolioSessionBoundaryPresentation {
  readonly announce?: "assertive"
  readonly description: string
  readonly title: string
  readonly tone?: "caution" | "critical"
}

export const portfolioSessionBoundaryPresentation = (
  reason: PortfolioSessionReason
): PortfolioSessionBoundaryPresentation => {
  switch (reason) {
    case "anonymous":
      return {
        description:
          "Pair this browser to read the workspace portfolio. Release facts never load before authentication.",
        title: "Release facts stay private"
      }
    case "checking":
      return {
        description: "Control Center is confirming whether this browser can read the workspace portfolio.",
        title: "Checking this browser"
      }
    case "blocked":
      return {
        announce: "assertive",
        description: "This connection cannot read private release facts. Use an allowed Control Center address.",
        title: "Portfolio access blocked",
        tone: "critical"
      }
    case "storage-unavailable":
      return {
        announce: "assertive",
        description:
          "This browser cannot retain the private session proof. Check storage permissions or space, then reload.",
        title: "Session storage unavailable",
        tone: "caution"
      }
    case "unavailable":
      return {
        announce: "assertive",
        description: "Control Center could not check this browser session. Check the server, then reload this page.",
        title: "Control Center unavailable",
        tone: "critical"
      }
  }
}

const SessionBoundary = ({ reason }: Extract<PortfolioOverviewState, { readonly _tag: "session" }>): ReactElement => {
  const presentation = portfolioSessionBoundaryPresentation(reason)
  return (
    <StatePanel
      {...presentation}
      action={
        reason === "anonymous" ? (
          <Link className={styles.pairAction} to="/pair">
            Pair this browser
          </Link>
        ) : undefined
      }
      className={styles.statePanel}
    />
  )
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

export const PortfolioReleaseDossier = ({
  onPreview,
  release,
  transitionNames
}: PortfolioReleaseDossierProps): ReactElement => (
  <div className={styles.releaseEntry} data-portfolio-release-id={release.id}>
    <ReleaseRow
      agentEntry={
        release.targetSettingsPath === undefined ? undefined : (
          <Link className={styles.configureTargets} to={release.targetSettingsPath}>
            Configure targets
          </Link>
        )
      }
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

const ReadyPortfolio = ({
  onPreviewRelease,
  portfolio,
  renderRelease,
  transitionNamesForRelease
}: {
  readonly onPreviewRelease: (releaseId: PortfolioReleasePresentation["id"]) => void
  readonly portfolio: PortfolioPresentation
  readonly renderRelease?: PortfolioOverviewViewProps["renderRelease"]
  readonly transitionNamesForRelease?: PortfolioOverviewViewProps["transitionNamesForRelease"]
}): ReactElement => {
  if (portfolio.releases.length === 0) return <EmptyPortfolio connectedProviders={portfolio.connectedProviders} />
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
          {releases.map((release) => {
            const transitionNames = transitionNamesForRelease?.(release.id)
            return (
              <Fragment key={release.id}>
                {renderRelease === undefined ? (
                  <PortfolioReleaseDossier
                    onPreview={() => onPreviewRelease(release.id)}
                    release={release}
                    {...(transitionNames === undefined ? {} : { transitionNames })}
                  />
                ) : (
                  renderRelease(release, () => onPreviewRelease(release.id))
                )}
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Render every Overview outcome from an explicit controlled state. */
export const PortfolioOverviewView = ({
  onPreviewRelease,
  onRetry,
  renderRelease,
  sessionStatus,
  state,
  transitionNamesForRelease
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
        {sessionStatus}
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
        <div className={styles.readyLayout}>
          <ReadyPortfolio
            onPreviewRelease={onPreviewRelease}
            portfolio={state.portfolio}
            {...(renderRelease === undefined ? {} : { renderRelease })}
            {...(transitionNamesForRelease === undefined ? {} : { transitionNamesForRelease })}
          />
          {state.portfolio.sources.length === 0 ? null : <SourcesPanel sources={state.portfolio.sources} />}
        </div>
      ) : null}
    </div>
  </section>
)
