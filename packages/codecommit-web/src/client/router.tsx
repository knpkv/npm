import { createBrowserRouter, Navigate } from "react-router"
import { AppLayout } from "./components/app.js"
import { NotificationsPage } from "./components/notifications-page.js"
import { PRDetail } from "./components/pr-detail.js"
import { PRList } from "./components/pr-list.js"
import { SettingsPage } from "./components/settings-page.js"

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <PRList /> },
      { path: "accounts/:accountId/prs/:prId", element: <PRDetail /> },
      { path: "settings/:tab?", element: <SettingsPage /> },
      { path: "notifications", element: <NotificationsPage /> },
      { path: "*", element: <Navigate to="/" replace /> }
    ]
  }
])
