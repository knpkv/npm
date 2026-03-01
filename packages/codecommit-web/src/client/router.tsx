import { createBrowserRouter, Navigate, useMatches } from "react-router"
import { AppLayout } from "./components/app.js"
import { NotificationsPage } from "./components/notifications-page.js"
import { PRDetail } from "./components/pr-detail.js"
import { PRList } from "./components/pr-list.js"
import { SandboxView } from "./components/sandbox-view.js"
import { SandboxesPage } from "./components/sandboxes-page.js"
import { SettingsPage } from "./components/settings-page.js"

interface RouteHandle {
  readonly fullWidth?: boolean
}

const isRouteHandle = (h: unknown): h is RouteHandle => h != null && typeof h === "object" && "fullWidth" in h

const hasFullWidth = (m: { handle?: unknown }): boolean => isRouteHandle(m.handle) && m.handle.fullWidth === true

export const useFullWidthRoute = (): boolean => useMatches().some(hasFullWidth)

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <PRList /> },
      { path: "accounts/:accountId/prs/:prId", element: <PRDetail /> },
      { path: "sandboxes", element: <SandboxesPage /> },
      { path: "sandbox/:sandboxId", element: <SandboxView />, handle: { fullWidth: true } },
      { path: "settings/:tab?", element: <SettingsPage /> },
      { path: "notifications", element: <NotificationsPage /> },
      { path: "*", element: <Navigate to="/" replace /> }
    ]
  }
])
