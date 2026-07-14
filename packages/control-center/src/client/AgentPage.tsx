import { StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { Link, useSearchParams } from "react-router"

import styles from "./pages.module.css"

interface AgentPageContext {
  readonly description: string
  readonly label: string
  readonly path: string
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

const contextFor = (path: string | null): AgentPageContext =>
  path === null ? DEFAULT_CONTEXT : (contexts[path] ?? DEFAULT_CONTEXT)

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
        <Link className={styles.textLink} to={context.path}>
          Return to {context.label}
        </Link>
      </Surface>
      <StatePanel
        className={styles.agentState}
        description="A local Codex or Claude runner is not connected yet. When it is, agent actions will require evidence and your approval."
        title="Agent runtime not connected"
      />
    </section>
  )
}
