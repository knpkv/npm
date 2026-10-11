// Fixtures from packages/codecommit-web/test/pr-detail-view.test.ts, test/pr-view-fixtures.ts and test/pr-files-diff-view.test.ts.
import { PRCommentsView, PRDetailView, PRFilesDiffView, PRLifecycleView } from "@knpkv/codecommit-web-design-system"
import type { PRDetailViewProps } from "@knpkv/codecommit-web/views"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { approvalActions, commentProps, detailActions, noop, now, pagePullRequest, readyComments, requirementDialogs, unknownHealth } from "../fixtures/pull-requests.js"
import { filesPropsFor } from "../fixtures/review-workspace.js"

const props: PRDetailViewProps = {
  pullRequest: AsyncResult.success(pagePullRequest()), routeAmbiguous: false, now: new Date(now),
  health: unknownHealth, actions: detailActions, approvals: approvalActions, dialogs: requirementDialogs,
  comments: { count: 1, navigation: null, refreshGeneration: 2, onCountChange: noop, onNavigateToDiff: noop },
  review: { accountId: "primary", commentNavigation: null, commentsRefreshGeneration: 2, refreshGeneration: 5, onFindingPosted: noop, onNavigateToComment: noop },
  renderComments: ({ navigation, now, onCountChange, onNavigateToDiff, visible }) => <PRCommentsView {...commentProps} navigation={navigation} now={now} onCountChange={onCountChange} onNavigateToDiff={onNavigateToDiff} visible={visible} />,
  renderLifecycle: (pr) => <PRLifecycleView pr={pr} comments={readyComments} />,
  renderReviewWorkspace: ({ pullRequest }) => <PRFilesDiffView {...filesPropsFor({ pullRequestId: pullRequest.id })} />
}
/** Ready pull request with the bundle's diff, comments and lifecycle slots. */
export const Ready = () => <PRDetailView {...props} />
/** The provider read has not completed. */
export const Loading = () => <PRDetailView {...props} pullRequest={AsyncResult.initial()} />
/** Disabled account offers settings and retry. */
export const AccountDisabled = () => <PRDetailView {...props} pullRequest={AsyncResult.fail({ message: "Account disabled", fixInSettings: true })} />
/** Missing repository and region block the runtime slots. */
export const Ambiguous = () => <PRDetailView {...props} routeAmbiguous />
/** Cached content stays visible while refresh and sandbox stop are pending. */
export const Refreshing = () => <PRDetailView {...props} actions={{ ...detailActions, isRefreshing: true, isSubscribed: true, copied: true, sandboxState: "stopping" }} />
