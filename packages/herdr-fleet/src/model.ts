import { Schema } from "effect"
import { fleetJobRecordMaxBytes } from "./limits.js"

export const JobIdentifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256)
)
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

export const DelegateMode = Schema.Literals(["consult", "review", "work"])
export type DelegateMode = typeof DelegateMode.Type

export const AgentStableId = Schema.String.check(
  Schema.isMinLength(7),
  Schema.isMaxLength(256),
  Schema.isPattern(/^agent-[A-Za-z0-9_-]+$/)
)
export type AgentStableId = typeof AgentStableId.Type

export const AgentWorkerRelationship = Schema.Struct({
  parentAgentId: AgentStableId,
  relation: Schema.Literals(["delegated", "pair", "review"])
})
export type AgentWorkerRelationship = typeof AgentWorkerRelationship.Type

export const AgentWorkerIdentity = Schema.Struct({
  host: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(253),
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/)
  ),
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
  channel: Schema.optionalKey(Schema.Literal("coordinator_chat"))
})
export type AgentDelegate = typeof AgentDelegate.Type
export const AgentMessage = Schema.Struct({
  kind: Schema.Literal("agent.message"),
  session: HerdrTarget,
  message: JobText
})

export const BrowserMcpRecover = Schema.Struct({
  kind: Schema.Literal("browser.mcp.recover")
})
export type BrowserMcpRecover = typeof BrowserMcpRecover.Type

export const CoreJobPayload = Schema.Union([
  NixCheck,
  NixApply,
  AgentDelegate,
  AgentMessage
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
  host: JobIdentifier,
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

export const HostConfiguration = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  stateDirectory: Schema.String,
  crossHost: Schema.Boolean,
  port: TcpPort,
  localPort: TcpPort,
  approvalPort: TcpPort,
  allowedUsers: Schema.Array(Schema.String),
  approvalNodes: Schema.Array(Schema.String),
  machines: FleetMachines,
  applyMachines: Schema.Array(Schema.String),
  checkCommand: Command,
  applyCommand: Schema.NullOr(Command),
  browserMcpRecoverCommand: Schema.NullOr(Command),
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
    host: Schema.String,
    nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    url: Schema.String.check(
      Schema.isMaxLength(2_048),
      Schema.isPattern(/^https:\/\/[^/]+\/$/)
    )
  }),
  pushAllowedOrigins: Schema.Array(
    Schema.String.check(
      Schema.isMaxLength(2_048),
      Schema.isPattern(/^https:\/\/[^/?#@]+$/)
    )
  ),
  pushSubject: Schema.String.check(
    Schema.isMaxLength(2_048),
    Schema.isPattern(/^(mailto:|https:\/\/)/)
  )
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
      return new Set(applyHosts).size === applyHosts.length &&
        applyHosts.every((host) => configuredHosts.has(host)) &&
        localConfigured &&
        approvalHubUrl !== null &&
        approvalHubPort === configuration.approvalPort &&
        (
          !configuration.crossHost ||
          (
            approvalHubConfigured &&
            configuration.port !== configuration.approvalPort
          )
        )
    },
    {
      expected:
        "valid fleet targets, distinct cross-host listeners, and an approval hub URL whose effective port matches the TLS listener"
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
  host: Schema.String
})
export type HostStatus = typeof HostStatus.Type

export const requiresApproval = (payload: JobPayload): boolean =>
  payload.kind === "nix.apply" ||
  payload.kind === "browser.mcp.recover" ||
  payload.kind === "agent.message" ||
  (payload.kind === "agent.delegate" && payload.mode === "work")
