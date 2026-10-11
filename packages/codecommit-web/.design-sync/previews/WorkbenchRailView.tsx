// Fixtures from packages/codecommit-web/test/workbench-rail.test.ts.
import { WorkbenchRailView } from "@knpkv/codecommit-web-design-system"
import { approvalUnknownQueue, conflictQueue, identityUnknownQueue, waitingQueue } from "../fixtures/pull-requests.js"

/** Two reviews wait, with one owned pull request below. */
export const Waiting = () => <WorkbenchRailView currentUser="owner" queue={waitingQueue} />
/** Nothing waits on review; the owned change has a conflict. */
export const OwnConflict = () => <WorkbenchRailView currentUser="owner" queue={conflictQueue} />
/** Every open pull request remains visible when caller identity is unknown. */
export const IdentityUnknown = () => <WorkbenchRailView currentUser={undefined} queue={identityUnknownQueue} />
/** Failed approval evaluation stays separate from the review count. */
export const ApprovalUnknown = () => <WorkbenchRailView currentUser="owner" queue={approvalUnknownQueue} />
