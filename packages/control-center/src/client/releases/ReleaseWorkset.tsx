import { LinkProvider } from "@knpkv/rly/foundations"
import { ServiceMark, WorksetCard } from "@knpkv/rly/patterns"
import { Button, Skeleton, StateLabel, StatePanel, Text } from "@knpkv/rly/primitives"
import { type ReactElement } from "react"
import { Link, useLocation, useNavigate } from "react-router"

import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import type { WorkspaceId } from "../../domain/identifiers.js"
import { WorkspaceEntityLink, workspaceEntityStateForHref } from "../entities/WorkspaceEntityLink.js"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import {
  presentReleaseWorkset,
  releaseWorksetRelationshipEvidenceClaims,
  releaseWorksetRelationshipEvidenceIds,
  selectReleaseWorksetObject,
  selectReleaseWorksetRelationship,
  selectReleaseWorksetTrace,
  type SelectedReleaseWorksetObject,
  type SelectedReleaseWorksetTrace
} from "./presentReleaseWorkset.js"
import { RelationshipDetailSheet } from "./RelationshipDetailSheet.js"
import { closeRelationshipDetailRoute, makeRelationshipDetailRouteState } from "./relationshipDetailRoute.js"
import styles from "./ReleaseWorkset.module.css"
import { useReleaseWorkset } from "./useReleaseWorkset.js"

const LoadingWorkset = (): ReactElement => (
  <div aria-busy="true" aria-label="Loading release work" className={styles.loading}>
    <Skeleton height="3rem" />
    <Skeleton height="15rem" />
  </div>
)

