import {
  AgentConnectTarget,
  AgentWorkerIdentity,
  WorkAbandon,
  workAbandonIsRecordable,
  WorkAdmit,
  WorkReassign,
  workReassignIsRecordable,
  WorkRecover
} from "@knpkv/herdr-fleet/model"
import { Equal, Schema, Struct } from "effect"

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)
// Approval hosts are bounded identifiers, not DNS names; the approvals app also
// accepts labels such as "PI 5".
const ApprovalHostName = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
const Text = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}]+$/u)
)
const Timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
)
/**
 * Credential-free HTTP(S) URL persisted for an outbound handoff. Provider
 * credentials and private locators never belong in this representation.
 */
const LinkUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter(
    (value) => {
      if (!URL.canParse(value)) return false
      const url = new URL(value)
      return (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === ""
    },
    { expected: "an HTTP(S) URL without embedded credentials" }
  )
)

export const workHistoryMaxEvents = 16_384
export const workSnapshotMaxGoals = 1_024

export const WorkGoalId = Identifier
export type WorkGoalId = typeof WorkGoalId.Type

export const WorkDispatchRequestId = Identifier
export type WorkDispatchRequestId = typeof WorkDispatchRequestId.Type

export const WorkLaneOperationId = Identifier
export type WorkLaneOperationId = typeof WorkLaneOperationId.Type

export const WorkCoordinatorSessionId = Identifier
export type WorkCoordinatorSessionId = typeof WorkCoordinatorSessionId.Type

export const WorkState = Schema.Literals([
  "planned",
  "working",
  "blocked",
  "review",
  "deployed",
  "completed",
  "abandoned"
])
export type WorkState = typeof WorkState.Type

/** A goal in one of these states is finished: nothing may bind to it, link it, or move it back. */
export const isTerminalWorkState = (state: WorkState): boolean =>
  state === "completed" || state === "deployed" || state === "abandoned"

export const DeliveryStage = Schema.Literals(["local", "review", "pull_request", "merged", "deployed"])
export type DeliveryStage = typeof DeliveryStage.Type

export const WorkOwner = Schema.Struct({ id: Identifier, name: Text })
export interface WorkOwner extends Schema.Schema.Type<typeof WorkOwner> {}

export const WorkRepository = Schema.Struct({
  repository: Text,
  branch: Text
})
export interface WorkRepository extends Schema.Schema.Type<typeof WorkRepository> {}

export const WorkSpend = Schema.Struct({
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
  minorUnits: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
})
export interface WorkSpend extends Schema.Schema.Type<typeof WorkSpend> {}

export const WorkBlocker = Schema.Struct({
  summary: Text,
  since: Timestamp
})
export interface WorkBlocker extends Schema.Schema.Type<typeof WorkBlocker> {}

export const WorkAgentHierarchy = Schema.Struct({
  agent: AgentWorkerIdentity
})
export interface WorkAgentHierarchy extends Schema.Schema.Type<typeof WorkAgentHierarchy> {}

export const WorkActivityKind = Schema.Literals([
  "note",
  "status",
  "blocker",
  "request",
  "review",
  "shipment"
])
export type WorkActivityKind = typeof WorkActivityKind.Type

export const WorkActivity = Schema.Struct({
  id: Identifier,
  kind: WorkActivityKind,
  summary: Text,
  occurredAt: Timestamp
})
export interface WorkActivity extends Schema.Schema.Type<typeof WorkActivity> {}

export const WorkApprovalTarget = Schema.Struct({
  host: ApprovalHostName,
  jobId: Identifier,
  url: LinkUrl
}).check(
  Schema.makeFilter(
    ({ host, jobId, url }) => {
      const parsed = new URL(url)
      const queryKeys = [...parsed.searchParams.keys()]
      const approvalHosts = parsed.searchParams.getAll("approvalHost")
      const approvalJobs = parsed.searchParams.getAll("approvalJob")
      return (
        parsed.pathname === "/" &&
        parsed.hash === "" &&
        queryKeys.length === 3 &&
        parsed.searchParams.getAll("tab").length === 1 &&
        parsed.searchParams.get("tab") === "approvals" &&
        approvalHosts.length === 1 &&
        approvalJobs.length === 1 &&
        approvalHosts[0]?.toLowerCase() === host.toLowerCase() &&
        approvalJobs[0] === jobId
      )
    },
    { expected: "an approval URL with matching host and job identity" }
  )
)
export interface WorkApprovalTarget extends Schema.Schema.Type<typeof WorkApprovalTarget> {}

/**
 * Checks a decoded approval target against the origin resolved by the
 * configuration-aware approvals boundary before the target is persisted.
 */
export const approvalTargetMatchesOrigin = (
  target: WorkApprovalTarget,
  authoritativeOrigin: string
): boolean => new URL(target.url).origin === authoritativeOrigin

export const WorkRequestState = Schema.Literals(["open", "approved", "rejected", "fulfilled"])
export type WorkRequestState = typeof WorkRequestState.Type

export const WorkRequest = Schema.Struct({
  id: Identifier,
  summary: Text,
  state: WorkRequestState,
  requestedAt: Timestamp,
  approvalTarget: Schema.NullOr(WorkApprovalTarget)
})
export interface WorkRequest extends Schema.Schema.Type<typeof WorkRequest> {}

export const WorkReviewState = Schema.Literals(["not_requested", "requested", "changes_requested", "approved"])
export type WorkReviewState = typeof WorkReviewState.Type

/** Review status plus the persisted credential-free destination, when known. */
export const WorkReview = Schema.Struct({
  state: WorkReviewState,
  summary: Schema.NullOr(Text),
  updatedAt: Timestamp,
  url: Schema.NullOr(LinkUrl)
})
export interface WorkReview extends Schema.Schema.Type<typeof WorkReview> {}

