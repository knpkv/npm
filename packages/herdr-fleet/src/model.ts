import { Schema } from "effect"
import { fleetJobRecordMaxBytes } from "./limits.js"

export const JobIdentifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)
export const HostOperationReceipt = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2 * 1_024),
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)
export type HostOperationReceipt = typeof HostOperationReceipt.Type
const WorkerTimestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
)

export const JobHash = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[0-9a-f]{64}$/)
)
export type JobHash = typeof JobHash.Type

export const DelegateMode = Schema.Literals(["consult", "review", "transition_summary", "work"])
export type DelegateMode = typeof DelegateMode.Type

export const AgentStableId = Schema.String.check(
  Schema.isMinLength(7),
  Schema.isMaxLength(256),
  Schema.isPattern(/^agent-[A-Za-z0-9_-]+$/)
)
export type AgentStableId = typeof AgentStableId.Type

export const FleetHostName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(253),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/)
)
export type FleetHostName = typeof FleetHostName.Type

export const AgentWorkerRelationship = Schema.Struct({
  parentAgentId: AgentStableId,
  relation: Schema.Literals(["delegated", "pair", "review"])
})
export type AgentWorkerRelationship = typeof AgentWorkerRelationship.Type

export const AgentWorkerIdentity = Schema.Struct({
  host: FleetHostName,
  agentId: AgentStableId,
  name: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[^\p{Cc}]+$/u)
  ),
  paneId: Schema.String.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^w[0-9A-Z]+:p[0-9A-Z]+$/)
  ),
  relationship: Schema.optionalKey(AgentWorkerRelationship)
})
export type AgentWorkerIdentity = typeof AgentWorkerIdentity.Type

const HttpsOrigin = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^https:\/\/[^/?#@]+$/),
  Schema.makeFilter(
    (value) => URL.canParse(value) && new URL(value).protocol === "https:",
    { expected: "a parseable HTTPS origin" }
  )
)

const VapidSubject = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^(?:mailto:\S+|https:\/\/[^/?#\s]+(?:[/?#]\S*)?)$/),
  Schema.makeFilter(
    (value) => {
      if (!URL.canParse(value)) return false
      const url = new URL(value)
      return url.protocol === "mailto:"
        ? url.pathname.length > 0
        : url.protocol === "https:" && url.hostname.length > 0
    },
    { expected: "a complete mailto or HTTPS URI" }
  )
)

const connectUrlFor = (host: string, agentId: string): string =>
  `/connect/?agent=${encodeURIComponent(agentId)}&host=${encodeURIComponent(host)}`

export const AgentConnectTarget = Schema.Struct({
  host: AgentWorkerIdentity.fields.host,
  agentId: AgentStableId,
  url: Schema.String.check(Schema.isMaxLength(1_024), Schema.isPattern(/^\/connect\/\?/))
}).check(
  Schema.makeFilter(
    (target) => target.url === connectUrlFor(target.host, target.agentId),
    { expected: "canonical Connect URL for the exact host and stable agent ID" }
  )
)
export type AgentConnectTarget = typeof AgentConnectTarget.Type

export const agentConnectTarget = (worker: AgentWorkerIdentity): AgentConnectTarget => ({
  agentId: worker.agentId,
  host: worker.host,
  url: connectUrlFor(worker.host, worker.agentId)
})

const NoNullByte = Schema.makeFilter(
  (value: string) => !value.includes("\u0000"),
  { expected: "text without a null byte" }
)
export const JobActor = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  NoNullByte
)
export type JobActor = typeof JobActor.Type
const JobPath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2 * 1_024),
  NoNullByte
)

/**
 * Leaves headroom below Linux's single-argument limit after JSON escaping and
 * worst-case UTF-8 encoding by the command adapter.
 */
export const jobTextMaxLength = 16 * 1_024
const JobText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(jobTextMaxLength),
  NoNullByte
)
const HerdrTarget = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(
    /^(?:[a-z][a-z0-9_-]{0,31}(?:@w[0-9A-Z]+:p[0-9A-Z]+)?|w[0-9A-Z]+:p[0-9A-Z]+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/
  )
)

