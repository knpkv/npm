import { createBrowserRouter } from "react-router"
import { AppShell } from "./AppShell.js"
import { NotFoundPage, ReleasesPage, ServicesPage } from "./Pages.js"

const overviewRoute = async () => {
  const module = await import("./portfolio/PortfolioOverview.js")
  return { Component: module.PortfolioOverview }
}

const pairRoute = async () => {
  const module = await import("./PairPage.js")
  return { Component: module.PairPage }
}

const agentRoute = async () => {
  const module = await import("./AgentPage.js")
  return { Component: module.ConnectedAgentPage }
}

const workspaceRoute = async () => {
  const module = await import("./releases/WorkspaceReleaseLayout.js")
  return { Component: module.WorkspaceReleaseLayout }
}

const workspaceOverviewRoute = async () => {
  const module = await import("./releases/WorkspaceReleaseLayout.js")
  return { Component: module.WorkspaceOverviewRoute }
}

const workspaceNotFoundRoute = async () => {
  const module = await import("./releases/WorkspaceReleaseLayout.js")
  return { Component: module.WorkspaceNotFoundRoute }
}

const releasePreviewRoute = async () => {
  const module = await import("./releases/ReleaseRoute.js")
  return { Component: module.ReleasePreviewRoute }
}

const releaseFullRoute = async () => {
  const module = await import("./releases/ReleaseRoute.js")
  return { Component: module.ReleaseFullRoute }
}

const activeWorkRoute = async () => {
  const module = await import("./releases/ActiveWorkPage.js")
  return { Component: module.ActiveWorkPage }
}

/** Browser routes remain application-owned while rly receives only a link bridge. */
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, lazy: overviewRoute },
      { path: "releases", element: <ReleasesPage /> },
      { path: "services", element: <ServicesPage /> },
      { path: "agent", lazy: agentRoute },
      { path: "pair", lazy: pairRoute },
      {
        path: "w/:workspaceId",
        lazy: workspaceRoute,
        children: [
          { path: "overview", lazy: workspaceOverviewRoute },
          { path: "work", lazy: activeWorkRoute },
          { path: "releases/:releaseId/preview", lazy: releasePreviewRoute },
          { path: "releases/:releaseId/agent", lazy: agentRoute },
          { path: "releases/:releaseId", lazy: releaseFullRoute },
          { path: "*", lazy: workspaceNotFoundRoute }
        ]
      },
      { path: "*", element: <NotFoundPage /> }
    ]
  }
])
