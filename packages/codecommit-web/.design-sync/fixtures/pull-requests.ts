// Fixtures from packages/codecommit-web/test/{workbench-rail,pr-row-presentation,pr-detail-view,pr-comments-view,pr-lifecycle-view,pr-approvals-view}.test.ts, test/pr-view-fixtures.ts and e2e/approval-unknown.spec.ts.
import { AwsProfileName, AwsRegion, PullRequestId, RepositoryName } from "@knpkv/codecommit-core/Domain.js"
import type { PRRowProps, WorkbenchRailViewProps } from "@knpkv/codecommit-web/views"
import type { PRApprovalsViewProps, PRCommentsViewProps, PRDetailViewProps, PRRequirementDialogsViewProps } from "@knpkv/codecommit-web/views"
import type { CommentThreadJsonEncoded, PRCommentLocationJson, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { calculateHealthScore, healthUnknownReason } from "@knpkv/codecommit-core/HealthScore.js"
import { Cause, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"

type Queue = WorkbenchRailViewProps["queue"]
type Row = Queue["rows"][number]

// Anchor age labels to module load so captures and live cards show the same age.
export const now = Date.now()
const hour = 3_600_000
const day = 86_400_000

// Fixture objects in decoded form; brands come from the domain's constructors, as in the tests.
export const pullRequest = (id: string, overrides: Partial<PullRequest> = {}): PullRequest => ({
  account: {
    profile: AwsProfileName.make("platform-prod"),
    region: AwsRegion.make("eu-west-1")
  },
  approvalRules: [{ poolMembers: ["owner"], poolMemberArns: [], requiredApprovals: 1, ruleName: "Approvals", satisfied: false }],
  approvedBy: [],
  approvedByArns: [],
  author: "contributor",
  commentedBy: [],
  creationDate: new Date(now - day),
  destinationBranch: "main",
  id: PullRequestId.make(id),
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: new Date(now - hour),
  link: "https://example.invalid/pr",
  consoleUrl: "https://example.invalid/pr",
  repositoryName: RepositoryName.make("infra-core"),
  sourceBranch: "feature",
  status: "OPEN",
  title: `Change ${id}`,
  ...overrides
})

export const caller: PRRowProps["caller"] = { identities: undefined, username: "owner" }
const unknown = { count: 0, reason: undefined }

const reviewOne: Row = {
  group: "review", openMs: 2 * 86_400_000, quietMs: 3_600_000,
  pullRequest: pullRequest("1", { creationDate: new Date(now - 2 * day) }),
  rule: { approved: 0, required: 1, name: "Approvals" }, stuck: undefined
}
const reviewTwo: Row = { ...reviewOne, openMs: 86_400_000, pullRequest: pullRequest("2") }
const own: Row = {
  ...reviewTwo, group: "yours", pullRequest: pullRequest("3", { author: "owner" }), stuck: "approvals"
}

export const waitingQueue: Queue = {
  approvalUnknown: unknown,
  rows: [reviewOne, reviewTwo, own],
  summary: { _tag: "Waiting", count: 2, oldest: reviewOne }
}
export const conflictQueue: Queue = {
  approvalUnknown: unknown,
  rows: [{ ...own, pullRequest: pullRequest("9", { author: "owner", isMergeable: false }), stuck: "conflicts" }],
  summary: { _tag: "Clear", next: { ...own, pullRequest: pullRequest("9", { author: "owner", isMergeable: false }), stuck: "conflicts" }, pooled: 0 }
}
export const identityUnknownQueue: Queue = {
  approvalUnknown: unknown,
  rows: [{ ...reviewTwo, group: "unsorted" }],
  summary: { _tag: "Unknown" }
}
export const approvalUnknownQueue: Queue = {
  approvalUnknown: { count: 2, reason: { _tag: "NotPermitted" } },
  rows: [
    reviewOne,
    ...["2", "3"].map((id): Row => ({
      ...reviewTwo, group: "pool", rule: undefined, stuck: "unverified",
      pullRequest: pullRequest(id, { approvalUnknown: { _tag: "NotPermitted" }, isApproved: true })
    }))
  ],
  summary: { _tag: "Waiting", count: 1, oldest: reviewOne }
}

export const noop = () => {}

// The page tests' decoded facts, with the same ages relative to this module's clock.
export const pagePullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => pullRequest("7", {
  account: {
    profile: AwsProfileName.make("primary"), region: AwsRegion.make("eu-west-1"),
    awsAccountId: "111122223333", repoAccountId: "111122223333"
  },
  approvalRules: [], author: "contributor", isApproved: true,
  title: "feat(queue): simplify retries", description: "**Reason for the change**",
  creationDate: new Date(now - 2 * day - 3.5 * hour),
  lastModifiedDate: new Date(now - 3 * hour), fetchedAt: new Date(now - 0.5 * hour),
  link: "https://example.invalid/pr/7", consoleUrl: "https://example.invalid/pr/7",
  ...overrides
})

export const managedRules: PullRequest["approvalRules"] = [{
  ruleName: "Required approvers", requiredApprovals: 1, poolMembers: ["reviewer"],
  poolMemberArns: ["CodeCommitApprovers:111122223333:reviewer"], satisfied: false
}]
export const repositoryRule: PullRequest["approvalRules"][number] = {
  ruleName: "Repository rule", fromTemplate: "base-template", requiredApprovals: 1,
  poolMembers: ["template-reviewer"], poolMemberArns: [], satisfied: true
}

export const detailActions: PRDetailViewProps["actions"] = {
  copied: false, isRefreshing: false, isSubscribed: false, sandboxState: "create",
  onBack: noop, onRefresh: noop, onSubscriptionToggle: noop, onSandbox: noop,
  onCopyLink: noop, onOpenConsole: noop, onRetryLoad: noop, onOpenAccountsSettings: noop
}
export const approvalActions: PRApprovalsViewProps["actions"] = {
  currentUser: "reviewer", knownUserArns: new Map(), repoAccountId: "111122223333",
  permissionPrompt: false, onSetApprovers: noop,
  onRemoveRule: () => Promise.resolve({ _tag: "Removed" }), onRefresh: () => Promise.resolve(true)
}
export const dialogState: PRRequirementDialogsViewProps["granted"] = {
  visible: false, dontRemind: false, onOpenChange: noop, onDontRemindChange: noop,
  onCancel: noop, onContinue: noop
}
export const requirementDialogs: PRRequirementDialogsViewProps = { granted: dialogState, docker: dialogState }

const reviewComment: CommentThreadJsonEncoded["root"] = {
  id: "c1", content: "**Review feedback**", author: "reviewer",
  creationDate: new Date(now - 2 * day - 1.5 * hour).toISOString(), deleted: false, lineNumber: 12
}
export const commentLocation: typeof PRCommentLocationJson.Type = {
  filePath: "src/retry.ts", beforeCommitId: "base", afterCommitId: "head", relativeFileVersion: "AFTER",
  comments: [{
    root: reviewComment, replies: []
  }]
}
export const feedbackLocation: typeof PRCommentLocationJson.Type = {
  ...commentLocation,
  comments: [{
    root: { ...reviewComment, id: "review", content: "Deleted feedback", deleted: true },
    replies: [{
      root: {
        id: "reply", author: "contributor", content: "Addressed", deleted: false,
        creationDate: new Date(now - 2 * day - 0.5 * hour).toISOString()
      }, replies: []
    }]
  }]
}
export const readyComments: PRCommentsViewProps["comments"] = AsyncResult.success([commentLocation])
export const feedbackComments: PRCommentsViewProps["comments"] = AsyncResult.success([feedbackLocation])
export const emptyComments: PRCommentsViewProps["comments"] = AsyncResult.success([])
export const loadingComments: PRCommentsViewProps["comments"] = AsyncResult.initial()
export const failedComments: PRCommentsViewProps["comments"] = AsyncResult.failure(Cause.die("Unavailable"))
export const commentProps: PRCommentsViewProps = {
  comments: readyComments, navigation: null, visible: true, now: new Date(now),
  onCountChange: noop, onNavigateToDiff: noop
}

// Derive category data from the tested PR facts, rather than inventing a score breakdown.
export const healthFor = (pr: PullRequest): PRDetailViewProps["health"] => ({
  score: Option.getOrUndefined(calculateHealthScore(pr, new Date(now))), unknownReason: healthUnknownReason(pr)
})
export const unknownHealth: PRDetailViewProps["health"] = {
  score: undefined, unknownReason: Option.some("creation date missing")
}