export const NixCheck = Schema.Struct({ kind: Schema.Literal("nix.check") })
export const NixApply = Schema.Struct({
  kind: Schema.Literal("nix.apply"),
  ref: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(4 * 1_024),
    NoNullByte
  )
})
export const AgentDelegate = Schema.Struct({
  kind: Schema.Literal("agent.delegate"),
  repository: JobPath,
  prompt: JobText,
  mode: DelegateMode,
  /** Approval-bound request to create a Work goal before delegation. */
  newWork: Schema.optionalKey(Schema.Struct({
    branch: Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(256),
      Schema.isPattern(/^[A-Za-z0-9._/-]+$/),
      Schema.makeFilter(
        (value) =>
          value !== "HEAD" &&
          !value.startsWith("-") &&
          !value.startsWith("/") &&
          !value.endsWith("/") &&
          !value.endsWith(".") &&
          !value.includes("//") &&
          !value.includes("..") &&
          value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock")),
        { expected: "a valid Git branch ref" }
      )
    ),
    title: Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(4_096),
      Schema.isPattern(/^[^\p{Cc}\p{Cs}\u2028\u2029]+$/u)
    )
  })),
  channel: Schema.optionalKey(Schema.Literal("coordinator_chat"))
})
export type AgentDelegate = typeof AgentDelegate.Type
export const AgentMessage = Schema.Struct({
  kind: Schema.Literal("agent.message"),
  session: HerdrTarget,
  message: JobText
})

/** Approval-bound, exact existing-owner Work reconciliation. */
export const WorkReconcile = Schema.Struct({
  kind: Schema.Literal("work.reconcile"),
  repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  pullRequest: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  goalId: Schema.String.check(Schema.isNonEmpty()),
  laneId: Schema.String.check(Schema.isNonEmpty()),
  operationId: Schema.String.check(Schema.isNonEmpty()),
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  expectedHead: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  newHead: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  expectedOwner: Schema.Struct({
    id: Schema.String.check(Schema.isNonEmpty()),
    name: Schema.String.check(Schema.isNonEmpty())
  }),
  expectedGoalEventId: Schema.String.check(Schema.isNonEmpty()),
  bindingDispatchRequestId: Schema.String.check(Schema.isNonEmpty()),
  sessionId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)),
  expectedWork: Schema.String.check(Schema.isNonEmpty()),
  worker: AgentWorkerIdentity,
  worktree: JobPath,
  branch: Schema.String.check(Schema.isNonEmpty())
})
export type WorkReconcile = typeof WorkReconcile.Type

/** A new, prospective Work admission for an already-running settled owner. */
export const WorkAdmit = Schema.Struct({
  kind: Schema.Literal("work.admit"),
  repository: WorkReconcile.fields.repository,
  pullRequest: WorkReconcile.fields.pullRequest,
  reviewUrl: Schema.String.check(
    Schema.isPattern(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/)
  ),
  goalId: WorkReconcile.fields.goalId,
  laneId: WorkReconcile.fields.laneId,
  operationId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(180)),
  expectedAbsenceToken: JobHash,
  head: WorkReconcile.fields.newHead,
  baseHead: WorkReconcile.fields.newHead,
  owner: WorkReconcile.fields.expectedOwner,
  sessionId: WorkReconcile.fields.sessionId,
  expectedWork: WorkReconcile.fields.expectedWork,
  worker: AgentWorkerIdentity,
  worktree: WorkReconcile.fields.worktree,
  branch: WorkReconcile.fields.branch,
  title: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  detail: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096))
}).check(Schema.makeFilter(
  ({ pullRequest, repository, reviewUrl }) => reviewUrl === `https://github.com/${repository}/pull/${pullRequest}`,
  { expected: "exact PR URL" }
))
export type WorkAdmit = typeof WorkAdmit.Type

/** Approval-bound linkage of one existing canonical goal to its settled owner. */
export const WorkRecover = Schema.Struct({
  kind: Schema.Literal("work.recover"),
  repository: WorkAdmit.fields.repository,
  pullRequest: WorkAdmit.fields.pullRequest,
  reviewUrl: WorkAdmit.fields.reviewUrl,
  goalId: WorkAdmit.fields.goalId,
  laneId: WorkAdmit.fields.laneId,
  operationId: WorkAdmit.fields.operationId,
  expectedGoalEventId: Schema.String.check(Schema.isNonEmpty()),
  expectedGoalUpdatedAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  expectedHistoryToken: JobHash,
  head: WorkAdmit.fields.head,
  baseHead: WorkAdmit.fields.baseHead,
  owner: WorkAdmit.fields.owner,
  sessionId: WorkAdmit.fields.sessionId,
  expectedWork: WorkAdmit.fields.expectedWork,
  worker: AgentWorkerIdentity,
  worktree: WorkAdmit.fields.worktree,
  branch: WorkAdmit.fields.branch
}).check(
  Schema.makeFilter(
    ({ pullRequest, repository, reviewUrl }) => reviewUrl === `https://github.com/${repository}/pull/${pullRequest}`,
    { expected: "exact PR URL" }
  )
)
export type WorkRecover = typeof WorkRecover.Type

