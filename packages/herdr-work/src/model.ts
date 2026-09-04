import { AgentConnectTarget, AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { Equal, Schema } from "effect"

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

export const WorkState = Schema.Literals(["planned", "working", "blocked", "review", "deployed", "completed"])
export type WorkState = typeof WorkState.Type

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
      return parsed.pathname === "/" &&
        parsed.hash === "" &&
        queryKeys.length === 3 &&
        parsed.searchParams.getAll("tab").length === 1 &&
        parsed.searchParams.get("tab") === "approvals" &&
        approvalHosts.length === 1 &&
        approvalJobs.length === 1 &&
        approvalHosts[0]?.toLowerCase() === host.toLowerCase() &&
        approvalJobs[0] === jobId
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
      return goal.updatedAt >= goal.createdAt &&
        ((goal.state === "blocked") === hasBlocker) &&
        (goal.blockers === undefined || goal.blocker === null) &&
        (goal.blocker === null || isDetailTimestamp(goal.blocker.since)) &&
        (goal.blockers === undefined || goal.blockers.every(({ since }) => isDetailTimestamp(since))) &&
        (goal.activity === undefined || goal.activity.every(({ occurredAt }) => isDetailTimestamp(occurredAt))) &&
        (goal.requests === undefined || goal.requests.every(({ requestedAt }) => isDetailTimestamp(requestedAt))) &&
        (goal.review === undefined || goal.review === null || isDetailTimestamp(goal.review.updatedAt)) &&
        (family === undefined || ((family.role === "canonical") === (family.canonicalGoalId === goal.id))) &&
        (agent === undefined || agent === null || (
          (agent.relationship === undefined || agent.relationship.parentAgentId !== agent.agentId) &&
          goal.connectTarget !== null &&
          goal.connectTarget.agentId === agent.agentId &&
          goal.connectTarget.host.toLowerCase() === agent.host.toLowerCase()
        ))
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
          !/[<>:"|?*]/.test(part) &&
          !/[. ]$/.test(part) &&
          !isReservedWindowsDevice(part)
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
  expectedRevision: ExpectedRevision
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
  worker: AgentWorkerIdentity
})
export interface WorkAgentBindingRequest extends Schema.Schema.Type<typeof WorkAgentBindingRequest> {}

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

export const WorkDecisionHandoff = Schema.Struct({
  version: Schema.Literal("herdr.work.decision.v1"),
  id: Identifier,
  sessionId: WorkCoordinatorSessionId,
  laneId: WorkGoalId,
  goalId: WorkGoalId,
  decision: Schema.Literals(["continue", "blocked", "handoff", "complete"]),
  summary: Text,
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

export const WorkSnapshotWindow = Schema.Literals(["now", "day", "week", "month"])
export type WorkSnapshotWindow = typeof WorkSnapshotWindow.Type

export const WorkSnapshot = Schema.Struct({
  window: WorkSnapshotWindow,
  observedAt: Timestamp,
  asOf: Timestamp,
  goals: Schema.Array(WorkGoal).check(Schema.isMaxLength(workSnapshotMaxGoals)),
  families: Schema.optionalKey(Schema.Array(WorkGoalFamilyGroup).check(Schema.isMaxLength(workSnapshotMaxGoals)))
}).check(
  Schema.makeFilter(
    (snapshot) => {
      const families = snapshot.families ?? []
      const goalById = new Map<string, WorkGoal>()
      for (const goal of snapshot.goals) {
        if (goal.goalFamily?.role === "superseded" || goalById.has(goal.id)) return false
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
      if (snapshot.goals.length + seenMember.size > workSnapshotMaxGoals) return false
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
})
export interface WorkSnapshots extends Schema.Schema.Type<typeof WorkSnapshots> {}
