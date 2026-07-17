import { LinkProvider, type RlyLinkProps } from "@knpkv/rly/foundations"
import { ServiceMark, WorksetCard } from "@knpkv/rly/patterns"
import { Button, Skeleton, StateLabel, StatePanel, Text } from "@knpkv/rly/primitives"
import { forwardRef, type ReactElement } from "react"
import { Link, useLocation } from "react-router"

import { type BrowserSessionState, useBrowserSession } from "../BrowserSession.js"
import type { WorkspaceId } from "../../domain/identifiers.js"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import {
  presentReleaseWorkset,
  selectReleaseWorksetObject,
  selectReleaseWorksetTrace,
  type SelectedReleaseWorksetObject,
  type SelectedReleaseWorksetTrace
} from "./presentReleaseWorkset.js"
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
  linkState,
  selectedObject,
  trace
}: {
  readonly linkState?: unknown
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
                      <Link state={linkState} to={relationship.other.href}>
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
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

const ReleaseWorksetLink = forwardRef<HTMLAnchorElement, RlyLinkProps>(function ReleaseWorksetLink(
  { href, ...props },
  ref
) {
  const location = useLocation()
  return <Link {...props} ref={ref} state={location.state} to={href} />
})

/** Cookie-authenticated reads remain available when only mutation-proof storage failed. */
export const releaseWorksetSessionKey = (state: BrowserSessionState): string | null => {
  switch (state._tag) {
    case "authenticated":
      return state.session.sessionId
    case "storage-unavailable":
      return state.session?.sessionId ?? null
    case "anonymous":
    case "blocked":
    case "checking":
    case "unavailable":
      return null
  }
}

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
  const selectedObjectId = new URLSearchParams(location.search).get("object")
  const selectedObject = selectReleaseWorksetObject(controller.state.inspection, selectedObjectId)
  const selectedTrace = selectReleaseWorksetTrace(controller.state.inspection, workspaceId, selectedObjectId)
  return (
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
                <Link className={styles.runbook} key={runbook.id} state={location.state} to={runbook.href}>
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
            linkState={location.state}
            selectedObject={selectedObject}
            trace={selectedTrace}
          />
        )}
      </div>
      <LinkProvider component={ReleaseWorksetLink}>
        <WorksetCard
          gaps={workset.gaps}
          heading={`${release.serviceName} release work`}
          jiraItems={workset.jiraItems}
          pipelines={workset.pipelines}
          pullRequestGroups={workset.pullRequestGroups}
        />
      </LinkProvider>
    </div>
  )
}
