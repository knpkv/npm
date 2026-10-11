import type { ReactElement } from "react"
import type { SessionSummary } from "../../api/session.js"
import { type BrowserSessionState, useBrowserSession } from "../BrowserSession.js"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import { RelationshipRepairCandidatePicker } from "./RelationshipRepairCandidatePicker.js"
import { useRelationshipRepairProposals } from "./useRelationshipRepairProposals.js"
import type { RelationshipRepairTransport } from "./relationshipRepairTransport.js"
import { RelationshipRepairLoading, RelationshipRepairPanelView } from "./RelationshipRepairPanelView.js"
import styles from "./RelationshipRepairPanel.module.css"

export { RelationshipRepairPanelView } from "./RelationshipRepairPanelView.js"

const ignoreSessionExpired = (): void => undefined

const sessionScopeKey = (session: SessionSummary): string => {
  const actorId = session.actor._tag === "human" ? session.actor.personId : session.actor.agentId
  return `${session.sessionId}:${session.workspaceId}:${session.permission}:${session.actor._tag}:${actorId}`
}

interface RelationshipRepairSessionAccess {
  readonly mutationsEnabled: boolean
  readonly session: SessionSummary | null
}

/** Cookie-authenticated reads survive storage failure; mutation controls do not. */
export const relationshipRepairSessionAccess = (state: BrowserSessionState): RelationshipRepairSessionAccess => {
  switch (state._tag) {
    case "authenticated":
      return { mutationsEnabled: true, session: state.session }
    case "storage-unavailable":
      return { mutationsEnabled: false, session: state.session }
    case "anonymous":
    case "blocked":
    case "checking":
    case "unavailable":
      return { mutationsEnabled: false, session: null }
  }
}

/** Render the repair ledger from an explicit browser-session state. */
export const RelationshipRepairPanelContent = ({
  browserSessionState,
  onSessionExpired = ignoreSessionExpired,
  release,
  transport
}: {
  readonly browserSessionState: BrowserSessionState
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly release: PortfolioReleasePresentation
  readonly transport?: RelationshipRepairTransport
}): ReactElement => {
  const access = relationshipRepairSessionAccess(browserSessionState)
  const controller = useRelationshipRepairProposals(
    release.id,
    release.targetEnvironmentIds,
    access.session?.sessionId ?? null,
    transport,
    onSessionExpired
  )
  if (access.session === null) return <RelationshipRepairLoading />
  return (
    <div className={styles.panelStack}>
      <RelationshipRepairPanelView
        mutationsEnabled={access.mutationsEnabled}
        onApply={controller.apply}
        onRetry={controller.retry}
        onReview={controller.review}
        release={release}
        session={access.session}
        state={controller.state}
      />
      {access.mutationsEnabled ? (
        <RelationshipRepairCandidatePicker
          environmentIds={release.targetEnvironmentIds}
          key={`${release.id}:${release.targetEnvironmentIds.join(":")}:${sessionScopeKey(access.session)}`}
          onCreated={controller.retry}
          releaseId={release.id}
          session={access.session}
        />
      ) : null}
    </div>
  )
}

/** Connect one full release view to its authenticated repair-proposal ledger. */
export const RelationshipRepairPanel = ({
  release
}: {
  readonly release: PortfolioReleasePresentation
}): ReactElement => {
  const browserSession = useBrowserSession()
  return (
    <RelationshipRepairPanelContent
      browserSessionState={browserSession.state}
      onSessionExpired={browserSession.invalidateSession}
      release={release}
    />
  )
}
