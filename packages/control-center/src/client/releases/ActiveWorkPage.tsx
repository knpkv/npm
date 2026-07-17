import { PeopleStrip, ReleaseRelay, Verdict } from "@knpkv/rly/patterns"
import { StatePanel, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { Link, Navigate, useLocation, useOutletContext } from "react-router"

import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import type { WorkspaceReleaseOutletContext } from "./WorkspaceReleaseLayout.js"
import { RelationshipRepairPanel } from "./RelationshipRepairPanel.js"
import { ReleaseAction, ReleaseAgentEntry, ReleaseEvidence } from "./ReleaseRoute.js"
import { ReleaseWorkset } from "./ReleaseWorkset.js"
import { releaseActiveWorkPath, releaseFullPath } from "./releasePaths.js"
import {
  decodeReleaseRouteId,
  makeReleaseRouteState,
  resolveReleaseOrigin,
  type ReleaseRouteState
} from "./releaseRoutes.js"
import styles from "./ActiveWorkPage.module.css"

const selectedReleaseId = (search: string): ReturnType<typeof decodeReleaseRouteId> =>
  decodeReleaseRouteId(new URLSearchParams(search).get("release"))

const ReleaseSelector = ({
  releases,
  selected,
  stateForRelease,
  workspaceId
}: {
  readonly releases: ReadonlyArray<PortfolioReleasePresentation>
  readonly selected: PortfolioReleasePresentation
  readonly stateForRelease: (release: PortfolioReleasePresentation) => ReleaseRouteState | undefined
  readonly workspaceId: WorkspaceReleaseOutletContext["workspaceId"]
}): ReactElement => (
  <nav aria-label="Release decisions" className={styles.releaseSelector}>
    {releases.map((release) => (
      <Link
        aria-current={release.id === selected.id ? "page" : undefined}
        className={styles.releaseChoice}
        data-active={release.id === selected.id ? "true" : "false"}
        key={release.id}
        state={stateForRelease(release)}
        to={releaseActiveWorkPath(workspaceId, release.id)}
      >
        <span>{release.relay.codename}</span>
        <strong>{release.release.verdict}</strong>
      </Link>
    ))}
  </nav>
)

/** Render one durable human decision ledger as a workspace-level queue. */
export const ActiveWorkPage = (): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext>()
  const location = useLocation()
  if (context.controller.state._tag !== "ready") {
    return (
      <StatePanel
        description="Control Center is loading the release portfolio before opening the decision queue."
        title="Loading active work"
      />
    )
  }
  const releases = context.controller.state.portfolio.releases
  if (releases.length === 0) {
    return (
      <StatePanel
        action={<Link to={`/w/${context.workspaceId}/overview`}>Return to overview</Link>}
        description="Active work appears when a synchronized release needs a human decision."
        title="No active release work"
      />
    )
  }
  const requestedId = selectedReleaseId(location.search)
  if (requestedId === null) {
    const first = releases[0]
    if (first === undefined) throw new Error("unreachable empty release portfolio")
    return <Navigate replace to={releaseActiveWorkPath(context.workspaceId, first.id)} />
  }
  const selected = releases.find(({ id }) => id === requestedId)
  if (selected === undefined) {
    return (
      <StatePanel
        action={
          <Link to={releaseActiveWorkPath(context.workspaceId, releases[0]?.id ?? requestedId)}>Open current work</Link>
        }
        description="This release is not part of the current workspace snapshot."
        title="Release work not found"
      />
    )
  }
  const resolvedOrigin = resolveReleaseOrigin(location.state, context.workspaceId, selected.id)
  const stateForRelease = (release: PortfolioReleasePresentation): ReleaseRouteState | undefined =>
    resolvedOrigin.isStored ? makeReleaseRouteState(context.workspaceId, release.id, resolvedOrigin.origin) : undefined

  return (
    <article className={styles.page}>
      <header className={styles.hero}>
        <Text as="p" tone="secondary" variant="label">
          Active work
        </Text>
        <Text as="h1" variant="verdict">
          Decisions,
          <br />
          not tickets.
        </Text>
        <Text className={styles.intro} tone="secondary" variant="body-large">
          One place to review the relationship changes that decide whether a release can move.
        </Text>
      </header>

      <ReleaseSelector
        releases={releases}
        selected={selected}
        stateForRelease={stateForRelease}
        workspaceId={context.workspaceId}
      />

      <section aria-labelledby="active-release-title" className={styles.selectedRelease}>
        <div className={styles.identity}>
          <ReleaseRelay
            algorithm={selected.relay.algorithm}
            codename={selected.relay.codename}
            size="hero"
            symbolIndices={selected.relay.symbolIndices}
          />
          <div>
            <Text as="h2" id="active-release-title" variant="page-title">
              {selected.serviceName}
            </Text>
            <Link
              className={styles.fullLink}
              state={location.state}
              to={releaseFullPath(context.workspaceId, selected.id)}
            >
              Open full release
            </Link>
          </div>
        </div>
        <Verdict reason={selected.readinessReason} tone={selected.release.tone} verdict={selected.release.verdict} />
        {selected.collaborators.length === 0 ? null : (
          <PeopleStrip
            aria-label={`${selected.relay.codename} collaborators`}
            expanded
            limit={selected.collaborators.length}
            onExpandedChange={() => undefined}
            people={selected.collaborators}
          />
        )}
        <ReleaseAction release={selected} />
        <section aria-labelledby="active-workset-title" className={styles.contextSection}>
          <Text as="h3" id="active-workset-title" variant="section-title">
            Release work
          </Text>
          <ReleaseWorkset release={selected} workspaceId={context.workspaceId} />
        </section>
        <RelationshipRepairPanel release={selected} />
        <section aria-labelledby="active-evidence-title" className={styles.contextSection}>
          <Text as="h3" id="active-evidence-title" variant="section-title">
            Evidence
          </Text>
          <ReleaseEvidence release={selected} />
        </section>
        <section aria-labelledby="active-agent-title" className={styles.contextSection}>
          <Text as="h3" id="active-agent-title" variant="section-title">
            Release agent
          </Text>
          <ReleaseAgentEntry release={selected} />
        </section>
      </section>
    </article>
  )
}
