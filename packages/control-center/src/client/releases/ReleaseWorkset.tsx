import { LinkProvider, type RlyLinkProps } from "@knpkv/rly/foundations"
import { ServiceMark, WorksetCard } from "@knpkv/rly/patterns"
import { Button, Skeleton, StateLabel, StatePanel, Text } from "@knpkv/rly/primitives"
import { forwardRef, type ReactElement } from "react"
import { Link, useLocation } from "react-router"

import { type BrowserSessionState, useBrowserSession } from "../BrowserSession.js"
import type { WorkspaceId } from "../../domain/identifiers.js"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import { presentReleaseWorkset, selectReleaseWorksetObject } from "./presentReleaseWorkset.js"
import styles from "./ReleaseWorkset.module.css"
import { useReleaseWorkset } from "./useReleaseWorkset.js"

const LoadingWorkset = (): ReactElement => (
  <div aria-busy="true" aria-label="Loading release work" className={styles.loading}>
    <Skeleton height="3rem" />
    <Skeleton height="15rem" />
  </div>
)

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
        {selectedObject === null ? null : (
          <StateLabel
            label={`Selected object · ${selectedObject.label}`}
            size="compact"
            title={`${selectedObject.title} · ${selectedObject.kind}`}
            tone="progress"
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
