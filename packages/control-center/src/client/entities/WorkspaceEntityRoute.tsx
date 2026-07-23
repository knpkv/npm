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
import { type ReactElement, useEffect, useRef, useState } from "react"
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router"

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
import { WorkspaceConfluencePageDetails } from "./WorkspaceConfluencePageDetails.js"
import { WorkspaceIssueDetails } from "./WorkspaceIssueDetails.js"
import { WorkspacePipelineExecutionDetails } from "./WorkspacePipelineExecutionDetails.js"
import { WorkspacePullRequestDetails } from "./WorkspacePullRequestDetails.js"
import { useWorkspaceEntity, type WorkspaceEntityState } from "./useWorkspaceEntity.js"

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
  onAskAgent,
  onSessionExpired,
  presentation,
  retry,
  sessionKey,
  stale
}: {
  readonly onAskAgent: () => void
  readonly onSessionExpired: (sessionKey: string) => void
  readonly presentation: WorkspaceEntityPresentation
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
      <WorkspaceClockifyTimeEntryDetails timeEntry={presentation.clockifyTimeEntry} />
    )}
    {presentation.issue === null ? null : <WorkspaceIssueDetails issue={presentation.issue} />}
    {presentation.confluencePage === null ? null : (
      <WorkspaceConfluencePageDetails page={presentation.confluencePage} />
    )}
    {presentation.pipelineExecution === null ? null : (
      <WorkspacePipelineExecutionDetails pipeline={presentation.pipelineExecution} />
    )}
    {presentation.pullRequest === null ? null : (
      <WorkspacePullRequestDetails
        approvers={presentation.collaborators.approvers}
        onAskAgent={onAskAgent}
        onSessionExpired={onSessionExpired}
        pullRequest={presentation.pullRequest}
        reviewers={presentation.collaborators.reviewers}
        sessionKey={sessionKey}
      />
    )}
    <DeliveryPath presentation={presentation} />
  </div>
)

interface WorkspaceEntityViewProps {
  readonly onAskAgent: () => void
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly originHref: string
  readonly originLabel: string
  readonly originState: WorkspaceEntityOrigin["state"]
  readonly retry: () => void
  readonly state: WorkspaceEntityState
  readonly sessionKey?: string | null
  readonly workspaceId: WorkspaceIdType
}

const ignoreSessionExpiration = (_sessionKey: string): void => undefined

/** Pure state renderer for the canonical entity route. */
export const WorkspaceEntityView = ({
  onAskAgent,
  onSessionExpired = ignoreSessionExpiration,
  originHref,
  originLabel: backLabel,
  originState,
  retry,
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
        description="This object is not present in the current workspace. It may have been deleted, disconnected, or the address may be incorrect."
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
  return (
    <LinkProvider component={WorkspaceEntityLink}>
      <EntityShell
        actions={<PrincipalAction action={presentation.primaryAction} />}
        activity={<EntityActivity presentation={presentation} />}
        agentEntry={
          <AgentContextButton
            actionLabel="Ask about this object"
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
            onAskAgent={onAskAgent}
            onSessionExpired={onSessionExpired}
            presentation={presentation}
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
      onAskAgent={() => navigate(agentPath, { state: location.state })}
      onSessionExpired={browserSession.invalidateSession}
      originHref={resolvedOriginHref}
      originLabel={originLabel(resolvedOriginHref, workspaceId)}
      originState={resolvedOrigin.origin.state}
      retry={controller.retry}
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
