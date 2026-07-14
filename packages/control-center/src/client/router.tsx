import { createBrowserRouter, Navigate } from "react-router"
import { AppShell } from "./AppShell.js"
import { ReleasesPage, ServicesPage } from "./Pages.js"

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
  return { Component: module.AgentPage }
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
      { path: "*", element: <Navigate replace to="/" /> }
    ]
  }
])
