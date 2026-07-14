import {
  AgentContextButton,
  FreshnessStamp,
  PeopleStrip,
  ReleasePreview,
  ReleaseRelay,
  ServiceMark,
  StageRail,
  Verdict
} from "@knpkv/rly/patterns"
import { Button, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import { type ReactElement, useEffect, useRef, useState } from "react"
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router"

import { PortfolioOverviewView } from "../portfolio/PortfolioOverview.js"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import type { WorkspaceReleaseOutletContext } from "./WorkspaceReleaseLayout.js"
import {
  decodeReleaseRouteId,
  readReleaseOrigin,
  resolveReleaseOrigin,
  releaseFullPath,
  releaseOriginHref,
  releaseParentPath
} from "./releaseRoutes.js"
import styles from "./ReleaseRoute.module.css"
import { useCompactReleasePreview } from "./useCompactReleasePreview.js"

interface ReleaseRouteSelection {
  readonly release: PortfolioReleasePresentation
  readonly releaseId: NonNullable<ReturnType<typeof decodeReleaseRouteId>>
}

const selectRelease = (
  context: WorkspaceReleaseOutletContext,
  routeReleaseId: string | undefined
): ReleaseRouteSelection | null => {
  const releaseId = decodeReleaseRouteId(routeReleaseId)
  if (releaseId === null || context.controller.state._tag !== "ready") return null
  const release = context.controller.state.portfolio.releases.find((candidate) => candidate.id === releaseId)
  return release === undefined ? null : { release, releaseId }
}

const ReleaseNotFound = ({ workspaceId }: Pick<WorkspaceReleaseOutletContext, "workspaceId">): ReactElement => (
  <section className={styles.state}>
    <StatePanel
      action={<Link to={releaseParentPath(workspaceId)}>Return to workspace overview</Link>}
      description="This release does not exist in the current workspace snapshot. It may have been removed or the address may be incorrect."
      title="Release not found"
    />
  </section>
)

const ReleaseRouteLoading = ({ context }: { readonly context: WorkspaceReleaseOutletContext }): ReactElement => (
  <PortfolioOverviewView
    onPreviewRelease={() => undefined}
    onRetry={context.controller.onRetry}
    state={context.controller.state}
  />
)

const ReleaseAction = (): ReactElement => (
  <Button disabled size="principal" stretch variant="primary">
    Readiness evidence required
  </Button>
)

const MissingRelationships = (): ReactElement => (
  <StatePanel
    description="Jira work, pull requests, and pipeline executions are not included in this summary snapshot. No demo relationships are substituted."
    title="Relationship detail not synchronized"
  />
)

const ReleaseEvidence = ({ release }: { readonly release: PortfolioReleasePresentation }): ReactElement => (
  <Surface as="section" className={styles.evidence} padding="compact" tone="secondary">
    <div className={styles.evidenceHeading}>
      {release.source.service === null ? null : <ServiceMark service={release.source.service} />}
      <div>
        <Text as="h2" variant="card-title">
          {release.source.displayName}
        </Text>
        <Text tone="secondary" variant="meta">
          Source evidence
        </Text>
      </div>
    </div>
    <StateLabel label={release.source.healthLabel} size="compact" tone={release.source.healthTone} />
    {release.source.warning === null ? (
      <Text tone="secondary">Detailed evidence is not evaluated in the tracer snapshot.</Text>
    ) : (
      <Text tone="secondary">{release.source.warning}</Text>
    )}
  </Surface>
)

const releaseContextLabel = (release: PortfolioReleasePresentation): string =>
  `${release.serviceName} · ${release.version} · ${release.relay.codename} · ${release.id}`

const ReleaseAgentEntry = ({ release }: { readonly release: PortfolioReleasePresentation }): ReactElement => {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <AgentContextButton
      actionLabel="Ask about this release"
      agentName="Relay"
      context={releaseContextLabel(release)}
      onClick={() => navigate(`/agent?from=${encodeURIComponent(location.pathname)}`)}
    />
  )
}

const CompleteCollaborators = ({ release }: { readonly release: PortfolioReleasePresentation }): ReactElement =>
  release.collaborators.length === 0 ? (
    <StatePanel
      description="Assign an owner or approver before a governed release action can proceed."
      title="No release collaborators assigned"
    />
  ) : (
    <PeopleStrip
      aria-label={`All ${release.serviceName} release collaborators`}
      expanded
      limit={release.collaborators.length}
      onExpandedChange={() => undefined}
      people={release.collaborators}
    />
  )

type PreviewExit = "full" | "origin" | null

