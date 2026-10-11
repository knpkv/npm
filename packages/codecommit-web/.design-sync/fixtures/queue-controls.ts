// Fixtures from packages/codecommit-web/test/pr-list-view.test.ts and test/queue-controls-view.test.ts.
import { AwsProfileName, AwsRegion, PullRequestId } from "@knpkv/codecommit-core/Domain.js"
import type { FilterSidebarViewProps, PRListViewProps, RecentActivityViewProps, SearchBarViewProps } from "@knpkv/codecommit-web/views"
import { managedRules, noop, now, pagePullRequest } from "./pull-requests.js"

export const filters: SearchBarViewProps["state"] = { filters: [], hot: false, mine: false, review: false, q: "" }
export const selectedFilters: SearchBarViewProps["state"] = {
  ...filters, q: "infra", filters: [{ key: "repo", value: "infra-core" }],
  from: new Date(now - 4 * 86_400_000).toISOString().slice(0, 10), to: new Date(now).toISOString().slice(0, 10)
}
export const filterOptions: FilterSidebarViewProps["options"] = {
  account: ["primary"], author: ["contributor"], approver: ["reviewer"], commenter: [], scope: [],
  repo: ["infra-core"], size: ["small"],
  status: ["open", "pending", "approved", "unknown", "not-required", "mergeable", "conflicts", "merged", "closed"]
}
export const searchProps: SearchBarViewProps = {
  state: filters, onSearchChange: noop, onToggleFilter: noop, onClearDateRange: noop, onClearAll: noop
}
export const sidebarProps: FilterSidebarViewProps = {
  state: filters, currentUser: "reviewer", options: filterOptions,
  onToggleOption: noop, onModeChange: noop, onClearAll: noop
}
export const notifications: RecentActivityViewProps["notifications"] = [{
  id: 1, pullRequestId: "7", awsAccountId: "111122223333", type: "new_comment", title: "Review feedback",
  profile: "primary", repositoryName: "infra-core", accountRegion: "eu-west-1", message: "New feedback",
  createdAt: new Date(now - 3 * 3_600_000).toISOString(), read: 0
}]
export const emptySnapshot: PRListViewProps["snapshot"] = {
  pullRequests: [], accounts: [{ profile: AwsProfileName.make("primary"), region: AwsRegion.make("eu-west-1"), enabled: true }],
  enabledProfiles: ["primary"], status: "idle", currentUser: "reviewer", notifications: undefined, permissionPrompt: undefined
}
export const queueSnapshot: PRListViewProps["snapshot"] = {
  ...emptySnapshot,
  pullRequests: [
    pagePullRequest({ id: PullRequestId.make("1"), title: "Change 1", isApproved: false, approvalRules: managedRules }),
    pagePullRequest({ id: PullRequestId.make("2"), title: "Change 2", approvalRules: managedRules.map((rule) => ({ ...rule, satisfied: true })) }),
    pagePullRequest({ id: PullRequestId.make("3"), title: "Change 3", approvalUnknown: { _tag: "Throttled" } }),
    pagePullRequest({ id: PullRequestId.make("4"), title: "Change 4", status: "MERGED" })
  ]
}
export const queueActions: PRListViewProps["actions"] = {
  onFacetChange: noop, onToggleFilter: noop, onRetryConnection: noop, onOpenSettings: noop, onSsoLogin: noop
}
