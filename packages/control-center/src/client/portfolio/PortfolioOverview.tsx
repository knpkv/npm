import { FreshnessStamp, PeopleStrip, ReleaseRelay, ServiceMark, StageRail, Verdict } from "@knpkv/rly/patterns"
import { Button, Skeleton, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import { type ReactElement, useState } from "react"
import { Link } from "react-router"

import { BrowserSessionStatus } from "../BrowserSessionStatus.js"
import { useBrowserSession } from "../BrowserSession.js"
import { presentPortfolio, type PortfolioPresentation, type PortfolioReleasePresentation } from "./presentPortfolio.js"
import {
  type PortfolioLoadFailure,
  type PortfolioSnapshotLoadState,
  usePortfolioSnapshot
} from "./usePortfolioSnapshot.js"
import styles from "./PortfolioOverview.module.css"

export type PortfolioOverviewState =
  | {
      readonly _tag: "session"
      readonly reason: "anonymous" | "blocked" | "checking" | "storage-unavailable" | "unavailable"
    }
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly portfolio: PortfolioPresentation }
  | { readonly _tag: "failed"; readonly failure: PortfolioLoadFailure }

export interface PortfolioOverviewViewProps {
  readonly onRetry: () => void
  readonly state: PortfolioOverviewState
}

interface ReleaseDossierProps {
  readonly release: PortfolioReleasePresentation
}

const COLLABORATOR_PREVIEW_LIMIT = 3

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

const ReleaseDossier = ({ release }: ReleaseDossierProps): ReactElement => {
  const [arePeopleExpanded, setArePeopleExpanded] = useState(false)
  const headingId = `release-${release.id}`
  const visibleCollaboratorCount = arePeopleExpanded
    ? release.collaborators.length
    : Math.min(COLLABORATOR_PREVIEW_LIMIT, release.collaborators.length)

  return (
    <Surface
      aria-labelledby={headingId}
      as="article"
      className={styles.dossier}
      data-portfolio-release-id={release.id}
      padding="spacious"
      shape="grouped"
      tone="primary"
    >
      <header className={styles.releaseHeader}>
        <div className={styles.releaseTitle}>
          <Text as="h2" id={headingId} variant="section-title">
            {release.serviceName}
          </Text>
          <Text as="code" tone="secondary" variant="code">
            {release.version}
          </Text>
        </div>
        <StateLabel label={release.lifecycleLabel} tone={release.lifecycleTone} />
      </header>

      <div className={styles.identity}>
        <ReleaseRelay
          algorithm={release.relay.algorithm}
          codename={release.relay.codename}
          size="hero"
          symbolIndices={release.relay.symbolIndices}
        />
      </div>

      <Verdict
        className={styles.verdict}
        reason={release.readinessReason}
        tone="neutral"
        verdict="Readiness not evaluated"
      />

      <section aria-label="Release collaborators" className={styles.people}>
        <Text as="h3" variant="card-title">
          People
        </Text>
        {release.collaborators.length === 0 ? (
          <Text tone="secondary">No release owner or approver is assigned.</Text>
        ) : (
          <>
            <PeopleStrip
              aria-label={`${release.serviceName} collaborators, showing ${visibleCollaboratorCount} of ${release.collaboratorCount}`}
              expanded={arePeopleExpanded}
              limit={COLLABORATOR_PREVIEW_LIMIT}
              onExpandedChange={setArePeopleExpanded}
              people={release.collaborators}
            />
            {release.collaboratorCount > release.collaborators.length ? (
              <Text tone="secondary" variant="meta">
                Showing {release.collaborators.length} of {release.collaboratorCount} collaborators in this overview.
              </Text>
            ) : null}
          </>
        )}
      </section>

      <StageRail className={styles.stages} heading="Readiness checks" size="compact" stages={release.stages} />

      <dl className={styles.facts}>
        {release.facts.map((fact) => (
          <div className={styles.fact} key={fact.id}>
            <Text as="dt" tone="tertiary" variant="meta">
              {fact.label}
            </Text>
            <Text as="dd" className={styles.factValue} variant="body-large">
              {fact.value}
            </Text>
          </div>
        ))}
      </dl>

      <section aria-label="Release source" className={styles.source}>
        <div className={styles.sourceIdentity}>
          {release.source.service === null ? (
            <Text tone="secondary" variant="label">
              Source unavailable
            </Text>
          ) : (
            <ServiceMark service={release.source.service} />
          )}
          <Text tone="secondary" variant="meta">
            {release.source.displayName}
          </Text>
        </div>
        <div className={styles.sourceState}>
          <StateLabel label={release.source.healthLabel} size="compact" tone={release.source.healthTone} />
          {release.source.freshnessDateTime === null || release.source.freshnessTime === null ? (
            <FreshnessStamp size="compact" state={release.source.freshness} />
          ) : (
            <FreshnessStamp
              dateTime={release.source.freshnessDateTime}
              size="compact"
              state={release.source.freshness}
              time={release.source.freshnessTime}
            />
          )}
        </div>
      </section>

      {release.source.warning === null ? null : (
        <StatePanel
          announce="polite"
          className={styles.sourceWarning}
          description={release.source.warning}
          title="Showing preserved source facts"
          tone="caution"
        />
      )}
    </Surface>
  )
}

const ReadyPortfolio = ({ portfolio }: { readonly portfolio: PortfolioPresentation }): ReactElement => {
  if (portfolio.releases.length === 0) return <EmptyPortfolio />
  return (
    <div className={styles.releaseList}>
      {portfolio.releases.map((release) => (
        <ReleaseDossier key={release.id} release={release} />
      ))}
    </div>
  )
}

/** Render every Overview outcome from an explicit controlled state. */
export const PortfolioOverviewView = ({ onRetry, state }: PortfolioOverviewViewProps): ReactElement => (
  <section aria-labelledby="portfolio-title" className={styles.root}>
    <header className={styles.hero}>
      <div className={styles.heroCopy}>
        <Text as="h1" className={styles.title} id="portfolio-title" variant="verdict">
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
          <Text as="time" dateTime={state.portfolio.generatedAt} tone="tertiary" variant="meta">
            Snapshot {state.portfolio.generatedTime}
          </Text>
        ) : null}
      </div>
    </header>

    <div className={styles.content}>
      {state._tag === "session" ? <SessionBoundary {...state} /> : null}
      {state._tag === "loading" ? <LoadingPortfolio /> : null}
      {state._tag === "failed" ? <FailedPortfolio failure={state.failure} onRetry={onRetry} /> : null}
      {state._tag === "ready" ? <ReadyPortfolio portfolio={state.portfolio} /> : null}
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
      return { _tag: "ready", portfolio: presentPortfolio(loadState.snapshot) }
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

/** Load and present the authenticated server portfolio at the root application route. */
export const PortfolioOverview = (): ReactElement => {
  const { invalidateSession, state: browserSession } = useBrowserSession()
  const readableSession =
    browserSession._tag === "authenticated"
      ? browserSession.session
      : browserSession._tag === "storage-unavailable"
        ? browserSession.session
        : null
  const controller = usePortfolioSnapshot(readableSession?.sessionId ?? null, invalidateSession)
  const state = selectPortfolioOverviewState(
    controller.state,
    readableSession?.sessionId ?? null,
    browserSession._tag === "authenticated" ? "checking" : browserSession._tag
  )
  return <PortfolioOverviewView onRetry={controller.retry} state={state} />
}