export const WorkGoalFamily = Schema.Struct({
  canonicalGoalId: WorkGoalId,
  role: Schema.Literals(["canonical", "superseded"])
})
export interface WorkGoalFamily extends Schema.Schema.Type<typeof WorkGoalFamily> {}

export const WorkGoal = Schema.Struct({
  id: WorkGoalId,
  title: Text,
  summary: Text,
  detail: Text,
  state: WorkState,
  owner: WorkOwner,
  repository: WorkRepository,
  spend: Schema.NullOr(WorkSpend),
  delivery: DeliveryStage,
  blocker: Schema.NullOr(WorkBlocker),
  connectTarget: Schema.NullOr(AgentConnectTarget),
  goalFamily: Schema.optionalKey(WorkGoalFamily),
  agentHierarchy: Schema.optionalKey(Schema.NullOr(WorkAgentHierarchy)),
  activity: Schema.optionalKey(
    Schema.Array(WorkActivity)
      .check(Schema.isMaxLength(128))
      .check(
        Schema.makeFilter(
          (activities) => new Set(activities.map(({ id }) => id)).size === activities.length,
          { expected: "unique activity ids" }
        )
      )
  ),
  blockers: Schema.optionalKey(
    Schema.Array(WorkBlocker)
      .check(Schema.isMaxLength(32))
      .check(
        Schema.makeFilter(
          (blockers) =>
            new Set(blockers.map(({ since, summary }) => `${since}\u0000${summary}`)).size === blockers.length,
          { expected: "unique blocker records" }
        )
      )
  ),
  requests: Schema.optionalKey(
    Schema.Array(WorkRequest)
      .check(Schema.isMaxLength(32))
      .check(
        Schema.makeFilter(
          (requests) => new Set(requests.map(({ id }) => id)).size === requests.length,
          { expected: "unique request ids" }
        )
      )
  ),
  review: Schema.optionalKey(Schema.NullOr(WorkReview)),
  approvalTarget: Schema.optionalKey(Schema.NullOr(WorkApprovalTarget)),
  createdAt: Timestamp,
  updatedAt: Timestamp
}).check(
  Schema.makeFilter(
    (goal) => {
      const hasBlocker = goal.blocker !== null ||
        (goal.blockers !== undefined && goal.blockers.length > 0)
      const agent = goal.agentHierarchy?.agent
      const family = goal.goalFamily
      const isDetailTimestamp = (timestamp: number): boolean =>
        timestamp >= goal.createdAt && timestamp <= goal.updatedAt
      return (
        goal.updatedAt >= goal.createdAt &&
        (goal.state === "blocked") === hasBlocker &&
        (goal.blockers === undefined || goal.blocker === null) &&
        (goal.blocker === null || isDetailTimestamp(goal.blocker.since)) &&
        (goal.blockers === undefined || goal.blockers.every(({ since }) => isDetailTimestamp(since))) &&
        (goal.activity === undefined || goal.activity.every(({ occurredAt }) => isDetailTimestamp(occurredAt))) &&
        (goal.requests === undefined || goal.requests.every(({ requestedAt }) => isDetailTimestamp(requestedAt))) &&
        (goal.review === undefined || goal.review === null || isDetailTimestamp(goal.review.updatedAt)) &&
        (family === undefined || (family.role === "canonical") === (family.canonicalGoalId === goal.id)) &&
        (agent === undefined || agent === null || (
          (agent.relationship === undefined || agent.relationship.parentAgentId !== agent.agentId) &&
          goal.connectTarget !== null &&
          goal.connectTarget.agentId === agent.agentId &&
          goal.connectTarget.host.toLowerCase() === agent.host.toLowerCase()
        ))
      )
    },
    { expected: "ordered goal timestamps, blocker state, and non-cyclic authoritative agent target" }
  )
)
export interface WorkGoal extends Schema.Schema.Type<typeof WorkGoal> {}

export const WorkGoalFamilyGroup = Schema.Struct({
  canonicalGoalId: WorkGoalId,
  canonical: WorkGoal,
  superseded: Schema.Array(WorkGoal).check(Schema.isMaxLength(workSnapshotMaxGoals))
}).check(
  Schema.makeFilter(
    (group) =>
      group.superseded.length > 0 &&
      group.canonical.goalFamily?.role === "canonical" &&
      group.canonical.goalFamily.canonicalGoalId === group.canonicalGoalId &&
      group.superseded.every(
        (goal) =>
          goal.goalFamily?.role === "superseded" &&
          goal.goalFamily.canonicalGoalId === group.canonicalGoalId
      ) &&
      new Set(group.superseded.map(({ id }) => id)).size === group.superseded.length &&
      !group.superseded.some(({ id }) => id === group.canonicalGoalId),
    { expected: "consistent goal-family history group" }
  )
)
export interface WorkGoalFamilyGroup extends Schema.Schema.Type<typeof WorkGoalFamilyGroup> {}

export const WorkGoalCheckpoint = Schema.Struct({
  version: Schema.Literal("herdr.work.event.v1"),
  eventId: Identifier,
  occurredAt: Timestamp,
  goal: WorkGoal
}).check(
  Schema.makeFilter(
    (event) => event.occurredAt === event.goal.updatedAt,
    { expected: "checkpoint occurrence equal to the durable goal update timestamp" }
  )
)
export interface WorkGoalCheckpoint extends Schema.Schema.Type<typeof WorkGoalCheckpoint> {}

const CanonicalWorktree = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}]+$/u),
  Schema.makeFilter(
    (value) => {
      const isPosix = value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
      const isWindows = /^[A-Za-z]:[\\/]/.test(value) && !(value.includes("/") && value.includes("\\"))
      if (!isPosix && !isWindows) return false
      const separator = isPosix || value.includes("/") ? "/" : "\\"
      const parts = value.split(separator)
      const isReservedWindowsDevice = (part: string): boolean =>
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part)
      return parts.slice(1).every((part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        (!isWindows || (
          !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !isReservedWindowsDevice(part)
        ))
      )
    },
    { expected: "an absolute canonical worktree path" }
  )
)

