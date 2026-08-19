import { LinkProvider } from "@knpkv/rly/foundations"
import {
  AgentContextButton,
  CollaboratorGroup,
  EntityShell,
  EvidenceStamp,
  RelationshipChain,
  RelationshipTable,
  ServiceMark,
  TimelineRow,
  type RlyCollaboratorCategory
} from "@knpkv/rly/patterns"
import { Button, Skeleton, StatePanel, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import { type ReactElement, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router"

import type { DurableAgentPrompt } from "../../api/agent.js"
import type { SubmitClockifyActionRequest } from "../../api/deliveryGraph.js"
import type { EntityId as EntityIdType, WorkspaceId as WorkspaceIdType } from "../../domain/identifiers.js"
import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import {
  decodeEntityRouteId,
  resolveWorkspaceEntityOrigin,
  type WorkspaceEntityOrigin,
  workspaceEntityAgentPath,
  workspaceEntityOriginHref,
  workspaceEntityParentPath
} from "../items/workspaceEntityRoutes.js"
import type { WorkspaceReleaseOutletContext } from "../releases/WorkspaceReleaseLayout.js"
import { presentWorkspaceEntity, type WorkspaceEntityPresentation } from "./presentWorkspaceEntity.js"
import { WorkspaceEntityLink } from "./WorkspaceEntityLink.js"
import styles from "./WorkspaceEntityRoute.module.css"
import { WorkspaceClockifyTimeEntryDetails } from "./WorkspaceClockifyTimeEntryDetails.js"
import { type ClockifyActionSubmissionState, useClockifyActionSubmission } from "./useClockifyActionSubmission.js"
import {
  type OpenConfluenceSynchronizationState,
  useOpenConfluenceSynchronization
} from "./useOpenConfluenceSynchronization.js"
import { WorkspaceConfluencePageDetails } from "./WorkspaceConfluencePageDetails.js"
import type { WorkspaceConfluenceVisualEditorProps } from "./WorkspaceConfluenceVisualEditor.js"
import { WorkspaceIssueDetails } from "./WorkspaceIssueDetails.js"
import { WorkspacePipelineExecutionDetails } from "./WorkspacePipelineExecutionDetails.js"
import {
  usePullRequestReview,
  type PullRequestReviewControllerState,
  type PullRequestReviewPublicationState,
  type ReviewSuggestionPublicationTarget,
  type ReviewSuggestionTarget
} from "./usePullRequestReview.js"
import type { ReviewSuggestionRevisionTransport } from "./useReviewSuggestionRevisions.js"
import { browserWorkspaceEntityTransport, useWorkspaceEntity, type WorkspaceEntityState } from "./useWorkspaceEntity.js"

const WorkspacePullRequestDetails = lazy(() =>
  import("./WorkspacePullRequestDetails.js").then((module) => ({
    default: module.WorkspacePullRequestDetails
  }))
)

const originLabel = (href: string, workspaceId: WorkspaceIdType): string => {
  const pathname = href.split(/[?#]/u, 1)[0] ?? ""
  if (pathname === workspaceEntityParentPath(workspaceId)) return "Back to items"
  if (pathname.includes("/releases/")) return "Back to release"
  if (pathname.endsWith("/work")) return "Back to active work"
  if (pathname.endsWith("/timeline")) return "Back to timeline"
  return "Back to workspace"
}

const RouteState = ({
  action,
  description,
  title,
  tone = "neutral"
}: {
  readonly action?: ReactElement
  readonly description: string
  readonly title: string
  readonly tone?: "critical" | "neutral" | "progress"
}): ReactElement => {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <section className={styles.state} data-workspace-entity-state={tone} ref={ref} tabIndex={-1}>
      <StatePanel action={action} description={description} title={title} tone={tone} />
    </section>
  )
}

const LoadingEntity = (): ReactElement => (
  <section aria-label="Loading canonical entity" className={styles.loading}>
    <Skeleton decorative={false} height="12rem" label="Loading canonical entity" variant="block" />
    <div className={styles.loadingColumns}>
      <Skeleton height="20rem" variant="block" />
      <Skeleton height="20rem" variant="block" />
    </div>
  </section>
)

const PrincipalAction = ({
  action
}: {
  readonly action: WorkspaceEntityPresentation["primaryAction"]
}): ReactElement => {
  if (action.href === null) {
    return (
      <Button disabled size="principal" stretch variant="primary">
        {action.label}
      </Button>
    )
  }
  return action.external ? (
    <a className={styles.principalAction} href={action.href} rel="noreferrer" target="_blank">
      {action.label}
    </a>
  ) : (
    <Link className={styles.principalAction} to={action.href}>
      {action.label}
    </Link>
  )
}

/** Derive Confluence's authenticated editor only from one canonical same-page source link. */
export const confluenceEditHref = (sourceHref: string | null, pageId: string): string | null => {
  if (sourceHref === null) return null
  const source = URL.parse(sourceHref)
  if (source === null || source.protocol !== "https:") return null
  const match = /^\/wiki\/spaces\/([^/]+)\/pages\/([^/]+)(?:\/|$)/u.exec(source.pathname)
  if (match?.[1] === undefined || match[2] !== encodeURIComponent(pageId)) return null
  source.pathname = `/wiki/spaces/${match[1]}/pages/edit-v2/${encodeURIComponent(pageId)}`
  source.search = ""
  source.hash = ""
  return source.href
}

const EntityActions = ({
  onConfluenceSynchronize,
  presentation,
  synchronizationState
}: {
  readonly onConfluenceSynchronize: () => void
  readonly presentation: WorkspaceEntityPresentation
  readonly synchronizationState: OpenConfluenceSynchronizationState | null
}): ReactElement => {
  const editHref =
    presentation.confluencePage === null
      ? null
      : confluenceEditHref(presentation.primaryAction.href, presentation.displayKey)
  return (
    <div className={styles.entityActions}>
      <PrincipalAction action={presentation.primaryAction} />
      {editHref === null ? null : (
        <a className={styles.secondaryAction} href={editHref} rel="noreferrer" target="_blank">
          Edit in Confluence
        </a>
      )}
      {presentation.confluencePage === null || synchronizationState === null ? null : (
        <div className={styles.pageSynchronization}>
          <Button
            disabled={synchronizationState === "syncing"}
            loading={synchronizationState === "syncing"}
            onClick={onConfluenceSynchronize}
            variant="secondary"
          >
            Sync now
          </Button>
          <Text tone="secondary" variant="meta">
            {synchronizationState === "failed"
              ? "Sync failed. Try again."
              : synchronizationState === "synchronized"
                ? "Up to date · live sync every 15 seconds while visible"
                : "Live sync every 15 seconds while visible"}
          </Text>
        </div>
      )}
    </div>
  )
}

const DeliveryPath = ({ presentation }: { readonly presentation: WorkspaceEntityPresentation }): ReactElement => (
  <section aria-labelledby="workspace-entity-path" className={styles.deliveryPath}>
    <div className={styles.sectionHeading}>
      <Text as="h2" id="workspace-entity-path" variant="section-title">
        Delivery path
      </Text>
      <Text tone="secondary" variant="meta">
        Where this work lives
      </Text>
    </div>
    <div className={styles.pathRail}>
      <div className={styles.pathNode}>
        <ServiceMark service={presentation.service} size="compact" />
        <span>
          <strong>{presentation.serviceName}</strong>
          <code>{presentation.displayKey}</code>
        </span>
      </div>
      {presentation.releases.length === 0 ? (
        <div className={styles.pathEmpty}>No release membership yet</div>
      ) : (
        <ol className={styles.releasePath}>
          {presentation.releases.map((release) => (
            <li key={release.id}>
              <Link to={release.href}>{release.label}</Link>
            </li>
          ))}
        </ol>
      )}
    </div>
    <Text tone="secondary">{presentation.contentSummary}</Text>
  </section>
)

const EntityFacts = ({ presentation }: { readonly presentation: WorkspaceEntityPresentation }): ReactElement => (
  <section aria-labelledby="workspace-entity-facts" className={styles.facts}>
    <Text as="h2" id="workspace-entity-facts" variant="card-title">
      At a glance
    </Text>
    <dl>
      {presentation.facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  </section>
)

const EntityEvidence = ({ presentation }: { readonly presentation: WorkspaceEntityPresentation }): ReactElement => (
  <section aria-labelledby="workspace-entity-evidence" className={styles.evidence}>
    <Text as="h2" id="workspace-entity-evidence" variant="card-title">
      Provenance
    </Text>
    <EvidenceStamp
      freshness={presentation.evidence.freshness}
      freshnessDateTime={presentation.evidence.freshnessDateTime}
      freshnessTime={presentation.evidence.freshnessTime}
      reference={presentation.evidence.reference}
      service={presentation.service}
    />
    <Text tone="secondary" variant="meta">
      {presentation.evidence.itemCount} evidence item{presentation.evidence.itemCount === 1 ? "" : "s"} ·{" "}
      {presentation.evidence.claimCount} claim{presentation.evidence.claimCount === 1 ? "" : "s"}
    </Text>
  </section>
)

const EntityCollaborators = ({
  presentation
}: {
  readonly presentation: WorkspaceEntityPresentation
}): ReactElement => {
  const [expanded, setExpanded] = useState<ReadonlyArray<RlyCollaboratorCategory>>(
    presentation.collaborators.expandedCategories
  )
  return (
    <div className={styles.workingCircle}>
      <CollaboratorGroup
        approvers={presentation.collaborators.approvers}
        authors={presentation.collaborators.authors}
        emptyLabel={presentation.collaborators.emptyLabel}
        expandedCategories={expanded}
        heading="Working circle"
        limit={3}
        onCategoryExpandedChange={(category, nextExpanded) => {
          setExpanded((current) =>
            nextExpanded ? [...new Set([...current, category])] : current.filter((candidate) => candidate !== category)
          )
        }}
        operators={presentation.collaborators.operators}
        owners={presentation.collaborators.owners}
        reviewers={presentation.collaborators.reviewers}
        size="compact"
      />
    </div>
  )
}

const EntityRelationships = ({ presentation }: { readonly presentation: WorkspaceEntityPresentation }): ReactElement =>
  presentation.relationships.length <= 4 ? (
    <RelationshipChain
      emptyLabel={presentation.relationshipEmptyLabel}
      heading="Delivery relationships"
      relationships={presentation.relationships}
    />
  ) : (
    <RelationshipTable
      emptyLabel={presentation.relationshipEmptyLabel}
      heading="Delivery relationships"
      relationships={presentation.relationships}
    />
  )

const EntityActivity = ({ presentation }: { readonly presentation: WorkspaceEntityPresentation }): ReactElement => (
  <section aria-labelledby="workspace-entity-activity" className={styles.activity}>
    <div className={styles.sectionHeading}>
      <Text as="h2" id="workspace-entity-activity" variant="section-title">
        Activity
      </Text>
      <Text tone="secondary" variant="meta">
        Quiet, attributable history
      </Text>
    </div>
    {presentation.activity.length === 0 ? (
      <Text tone="secondary">{presentation.activityEmptyLabel}</Text>
    ) : (
      <ol className={styles.timeline}>
        {presentation.activity.map((event, index) => (
          <TimelineRow continued={index < presentation.activity.length - 1} event={event} key={event.id} />
        ))}
      </ol>
    )}
  </section>
)

const staleMessage = (state: Extract<WorkspaceEntityState, { readonly _tag: "stale" }>): string => {
  switch (state.reason) {
    case "refreshing":
      return "Refreshing from the connected service. The last complete inspection remains visible."
    case "refresh-failed":
      return "The latest refresh failed. The last complete inspection remains visible and may be out of date."
    case "source-stale":
      return "The connected service reported stale source data. Confirm current state before acting."
  }
}

const EntityContent = ({
  clockifyActionCanApprove,
  clockifyActionCanCorrect,
  clockifyActionState,
  clockifyActionSubmit,
  confluenceEditor,
  onSessionExpired,
  presentation,
  retry,
  reviewCanEnqueue,
  reviewCancel,
  reviewExtendBudget,
  reviewLoadEarlier,
  reviewPublication,
  reviewPublicationCancel,
  reviewPublicationPreview,
  reviewRetry,
  reviewStart,
  reviewState,
  reviewSuggestionPublish,
  reviewSuggestionRevisionTransport,
  reviewTargetSuggestion,
  sessionKey,
  stale
}: {
  readonly clockifyActionCanApprove: boolean
  readonly clockifyActionCanCorrect: boolean
  readonly clockifyActionState: ClockifyActionSubmissionState
  readonly clockifyActionSubmit: (request: SubmitClockifyActionRequest) => void
  readonly confluenceEditor: Omit<WorkspaceConfluenceVisualEditorProps, "page">
  readonly onSessionExpired: (sessionKey: string) => void
  readonly presentation: WorkspaceEntityPresentation
  readonly reviewCanEnqueue: boolean
  readonly reviewCancel: () => void
  readonly reviewExtendBudget: () => void
  readonly reviewPublication: PullRequestReviewPublicationState
  readonly reviewPublicationCancel: () => void
  readonly reviewLoadEarlier: () => void
  readonly reviewPublicationPreview: (selection: ReviewSuggestionPublicationTarget) => void
  readonly reviewRetry: () => void
  readonly reviewSuggestionRevisionTransport?: ReviewSuggestionRevisionTransport
  readonly reviewSuggestionPublish: (finalContent: string) => void
  readonly reviewTargetSuggestion: (target: ReviewSuggestionTarget) => void
  readonly reviewStart: (prompt?: DurableAgentPrompt) => void
  readonly reviewState: PullRequestReviewControllerState
  readonly retry: () => void
  readonly sessionKey: string | null
  readonly stale: Extract<WorkspaceEntityState, { readonly _tag: "stale" }> | null
}): ReactElement => (
  <div className={styles.content}>
    {stale === null ? null : (
      <StatePanel
        action={stale.reason === "refreshing" ? undefined : <Button onClick={retry}>Retry refresh</Button>}
        announce={stale.reason === "refresh-failed" ? "polite" : "off"}
        description={staleMessage(stale)}
        title={stale.reason === "refreshing" ? "Refreshing source" : "Showing retained source data"}
        tone="caution"
      />
    )}
    {presentation.partialMessages.map((message) => (
      <StatePanel description={message} key={message} title="Partial canonical view" tone="caution" />
    ))}
    {presentation.clockifyTimeEntry === null ? null : (
      <WorkspaceClockifyTimeEntryDetails
        canApprove={clockifyActionCanApprove}
        canCorrect={clockifyActionCanCorrect}
        onSubmit={clockifyActionSubmit}
        submission={clockifyActionState}
        timeEntry={presentation.clockifyTimeEntry}
      />
    )}
    {presentation.issue === null ? null : <WorkspaceIssueDetails issue={presentation.issue} />}
    {presentation.confluencePage === null ? null : (
      <WorkspaceConfluencePageDetails editor={confluenceEditor} page={presentation.confluencePage} />
    )}
    {presentation.pipelineExecution === null ? null : (
      <WorkspacePipelineExecutionDetails pipeline={presentation.pipelineExecution} />
    )}
    {presentation.pullRequest === null ? null : (
      <Suspense fallback={<Skeleton decorative={false} height="20rem" label="Loading pull request" variant="block" />}>
        <WorkspacePullRequestDetails
          approvers={presentation.collaborators.approvers}
          onSessionExpired={onSessionExpired}
          onReviewCancel={reviewCancel}
          onReviewExtendBudget={reviewExtendBudget}
          onReviewLoadEarlier={reviewLoadEarlier}
          onReviewPublicationCancel={reviewPublicationCancel}
          onReviewPublicationPreview={reviewPublicationPreview}
          onReviewRetry={reviewRetry}
          onReviewSuggestionPublish={reviewSuggestionPublish}
          onReviewTargetSuggestion={reviewTargetSuggestion}
          onReviewStart={reviewStart}
          pullRequest={presentation.pullRequest}
          reviewCanEnqueue={reviewCanEnqueue}
          reviewPublication={reviewPublication}
          {...(reviewSuggestionRevisionTransport === undefined ? {} : { reviewSuggestionRevisionTransport })}
          reviewState={reviewState}
          reviewers={presentation.collaborators.reviewers}
          sessionKey={sessionKey}
        />
      </Suspense>
    )}
    <DeliveryPath presentation={presentation} />
  </div>
)

interface WorkspaceEntityViewProps {
  readonly clockifyActionCanApprove?: boolean
  readonly clockifyActionCanCorrect?: boolean
  readonly clockifyActionState?: ClockifyActionSubmissionState
  readonly clockifyActionSubmit?: (request: SubmitClockifyActionRequest) => void
  readonly confluenceCanEdit?: boolean
  readonly confluenceSynchronizationState?: OpenConfluenceSynchronizationState | null
  readonly onConfluenceSaved?: () => void
  readonly onConfluenceSynchronize?: () => void
  readonly onAskAgent: () => void
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly originHref: string
  readonly originLabel: string
  readonly originState: WorkspaceEntityOrigin["state"]
  readonly retry: () => void
  readonly reviewCanEnqueue?: boolean
  readonly reviewCancel?: () => void
  readonly reviewExtendBudget?: () => void
  readonly reviewLoadEarlier?: () => void
  readonly reviewPublication?: PullRequestReviewPublicationState
  readonly reviewPublicationCancel?: () => void
  readonly reviewPublicationPreview?: (selection: ReviewSuggestionPublicationTarget) => void
  readonly reviewRetry?: () => void
  readonly reviewSuggestionRevisionTransport?: ReviewSuggestionRevisionTransport
  readonly reviewSuggestionPublish?: (finalContent: string) => void
  readonly reviewTargetSuggestion?: (target: ReviewSuggestionTarget) => void
  readonly reviewStart?: (prompt?: DurableAgentPrompt) => void
  readonly reviewState?: PullRequestReviewControllerState
  readonly state: WorkspaceEntityState
  readonly sessionKey?: string | null
  readonly workspaceId: WorkspaceIdType
}

const ignoreSessionExpiration = (_sessionKey: string): void => undefined
const ignoreAction = (): void => undefined

/** Pure state renderer for the canonical entity route. */
export const WorkspaceEntityView = ({
  clockifyActionCanApprove = false,
  clockifyActionCanCorrect = false,
  clockifyActionState = { _tag: "idle" },
  clockifyActionSubmit = ignoreAction,
  confluenceCanEdit = false,
  confluenceSynchronizationState = null,
  onAskAgent,
  onConfluenceSaved,
  onConfluenceSynchronize = ignoreAction,
  onSessionExpired = ignoreSessionExpiration,
  originHref,
  originLabel: backLabel,
  originState,
  retry,
  reviewCanEnqueue = false,
  reviewCancel = ignoreAction,
  reviewExtendBudget = ignoreAction,
  reviewLoadEarlier = ignoreAction,
  reviewPublication = { _tag: "idle" },
  reviewPublicationCancel = ignoreAction,
  reviewPublicationPreview = ignoreAction,
  reviewRetry = ignoreAction,
  reviewStart = ignoreAction,
  reviewState = { _tag: "idle" },
  reviewSuggestionPublish = ignoreAction,
  reviewSuggestionRevisionTransport,
  reviewTargetSuggestion = ignoreAction,
  sessionKey = null,
  state,
  workspaceId
}: WorkspaceEntityViewProps): ReactElement => {
  const focusRef = useRef<HTMLElement>(null)
  const visibleEntityId =
    state._tag === "ready" || state._tag === "stale" ? state.inspection.entity.projection.entityId : state._tag
  useEffect(() => focusRef.current?.focus(), [visibleEntityId])

  if (state._tag === "idle") {
    return (
      <RouteState
        action={
          <Link state={originState} to={originHref}>
            {backLabel}
          </Link>
        }
        description="A readable workspace session is required before this object can be loaded."
        title="Entity unavailable"
      />
    )
  }
  if (state._tag === "loading") return <LoadingEntity />
  if (state._tag === "not-found") {
    return (
      <RouteState
        action={
          <Link state={originState} to={originHref}>
            {backLabel}
          </Link>
        }
        description="This object is not in this workspace. It may have been deleted, disconnected, or the address may be wrong."
        title="Object not found"
      />
    )
  }
  if (state._tag === "failed") {
    return (
      <RouteState
        action={<Button onClick={retry}>Retry entity</Button>}
        description="The canonical object could not be loaded. Your current workspace location is preserved."
        title="Could not load object"
        tone="critical"
      />
    )
  }

  const presentation = presentWorkspaceEntity(workspaceId, state.inspection)
  const clockifyActionsCurrent =
    state._tag === "ready" && state.inspection.isSourceCurrent && state.inspection.sourceActionsAvailable
  const afterConfluenceSave = onConfluenceSaved ?? retry
  return (
    <LinkProvider component={WorkspaceEntityLink}>
      <EntityShell
        actions={
          <EntityActions
            onConfluenceSynchronize={onConfluenceSynchronize}
            presentation={presentation}
            synchronizationState={confluenceSynchronizationState}
          />
        }
        activity={<EntityActivity presentation={presentation} />}
        agentEntry={
          <AgentContextButton
            actionLabel={presentation.confluencePage === null ? "Ask about this object" : "Draft with Relay"}
            agentName="Relay"
            context={presentation.agentContext}
            onClick={onAskAgent}
          />
        }
        collaborators={
          <EntityCollaborators key={state.inspection.entity.projection.entityId} presentation={presentation} />
        }
        className={styles.shell}
        content={
          <EntityContent
            clockifyActionCanApprove={clockifyActionsCurrent && clockifyActionCanApprove}
            clockifyActionCanCorrect={clockifyActionsCurrent && clockifyActionCanCorrect}
            clockifyActionState={clockifyActionState}
            clockifyActionSubmit={clockifyActionSubmit}
            confluenceEditor={{
              canEdit:
                confluenceCanEdit &&
                state._tag === "ready" &&
                state.inspection.isSourceCurrent &&
                state.inspection.sourceActionsAvailable,
              entityId: state.inspection.entity.projection.entityId,
              onAskAgent,
              onSaved: afterConfluenceSave,
              releaseId: state.inspection.entity.canonicalReleaseId,
              title: presentation.title
            }}
            onSessionExpired={onSessionExpired}
            presentation={presentation}
            reviewCanEnqueue={reviewCanEnqueue}
            reviewCancel={reviewCancel}
            reviewExtendBudget={reviewExtendBudget}
            reviewPublication={reviewPublication}
            reviewPublicationCancel={reviewPublicationCancel}
            reviewLoadEarlier={reviewLoadEarlier}
            reviewPublicationPreview={reviewPublicationPreview}
            reviewRetry={reviewRetry}
            {...(reviewSuggestionRevisionTransport === undefined ? {} : { reviewSuggestionRevisionTransport })}
            reviewSuggestionPublish={reviewSuggestionPublish}
            reviewTargetSuggestion={reviewTargetSuggestion}
            reviewStart={reviewStart}
            reviewState={reviewState}
            retry={retry}
            sessionKey={sessionKey}
            stale={state._tag === "stale" ? state : null}
          />
        }
        data-service={presentation.service}
        data-workspace-entity-id={state.inspection.entity.projection.entityId}
        evidence={<EntityEvidence presentation={presentation} />}
        facts={<EntityFacts presentation={presentation} />}
        freshness={presentation.freshness}
        freshnessDateTime={presentation.freshnessDateTime}
        freshnessTime={presentation.freshnessTime}
        navigation={
          <Link className={styles.back} state={originState} to={originHref}>
            {backLabel}
          </Link>
        }
        reason={`${presentation.displayKey} is ${presentation.verdict.toLocaleLowerCase("en-US")} in ${presentation.serviceName}.`}
        ref={focusRef}
        relationships={<EntityRelationships presentation={presentation} />}
        service={presentation.service}
        tabIndex={-1}
        title={presentation.title}
        tone={presentation.tone}
        verdict={presentation.verdict}
      />
    </LinkProvider>
  )
}

const ConnectedWorkspaceEntity = ({
  entityId,
  workspaceId
}: {
  readonly entityId: EntityIdType
  readonly workspaceId: WorkspaceIdType
}): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const browserSession = useBrowserSession()
  const location = useLocation()
  const navigate = useNavigate()
  const refreshKey =
    context.controller.state._tag === "ready" ? context.controller.state.portfolio.generatedAt : "pending"
  const sessionKey = browserReadableSessionKey(browserSession.state)
  const controller = useWorkspaceEntity(workspaceId, entityId, refreshKey, sessionKey, browserSession.invalidateSession)
  const confluencePluginConnectionId =
    (controller.state._tag === "ready" || controller.state._tag === "stale") &&
    controller.state.inspection.entity.projection.details._tag === "page"
      ? controller.state.inspection.source.pluginConnectionId
      : null
  const canSynchronizeConfluence =
    confluencePluginConnectionId !== null &&
    (controller.state._tag === "ready" || controller.state._tag === "stale") &&
    controller.state.inspection.sourceSynchronizationAvailable &&
    browserSession.state._tag === "authenticated" &&
    browserSession.state.session.permission === "workspace-owner"
  const confluenceSynchronizedAt =
    confluencePluginConnectionId !== null && (controller.state._tag === "ready" || controller.state._tag === "stale")
      ? DateTime.toEpochMillis(controller.state.inspection.source.synchronizedAt)
      : null
  const readConfluenceSynchronizationRevision = useCallback(
    async (signal: AbortSignal): Promise<number | null> => {
      if (confluencePluginConnectionId === null) return null
      const current = await browserWorkspaceEntityTransport.load(entityId, signal)
      return current.entity.projection.entityId === entityId &&
        current.source.pluginConnectionId === confluencePluginConnectionId
        ? DateTime.toEpochMillis(current.source.synchronizedAt)
        : null
    },
    [confluencePluginConnectionId, entityId]
  )
  const confluenceSynchronization = useOpenConfluenceSynchronization({
    enabled: canSynchronizeConfluence,
    onSessionExpired: browserSession.invalidateSession,
    onSynchronized: controller.retry,
    pluginConnectionId: confluencePluginConnectionId,
    readSynchronizationRevision: readConfluenceSynchronizationRevision,
    sessionKey,
    synchronizationRevision: confluenceSynchronizedAt
  })
  const clockifyActions = useClockifyActionSubmission(
    entityId,
    sessionKey,
    browserSession.invalidateSession,
    controller.retry
  )
  const reviewCanEnqueue =
    browserSession.state._tag === "authenticated" && browserSession.state.session.permission === "workspace-owner"
  const reviewSubject =
    (controller.state._tag === "ready" || controller.state._tag === "stale") &&
    controller.state.inspection.entity.projection.details._tag === "pull-request"
      ? {
          baseRevision: controller.state.inspection.entity.projection.details.baseRevision ?? null,
          headRevision: controller.state.inspection.entity.projection.details.headRevision
        }
      : null
  const reviewController = usePullRequestReview(
    entityId,
    reviewSubject?.baseRevision ?? null,
    reviewSubject?.headRevision ?? null,
    sessionKey,
    reviewCanEnqueue,
    browserSession.invalidateSession
  )
  const resolvedOrigin = resolveWorkspaceEntityOrigin(location.state, workspaceId, entityId)
  const resolvedOriginHref = workspaceEntityOriginHref(resolvedOrigin.origin)
  const releaseContext =
    controller.state._tag === "ready" || controller.state._tag === "stale"
      ? controller.state.inspection.entity
      : { canonicalReleaseId: null, releaseIds: [], releaseMembershipsTruncated: false }
  const routableReleaseIds = new Set(
    context.controller.state._tag === "ready" ? context.controller.state.portfolio.releases.map(({ id }) => id) : []
  )
  const agentPath = workspaceEntityAgentPath(
    resolvedOrigin.origin,
    workspaceId,
    location,
    releaseContext,
    routableReleaseIds
  )
  return (
    <WorkspaceEntityView
      clockifyActionCanApprove={
        browserSession.state._tag === "authenticated" &&
        (browserSession.state.session.permission === "workspace-owner" ||
          browserSession.state.session.permission === "workspace-approver")
      }
      clockifyActionCanCorrect={
        browserSession.state._tag === "authenticated" && browserSession.state.session.permission === "workspace-owner"
      }
      clockifyActionState={clockifyActions.state}
      clockifyActionSubmit={clockifyActions.submit}
      confluenceCanEdit={
        browserSession.state._tag === "authenticated" && browserSession.state.session.permission === "workspace-owner"
      }
      confluenceSynchronizationState={canSynchronizeConfluence ? confluenceSynchronization.state : null}
      onAskAgent={() => navigate(agentPath, { state: location.state })}
      onConfluenceSaved={confluenceSynchronization.synchronizeAfterMutation}
      onConfluenceSynchronize={confluenceSynchronization.synchronizeNow}
      onSessionExpired={browserSession.invalidateSession}
      originHref={resolvedOriginHref}
      originLabel={originLabel(resolvedOriginHref, workspaceId)}
      originState={resolvedOrigin.origin.state}
      retry={controller.retry}
      reviewCanEnqueue={reviewCanEnqueue}
      reviewCancel={reviewController.cancel}
      reviewExtendBudget={reviewController.extendBudget}
      reviewPublication={reviewController.publication}
      reviewPublicationCancel={reviewController.cancelPublication}
      reviewLoadEarlier={reviewController.loadEarlier}
      reviewPublicationPreview={reviewController.previewPublication}
      reviewRetry={reviewController.retry}
      reviewSuggestionPublish={reviewController.publishSuggestion}
      reviewTargetSuggestion={reviewController.targetSuggestion}
      reviewStart={reviewController.start}
      reviewState={reviewController.state}
      state={controller.state}
      sessionKey={sessionKey}
      workspaceId={workspaceId}
    />
  )
}

/** Load and render one exact normalized object at its canonical full-page route. */
export const WorkspaceEntityRoute = (): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const params = useParams()
  const entityId = decodeEntityRouteId(params.entityId)
  return entityId === null ? (
    <RouteState
      action={<Link to={workspaceEntityParentPath(context.workspaceId)}>Back to items</Link>}
      description="The object address is not a canonical entity identifier."
      title="Object not found"
    />
  ) : (
    <ConnectedWorkspaceEntity entityId={entityId} workspaceId={context.workspaceId} />
  )
}