/**
 * The agent target a reassigned goal ends with: `set` points it at a new
 * worker, `clear` removes it, and `keep` is accepted only when the goal has no
 * target, so a reassignment never leaves the previous owner's agent in place.
 */
export const WorkReassignAgent = Schema.TaggedUnion({
  set: { agent: AgentWorkerIdentity },
  clear: {},
  keep: {}
})
export type WorkReassignAgent = typeof WorkReassignAgent.Type

const workReassignOwnerIdMaxLength = 256
const workReassignActivityMaxLength = 4_096
const workReassignActivityText = /^[^\p{Cc}\p{Cs}]+$/u

/**
 * Activity text the Work store records for an approved reassignment: the owners by name and the
 * reason, written for people. Owner ids and the approval's job id and hash stay structured on the
 * reassignment record, where they are evidence; in prose they were unreadable hex.
 */
export const workReassignActivitySummary = (
  payload: {
    readonly from: { readonly id: string; readonly name: string }
    readonly to: { readonly id: string; readonly name: string }
    readonly reason: string
  }
): string => `Reassigned from ${payload.from.name} to ${payload.to.name}: ${payload.reason}`

/**
 * Accepts a reassignment only when its target owner and its longest possible
 * activity summary fit Work's durable limits, so nothing approved can fail to
 * record for size or control characters.
 */
export const workReassignIsRecordable = (
  payload: Parameters<typeof workReassignActivitySummary>[0]
): boolean => {
  const summary = workReassignActivitySummary(payload)
  // The ids are no longer in the summary, so check them directly: an id Work cannot store (too
  // long, a control character or a lone surrogate) must be refused before approval, not fail on
  // record. The schema only requires them to be non-empty.
  return payload.from.id !== payload.to.id &&
    payload.from.id.length <= workReassignOwnerIdMaxLength &&
    payload.to.id.length <= workReassignOwnerIdMaxLength &&
    workReassignActivityText.test(payload.from.id) &&
    workReassignActivityText.test(payload.to.id) &&
    summary.length <= workReassignActivityMaxLength &&
    workReassignActivityText.test(summary)
}

/**
 * Approval-bound transfer of one Work goal, and its active lane, from the exact
 * current owner to a new owner.
 */
export const WorkReassign = Schema.Struct({
  kind: Schema.Literal("work.reassign"),
  goalId: WorkAdmit.fields.goalId,
  from: WorkAdmit.fields.owner,
  to: WorkAdmit.fields.owner,
  toAgent: WorkReassignAgent,
  reason: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  expectedGoalEventId: WorkRecover.fields.expectedGoalEventId,
  expectedGoalUpdatedAt: WorkRecover.fields.expectedGoalUpdatedAt
}).check(
  Schema.makeFilter(workReassignIsRecordable, {
    expected: "a different, recordable target owner and a bounded single-line activity summary"
  })
)
export type WorkReassign = typeof WorkReassign.Type

/**
 * Activity text the Work store records for an approved abandonment: the reason, for people. The
 * approval's job id and hash stay structured on the abandonment record.
 */
export const workAbandonActivitySummary = (payload: { readonly reason: string }): string =>
  `Abandoned: ${payload.reason}`

/**
 * Accepts an abandonment only when its longest possible activity summary fits
 * Work's durable limits, so nothing approved can fail to record for size or
 * control characters.
 */
export const workAbandonIsRecordable = (payload: Parameters<typeof workAbandonActivitySummary>[0]): boolean => {
  const summary = workAbandonActivitySummary(payload)
  return summary.length <= workReassignActivityMaxLength && workReassignActivityText.test(summary)
}

/**
 * Approval-bound move of one Work goal, owned by exactly `owner` and at the
 * exact head the approver saw, to `abandoned`. A goal with an active lane, or
 * already finished, is refused: releasing a lane is its own approved action.
 */
export const WorkAbandon = Schema.Struct({
  kind: Schema.Literal("work.abandon"),
  goalId: WorkAdmit.fields.goalId,
  owner: WorkAdmit.fields.owner,
  reason: WorkReassign.fields.reason,
  expectedGoalEventId: WorkRecover.fields.expectedGoalEventId,
  expectedGoalUpdatedAt: WorkRecover.fields.expectedGoalUpdatedAt
}).check(
  Schema.makeFilter(workAbandonIsRecordable, { expected: "a bounded single-line activity summary" })
)
export type WorkAbandon = typeof WorkAbandon.Type

