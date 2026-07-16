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
import { Link, useLocation, useNavigate, useOutletContext, useParams, useViewTransitionState } from "react-router"

import { PortfolioOverviewView } from "../portfolio/PortfolioOverview.js"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import type { WorkspaceReleaseOutletContext } from "./WorkspaceReleaseLayout.js"
import {
  decodeReleaseRouteId,
  readReleaseOrigin,
  releaseActiveWorkPath,
  releaseAgentPath,
  resolveReleaseOrigin,
  releaseFullPath,
  releaseOriginHref,
  releaseParentPath,
  releasePreviewPath,
  releaseTransitionNames
} from "./releaseRoutes.js"
import styles from "./ReleaseRoute.module.css"
import { useCompactReleasePreview, usePrefersReducedReleaseMotion } from "./useCompactReleasePreview.js"
import { RelationshipRepairPanel } from "./RelationshipRepairPanel.js"
import { ReleaseWorkset } from "./ReleaseWorkset.js"

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

const ReleaseNotFound = ({ workspaceId }: Pick<WorkspaceReleaseOutletContext, "workspaceId">): ReactElement => {
  const stateRef = useRef<HTMLElement>(null)
  useEffect(() => stateRef.current?.focus(), [])
  return (
    <section className={styles.state} data-release-not-found="" ref={stateRef} tabIndex={-1}>
      <StatePanel
        action={<Link to={releaseParentPath(workspaceId)}>Return to workspace overview</Link>}
        description="This release does not exist in the current workspace snapshot. It may have been removed or the address may be incorrect."
        title="Release not found"
      />
    </section>
  )
}

const ReleaseRouteLoading = ({ context }: { readonly context: WorkspaceReleaseOutletContext }): ReactElement => {
  const stateRef = useRef<HTMLDivElement>(null)
  useEffect(() => stateRef.current?.querySelector<HTMLElement>("#portfolio-title")?.focus(), [])
  return (
    <div ref={stateRef}>
      <PortfolioOverviewView
        onPreviewRelease={() => undefined}
        onRetry={context.controller.onRetry}
        state={context.controller.state}
      />
    </div>
  )
}

export const ReleaseAction = ({ release }: { readonly release: PortfolioReleasePresentation }): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const location = useLocation()
  const action = (() => {
    switch (release.readinessVerdict) {
      case "blocked":
        return { label: "Review blocker", to: releaseActiveWorkPath(context.workspaceId, release.id) }
      case "held":
        return { label: "Repair missing links", to: `${releaseFullPath(context.workspaceId, release.id)}#release-work` }
      case "ready":
        return {
          label: "Review ship evidence",
          to: `${releaseFullPath(context.workspaceId, release.id)}#release-evidence`
        }
      case "deploying":
        return { label: "Open deployment", to: `${releaseFullPath(context.workspaceId, release.id)}#release-work` }
      case "building":
        return { label: "Open build", to: `${releaseFullPath(context.workspaceId, release.id)}#release-work` }
      case "shipped":
        return {
          label: "View release record",
          to: `${releaseFullPath(context.workspaceId, release.id)}#release-evidence`
        }
      case "unknown":
        return null
    }
  })()
  return action === null ? (
    <Button disabled size="principal" stretch variant="primary">
      Readiness evidence required
    </Button>
  ) : (
    <Link className={styles.releaseAction} state={location.state} to={action.to}>
      {action.label}
    </Link>
  )
}