const ReleasePreviewContent = ({ selection }: { readonly selection: ReleaseRouteSelection }): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const isCompact = useCompactReleasePreview()
  const location = useLocation()
  const navigate = useNavigate()
  const [exit, setExit] = useState<PreviewExit>(null)
  const [isOpen, setIsOpen] = useState(true)
  const resolvedOrigin = resolveReleaseOrigin(location.state, context.workspaceId, selection.releaseId)
  const originHref = releaseOriginHref(resolvedOrigin.origin)

  useEffect(() => {
    if (isOpen || exit === null) return
    if (exit === "full") {
      navigate(releaseFullPath(context.workspaceId, selection.releaseId), { state: location.state })
      return
    }
    if (resolvedOrigin.isStored) navigate(-1)
    else navigate(originHref, { replace: true })
  }, [
    context.workspaceId,
    exit,
    isOpen,
    location.state,
    navigate,
    originHref,
    resolvedOrigin.isStored,
    selection.releaseId
  ])

  const requestExit = (nextExit: Exclude<PreviewExit, null>): void => {
    setExit(nextExit)
    setIsOpen(false)
  }

  return (
    <ReleasePreview
      agentEntry={<ReleaseAgentEntry release={selection.release} />}
      collaborators={<CompleteCollaborators release={selection.release} />}
      evidence={<ReleaseEvidence release={selection.release} />}
      onOpenChange={(open) => {
        if (!open) requestExit("origin")
      }}
      onOpenFullView={() => requestExit("full")}
      open={isOpen}
      openFullViewLabel={`Open ${selection.release.relay.codename} full view`}
      presentation={isCompact ? "sheet" : "dialog"}
      primaryAction={<ReleaseAction />}
      release={selection.release.release}
      stages={<StageRail heading="Release stages" stages={selection.release.stages} />}
      workset={
        <div className={styles.previewDetails}>
          <MissingRelationships />
        </div>
      }
    />
  )
}

/** Render the canonical release preview over its still-mounted workspace origin. */
export const ReleasePreviewRoute = (): ReactElement | null => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const params = useParams()
  if (context.controller.state._tag !== "ready") return null
  const selection = selectRelease(context, params.releaseId)
  return selection === null ? (
    <ReleaseNotFound workspaceId={context.workspaceId} />
  ) : (
    <ReleasePreviewContent selection={selection} />
  )
}

const FullRelease = ({ selection }: { readonly selection: ReleaseRouteSelection }): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const location = useLocation()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const origin = readReleaseOrigin(location.state, context.workspaceId, selection.releaseId)
  const release = selection.release

  useEffect(() => headingRef.current?.focus(), [])

  return (
    <article className={styles.full} data-release-full-id={release.id}>
      <header className={styles.fullHeader}>
        <Link className={styles.back} to={releaseOriginHref(origin)}>
          Back to overview
        </Link>
        <div className={styles.fullIdentity}>
          <ReleaseRelay
            algorithm={release.relay.algorithm}
            codename={release.relay.codename}
            size="hero"
            symbolIndices={release.relay.symbolIndices}
          />
          {release.source.freshnessDateTime === null || release.source.freshnessTime === null ? (
            <FreshnessStamp state={release.source.freshness} />
          ) : (
            <FreshnessStamp
              dateTime={release.source.freshnessDateTime}
              state={release.source.freshness}
              time={release.source.freshnessTime}
            />
          )}
        </div>
        <div className={styles.fullTitle}>
          <Text as="h1" id="release-title" ref={headingRef} tabIndex={-1} variant="verdict">
            {release.serviceName}
          </Text>
          <Text as="code" tone="secondary" variant="code">
            {release.version}
          </Text>
        </div>
        <Verdict reason={release.readinessReason} tone="neutral" verdict="Readiness not evaluated" />
        <ReleaseAction />
      </header>

      <StageRail heading="Build, verify, production" stages={release.stages} />
      <section aria-labelledby="release-people" className={styles.section}>
        <Text as="h2" id="release-people" variant="section-title">
          People
        </Text>
        <CompleteCollaborators release={release} />
      </section>
      <section aria-labelledby="release-work" className={styles.section}>
        <Text as="h2" id="release-work" variant="section-title">
          Delivery relationships
        </Text>
        <MissingRelationships />
      </section>
      <section aria-labelledby="release-evidence" className={styles.section}>
        <Text as="h2" id="release-evidence" variant="section-title">
          Evidence
        </Text>
        <ReleaseEvidence release={release} />
      </section>
      <section aria-labelledby="release-agent" className={styles.section}>
        <Text as="h2" id="release-agent" variant="section-title">
          Release agent
        </Text>
        <ReleaseAgentEntry release={release} />
      </section>
    </article>
  )
}

/** Render an exact release at its canonical full route without selecting a fallback entity. */
export const ReleaseFullRoute = (): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const params = useParams()
  if (context.controller.state._tag !== "ready") return <ReleaseRouteLoading context={context} />
  const selection = selectRelease(context, params.releaseId)
  return selection === null ? (
    <ReleaseNotFound workspaceId={context.workspaceId} />
  ) : (
    <FullRelease selection={selection} />
  )
}