/** Fleet job kinds that change Work authority; only a composed Work adapter executes them. */
export const WorkJobKind = Schema.Literals([
  "work.reconcile",
  "work.admit",
  "work.recover",
  "work.reassign",
  "work.abandon"
])
export type WorkJobKind = typeof WorkJobKind.Type
export const isWorkJobKind = Schema.is(WorkJobKind)

export const BrowserMcpRecover = Schema.Struct({
  kind: Schema.Literal("browser.mcp.recover")
})
export type BrowserMcpRecover = typeof BrowserMcpRecover.Type

export const CoreJobPayload = Schema.Union([
  Schema.Union([NixCheck, NixApply, AgentDelegate, AgentMessage]),
  WorkReconcile,
  WorkAdmit,
  WorkRecover,
  WorkReassign,
  WorkAbandon
])
export type CoreJobPayload = typeof CoreJobPayload.Type

export const LocalJobPayload = BrowserMcpRecover
export type LocalJobPayload = typeof LocalJobPayload.Type

export const JobPayload = Schema.Union([
  CoreJobPayload,
  LocalJobPayload
])
export type JobPayload = typeof JobPayload.Type

export const JobRequest = Schema.Struct({ payload: JobPayload })
export type JobRequest = typeof JobRequest.Type

export const JobStatus = Schema.Literals([
  "pending_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "rejected",
  "expired"
])
export type JobStatus = typeof JobStatus.Type

export const workerObservationMaxLength = 1_024
export const AgentWorkerObservation = Schema.Struct({
  ...AgentWorkerIdentity.fields,
  jobId: JobIdentifier,
  status: JobStatus,
  terminalObservedAt: Schema.NullOr(WorkerTimestamp)
})
export type AgentWorkerObservation = typeof AgentWorkerObservation.Type

export const AgentWorkerObservations = Schema.Array(
  AgentWorkerObservation
).check(
  Schema.isMaxLength(workerObservationMaxLength),
  Schema.makeFilter(
    (observations) => {
      const keys = new Set(
        observations.map(({ agentId, host, jobId }) => `${host.toLowerCase()}\u0000${agentId}\u0000${jobId}`)
      )
      return keys.size === observations.length
    },
    { expected: "worker observations unique by host, agent ID, and job ID" }
  )
)
export type AgentWorkerObservations = typeof AgentWorkerObservations.Type

export const JobRecord = Schema.Struct({
  id: JobIdentifier,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  actor: JobActor,
  hash: JobHash,
  approvalNonce: Schema.NullOr(JobIdentifier),
  approvalExpiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  approvedBy: Schema.NullOr(JobActor),
  approvedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  rejectedBy: Schema.optionalKey(Schema.NullOr(JobActor)),
  rejectedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  expiredAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  status: JobStatus,
  payload: JobPayload,
  result: Schema.NullOr(Schema.String),
  acceptedReceipt: Schema.optionalKey(Schema.NullOr(HostOperationReceipt)),
  durableOperation: Schema.optionalKey(Schema.Literal(true)),
  error: Schema.NullOr(Schema.String),
  worker: Schema.optionalKey(AgentWorkerIdentity),
  connectTarget: Schema.optionalKey(AgentConnectTarget),
  workerTerminalObservedAt: Schema.optionalKey(Schema.NullOr(WorkerTimestamp))
}).check(
  Schema.makeFilter(
    (record) =>
      ((record.worker === undefined && record.connectTarget === undefined) ||
        (record.worker !== undefined &&
          record.connectTarget !== undefined &&
          record.connectTarget.host === record.worker.host &&
          record.connectTarget.agentId === record.worker.agentId)) &&
      (record.workerTerminalObservedAt === undefined ||
        record.workerTerminalObservedAt === null ||
        (record.worker !== undefined &&
          (record.status === "succeeded" || record.status === "failed" || record.status === "interrupted"))),
    { expected: "exact Connect target and terminal evidence only for the matching started worker" }
  ),
  Schema.makeFilter(
    (record) =>
      new TextEncoder().encode(JSON.stringify(record)).byteLength <=
        fleetJobRecordMaxBytes,
    { expected: `serialized job record at most ${fleetJobRecordMaxBytes} bytes` }
  )
)
export type JobRecord = typeof JobRecord.Type

