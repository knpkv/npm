import { StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { BrowserSessionStatus } from "./BrowserSessionStatus.js"
import styles from "./pages.module.css"

const Metric = ({ label, value }: { readonly label: string; readonly value: string }): ReactElement => (
  <Surface as="article" className={styles.metric} padding="spacious" shape="grouped" tone="secondary">
    <Text tone="secondary" variant="label">
      {label}
    </Text>
    <Text as="strong" className={styles.metricValue} variant="verdict">
      {value}
    </Text>
  </Surface>
)

/** Bird's-eye landing state before a workspace has synchronized its first sources. */
export const TodayPage = (): ReactElement => (
  <section aria-labelledby="control-center-title">
    <div className={styles.hero}>
      <Text className={styles.eyebrow} tone="secondary" variant="label">
        <span aria-hidden="true" className={styles.pulse} />
        Workspace is private
      </Text>
      <Text as="h1" className={styles.title} id="control-center-title" variant="verdict">
        Everything that can ship.
      </Text>
      <Text className={styles.lede} tone="secondary" variant="body-large">
        One factual view of releases, tickets, pull requests, deployments, collaborators, and agent work.
      </Text>
      <div aria-live="polite" className={styles.actions}>
        <BrowserSessionStatus />
      </div>
    </div>
    <div aria-label="Portfolio summary" className={styles.grid}>
      <Metric label="Ready to ship" value="—" />
      <Metric label="Needs a person" value="—" />
      <Metric label="Sources online" value="—" />
    </div>
  </section>
)

const EmptyPage = ({ description, title }: { readonly description: string; readonly title: string }): ReactElement => (
  <section aria-labelledby="page-title" className={styles.page}>
    <header className={styles.sectionHeading}>
      <Text as="h1" id="page-title" variant="page-title">
        {title}
      </Text>
      <Text tone="secondary" variant="body-large">
        {description}
      </Text>
    </header>
    <StatePanel
      className={styles.empty}
      description="Pair this browser, then connect a service. Control Center will preserve source truth and show the relationships here."
      title="Waiting for the first source"
    />
  </section>
)

export const ReleasesPage = (): ReactElement => (
  <EmptyPage
    description="A compact, human view of what is in every release and where it has reached."
    title="Releases"
  />
)

export const ServicesPage = (): ReactElement => (
  <EmptyPage description="Health and configuration for every negotiated delivery plugin." title="Services" />
)
