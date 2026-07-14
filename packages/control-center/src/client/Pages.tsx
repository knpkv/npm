import { StatePanel, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import styles from "./pages.module.css"

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