const Branch = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9._/-]+$/),
  Schema.makeFilter(
    (value) =>
      value !== "@" &&
      value !== "HEAD" &&
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("//") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock")),
    { expected: "a valid Git branch ref" }
  )
)

const ExactHead = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  Schema.isMaxLength(64)
)

const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
)
const ExpectedRevision = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 })
)

export const WorkLanePhase = Schema.Literals([
  "claim",
  "implementation",
  "validation",
  "review",
  "shipped"
])
export type WorkLanePhase = typeof WorkLanePhase.Type

const CodexSessionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
)

export const WorkLaneReconciliationProof = Schema.Struct({
  repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  pullRequest: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  expectedHead: ExactHead,
  expectedOwner: WorkOwner,
  expectedGoalEventId: Identifier,
  bindingDispatchRequestId: WorkDispatchRequestId,
  sessionId: CodexSessionId,
  worker: AgentWorkerIdentity
})

/** Compare-and-set authority for one package-owned Work lane. */
export const WorkLaneClaim = Schema.Struct({
  operationId: WorkLaneOperationId,
  goalId: WorkGoalId,
  laneId: WorkGoalId,
  worktree: CanonicalWorktree,
  branch: Branch,
  head: ExactHead,
  owner: WorkOwner,
  parent: Schema.NullOr(Identifier),
  phase: WorkLanePhase,
  expectedRevision: ExpectedRevision,
  reconciliation: Schema.optionalKey(WorkLaneReconciliationProof)
})
export interface WorkLaneClaim extends Schema.Schema.Type<typeof WorkLaneClaim> {}

export const WorkLaneClaimed = Schema.Struct({
  ...WorkLaneClaim.fields,
  revision: Revision
}).check(
  Schema.makeFilter(
    ({ expectedRevision, revision }) => revision === expectedRevision + 1,
    { expected: "a claimed revision exactly one greater than its expected revision" }
  )
)
export interface WorkLaneClaimed extends Schema.Schema.Type<typeof WorkLaneClaimed> {}

/** Compare-and-set authority used exactly when a dispatched worker starts. */
export const WorkAgentBindingRequest = Schema.Struct({
  version: Schema.Literal("herdr.work.agent-binding-request.v1"),
  dispatchRequestId: WorkDispatchRequestId,
  laneId: WorkGoalId,
  expectedRevision: ExpectedRevision,
  worker: AgentWorkerIdentity,
  prospectiveAdmission: Schema.optionalKey(Schema.Struct({
    sessionId: CodexSessionId,
    workAssignment: Text,
    baseHead: ExactHead,
    expectedAbsenceToken: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    approvalJobId: Identifier,
    approvalActor: Identifier
  })),
  /**
   * Set when the reconciler admitted an observed worker without an approval:
   * the same evidence as a prospective admission, credited to the observation
   * that showed it.
   */
  observedAdmission: Schema.optionalKey(Schema.Struct({
    sessionId: CodexSessionId,
    workAssignment: Text,
    baseHead: ExactHead,
    expectedAbsenceToken: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    actor: Schema.Literal("reconciler"),
    observationId: Identifier
  })),
  existingGoalRecovery: Schema.optionalKey(
    Schema.Struct({
      sessionId: CodexSessionId,
      workAssignment: Text,
      baseHead: ExactHead,
      expectedHistoryToken: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      expectedGoalEventId: Identifier,
      expectedGoalUpdatedAt: Timestamp,
      approvalJobId: Identifier,
      approvalActor: Identifier,
      approvalApprovedBy: Identifier,
      approvalApprovedAt: Timestamp,
      approvalHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
    })
  ),
  /** Set when an approved `work.reassign` job moved the lane's binding to a new worker. */
  ownerReassignment: Schema.optionalKey(
    Schema.Struct({
      previousDispatchRequestId: WorkDispatchRequestId,
      approvalJobId: Identifier,
      approvalActor: Identifier,
      approvalApprovedBy: Identifier,
      approvalApprovedAt: Timestamp,
      approvalHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
    })
  )
}).check(
  Schema.makeFilter(
    ({ existingGoalRecovery, observedAdmission, ownerReassignment, prospectiveAdmission }) =>
      [existingGoalRecovery, observedAdmission, ownerReassignment, prospectiveAdmission].filter((kind) =>
        kind !== undefined
      ).length <= 1,
    { expected: "one truthful owner-linkage provenance kind" }
  )
)
export interface WorkAgentBindingRequest extends Schema.Schema.Type<typeof WorkAgentBindingRequest> {}

/**
 * The admission evidence a binding was created with, whether an approved job
 * (`prospectiveAdmission`) or the reconciler (`observedAdmission`) admitted it.
 * Session, assignment and base-head checks read it so both kinds behave alike.
 */
export const admissionEvidence = (
  request: WorkAgentBindingRequest
): WorkAgentBindingRequest["prospectiveAdmission"] | WorkAgentBindingRequest["observedAdmission"] =>
  request.prospectiveAdmission ?? request.observedAdmission

/** Durable result of atomically binding a started worker to its Work goal. */
export const WorkAgentBinding = Schema.Struct({
  version: Schema.Literal("herdr.work.agent-binding.v1"),
  request: WorkAgentBindingRequest,
  lane: WorkLaneClaimed,
  checkpoint: WorkGoalCheckpoint
}).check(
  Schema.makeFilter(
    ({ checkpoint, lane, request }) =>
      lane.laneId === request.laneId &&
      lane.goalId === checkpoint.goal.id &&
      lane.expectedRevision === request.expectedRevision &&
      lane.revision === request.expectedRevision + 1 &&
      lane.operationId === request.dispatchRequestId &&
      checkpoint.eventId === request.dispatchRequestId &&
      Equal.equals(checkpoint.goal.agentHierarchy?.agent, request.worker) &&
      checkpoint.goal.connectTarget?.agentId === request.worker.agentId &&
      checkpoint.goal.connectTarget.host.toLowerCase() === request.worker.host.toLowerCase(),
    { expected: "one exact dispatch, lane revision, worker, and Work checkpoint binding" }
  )
)
export interface WorkAgentBinding extends Schema.Schema.Type<typeof WorkAgentBinding> {}

