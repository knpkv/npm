import { StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { Link, useSearchParams } from "react-router"

import { decodeReleaseRouteId, decodeWorkspaceRouteId } from "./releases/releaseRoutes.js"
import styles from "./pages.module.css"

interface AgentPageContext {
  readonly description: string
  readonly label: string
  readonly path: string | null
}

const DEFAULT_CONTEXT: AgentPageContext = {
  description: "The workspace-wide view of release readiness, people, source health, and agent work.",
  label: "Overview",
  path: "/"
}

const contexts: Readonly<Record<string, AgentPageContext>> = {
  "/": DEFAULT_CONTEXT,
  "/pair": {
    description: "The private browser-pairing flow. Credentials never become part of the agent context.",
    label: "Browser pairing",
    path: "/pair"
  },
  "/releases": {
    description: "Release relationships, blockers, collaborators, pull requests, and deployment evidence.",
    label: "Releases",
    path: "/releases"
  },
  "/services": {
    description: "Negotiated plugin health and the connections that provide delivery evidence.",
    label: "Services",
    path: "/services"
  }
}

const AGENT_CONTEXT_BASE = "https://control-center.invalid"

const contextFor = (path: string | null): AgentPageContext => {
  if (path === null) return DEFAULT_CONTEXT
  const contextUrl = URL.parse(path, AGENT_CONTEXT_BASE)
  if (contextUrl === null || contextUrl.origin !== AGENT_CONTEXT_BASE) {
    return {
      description:
        "The calling page is not a recognized Control Center context. No fallback workspace or entity is substituted.",
      label: "Context unavailable",
      path: null
    }
  }
  const safePath = `${contextUrl.pathname}${contextUrl.search}${contextUrl.hash}`
  const knownContext = contexts[contextUrl.pathname]
  if (knownContext !== undefined) return { ...knownContext, path: safePath }
  const routeSegments = contextUrl.pathname.split("/")
  const workspaceId = decodeWorkspaceRouteId(routeSegments[2])
  const routeKind = routeSegments[3]
  const releaseId = decodeReleaseRouteId(routeSegments[4])
  const releaseSuffix = routeSegments[5]
  const isReleaseRoute =
    routeSegments[1] === "w" &&
    workspaceId !== null &&
    routeKind === "releases" &&
    releaseId !== null &&
    (releaseSuffix === undefined || releaseSuffix === "preview")
  if (workspaceId !== null && routeKind === "overview" && releaseId === null) {
    return {
      description: `Workspace ${workspaceId} release readiness, people, source health, and agent work.`,
      label: "Workspace overview",
      path: safePath
    }
  }
  if (isReleaseRoute) {
    return {
      description: `Release ${releaseId} in workspace ${workspaceId}. The agent placeholder receives only this explicit route identity until evidence loading is connected.`,
      label: `Release ${releaseId.slice(-6)}`,
      path: safePath
    }
  }
  return {
    description:
      "The calling page is not a recognized Control Center context. No fallback workspace or entity is substituted.",
    label: "Context unavailable",
    path: null
  }
}

/** Preview the calling page context before a local agent runtime is connected. */
export const AgentPage = (): ReactElement => {
  const [searchParams] = useSearchParams()
  const context = contextFor(searchParams.get("from"))

  return (
    <section aria-labelledby="agent-title" className={styles.page}>
      <header className={styles.sectionHeading}>
        <Text className={styles.eyebrow} tone="secondary" variant="label">
          Workspace agent
        </Text>
        <Text as="h1" id="agent-title" variant="page-title">
          Relay context
        </Text>
        <Text tone="secondary" variant="body-large">
          Preview the workspace context that a local agent will receive. No prompt is sent from this screen.
        </Text>
      </header>
      <Surface as="section" className={styles.agentCard} padding="spacious" shape="grouped" tone="secondary">
        <Text tone="secondary" variant="label">
          Current context
        </Text>
        <Text as="h2" variant="section-title">
          {context.label}
        </Text>
        <Text tone="secondary">{context.description}</Text>
        {context.path === null ? null : (
          <Link className={styles.textLink} to={context.path}>
            Return to {context.label}
          </Link>
        )}
      </Surface>
      <StatePanel
        className={styles.agentState}
        description="A local Codex or Claude runner is not connected yet. When it is, agent actions will require evidence and your approval."
        title="Agent runtime not connected"
      />
    </section>
  )
}
