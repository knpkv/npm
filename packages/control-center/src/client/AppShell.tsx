import { lazy, type ReactElement, Suspense, useEffect, useState } from "react"
import { NavLink, Outlet, useLocation } from "react-router"
import type { WorkspaceId } from "../domain/identifiers.js"
import { type BrowserSessionState, useBrowserSession } from "./BrowserSession.js"
import { contextualAgentPath, isWorkspaceRouteId } from "./contextualAgentPath.js"
import { subscribeWorkspacePresentation } from "./settings/workspaceSettingsSignals.js"
import styles from "./AppShell.module.css"
import { WorkspaceScrollRestoration } from "./workspaceScrollRestoration.js"

const CommandSearch = lazy(async () => {
  const module = await import("./command/CommandSearch.js")
  return { default: module.CommandSearch }
})

const WorkspaceHomeLink = lazy(async () => {
  const module = await import("./settings/WorkspaceHomeLink.js")
  return { default: module.WorkspaceHomeLink }
})

const workspaceOverviewPath = (pathname: string): string => {
  const workspaceId = pathname.split("/")[2]
  return isWorkspaceRouteId(workspaceId) ? `/w/${workspaceId}/overview` : "/"
}

const workspaceIdFromPathname = (pathname: string): WorkspaceId | null => {
  const segments = pathname.split("/")
  const workspaceId = segments[2]
  return segments[1] === "w" && isWorkspaceRouteId(workspaceId) ? workspaceId : null
}

/** Decide whether workspace settings belong in the current session's navigation. @internal */
export const canInspectWorkspaceSettings = (state: BrowserSessionState, workspaceId: WorkspaceId | null): boolean => {
  const session = state._tag === "authenticated" || state._tag === "storage-unavailable" ? state.session : null
  return (
    workspaceId !== null &&
    session?.workspaceId === workspaceId &&
    (session.permission === "workspace-owner" || session.permission === "workspace-approver")
  )
}

/** The narrow PR resolver is available to workspace-wide readers. @internal */
export const canOpenCodeCommitPullRequest = (state: BrowserSessionState, workspaceId: WorkspaceId | null): boolean => {
  const session = state._tag === "authenticated" || state._tag === "storage-unavailable" ? state.session : null
  return (
    workspaceId !== null &&
    session?.workspaceId === workspaceId &&
    (session.permission === "workspace-owner" || session.permission === "workspace-approver")
  )
}

const navigation = (
  overviewPath: string,
  includeSettings: boolean
): ReadonlyArray<{ readonly label: string; readonly to: string }> => {
  const workspaceId = overviewPath.split("/")[2]
  return isWorkspaceRouteId(workspaceId)
    ? [
        { label: "Overview", to: overviewPath },
        { label: "Active work", to: `/w/${workspaceId}/work` },
        { label: "Items", to: `/w/${workspaceId}/items` },
        { label: "Timeline", to: `/w/${workspaceId}/timeline` },
        ...(includeSettings ? [{ label: "Settings", to: `/w/${workspaceId}/settings` }] : []),
        { label: "Services", to: "/services" }
      ]
    : [
        { label: "Overview", to: overviewPath },
        { label: "Releases", to: "/releases" },
        { label: "Services", to: "/services" }
      ]
}

const navClassName = ({ isActive }: { readonly isActive: boolean }): string =>
  `${styles.navLink ?? ""}${isActive ? ` ${styles.navLinkActive ?? ""}` : ""}`

const PrimaryNavigation = ({
  className,
  includeSettings,
  overviewPath
}: {
  readonly className: string
  readonly includeSettings: boolean
  readonly overviewPath: string
}): ReactElement => (
  <nav aria-label="Primary" className={`${styles.nav ?? ""} ${className}`}>
    {navigation(overviewPath, includeSettings).map((item) => (
      <NavLink className={navClassName} end={item.to === overviewPath} key={item.label} to={item.to}>
        {item.label}
      </NavLink>
    ))}
  </nav>
)

/** Quiet application chrome that keeps delivery work and the contextual agent one action away. */
export const AppShell = (): ReactElement => {
  const location = useLocation()
  const browserSession = useBrowserSession()
  const isAuthorizedShare = location.pathname.startsWith("/shares/")
  const overviewPath = workspaceOverviewPath(location.pathname)
  const agentDestination = contextualAgentPath(location.pathname, location.search, location.hash)
  const workspaceId = workspaceIdFromPathname(location.pathname)
  const includeSettings = canInspectWorkspaceSettings(browserSession.state, workspaceId)
  const includeOpenPullRequest = canOpenCodeCommitPullRequest(browserSession.state, workspaceId)
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable")
  useEffect(() => {
    setDensity("comfortable")
    let latestRevision = 0
    return subscribeWorkspacePresentation((settings) => {
      if (settings.workspaceId !== workspaceId || settings.revision < latestRevision) return
      latestRevision = settings.revision
      setDensity(settings.presentation.density)
    })
  }, [workspaceId])
  const brand = (
    <>
      <span aria-hidden="true" className={styles.brandMark}>
        C
      </span>
      <span className={styles.brandName}>Control Center</span>
    </>
  )

  return (
    <div className={styles.root} data-workspace-density={density}>
      <header className={styles.header}>
        {isAuthorizedShare ? (
          <span className={styles.brand ?? ""}>{brand}</span>
        ) : workspaceId === null ? (
          <NavLink className={styles.brand ?? ""} to={overviewPath}>
            {brand}
          </NavLink>
        ) : (
          <Suspense
            fallback={
              <NavLink className={styles.brand ?? ""} to="/">
                {brand}
              </NavLink>
            }
          >
            <WorkspaceHomeLink className={styles.brand ?? ""} fallbackPath="/" workspaceId={workspaceId}>
              {brand}
            </WorkspaceHomeLink>
          </Suspense>
        )}
        {isAuthorizedShare ? null : (
          <>
            <PrimaryNavigation
              className={styles.desktopNav ?? ""}
              includeSettings={includeSettings}
              overviewPath={overviewPath}
            />
            <div className={styles.actions}>
              {includeOpenPullRequest ? (
                <NavLink className={styles.agent ?? ""} to="/open-pr">
                  Open PR
                </NavLink>
              ) : null}
              {workspaceId === null ? null : (
                <Suspense fallback={null}>
                  <CommandSearch workspaceId={workspaceId} />
                </Suspense>
              )}
              <NavLink className={styles.agent ?? ""} state={location.state} to={agentDestination}>
                Ask Relay
              </NavLink>
            </div>
            <PrimaryNavigation
              className={styles.mobileNav ?? ""}
              includeSettings={includeSettings}
              overviewPath={overviewPath}
            />
          </>
        )}
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
      <WorkspaceScrollRestoration />
    </div>
  )
}