export const ReleaseEvidence = ({ release }: { readonly release: PortfolioReleasePresentation }): ReactElement => (
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

export const ReleaseAgentEntry = ({ release }: { readonly release: PortfolioReleasePresentation }): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const navigate = useNavigate()
  const prefersReducedMotion = usePrefersReducedReleaseMotion()
  return (
    <AgentContextButton
      actionLabel="Ask about this release"
      agentName="Relay"
      context={releaseContextLabel(release)}
      onClick={() =>
        navigate(releaseAgentPath(context.workspaceId, release.id), { viewTransition: !prefersReducedMotion })
      }
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

type PreviewExit = "origin" | null

const ReleasePreviewContent = ({ selection }: { readonly selection: ReleaseRouteSelection }): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const isCompact = useCompactReleasePreview()
  const prefersReducedMotion = usePrefersReducedReleaseMotion()
  const location = useLocation()
  const navigate = useNavigate()
  const [exit, setExit] = useState<PreviewExit>(null)
  const [isOpen, setIsOpen] = useState(true)
  const resolvedOrigin = resolveReleaseOrigin(location.state, context.workspaceId, selection.releaseId)
  const originHref = releaseOriginHref(resolvedOrigin.origin)
  const fullPath = releaseFullPath(context.workspaceId, selection.releaseId)
  const agentPath = releaseAgentPath(context.workspaceId, selection.releaseId)
  const previewPath = releasePreviewPath(context.workspaceId, selection.releaseId)
  const isPreviewTransitioning = useViewTransitionState(previewPath)
  const isFullTransitioning = useViewTransitionState(fullPath)
  const isAgentTransitioning = useViewTransitionState(agentPath)
  const transitionNames =
    isPreviewTransitioning || isFullTransitioning || isAgentTransitioning
      ? releaseTransitionNames(selection.releaseId)
      : undefined

  useEffect(() => {
    if (isOpen || exit === null) return
    if (resolvedOrigin.isStored) navigate(-1)
    else navigate(originHref, { replace: true })
  }, [context.workspaceId, exit, isOpen, navigate, originHref, resolvedOrigin.isStored, selection.releaseId])

  const requestOrigin = (): void => {
    context.requestReleaseFocus(selection.releaseId)
    setExit("origin")
    setIsOpen(false)
  }

  return (
    <ReleasePreview
      agentEntry={<ReleaseAgentEntry release={selection.release} />}
      collaborators={<CompleteCollaborators release={selection.release} />}
      entryMotion={resolvedOrigin.isStored ? "external" : "intrinsic"}
      evidence={<ReleaseEvidence release={selection.release} />}
      onOpenChange={(open) => {
        if (!open) requestOrigin()
      }}
      onOpenFullView={() => navigate(fullPath, { state: location.state, viewTransition: !prefersReducedMotion })}
      open={isOpen}
      openFullViewLabel={`Open ${selection.release.relay.codename} full view`}
      presentation={isCompact ? "sheet" : "dialog"}
      primaryAction={<ReleaseAction release={selection.release} />}
      release={selection.release.release}
      stages={<StageRail heading="Release stages" stages={selection.release.stages} />}
      {...(transitionNames === undefined ? {} : { transitionNames })}
      workset={
        <div className={styles.previewDetails}>
          <ReleaseWorkset release={selection.release} workspaceId={context.workspaceId} />
        </div>
      }
    />
  )
}

/** Render the canonical release preview over its still-mounted workspace origin. */
export const ReleasePreviewRoute = (): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const params = useParams()
  if (context.controller.state._tag !== "ready") return <ReleaseRouteLoading context={context} />
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
  const fullPath = releaseFullPath(context.workspaceId, selection.releaseId)
  const agentPath = releaseAgentPath(context.workspaceId, selection.releaseId)
  const isFullTransitioning = useViewTransitionState(fullPath)
  const isAgentTransitioning = useViewTransitionState(agentPath)
  const transitionNames =
    isFullTransitioning || isAgentTransitioning ? releaseTransitionNames(selection.releaseId) : undefined

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
            data-rly-release-transition-name={transitionNames?.relay}
            data-rly-release-transition-part="relay"
            size="hero"
            style={transitionNames === undefined ? undefined : { viewTransitionName: transitionNames.relay }}
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
          <Text
            as="code"
            data-rly-release-transition-name={transitionNames?.version}
            data-rly-release-transition-part="version"
            style={transitionNames === undefined ? undefined : { viewTransitionName: transitionNames.version }}
            tone="secondary"
            variant="code"
          >
            {release.version}
          </Text>
        </div>
        <Verdict
          data-rly-release-transition-name={transitionNames?.verdict}
          data-rly-release-transition-part="verdict"
          reason={release.readinessReason}
          style={transitionNames === undefined ? undefined : { viewTransitionName: transitionNames.verdict }}
          tone={release.release.tone}
          verdict={release.release.verdict}
        />
        <ReleaseAction release={release} />
      </header>

      <StageRail heading="Build, verify, production" stages={release.stages} />
      <section aria-labelledby="release-people" className={styles.section}>
        <Text as="h2" id="release-people" variant="section-title">
          People
        </Text>
        <CompleteCollaborators release={release} />
      </section>
      <section aria-labelledby="release-work-title" className={styles.section} id="release-work">
        <Text as="h2" id="release-work-title" variant="section-title">
          Delivery relationships
        </Text>
        <ReleaseWorkset release={release} workspaceId={context.workspaceId} />
        <RelationshipRepairPanel release={release} />
      </section>
      <section aria-labelledby="release-evidence-title" className={styles.section} id="release-evidence">
        <Text as="h2" id="release-evidence-title" variant="section-title">
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
