import { lazy, type ReactElement, Suspense } from "react"
import { NavLink, Outlet, useLocation } from "react-router"
import type { WorkspaceId } from "../domain/identifiers.js"
import { contextualAgentPath, isWorkspaceRouteId } from "./contextualAgentPath.js"
import styles from "./AppShell.module.css"

const CommandSearch = lazy(async () => {
  const module = await import("./command/CommandSearch.js")
  return { default: module.CommandSearch }
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

const navigation = (overviewPath: string): ReadonlyArray<{ readonly label: string; readonly to: string }> => {
  const workspaceId = overviewPath.split("/")[2]
  return isWorkspaceRouteId(workspaceId)
    ? [
        { label: "Overview", to: overviewPath },
        { label: "Active work", to: `/w/${workspaceId}/work` },
        { label: "Items", to: `/w/${workspaceId}/items` },
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
  const agentDestination = contextualAgentPath(location.pathname, location.search, location.hash)
  const workspaceId = workspaceIdFromPathname(location.pathname)

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
        <div className={styles.actions}>
          {workspaceId === null ? null : (
            <Suspense fallback={null}>
              <CommandSearch workspaceId={workspaceId} />
            </Suspense>
          )}
          <NavLink className={styles.agent ?? ""} state={location.state} to={agentDestination}>
            Ask Relay
          </NavLink>
        </div>
        <PrimaryNavigation className={styles.mobileNav ?? ""} overviewPath={overviewPath} />
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