const PullRequestNumber = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const RepositoryName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))

/** Exact authority requested by an existing-owner PR inspection. */
export const WorkPullRequestLinkRequest = Schema.Struct({
  repository: RepositoryName,
  pullRequest: PullRequestNumber,
  goalId: WorkGoalId,
  laneId: WorkGoalId
})
export interface WorkPullRequestLinkRequest extends Schema.Schema.Type<typeof WorkPullRequestLinkRequest> {}

export const WorkPullRequestLink = Schema.Struct({
  request: WorkPullRequestLinkRequest,
  goalEventId: Identifier,
  goal: WorkGoal,
  lane: WorkLaneClaimed,
  binding: WorkAgentBinding
}).check(Schema.makeFilter(
  ({ binding, goal, lane, request }) =>
    goal.id === request.goalId &&
    goal.review?.url === `https://github.com/${request.repository}/pull/${request.pullRequest}` &&
    lane.goalId === goal.id && lane.laneId === request.laneId &&
    binding.lane.laneId === lane.laneId &&
    binding.request.worker.agentId === goal.agentHierarchy?.agent.agentId &&
    binding.request.worker.host.toLowerCase() === goal.agentHierarchy?.agent.host.toLowerCase() &&
    goal.connectTarget?.agentId === binding.request.worker.agentId,
  { expected: "one PR goal, lane, and durable started-worker binding" }
))
export interface WorkPullRequestLink extends Schema.Schema.Type<typeof WorkPullRequestLink> {}

/** The session is checked against Herdr by the approval-bound host adapter before CAS. */
export const WorkExistingOwnerReconciliation = Schema.Struct({
  ...WorkPullRequestLinkRequest.fields,
  operationId: WorkLaneOperationId,
  expectedRevision: ExpectedRevision,
  expectedHead: ExactHead,
  newHead: ExactHead,
  expectedOwner: WorkOwner,
  expectedGoalEventId: Identifier,
  bindingDispatchRequestId: WorkDispatchRequestId,
  sessionId: CodexSessionId,
  worker: AgentWorkerIdentity,
  worktree: CanonicalWorktree,
  branch: Branch
})
export interface WorkExistingOwnerReconciliation extends Schema.Schema.Type<typeof WorkExistingOwnerReconciliation> {}

/** The authenticated preflight is evidence, never permission to create a worker. */
export const WorkAdmissionTarget = Schema.Struct({
  repository: WorkAdmit.fields.repository,
  pullRequest: WorkAdmit.fields.pullRequest,
  reviewUrl: WorkAdmit.fields.reviewUrl,
  goalId: WorkAdmit.fields.goalId,
  laneId: WorkAdmit.fields.laneId,
  head: WorkAdmit.fields.head,
  baseHead: WorkAdmit.fields.baseHead,
  owner: WorkAdmit.fields.owner,
  sessionId: WorkAdmit.fields.sessionId,
  expectedWork: WorkAdmit.fields.expectedWork,
  worker: WorkAdmit.fields.worker,
  worktree: WorkAdmit.fields.worktree,
  branch: WorkAdmit.fields.branch
}).check(Schema.makeFilter(
  ({ pullRequest, repository, reviewUrl }) => reviewUrl === `https://github.com/${repository}/pull/${pullRequest}`,
  { expected: "an exact canonical PR URL" }
))
export interface WorkAdmissionTarget extends Schema.Schema.Type<typeof WorkAdmissionTarget> {}

export const WorkAdmissionPreflight = Schema.TaggedUnion({
  prospective: { target: WorkAdmissionTarget, absenceToken: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)) },
  existing: { target: WorkAdmissionTarget, link: WorkPullRequestLink },
  conflict: { target: WorkAdmissionTarget, reason: Schema.String }
})
export type WorkAdmissionPreflight = typeof WorkAdmissionPreflight.Type

/** Runtime-only approval provenance is supplied by the approved Fleet job. */
export const WorkProspectiveAdmission = Schema.Struct({
  ...WorkAdmit.fields,
  approvalJobId: Identifier,
  approvalActor: Identifier
}).check(Schema.makeFilter(
  ({ pullRequest, repository, reviewUrl }) => reviewUrl === `https://github.com/${repository}/pull/${pullRequest}`,
  { expected: "an exact canonical PR URL" }
))
export type WorkProspectiveAdmission = typeof WorkProspectiveAdmission.Type

/**
 * An admission the reconciler makes without an approval, for a worker it
 * observed: the same fields as an approved admission, with the observation in
 * place of the job. The caller (hostd) has already checked what the store can't
 * see: the pane is on this host with lineage, and its worktree is the canonical
 * toplevel on the PR branch at the PR head with an origin equal to the PR's
 * repository. The store re-checks the absence evidence in its transaction.
 */
export const WorkObservedAdmission = Schema.Struct({
  ...Struct.omit(WorkAdmit.fields, ["kind"]),
  observationId: Identifier
}).check(Schema.makeFilter(
  ({ pullRequest, repository, reviewUrl }) => reviewUrl === `https://github.com/${repository}/pull/${pullRequest}`,
  { expected: "an exact canonical PR URL" }
))
export type WorkObservedAdmission = typeof WorkObservedAdmission.Type