export const PendingApprovalCursor = Schema.Struct({
  createdAt: Schema.Number,
  id: JobIdentifier
})
export type PendingApprovalCursor = typeof PendingApprovalCursor.Type

export const JobHistoryPage = Schema.Struct({
  records: Schema.Array(JobRecord),
  nextCursor: Schema.NullOr(PendingApprovalCursor)
})
export type JobHistoryPage = typeof JobHistoryPage.Type

export const FleetMachine = Schema.Struct({
  host: FleetHostName,
  nodeId: JobIdentifier
})
export type FleetMachine = typeof FleetMachine.Type

const FleetMachines = Schema.Array(FleetMachine).check(
  Schema.makeFilter(
    (machines) => {
      const hosts = new Set(machines.map(({ host }) => host.toLowerCase()))
      const nodeIds = new Set(machines.map(({ nodeId }) => nodeId))
      return hosts.size === machines.length && nodeIds.size === machines.length
    },
    { expected: "fleet machines unique by case-insensitive host and stable node ID" }
  )
)

const CommandArgument = Schema.String.check(
  Schema.isMaxLength(jobTextMaxLength),
  NoNullByte
)
const Command = Schema.Array(CommandArgument).check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (command) => command[0] !== undefined && command[0].length > 0,
    { expected: "a command with a non-empty executable" }
  )
)

const TcpPort = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
)

const WorkBindAddress = Schema.String.check(
  Schema.isPattern(/^(?:\d{1,3}\.){3}\d{1,3}$/),
  Schema.makeFilter(
    (address) => {
      const octets = address.split(".")
      const values = octets.map(Number)
      // The Work listener has no authentication of its own, so only loopback may reach it.
      return (
        values[0] === 127 &&
        values.every(
          (octet, index) => String(octet) === octets[index] && octet >= 0 && octet <= 255
        )
      )
    },
    { expected: "a specific IPv4 loopback address (127.0.0.0/8) for the unauthenticated Work listener" }
  )
)

export const LanWorkConfiguration = Schema.Struct({
  address: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(253)),
  host: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(253),
    Schema.isPattern(/^[A-Za-z0-9.-]+$/u)
  ),
  port: TcpPort
})
export interface LanWorkConfiguration extends Schema.Schema.Type<typeof LanWorkConfiguration> {}

