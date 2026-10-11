// Fixtures from packages/codecommit-web/test/pr-comments-view.test.ts, test/pr-lifecycle-view.test.ts and test/pr-view-fixtures.ts.
// Deleted-root threads have no visible content; their IDs remain in counts, so they have no card.
import { PRCommentsView } from "@knpkv/codecommit-web-design-system"
import { commentProps, emptyComments, failedComments, loadingComments } from "../fixtures/pull-requests.js"

/** File-bound review feedback offers an exact diff jump. */
export const Feedback = () => <PRCommentsView {...commentProps} />
/** Conversation read has not completed. */
export const Loading = () => <PRCommentsView {...commentProps} comments={loadingComments} />
/** Failed conversation read offers refresh guidance. */
export const Unavailable = () => <PRCommentsView {...commentProps} comments={failedComments} />
/** Loaded conversation contains no comments. */
export const Empty = () => <PRCommentsView {...commentProps} comments={emptyComments} />
