// Fixtures from packages/codecommit-web/test/workbench-rail.test.ts and packages/codecommit-web/test/pr-row-presentation.test.ts.
import { AwsProfileName, AwsRegion, type PullRequest, PullRequestId, RepositoryName } from "@knpkv/codecommit-core/Domain.js"
import type { PRRowProps, WorkbenchRailViewProps } from "@knpkv/codecommit-web/views"

type Queue = WorkbenchRailViewProps["queue"]
type Row = Queue["rows"][number]

// Anchor age labels to module load so captures and live cards show the same age.
const now = Date.now()
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
  author: "ana",
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