export const HostConfiguration = Schema.Struct({
  host: FleetHostName,
  repository: Schema.String,
  stateDirectory: Schema.String,
  crossHost: Schema.Boolean,
  port: TcpPort,
  localPort: TcpPort,
  workBindAddress: Schema.optionalKey(WorkBindAddress),
  approvalPort: TcpPort,
  lanWork: Schema.optionalKey(LanWorkConfiguration),
  allowedUsers: Schema.Array(Schema.String),
  approvalNodes: Schema.Array(Schema.String),
  machines: FleetMachines,
  applyMachines: Schema.Array(FleetHostName),
  checkCommand: Command,
  applyCommand: Schema.NullOr(Command),
  browserMcpRecoverCommand: Schema.NullOr(Command),
  /**
   * Prints this host's Claude and Codex limits as one JSON line (`agent-usage limits`), shown in
   * Connect; absent turns limits off for this host.
   */
  agentUsageLimitsCommand: Schema.optionalKey(Command),
  coordinatorCommand: Command,
  herdrCommand: Schema.String,
  tailscaleCommand: Schema.String,
  approvalTls: Schema.NullOr(
    Schema.Struct({
      certificatePath: Schema.String.check(
        Schema.isMaxLength(1_024),
        Schema.isPattern(/^\//)
      ),
      privateKeyPath: Schema.String.check(
        Schema.isMaxLength(1_024),
        Schema.isPattern(/^\//)
      )
    })
  ),
  approvalHub: Schema.Struct({
    host: FleetHostName,
    nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    url: Schema.String.check(
      Schema.isMaxLength(2_048),
      Schema.isPattern(/^https:\/\/[^/]+\/$/)
    )
  }),
  pushAllowedOrigins: Schema.Array(HttpsOrigin),
  pushSubject: VapidSubject
}).check(
  Schema.makeFilter(
    (configuration) => {
      const configuredHosts = new Set(
        configuration.machines.map(({ host }) => host.toLowerCase())
      )
      const applyHosts = configuration.applyMachines.map((host) => host.toLowerCase())
      const localConfigured = configuredHosts.has(
        configuration.host.toLowerCase()
      )
      const approvalHubConfigured = configuration.machines.some(
        ({ host, nodeId }) =>
          host.toLowerCase() === configuration.approvalHub.host.toLowerCase() &&
          nodeId === configuration.approvalHub.nodeId
      )
      const approvalHubUrl = URL.canParse(configuration.approvalHub.url)
        ? new URL(configuration.approvalHub.url)
        : null
      const approvalHubPort = approvalHubUrl === null || approvalHubUrl.port === ""
        ? 443
        : Number(approvalHubUrl.port)
      const lanPortAvailable = configuration.lanWork === undefined ||
        ![configuration.localPort, configuration.port, configuration.approvalPort].includes(
          configuration.lanWork.port
        )
      return (
        new Set(applyHosts).size === applyHosts.length &&
        applyHosts.every((host) => configuredHosts.has(host)) &&
        localConfigured &&
        approvalHubUrl !== null &&
        approvalHubPort === configuration.approvalPort &&
        (configuration.crossHost || configuration.port !== configuration.localPort) &&
        (
          !configuration.crossHost ||
          (
            approvalHubConfigured &&
            configuration.port !== configuration.approvalPort
          )
        ) &&
        lanPortAvailable
      )
    },
    {
      expected:
        "valid fleet targets, distinct listeners, and an approval hub URL whose effective port matches the TLS listener"
    }
  )
)
export type HostConfiguration = typeof HostConfiguration.Type

export const AgentSummary = Schema.Struct({
  agentId: Schema.NullOr(AgentStableId),
  activityRevision: Schema.Number,
  kind: Schema.String,
  name: AgentWorkerIdentity.fields.name,
  paneId: AgentWorkerIdentity.fields.paneId,
  parentAgentId: Schema.NullOr(AgentStableId),
  relation: Schema.NullOr(Schema.Literals(["delegated", "pair", "review"])),
  status: Schema.String,
  work: Schema.String
}).check(
  Schema.makeFilter(
    (agent) =>
      (agent.parentAgentId === null && agent.relation === null) ||
      (agent.agentId !== null &&
        agent.parentAgentId !== null &&
        agent.relation !== null),
    { expected: "complete agent relationship metadata or no relationship" }
  )
)
export type AgentSummary = typeof AgentSummary.Type

export const AgentInventory = Schema.Struct({
  agents: Schema.Array(AgentSummary),
  available: Schema.Boolean,
  error: Schema.NullOr(Schema.String)
})
export type AgentInventory = typeof AgentInventory.Type

export const HostDetails = Schema.Struct({
  applyConfigured: Schema.Boolean,
  branch: Schema.String,
  dirty: Schema.Boolean,
  repository: Schema.String,
  revision: Schema.String
})
export type HostDetails = typeof HostDetails.Type

export const HostStatus = Schema.Struct({
  ...HostDetails.fields,
  herdr: AgentInventory,
  host: FleetHostName
})
export type HostStatus = typeof HostStatus.Type

export const requiresApproval = (payload: JobPayload): boolean =>
  payload.kind === "nix.apply" ||
  payload.kind === "browser.mcp.recover" ||
  payload.kind === "agent.message" ||
  payload.kind === "work.reconcile" ||
  payload.kind === "work.admit" ||
  payload.kind === "work.recover" ||
  payload.kind === "work.reassign" ||
  payload.kind === "work.abandon" ||
  (payload.kind === "agent.delegate" && payload.mode === "work")

/**
 * Which listener delivered a submission. Only the HTTP listener sets it, after
 * transport authorization; it is never decoded from a request body.
 */
export type SubmissionProvenance = "verified_local_listener" | "authenticated_remote"

/**
 * Job kinds a verified local listener may queue without approval. Work kinds
 * change Work authority, so they always require approval; the `satisfies`
 * constraint fails to compile if one is ever added here.
 */
export const LocalListenerApprovalExemptKind = Schema.Literals(
  [
    "nix.check",
    "nix.apply",
    "agent.delegate",
    "agent.message"
  ] satisfies ReadonlyArray<Exclude<JobPayload["kind"], WorkJobKind>>
)
export type LocalListenerApprovalExemptKind = typeof LocalListenerApprovalExemptKind.Type
export const isLocalListenerApprovalExempt = Schema.is(LocalListenerApprovalExemptKind)

/** Whether a submission from `provenance` must wait for an approval. */
export const submissionRequiresApproval = (payload: JobPayload, provenance: SubmissionProvenance): boolean =>
  requiresApproval(payload) &&
  !(provenance === "verified_local_listener" && isLocalListenerApprovalExempt(payload.kind))