/** Read-only evidence for a genuine, existing unlinked canonical goal. */
export const WorkRecoveryTarget = Schema.Struct({
  ...WorkAdmissionTarget.fields,
  expectedGoalEventId: Identifier,
  expectedGoalUpdatedAt: Timestamp
}).check(
  Schema.makeFilter(
    ({ pullRequest, repository, reviewUrl }) => reviewUrl === `https://github.com/${repository}/pull/${pullRequest}`,
    { expected: "an exact canonical PR URL" }
  )
)
export interface WorkRecoveryTarget extends Schema.Schema.Type<typeof WorkRecoveryTarget> {}

export const WorkRecoveryContext = Schema.Struct({
  goalId: WorkGoalId,
  expectedGoalEventId: Identifier,
  expectedGoalUpdatedAt: Timestamp
})
export interface WorkRecoveryContext extends Schema.Schema.Type<typeof WorkRecoveryContext> {}

export const WorkRecoveryPreflight = Schema.TaggedUnion({
  recoverable: {
    target: WorkRecoveryTarget,
    historyToken: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
  },
  existing: { target: WorkRecoveryTarget, link: WorkPullRequestLink },
  conflict: { target: WorkRecoveryTarget, reason: Schema.String }
})
export type WorkRecoveryPreflight = typeof WorkRecoveryPreflight.Type

/** The approved Fleet job supplies actor, job identity, and immutable hash. */
export const WorkExistingGoalRecovery = Schema.Struct({
  ...WorkRecover.fields,
  approvalJobId: Identifier,
  approvalActor: Identifier,
  approvalApprovedBy: Identifier,
  approvalApprovedAt: Timestamp,
  approvalHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
}).check(
  Schema.makeFilter(
    ({ pullRequest, repository, reviewUrl }) => reviewUrl === `https://github.com/${repository}/pull/${pullRequest}`,
    { expected: "an exact canonical PR URL" }
  )
)
export type WorkExistingGoalRecovery = typeof WorkExistingGoalRecovery.Type

/** The approved Fleet job supplies actor, job identity, and immutable hash. */
/** An approved `work.abandon` job, with the approval the Fleet service persisted. */
export const WorkGoalAbandonment = Schema.Struct({
  ...WorkAbandon.fields,
  approvalJobId: Identifier,
  approvalActor: Identifier,
  approvalApprovedBy: Identifier,
  approvalApprovedAt: Timestamp,
  approvalHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
}).check(
  Schema.makeFilter(workAbandonIsRecordable, { expected: "a bounded single-line activity summary" })
)
export type WorkGoalAbandonment = typeof WorkGoalAbandonment.Type

/** Durable result of one abandonment: its checkpoint, identified by the approval job id. */
export const WorkGoalAbandoned = Schema.Struct({
  abandonment: WorkGoalAbandonment,
  checkpoint: WorkGoalCheckpoint
}).check(
  Schema.makeFilter(
    ({ abandonment, checkpoint }) =>
      checkpoint.eventId === abandonment.approvalJobId &&
      checkpoint.goal.id === abandonment.goalId &&
      checkpoint.goal.state === "abandoned" &&
      Equal.equals(checkpoint.goal.owner, abandonment.owner),
    { expected: "an abandoned checkpoint for the approved goal and owner" }
  )
)
export interface WorkGoalAbandoned extends Schema.Schema.Type<typeof WorkGoalAbandoned> {}

export const WorkGoalReassignment = Schema.Struct({
  ...WorkReassign.fields,
  approvalJobId: Identifier,
  approvalActor: Identifier,
  approvalApprovedBy: Identifier,
  approvalApprovedAt: Timestamp,
  approvalHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
}).check(
  Schema.makeFilter(workReassignIsRecordable, {
    expected: "a different, recordable target owner and a bounded single-line activity summary"
  })
)
export type WorkGoalReassignment = typeof WorkGoalReassignment.Type

/**
 * Durable result of one reassignment. The checkpoint, any rewritten lane, and
 * any rebound worker binding are all identified by the approval job id. `lane`
 * is null when the goal had no active lane (a shipped lane keeps its previous
 * owner); `binding` is null when that lane had no started-worker binding.
 */
export const WorkGoalReassigned = Schema.Struct({
  reassignment: WorkGoalReassignment,
  checkpoint: WorkGoalCheckpoint,
  lane: Schema.NullOr(WorkLaneClaimed),
  binding: Schema.NullOr(WorkAgentBinding)
}).check(
  Schema.makeFilter(
    ({ binding, checkpoint, lane, reassignment }) =>
      checkpoint.eventId === reassignment.approvalJobId &&
      checkpoint.goal.id === reassignment.goalId &&
      Equal.equals(checkpoint.goal.owner, reassignment.to) &&
      (lane === null || (
        lane.goalId === reassignment.goalId &&
        lane.operationId === reassignment.approvalJobId &&
        Equal.equals(lane.owner, reassignment.to)
      )) &&
      (binding === null || (
        lane !== null &&
        Equal.equals(binding.lane, lane) &&
        Equal.equals(binding.checkpoint, checkpoint) &&
        binding.request.ownerReassignment?.approvalJobId === reassignment.approvalJobId
      )),
    { expected: "a checkpoint, lane, and binding owned by the approved target owner" }
  )
)
export interface WorkGoalReassigned extends Schema.Schema.Type<typeof WorkGoalReassigned> {}

export const WorkCoordinatorBlocker = Schema.Struct({
  id: Identifier,
  detail: Text
})
export interface WorkCoordinatorBlocker extends Schema.Schema.Type<typeof WorkCoordinatorBlocker> {}

export const WorkEvidenceReference = Schema.Struct({
  id: Identifier,
  kind: Schema.Literals(["commit", "test", "review", "document"]),
  reference: Text
})
export interface WorkEvidenceReference extends Schema.Schema.Type<typeof WorkEvidenceReference> {}

/** Bounded credential-free context carried from the accepted Work handoff into execution. */
export const WorkContextDelta = Text
export type WorkContextDelta = typeof WorkContextDelta.Type

