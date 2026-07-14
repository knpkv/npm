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
  label: "Today",
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

/** Show the workspace agent with the calling page preserved as explicit context. */
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
          Relay
        </Text>
        <Text tone="secondary" variant="body-large">
          One thread that keeps the page you came from attached to every question, proposal, and check.
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
        action={
          <Link className={styles.linkButton} to="/pair">
            Pair this browser
          </Link>
        }
        className={styles.agentState}
        description="Pairing gives Relay a private workspace session. Agent actions will still require evidence and your approval."
        icon="link"
        title="Context is ready"
        tone="progress"
      />
    </section>
  )
}
