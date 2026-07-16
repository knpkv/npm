import type { ReactElement } from "react"
import { NavLink, Outlet, useLocation } from "react-router"
import type { ReleaseId, WorkspaceId } from "../domain/identifiers.js"
import { releaseAgentPath } from "./releases/releasePaths.js"
import styles from "./AppShell.module.css"

const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const isWorkspaceId = (value: string | undefined): value is WorkspaceId =>
  value !== undefined && CANONICAL_ID.test(value)

const isReleaseId = (value: string | undefined): value is ReleaseId => value !== undefined && CANONICAL_ID.test(value)

const workspaceOverviewPath = (pathname: string): string => {
  const workspaceId = pathname.split("/")[2]
  return isWorkspaceId(workspaceId) ? `/w/${workspaceId}/overview` : "/"
}

const contextualAgentPath = (pathname: string, search: string): string => {
  const segments = pathname.split("/")
  const workspaceId = segments[2]
  const releaseId = segments[4]
  if (segments[1] === "w" && isWorkspaceId(workspaceId) && segments[3] === "releases" && isReleaseId(releaseId)) {
    return releaseAgentPath(workspaceId, releaseId)
  }
  const activeWorkReleaseId = new URLSearchParams(search).get("release") ?? undefined
  if (segments[1] === "w" && isWorkspaceId(workspaceId) && segments[3] === "work" && isReleaseId(activeWorkReleaseId)) {
    return releaseAgentPath(workspaceId, activeWorkReleaseId)
  }
  return `/agent?from=${encodeURIComponent(`${pathname}${search}`)}`
}

const navigation = (overviewPath: string): ReadonlyArray<{ readonly label: string; readonly to: string }> => {
  const workspaceId = overviewPath.split("/")[2]
  return isWorkspaceId(workspaceId)
    ? [
        { label: "Overview", to: overviewPath },
        { label: "Active work", to: `/w/${workspaceId}/work` },
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
  overviewPath
}: {
  readonly className: string
  readonly overviewPath: string
}): ReactElement => (
  <nav aria-label="Primary" className={`${styles.nav ?? ""} ${className}`}>
    {navigation(overviewPath).map((item) => (
      <NavLink className={navClassName} end={item.to === overviewPath} key={item.label} to={item.to}>
        {item.label}
      </NavLink>
    ))}
  </nav>
)

/** Quiet application chrome that keeps delivery work and the contextual agent one action away. */
export const AppShell = (): ReactElement => {
  const location = useLocation()
  const overviewPath = workspaceOverviewPath(location.pathname)
  const agentDestination = contextualAgentPath(location.pathname, location.search)

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <NavLink aria-label="Control Center home" className={styles.brand ?? ""} to={overviewPath}>
          <span aria-hidden="true" className={styles.brandMark}>
            C
          </span>
          <span className={styles.brandName}>Control Center</span>
        </NavLink>
        <PrimaryNavigation className={styles.desktopNav ?? ""} overviewPath={overviewPath} />
        <NavLink className={styles.agent ?? ""} state={location.state} to={agentDestination}>
          Ask Relay
        </NavLink>
        <PrimaryNavigation className={styles.mobileNav ?? ""} overviewPath={overviewPath} />
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