export const WorkDecisionHandoff = Schema.Struct({
  version: Schema.Literal("herdr.work.decision.v2"),
  id: Identifier,
  sessionId: WorkCoordinatorSessionId,
  laneId: WorkGoalId,
  goalId: WorkGoalId,
  expectedRevision: ExpectedRevision,
  decision: Schema.Literals(["continue", "blocked", "handoff", "complete"]),
  summary: Text,
  contextDelta: WorkContextDelta,
  owner: WorkOwner,
  dispatchIds: Schema.Array(WorkDispatchRequestId).check(
    Schema.isMaxLength(32),
    Schema.makeFilter(
      (ids) => new Set(ids).size === ids.length,
      { expected: "unique dispatch IDs in a coordinator handoff" }
    )
  ),
  blockers: Schema.Array(WorkCoordinatorBlocker).check(
    Schema.isMaxLength(32),
    Schema.makeFilter(
      (blockers) => new Set(blockers.map(({ id }) => id)).size === blockers.length,
      { expected: "unique blocker IDs in a coordinator handoff" }
    )
  ),
  evidenceRefs: Schema.Array(WorkEvidenceReference).check(
    Schema.isMaxLength(64),
    Schema.makeFilter(
      (references) => new Set(references.map(({ id }) => id)).size === references.length,
      { expected: "unique evidence reference IDs in a coordinator handoff" }
    )
  ),
  occurredAt: Timestamp
})
export interface WorkDecisionHandoff extends Schema.Schema.Type<typeof WorkDecisionHandoff> {}

/** A durable dispatch-to-Work binding written with the dispatch acceptance. */
export const WorkDispatchHandoff = Schema.Struct({
  dispatchRequestId: WorkDispatchRequestId,
  handoff: WorkDecisionHandoff,
  lineage: Schema.Array(WorkDispatchRequestId).check(
    Schema.isMaxLength(32),
    Schema.makeFilter(
      (ids) => new Set(ids).size === ids.length,
      { expected: "unique dispatch IDs in Work lineage" }
    )
  )
}).check(
  Schema.makeFilter(
    ({ handoff, lineage }) => lineage.every((dispatchId) => handoff.dispatchIds.includes(dispatchId)),
    { expected: "Work lineage contained in the persisted handoff dispatch IDs" }
  )
)
export interface WorkDispatchHandoff extends Schema.Schema.Type<typeof WorkDispatchHandoff> {}

/**
 * The key one subject's facts and failures are stored under, such as
 * `github:<owner>/<repo>#<n>` or `herdr:<host>/<agentId>`. Composite, so it is
 * bounded on its own rather than by `Identifier`.
 */
export const WorkObservationSubject = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}]+$/u)
)

/**
 * A branch name as a provider reported it. Looser than the lane `Branch`
 * authority type: any one-line name a provider accepts (`renovate/@types-x`).
 */
const ObservedBranch = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}]+$/u)
)

/** Why a source could not be read: one bounded line, so failures stay small in every snapshot. */
const FailureReason = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}]+$/u)
)

/** CI status of a pull request's head, rolled up from its check runs and statuses. */
export const WorkObservedChecks = Schema.Literals(["none", "pending", "passing", "failing"])
export type WorkObservedChecks = typeof WorkObservedChecks.Type

/** A pull request as GitHub reported it. Facts only; never approval to act on it. */
export const WorkPullRequestObservation = Schema.TaggedStruct("pull_request", {
  repository: RepositoryName,
  pullRequest: PullRequestNumber,
  state: Schema.Literals(["open", "merged", "closed"]),
  branch: ObservedBranch,
  head: ExactHead,
  review: WorkReviewState,
  checks: WorkObservedChecks,
  /** GitHub's mergedAt or closedAt; null while open. A terminal checkpoint is stamped with it, never the wall clock. */
  closedAt: Schema.NullOr(Timestamp)
}).check(Schema.makeFilter(
  ({ closedAt, state }) => (state === "open") === (closedAt === null),
  { expected: "a close time exactly when the pull request is merged or closed" }
))
export interface WorkPullRequestObservation extends Schema.Schema.Type<typeof WorkPullRequestObservation> {}

/** An agent pane as Herdr reported it; `gone` means the pane is no longer in the host's snapshot. */
export const WorkAgentObservation = Schema.TaggedStruct("agent", {
  host: ApprovalHostName,
  agentId: Identifier,
  status: Schema.Literals(["idle", "working", "blocked", "done", "gone"])
})
export interface WorkAgentObservation extends Schema.Schema.Type<typeof WorkAgentObservation> {}

/** A source that could not be read. It is reported, never turned into a fact about a goal. */
export const WorkUnknownObservation = Schema.TaggedStruct("unknown", {
  source: Schema.Literals(["github", "herdr", "git"]),
  subject: WorkObservationSubject,
  reason: FailureReason
})
export interface WorkUnknownObservation extends Schema.Schema.Type<typeof WorkUnknownObservation> {}

export const WorkObservation = Schema.Union([
  WorkPullRequestObservation,
  WorkAgentObservation,
  WorkUnknownObservation
])
export type WorkObservation = typeof WorkObservation.Type

/** One observation and when it was made. Observing the same facts again is a no-op. */
export const WorkObservationEnvelope = Schema.Struct({
  observation: WorkObservation,
  observedAt: Timestamp
})
export interface WorkObservationEnvelope extends Schema.Schema.Type<typeof WorkObservationEnvelope> {}

/**
 * A stored observation's id, and what `reconcile` accepts as confirmation of
 * it: lowercase hex of the SHA-256 of the UTF-8 bytes persisted in
 * `work_observed_facts.record`. That record is the JSON of the encoded
 * observation alone (a pull request's or an agent's fields, in schema field
 * order) with its case-insensitive identity, the repository or host,
 * ASCII-lowercased. `observedAt` is not an input, so the same facts read again
 * keep their id.
 */
