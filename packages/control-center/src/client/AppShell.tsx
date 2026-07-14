import type { ReactElement } from "react"
import { NavLink, Outlet, useLocation } from "react-router"
import styles from "./AppShell.module.css"

const navigation: ReadonlyArray<{ readonly label: string; readonly to: string }> = [
  { label: "Today", to: "/" },
  { label: "Releases", to: "/releases" },
  { label: "Services", to: "/services" }
]

const navClassName = ({ isActive }: { readonly isActive: boolean }): string =>
  `${styles.navLink ?? ""}${isActive ? ` ${styles.navLinkActive ?? ""}` : ""}`

const PrimaryNavigation = ({ className }: { readonly className: string }): ReactElement => (
  <nav aria-label="Primary" className={`${styles.nav ?? ""} ${className}`}>
    {navigation.map((item) => (
      <NavLink className={navClassName} end={item.to === "/"} key={item.to} to={item.to}>
        {item.label}
      </NavLink>
    ))}
  </nav>
)

/** Quiet application chrome that keeps delivery work and the contextual agent one action away. */
export const AppShell = (): ReactElement => {
  const location = useLocation()
  const agentDestination = `/agent?from=${encodeURIComponent(location.pathname)}`

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <NavLink aria-label="Control Center home" className={styles.brand ?? ""} to="/">
          <span aria-hidden="true" className={styles.brandMark}>
            C
          </span>
          <span className={styles.brandName}>Control Center</span>
        </NavLink>
        <PrimaryNavigation className={styles.desktopNav ?? ""} />
        <NavLink className={styles.agent ?? ""} to={agentDestination}>
          Relay context
        </NavLink>
        <PrimaryNavigation className={styles.mobileNav ?? ""} />
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
