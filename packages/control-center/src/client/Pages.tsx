import { StatePanel, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { Link } from "react-router"
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

/** Keep an unknown application URL visible and recoverable without substituting another page. */
export const NotFoundPage = (): ReactElement => (
  <section className={styles.page}>
    <StatePanel
      action={
        <Link className={styles.textLink} to="/">
          Return to Control Center
        </Link>
      }
      description="The requested page does not exist. Check the address or return home."
      title="Page not found"
    />
  </section>
)
