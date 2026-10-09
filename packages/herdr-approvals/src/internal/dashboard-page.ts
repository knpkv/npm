/**
 * The host dashboard page, server-rendered for a non-canonical host and hydrated by `approval.js`.
 *
 * @module
 */
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import type { DashboardSnapshot } from "../dashboard-model.js"
import { DashboardView } from "../dashboard-view.js"
import { dashboardDocumentTitle } from "./html.js"

/**
 * The host dashboard page. A non-canonical page is server-rendered and then hydrated by
 * `approval.js`, so it must be `renderToString`: static markup merges adjacent text nodes and
 * drops the separators hydration needs (React #418).
 */
export const dashboardPage = (snapshot: DashboardSnapshot, fontPreload: string): string => {
  const markup = snapshot.approvalApp.canonical ? "" : renderToString(
    createElement(
      "div",
      { className: "dashboard-gesture" },
      createElement(DashboardView, {
        busyJobId: null,
        notificationState: "loading",
        onDecision: () => undefined,
        onDisableNotifications: undefined,
        onEnableNotifications: undefined,
        onRefresh: () => undefined,
        pull: { distance: 0, ready: false, refreshing: false },
        snapshot
      })
    )
  )
  const data = JSON.stringify(snapshot).replaceAll("<", "\\u003c")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#111418">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Relay">
<title>${dashboardDocumentTitle(snapshot)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/assets/relay-icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/relay-apple-touch-180.png">
${fontPreload}<link rel="stylesheet" href="/assets/index.css">
</head>
<body data-rly-root data-rly-theme="dark">
<div id="fleet-dashboard-root">${markup}</div>
<script id="fleet-dashboard-data" type="application/json">${data}</script>
<script src="/assets/approval.js" defer></script>
</body>
</html>`
}