export const WorkObservationId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("WorkObservationId")
)
export type WorkObservationId = typeof WorkObservationId.Type

/**
 * The latest stored fact for one subject. `observedAt` is when these exact
 * facts were first seen, so for a `gone` agent it is the time it went away;
 * `confirmedAt` is the last time a read returned them again.
 */

export const WorkObservedFact = Schema.Struct({
  subject: WorkObservationSubject,
  observationId: WorkObservationId,
  observedAt: Timestamp,
  confirmedAt: Timestamp,
  observation: Schema.Union([WorkPullRequestObservation, WorkAgentObservation])
}).check(Schema.makeFilter(
  ({ confirmedAt, observedAt }) => confirmedAt >= observedAt,
  { expected: "a confirmation no earlier than the first observation" }
))
export interface WorkObservedFact extends Schema.Schema.Type<typeof WorkObservedFact> {}

/**
 * The current run of failed reads for one subject. `since` is the first
 * failure of the run; a later failure keeps it, a good read newer than every
 * failure ends the run, and a good read inside it restarts the run at its
 * latest failure.
 */
export const WorkObservedFailure = Schema.Struct({
  subject: WorkObservationSubject,
  source: WorkUnknownObservation.fields.source,
  reason: FailureReason,
  since: Timestamp,
  /** The latest failed read of the run; `source` and `reason` are from it. */
  lastAt: Timestamp
}).check(Schema.makeFilter(
  ({ lastAt, since }) => lastAt >= since,
  { expected: "a latest failed read no earlier than the run's first" }
))
export interface WorkObservedFailure extends Schema.Schema.Type<typeof WorkObservedFailure> {}

/** The overlay keeps one latest fact per subject, within its own bounds; over them, the oldest facts go first. */
/** How far ahead of the store's clock an observation may be stamped before it is skipped as stale. */
export const workObservationMaxSkewMillis = 5 * 60 * 1_000

export const workObservedFactMaxRecords = 4_096
export const workObservedFactMaxBytes = 2 * 1024 * 1024

/**
 * What `observe` did with one envelope: stored a new fact, found the same
 * facts already stored, skipped it as older than the stored fact, or reported
 * a source it could not read.
 */
export const WorkObserveOutcome = Schema.TaggedUnion({
  stored: { subject: WorkObservationSubject, observationId: WorkObservationId },
  unchanged: { subject: WorkObservationSubject, observationId: WorkObservationId },
  stale: { subject: WorkObservationSubject },
  unknown: { subject: WorkObservationSubject, reason: FailureReason }
})
export type WorkObserveOutcome = typeof WorkObserveOutcome.Type

export const WorkObserveReport = Schema.Struct({
  outcomes: Schema.Array(WorkObserveOutcome),
  evicted: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
})
export interface WorkObserveReport extends Schema.Schema.Type<typeof WorkObserveReport> {}

/** History the reconciler always leaves free for owners and approvals. */
export const workReconcilerHeadroom = 256

/**
 * What `reconcile` did for one goal whose pull request is observed merged or
 * closed: recorded it as finished, found it already recorded once by the
 * reconciler (it never stamps a goal twice, even after an owner reopens it),
 * or found a newer owner checkpoint than the one it planned from (it tries
 * again on the next run).
 */
/**
 * What `reconcile` may act on: `confirmed` lists the pull request facts the
 * caller has just read and the store accepted, the `subject` and
 * `observationId` of each `stored` or `unchanged` outcome from that `observe`.
 * A read refused as stale, or one that failed, confirms nothing, so a fact
 * stored earlier (the pull request may since have reopened) is never acted on.
 */
export const WorkReconcileOptions = Schema.Struct({
  confirmed: Schema.Array(Schema.Struct({ subject: WorkObservationSubject, observationId: WorkObservationId })).check(
    Schema.isMaxLength(workObservedFactMaxRecords)
  )
})
export interface WorkReconcileOptions extends Schema.Schema.Type<typeof WorkReconcileOptions> {}

export const WorkReconcileOutcome = Schema.TaggedUnion({
  applied: { goalId: WorkGoalId, eventId: Identifier, state: Schema.Literals(["completed", "abandoned"]) },
  recorded: { goalId: WorkGoalId, eventId: Identifier },
  conflict: { goalId: WorkGoalId }
})
export type WorkReconcileOutcome = typeof WorkReconcileOutcome.Type

/**
 * One step `reconcile` would take now, from `planReconcile`. `would_apply`
 * passed every check `reconcile` makes before writing and names the fact and
 * the goal's latest event it was planned from. A later `reconcile` decides
 * again from the store as it then is; it is not bound to this plan.
 */
export const WorkReconcilePlanStep = Schema.TaggedUnion({
  would_apply: {
    goalId: WorkGoalId,
    eventId: Identifier,
    state: Schema.Literals(["completed", "abandoned"]),
    subject: WorkObservationSubject,
    observationId: WorkObservationId,
    goalEventId: Identifier,
    goalUpdatedAt: Timestamp
  },
  recorded: { goalId: WorkGoalId, eventId: Identifier },
  conflict: { goalId: WorkGoalId, reason: Schema.Literals(["checkpoint", "revision"]) }
})
export type WorkReconcilePlanStep = typeof WorkReconcilePlanStep.Type

/** What the Work tab shows for a goal: its recorded state, or a newer observed one. */
export const WorkDisplayState = WorkState
export type WorkDisplayState = typeof WorkDisplayState.Type