/** Inspectable destination for an Items result selected within its release context. */
export const SelectedReleaseWorksetObjectPanel = ({
  linkLocation,
  selectedObject,
  trace
}: {
  readonly linkLocation?: RouterLocationParts
  readonly selectedObject: SelectedReleaseWorksetObject
  readonly trace?: SelectedReleaseWorksetTrace
}): ReactElement => {
  return (
    <section aria-label={`Selected ${selectedObject.kind} ${selectedObject.label}`} className={styles.selected}>
      <div className={styles.selectedHeading}>
        <ServiceMark service={selectedObject.service} size="compact" />
        <Text as="p" variant="label">
          Selected object · {selectedObject.label}
        </Text>
        <StateLabel label={selectedObject.status} size="compact" tone={selectedObject.tone} />
      </div>
      <Text as="h3" variant="section-title">
        {selectedObject.title}
      </Text>
      <Text tone="secondary" variant="meta">
        {selectedObject.kind}
      </Text>
      <dl className={styles.selectedFacts}>
        {selectedObject.facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {trace === undefined ? null : (
        <div className={styles.trace}>
          <div className={styles.traceHeading}>
            <Text as="h4" variant="label">
              Delivery trace
            </Text>
            <StateLabel
              label={`${trace.relationships.length} relationship${trace.relationships.length === 1 ? "" : "s"}${trace.truncated ? "+" : ""}`}
              size="compact"
              tone={trace.truncated ? "caution" : "neutral"}
            />
          </div>
          {trace.relationships.length === 0 ? (
            <Text tone="secondary">No relationship touches this object in the current release slice.</Text>
          ) : (
            <ul className={styles.traceList}>
              {trace.relationships.map((relationship) => (
                <li key={relationship.id}>
                  {relationship.other.service === null ? null : (
                    <ServiceMark service={relationship.other.service} size="compact" />
                  )}
                  <div className={styles.traceConnection}>
                    <Text as="p" variant="label">
                      {relationship.direction === "incoming" ? "From" : "To"} {relationship.other.label}
                    </Text>
                    {relationship.other.href === null ? (
                      <Text tone="secondary">{relationship.other.title}</Text>
                    ) : (
                      <Link
                        state={
                          linkLocation === undefined
                            ? undefined
                            : workspaceEntityStateForHref(relationship.other.href, linkLocation)
                        }
                        to={relationship.other.href}
                      >
                        {relationship.other.title}
                      </Link>
                    )}
                  </div>
                  <div className={styles.traceRelation}>
                    <Text as="span" tone="secondary" variant="meta">
                      {relationship.kind}
                    </Text>
                    <StateLabel label={relationship.lifecycle} size="compact" tone={relationship.tone} />
                  </div>
                  <Text as="span" tone="secondary" variant="meta">
                    {relationship.confidence} · {relationship.evidenceCount} evidence claim
                    {relationship.evidenceCount === 1 ? "" : "s"}
                  </Text>
                  <Link
                    aria-label={`Details for ${relationship.kind} ${relationship.direction} relationship with ${relationship.other.label}`}
                    className={styles.traceDetails}
                    state={makeRelationshipDetailRouteState(linkLocation?.state, selectedObject.id, relationship.id)}
                    to={relationship.detailsHref}
                  >
                    Details
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

interface RouterLocationParts {
  readonly hash: string
  readonly pathname: string
  readonly search: string
  readonly state: unknown
}

/** Compatibility name retained for release-workset callers of the shared readable-session policy. */
export const releaseWorksetSessionKey = browserReadableSessionKey

/** Render one server-backed release graph without substituting demo relationships. */
export const ReleaseWorkset = ({
  release,
  workspaceId
}: {
  readonly release: PortfolioReleasePresentation
  readonly workspaceId: WorkspaceId
}): ReactElement => {
  const browserSession = useBrowserSession()
  const location = useLocation()
  const navigate = useNavigate()
  const sessionKey = releaseWorksetSessionKey(browserSession.state)
  const controller = useReleaseWorkset(
    release.id,
    release.targetEnvironmentIds,
    sessionKey,
    browserSession.invalidateSession
  )
  if (sessionKey === null || controller.state._tag === "idle" || controller.state._tag === "loading") {
    return <LoadingWorkset />
  }
  if (controller.state._tag === "failed") {
    return (
      <StatePanel
        action={<Button onClick={controller.retry}>Try again</Button>}
        description="Control Center could not read the delivery graph for this release. Saved release facts remain unchanged."
        title="Release work unavailable"
        tone="caution"
      />
    )
  }

  const workset = presentReleaseWorkset(controller.state.inspection, workspaceId, release.stages)
  const searchParams = new URLSearchParams(location.search)
  const selectedObjectId = searchParams.get("object")
  const selectedRelationshipId = searchParams.get("relationship")
  const selectedObject = selectReleaseWorksetObject(controller.state.inspection, selectedObjectId)
  const selectedTrace = selectReleaseWorksetTrace(controller.state.inspection, workspaceId, selectedObjectId)
  const selectedRelationship = selectReleaseWorksetRelationship(
    controller.state.inspection,
    selectedObjectId,
    selectedRelationshipId
  )
  const selectedEvidenceIds = releaseWorksetRelationshipEvidenceIds(controller.state.inspection, selectedRelationship)
  const selectedEvidenceClaims = releaseWorksetRelationshipEvidenceClaims(
    controller.state.inspection,
    selectedRelationship
  )
  const closeRelationshipDetails = (): void => {
    if (selectedObject === null || selectedRelationship === null) return
    closeRelationshipDetailRoute(navigate, location, selectedObject.id, selectedRelationship.relationshipId)
  }
  return (
    <>
      <div className={styles.root}>
        <div className={styles.context}>
          <div className={styles.contextGroup}>
            <Text as="h3" variant="label">
              Environment
            </Text>
            {release.targetEnvironmentIds.length === 0 ? (
              <Text tone="secondary">No target environment recorded.</Text>
            ) : (
              <div className={styles.tags}>
                {release.targetEnvironmentIds.map((environmentId) => (
                  <StateLabel
                    key={environmentId}
                    label={`Unknown target · ${environmentId.slice(-4)}`}
                    size="compact"
                    title={`Environment ${environmentId}; provider metadata unavailable`}
                    tone="neutral"
                  />
                ))}
              </div>
            )}
          </div>
          <div className={styles.contextGroup}>
            <div className={styles.contextHeading}>
              <ServiceMark service="confluence" size="compact" />
              <Text as="h3" variant="label">
                Runbook
              </Text>
            </div>
            {workset.runbooks.length === 0 ? (
              <Text tone="secondary">No runbook linked.</Text>
            ) : (
              <div className={styles.runbooks}>
                {workset.runbooks.map((runbook) => (
                  <Link
                    className={styles.runbook}
                    key={runbook.id}
                    state={workspaceEntityStateForHref(runbook.href, location)}
                    to={runbook.href}
                  >
                    <strong>{runbook.title}</strong>
                    <span>{runbook.reference}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          {workset.truncated ? (
            <StateLabel label="Bounded view · more records exist" size="compact" tone="caution" />
          ) : null}
          {selectedObject === null || selectedTrace === null ? null : (
            <SelectedReleaseWorksetObjectPanel
              linkLocation={location}
              selectedObject={selectedObject}
              trace={selectedTrace}
            />
          )}
        </div>
        <LinkProvider component={WorkspaceEntityLink}>
          <WorksetCard
            gaps={workset.gaps}
            heading={`${release.serviceName} release work`}
            jiraItems={workset.jiraItems}
            pipelines={workset.pipelines}
            pullRequestGroups={workset.pullRequestGroups}
          />
        </LinkProvider>
      </div>
      <RelationshipDetailSheet
        claims={selectedEvidenceClaims}
        evidenceIds={selectedEvidenceIds}
        onClose={closeRelationshipDetails}
        onSessionExpired={browserSession.invalidateSession}
        relationship={selectedRelationship}
        sessionKey={sessionKey}
      />
    </>
  )
}
