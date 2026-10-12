// Fixtures from packages/codecommit-web/test/pr-list-view.test.ts and test/queue-controls-view.test.ts.
import { FilterSidebarView, PRListView, SearchBarView } from "@knpkv/codecommit-web-design-system"
import type { PRListViewProps } from "@knpkv/codecommit-web/views"
import { now } from "../fixtures/pull-requests.js"
import { emptySnapshot, filters, queueActions, queueSnapshot, searchProps, sidebarProps } from "../fixtures/queue-controls.js"

const props: PRListViewProps = {
  snapshot: queueSnapshot, connection: { _tag: "Live" }, snapshotSeen: true, filterState: filters,
  now: new Date(now), actions: queueActions,
  renderControls: ({ currentUser, filterState }) => <>
    <SearchBarView {...searchProps} state={filterState} />
    <FilterSidebarView {...sidebarProps} state={filterState} currentUser={currentUser} />
  </>
}
/** Pending, approved and unknown approvals keep separate queue counts. */
export const Queue = () => <PRListView {...props} />
/** The first account read has no rows yet. */
export const Loading = () => <PRListView {...props} snapshot={{ ...emptySnapshot, status: "loading" }} />
/** An unsigned browser needs another sign-in link. */
export const SignedOut = () => <PRListView {...props} snapshot={emptySnapshot} connection={{ _tag: "Unauthenticated", detail: "Sign in again" }} />
/** A configured account has no loaded rows and offers SSO sign-in. */
export const SsoNeeded = () => <PRListView {...props} snapshot={emptySnapshot} />
/** Cached rows are hidden by the tested unmatched search. */
export const FilteredEmpty = () => <PRListView {...props} filterState={{ ...filters, q: "absent" }} />
