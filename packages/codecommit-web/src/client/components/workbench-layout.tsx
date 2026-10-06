/**
 * Layout route for the review Workbench: the queue rail beside whatever pull request route is
 * open. From 760px the rail sits to the left; below that the page shows the pull request alone
 * (its own back link returns to the queue), because a phone reads one region at a time.
 *
 * @module
 */
import { Outlet, useParams } from "react-router"
import { WorkbenchRail } from "./workbench-rail.js"
import styles from "./workbench-layout.module.css"

export function WorkbenchLayout() {
  const { accountId, prId } = useParams<{ accountId: string; prId: string }>()
  const current = accountId !== undefined && prId !== undefined ? { accountId, pullRequestId: prId } : undefined
  return (
    <div className={styles.container}>
      <div className={styles.workbench}>
        <div className={styles.rail}>
          <WorkbenchRail current={current} />
        </div>
        <div className={styles.main}>
          <Outlet />
        </div>
      </div>
    </div>
  )
}
