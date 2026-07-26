import { StatePanel } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { Link } from "react-router"
import styles from "./pages.module.css"

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