/** Observed facts overlaid on one goal at read time. Nothing here is goal history. */
export const WorkGoalObserved = Schema.Struct({
  pullRequest: Schema.NullOr(
    Schema.Struct({ fact: WorkPullRequestObservation, observedAt: Timestamp, confirmedAt: Timestamp })
  ),
  agent: Schema.NullOr(Schema.Struct({ fact: WorkAgentObservation, observedAt: Timestamp, confirmedAt: Timestamp })),
  /**
   * A source that can't currently be read for this goal; the oldest failing
   * run when both its pull request and its agent fail. `lastGoodAt` is when
   * that subject last read successfully, null if it never has. A goal with no
   * pull request URL or no agent has no subject there, so no failure either.
   */
  unknown: Schema.NullOr(Schema.Struct({
    source: WorkUnknownObservation.fields.source,
    reason: FailureReason,
    since: Timestamp,
    lastGoodAt: Schema.NullOr(Timestamp)
  })),
  displayState: WorkDisplayState,
  stale: Schema.Boolean
})
export interface WorkGoalObserved extends Schema.Schema.Type<typeof WorkGoalObserved> {}

export const WorkGoalObservedEntry = Schema.Struct({ goalId: WorkGoalId, ...WorkGoalObserved.fields })
export interface WorkGoalObservedEntry extends Schema.Schema.Type<typeof WorkGoalObservedEntry> {}

/**
 * Who wrote one goal activity, when it was not the goal's owner: the
 * reconciler (from an observed fact) or an approved Fleet job.
 */
export const WorkActivityProvenance = Schema.Struct({
  goalId: WorkGoalId,
  activityId: Identifier,
  provenance: Schema.Literals(["reconciler", "approval"]),
  approvalJobId: Schema.NullOr(Identifier)
})
export interface WorkActivityProvenance extends Schema.Schema.Type<typeof WorkActivityProvenance> {}

export const WorkSnapshotWindow = Schema.Literals(["now", "day", "week", "month"])
export type WorkSnapshotWindow = typeof WorkSnapshotWindow.Type

export const WorkSnapshot = Schema.Struct({
  window: WorkSnapshotWindow,
  observedAt: Timestamp,
  asOf: Timestamp,
  goals: Schema.Array(WorkGoal).check(Schema.isMaxLength(workSnapshotMaxGoals)),
  families: Schema.optionalKey(Schema.Array(WorkGoalFamilyGroup).check(Schema.isMaxLength(workSnapshotMaxGoals))),
  /**
   * Observed facts per goal, merged at read time; only the `now` window
   * carries them, and only for goals something was observed about.
   */
  observed: Schema.optionalKey(
    Schema.Array(WorkGoalObservedEntry).check(Schema.isMaxLength(workSnapshotMaxGoals))
  ),
  /**
   * How many goals' observed entries were left out to keep the snapshot within
   * the response budget; the most recently updated goals keep theirs.
   */
  observedOmitted: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  /** Activities written by the reconciler or an approved job; only on `now`. */
  activityProvenance: Schema.optionalKey(Schema.Array(WorkActivityProvenance)),
  /**
   * Goals whose non-owner activities are all in `activityProvenance`. In a
   * covered goal an activity missing from it is the owner's; a goal that isn't
   * covered has unknown provenance. Trimming to the response budget drops
   * whole goals, never single activities.
   */
  activityProvenanceGoals: Schema.optionalKey(Schema.Array(WorkGoalId).check(Schema.isMaxLength(workSnapshotMaxGoals))),
  /** How many goals were left uncovered to keep the snapshot within the response budget. */
  activityProvenanceOmitted: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)))
}).check(
  Schema.makeFilter(
    (snapshot) => {
      const families = snapshot.families ?? []
      const goalById = new Map<string, WorkGoal>()
      for (const goal of snapshot.goals) {
        if (goal.goalFamily?.role === "superseded" || goalById.has(goal.id)) {
          return false
        }
        goalById.set(goal.id, goal)
      }
      const seenCanonical = new Set<string>()
      const seenMember = new Set<string>()
      for (const group of families) {
        if (seenCanonical.has(group.canonicalGoalId)) return false
        seenCanonical.add(group.canonicalGoalId)
        const active = goalById.get(group.canonicalGoalId)
        if (active === undefined) return false
        if (!Equal.equals(active, group.canonical)) return false
        for (const member of group.superseded) {
          if (seenMember.has(member.id)) return false
          seenMember.add(member.id)
          if (goalById.has(member.id)) return false
        }
      }
      if (snapshot.goals.length + seenMember.size > workSnapshotMaxGoals) {
        return false
      }
      return true
    },
    {
      expected:
        "families consistent with non-superseded active goals, without duplicated active or superseded members, and within total distinct goal limit"
    }
  )
)
export interface WorkSnapshot extends Schema.Schema.Type<typeof WorkSnapshot> {}

export const WorkSnapshots = Schema.Struct({
  observedAt: Timestamp,
  now: WorkSnapshot,
  day: WorkSnapshot,
  week: WorkSnapshot,
  month: WorkSnapshot
}).check(Schema.makeFilter(
  ({ day, month, now, week }) =>
    [day, week, month].every((window) =>
      window.observed === undefined && window.observedOmitted === undefined &&
      window.activityProvenance === undefined && window.activityProvenanceGoals === undefined &&
      window.activityProvenanceOmitted === undefined
    ) &&
    (now.activityProvenanceGoals === undefined ||
      now.activityProvenanceGoals.every((goalId) => now.goals.some(({ id }) => id === goalId))) &&
    (now.activityProvenance === undefined ||
      now.activityProvenance.every(({ goalId }) => now.activityProvenanceGoals?.includes(goalId) === true)) &&
    (now.observed === undefined || (
      new Set(now.observed.map(({ goalId }) => goalId)).size === now.observed.length &&
      now.observed.every(({ goalId }) => now.goals.some(({ id }) => id === goalId))
    )),
  {
    expected:
      "observed facts and activity provenance only on the now window, for goals in that window and covered goals only"
  }
))
export interface WorkSnapshots extends Schema.Schema.Type<typeof WorkSnapshots> {}
