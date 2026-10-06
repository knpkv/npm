import { createBrowserRouter, Navigate, useMatches } from "react-router"
import { AppLayout } from "./components/app.js"
import { AuditLogPage } from "./components/audit-log-page.js"
import { NotificationsPage } from "./components/notifications-page.js"
import { PRDetail } from "./components/pr-detail.js"
import { PRList } from "./components/pr-list.js"
import { SandboxView } from "./components/sandbox-view.js"
import { SandboxesPage } from "./components/sandboxes-page.js"
import { SettingsPage } from "./components/settings-page.js"
import { StatsPage } from "./components/stats-page.js"
import { WorkbenchLayout } from "./components/workbench-layout.js"
import * as Predicate from "effect/Predicate"

/**
 * `fullWidth`: the page fills the viewport and scrolls inside itself (the sandbox editor).
 * `wide`: an ordinary scrolling page with a wider cap, for the Workbench's rail + PR + findings.
 */
interface RouteHandle {
  readonly fullWidth?: boolean
  readonly wide?: boolean
}

const isRouteHandle = <UnparsedInput,>(h: UnparsedInput): h is UnparsedInput & RouteHandle =>
  h != null && (Predicate.hasProperty(h, "fullWidth") || Predicate.hasProperty(h, "wide"))

const hasFullWidth = (m: { handle?: unknown }): boolean => isRouteHandle(m.handle) && m.handle.fullWidth === true

const hasWide = (m: { handle?: unknown }): boolean => isRouteHandle(m.handle) && m.handle.wide === true

export const useFullWidthRoute = (): boolean => useMatches().some(hasFullWidth)

export const useWideRoute = (): boolean => useMatches().some(hasWide)

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <PRList /> },
      {
        element: <WorkbenchLayout />,
        handle: { wide: true },
        children: [{ path: "accounts/:accountId/prs/:prId", element: <PRDetail /> }]
      },
      { path: "sandboxes", element: <SandboxesPage /> },
      { path: "sandbox/:sandboxId", element: <SandboxView />, handle: { fullWidth: true } },
      { path: "settings/:tab?", element: <SettingsPage /> },
      { path: "notifications", element: <NotificationsPage /> },
      { path: "stats", element: <StatsPage /> },
      { path: "audit", element: <AuditLogPage /> },
      { path: "*", element: <Navigate to="/" replace /> }
    ]
  }
])
