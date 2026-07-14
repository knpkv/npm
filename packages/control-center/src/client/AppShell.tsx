import type { ReactElement } from "react"
import { NavLink, Outlet, useLocation } from "react-router"
import styles from "./AppShell.module.css"

const CANONICAL_WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const workspaceOverviewPath = (pathname: string): string => {
  const workspaceId = pathname.split("/")[2]
  return workspaceId !== undefined && CANONICAL_WORKSPACE_ID.test(workspaceId) ? `/w/${workspaceId}/overview` : "/"
}

const navigation = (overviewPath: string): ReadonlyArray<{ readonly label: string; readonly to: string }> => [
  { label: "Overview", to: overviewPath },
  { label: "Releases", to: "/releases" },
  { label: "Services", to: "/services" }
]

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
  const agentDestination = `/agent?from=${encodeURIComponent(`${location.pathname}${location.search}`)}`

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
        <NavLink className={styles.agent ?? ""} to={agentDestination}>
          Relay context
        </NavLink>
        <PrimaryNavigation className={styles.mobileNav ?? ""} overviewPath={overviewPath} />
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
