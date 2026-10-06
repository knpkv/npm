/**
 * Layout route for the review Workbench: the queue rail beside whatever pull request route is
 * open. From 760px of content (an 800px window) the rail sits to the left; below that, 768px
 * tablets included, the page shows the pull request alone
 * (its own back link returns to the queue), because a phone reads one region at a time.
 *
 * @module
 */
import { Outlet, useParams, useSearchParams } from "react-router"
import { pullRequestRouteCoordinates } from "../codecommit-route.js"
import { WorkbenchRail } from "./workbench-rail.js"
import styles from "./workbench-layout.module.css"

export function WorkbenchLayout() {
  const { accountId, prId } = useParams<{ accountId: string; prId: string }>()
  const [searchParams] = useSearchParams()
  const route = pullRequestRouteCoordinates(accountId, prId, searchParams)
  return (
    <div className={styles.container}>
      <div className={styles.workbench}>
        <div className={styles.rail}>
          <WorkbenchRail route={route} />
        </div>
        <div className={styles.main}>
          <Outlet />
        </div>
      </div>
    </div>
  )
}
