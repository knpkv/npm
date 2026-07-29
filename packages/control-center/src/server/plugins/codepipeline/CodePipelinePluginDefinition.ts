/**
 * Production AWS CodePipeline read adapter for one configured pipeline.
 *
 * Entity synchronization, bounded evidence reads, and governed pipeline
 * mutations share this adapter's exact pipeline and AWS identity boundary.
 *
 * @internal
 */
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as SynchronizedRef from "effect/SynchronizedRef"

import { PluginHealth } from "../../../domain/freshness.js"
import type { PluginPayloadJson } from "../../../domain/plugins/bounds.js"
import {
  type AuthorizedPluginActionV1,
  NormalizedPluginEventV1,
  PluginActionActorIdentityV1,
  type PluginActionDispatchResultV1,
  PluginActionPayloadDigest,
  PluginActionPreflightV1,
  PluginActionProposalV1,
  PluginActionReconciliationKey,
  type PluginActionReconciliationRequestV1,
  type PluginActionReconciliationResultV1,
  PluginDiscoveryV1,
  type PluginPipelineArtifactRangeRequestV1,
  PluginPipelineArtifactRangeV1,
  type PluginPipelineLogPageRequestV1,
  PluginPipelineLogPageV1,
  PluginProviderOperationId,
  PluginSyncPageV1,
  type PluginSyncRequestV1,
  type ProposePluginActionRequestV1,
  type ReadPluginEntityRequestV1,
  ReadPluginEntityResultV1
} from "../../../domain/plugins/index.js"
import { Revision } from "../../../domain/sourceRevision.js"
import { digestGovernedActionPayload } from "../../governance/governedActionDigests.js"
import {
  PluginConfigurationFailure,
  PluginConflictFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginTimeoutFailure,
  PluginUnknownOutcomeFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import { pluginCapabilityCodecsV1 } from "../PluginCapabilityCodecs.js"
import type { PluginConnectionV1 } from "../PluginConnection.js"
import { definePluginV1 } from "../PluginDefinition.js"
import type { PluginDefinitionV1 } from "../PluginDefinitionV1.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import {
  canonicalCodePipelinePrincipalArn,
  CodePipelineAccountIdentity,
  type CodePipelineActionExecution,
  type CodePipelineExecutionSnapshot,
  type CodePipelinePipeline,
  CodePipelineReadClient
} from "./CodePipelineReadClient.js"
import type {
  CodePipelineMutationProviderFailure,
  CodePipelinePreDispatchTimeoutFailure,
  CodePipelineProviderFailure
} from "./CodePipelineReadProvider.js"

const EXECUTION_STREAM_KEY = "executions"
const COMPLETE_CHECKPOINT = "complete"
const NEXT_CHECKPOINT_PREFIX = "next:"
const LOG_CURSOR_SEPARATOR = ":"
const LOG_PROVIDER_PAGE_SIZE = 100
const MAXIMUM_LOG_CURSOR_PROVIDER_TOKEN_LENGTH = 3_900
const utf8Encoder = new TextEncoder()

interface CloudWatchLogCoordinates {
  readonly region: string
  readonly logGroupName: string
  readonly logStreamName: string
}

const cloudWatchLogCoordinates = (
  arn: string,
  expectedAccountId: string,
  expectedPrincipalArn: string,
  actionRegion: string | null
): CloudWatchLogCoordinates | null => {
  const match = /^arn:([^:]+):logs:([^:]+):([^:]+):log-group:(.+):log-stream:(.+)$/u.exec(arn)
  const expectedPartition = /^arn:([^:]+):/u.exec(expectedPrincipalArn)?.[1]
  const partition = match?.[1]
  const region = match?.[2]
  const accountId = match?.[3]
  const logGroupName = match?.[4]
  const logStreamName = match?.[5]
  if (
    partition === undefined ||
    region === undefined ||
    accountId === undefined ||
    logGroupName === undefined ||
    logStreamName === undefined ||
    expectedPartition === undefined ||
    partition !== expectedPartition ||
    accountId !== expectedAccountId ||
    (actionRegion !== null && actionRegion !== region)
  ) {
    return null
  }
  return {
    region,
    logGroupName,
    logStreamName
  }
}

const AwsProfile = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))
const AwsRegion = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))
const PipelineName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))
const ActionIdentifier = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256))
const SourceRevisionValue = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))
const StopReason = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))
const ApprovalSummary = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const SourceRevisionType = Schema.Literals([
  "COMMIT_ID",
  "IMAGE_DIGEST",
  "S3_OBJECT_VERSION_ID",
  "S3_OBJECT_KEY"
])
const SourceRevision = Schema.Struct({
  actionName: ActionIdentifier,
  revisionType: SourceRevisionType,
  revisionValue: SourceRevisionValue
}).check(
  Schema.makeFilter(
    ({ revisionType, revisionValue }) =>
      revisionType === "S3_OBJECT_KEY" || revisionType === "S3_OBJECT_VERSION_ID"
        ? utf8Encoder.encode(revisionValue).byteLength <= 1_024
        : revisionValue === revisionValue.trim() && revisionValue.length <= 256,
    { expected: "a provider-compatible source revision value" }
  )
)
const PipelineVariable = Schema.Struct({
  name: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9@_-]+$/u)
  ),
  value: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_000))
})
const PipelineVariables = Schema.Array(PipelineVariable).check(
  Schema.isMaxLength(50),
  Schema.makeFilter(
    (variables) => new Set(variables.map(({ name }) => name)).size === variables.length,
    { expected: "unique pipeline variable names" }
  )
)
const StartSourceRevisions = Schema.Array(SourceRevision).check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(50),
  Schema.makeFilter(
    (revisions) => new Set(revisions.map(({ actionName }) => actionName)).size === revisions.length,
    { expected: "unique source action names" }
  )
)
const StartActionPayloadInput = Schema.Struct({
  sourceRevisions: StartSourceRevisions,
  variables: Schema.optionalKey(PipelineVariables),
  pipelineRevision: Schema.optionalKey(Revision)
})
const StartActionPayload = Schema.Struct({
  sourceRevisions: StartSourceRevisions,
  variables: PipelineVariables,
  pipelineRevision: Schema.optionalKey(Revision)
})
const StopActionPayload = Schema.Struct({
  mode: Schema.Literals(["wait", "abandon"]),
  reason: StopReason,
  pipelineRevision: Schema.optionalKey(Revision)
})
const ApprovalActionPayload = Schema.Struct({
  stageName: ActionIdentifier,
  actionName: ActionIdentifier,
  actionExecutionId: ActionIdentifier,
  summary: ApprovalSummary,
  pipelineRevision: Schema.optionalKey(Revision),
  actionRevision: Schema.optionalKey(Revision),
  approvalStatus: Schema.optionalKey(Schema.Literals(["Approved", "Rejected"])),
  approvalTokenDigest: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128))
  )
})
const RetryActionPayload = Schema.Struct({
  retryOf: ActionIdentifier,
  sourceRevisions: Schema.Array(SourceRevision).check(Schema.isNonEmpty(), Schema.isMaxLength(50)),
  variables: PipelineVariables,
  pipelineRevision: Schema.optionalKey(Revision)
})
const LogCursorParts = Schema.Struct({
  scope: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)),
  eventOffset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  token: Schema.NullOr(
    Schema.String.check(
      Schema.isTrimmed(),
      Schema.isNonEmpty(),
      Schema.isMaxLength(MAXIMUM_LOG_CURSOR_PROVIDER_TOKEN_LENGTH)
    )
  )
})

type CodePipelineActionKind =
  | "pipeline.start"
  | "pipeline.stop"
  | "pipeline.approve"
  | "pipeline.reject"
  | "pipeline.retry"

const ACTION_KINDS: ReadonlySet<string> = new Set([
  "pipeline.start",
  "pipeline.stop",
  "pipeline.approve",
  "pipeline.reject",
  "pipeline.retry"
])

const isActionKind = (value: string): value is CodePipelineActionKind => ACTION_KINDS.has(value)
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const ReconciliationActionKind = Schema.Literals(["start", "stop", "approval", "retry"])
const ReconciliationLocator = Schema.TemplateLiteralParser([
  "codepipeline:",
  ReconciliationActionKind,
  ":",
  PluginActionPayloadDigest
])

const reconciliationActionKind = (
  actionKind: CodePipelineActionKind
): typeof ReconciliationActionKind.Type => {
  switch (actionKind) {
    case "pipeline.start":
      return "start"
    case "pipeline.stop":
      return "stop"
    case "pipeline.approve":
    case "pipeline.reject":
      return "approval"
    case "pipeline.retry":
      return "retry"
  }
}

/** Secret-free production adapter configuration. @internal */
export const CodePipelinePluginConfiguration = Schema.Struct({
  profile: AwsProfile,
  region: AwsRegion,
  pipelineName: PipelineName,
  maximumExecutionPages: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  actionPageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  maximumActionPages: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  maximumActionsPerExecution: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  maximumLogBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 })),
  operationTimeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 })),
  runtimeIdentity: Schema.optionalKey(CodePipelineAccountIdentity)
})

type CodePipelineConfiguration = typeof CodePipelinePluginConfiguration.Type

const descriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.aws-codepipeline",
  adapterVersion: { major: 0, minor: 2, patch: 0 },
  displayName: "AWS CodePipeline",
  configurationFields: [
    {
      _tag: "text",
      key: "profile",
      label: "AWS profile",
      description: "Local AWS credential profile resolved only by the server-side adapter.",
      required: true
    },
    {
      _tag: "text",
      key: "region",
      label: "AWS region",
      description: "AWS region containing the configured pipeline.",
      required: true
    },
    {
      _tag: "text",
      key: "pipelineName",
      label: "Pipeline",
      description: "One CodePipeline pipeline normalized by this connection.",
      required: true
    },
    {
      _tag: "integer",
      key: "maximumExecutionPages",
      label: "Execution pages",
      description: "Maximum single-execution provider pages read by one synchronization run.",
      required: true,
      minimum: 1,
      maximum: 20
    },
    {
      _tag: "integer",
      key: "actionPageSize",
      label: "Action page size",
      description: "Maximum action executions requested from one provider page.",
      required: true,
      minimum: 1,
      maximum: 100
    },
    {
      _tag: "integer",
      key: "maximumActionPages",
      label: "Action pages",
      description: "Maximum action-execution pages read for one pipeline execution.",
      required: true,
      minimum: 1,
      maximum: 5
    },
    {
      _tag: "integer",
      key: "maximumActionsPerExecution",
      label: "Actions per execution",
      description: "Hard normalization limit for action executions under one execution.",
      required: true,
      minimum: 1,
      maximum: 200
    },
    {
      _tag: "integer",
      key: "maximumLogBytes",
      label: "Log page bytes",
      description: "Maximum aggregate UTF-8 message bytes returned by one log page.",
      required: true,
      minimum: 1,
      maximum: 1024 * 1024
    },
    {
      _tag: "integer",
      key: "operationTimeoutMillis",
      label: "Request timeout",
      description: "Maximum milliseconds for credential and CodePipeline provider requests.",
      required: true,
      minimum: 1_000,
      maximum: 120_000
    }
  ],
  capabilities: [
    "entity.read",
    "sync.incremental",
    "action.propose",
    "action.execute",
    "action.reconcile",
    "pipeline.logs",
    "pipeline.artifact"
  ].map((capabilityId) => ({
    capabilityId,
    supportedVersions: [1],
    requirement: "required"
  }))
} satisfies unknown

/** Current CodePipeline descriptor snapshot used by first-party runtime compatibility checks. @internal */
export const codePipelinePluginDescriptor = descriptor

const unsupported = (capabilityId: "action.cancel") =>
  new PluginUnsupportedCapabilityFailure({
    capabilityId,
    requestedVersion: 1,
    diagnosticCode: "codepipeline-read-adapter-capability-not-offered"
  })

const decodeOutput = <Codec extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: Codec,
  value: unknown
): Effect.Effect<Codec["Type"], PluginMalformedResponseFailure> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation,
        diagnosticCode: "codepipeline-plugin-normalization-invalid"
      })
    )
  )

const formatDate = (value: Date): string => DateTime.formatIso(DateTime.makeUnsafe(value))
const pipelineConsoleUrl = (configuration: CodePipelineConfiguration): string =>
  `https://${configuration.region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${
    encodeURIComponent(configuration.pipelineName)
  }/view`
const executionConsoleUrl = (configuration: CodePipelineConfiguration, executionId: string): string =>
  `${pipelineConsoleUrl(configuration)}?region=${encodeURIComponent(configuration.region)}&pipeline-execution=${
    encodeURIComponent(executionId)
  }`

const sampledAt = DateTime.now.pipe(Effect.map(DateTime.formatIso))

const account = (configuration: CodePipelineConfiguration) => ({
  profile: configuration.profile,
  region: configuration.region,
  operationTimeoutMillis: configuration.operationTimeoutMillis
})

const actionBounds = (configuration: CodePipelineConfiguration) => ({
  pageSize: configuration.actionPageSize,
  maximumPages: configuration.maximumActionPages,
  maximumActions: configuration.maximumActionsPerExecution
})

const pipelineEvent = Effect.fn("CodePipelinePlugin.pipelineEvent")(function*(
  configuration: CodePipelineConfiguration,
  pipeline: CodePipelinePipeline
) {
  const observedAt = pipeline.updatedAt === null
    ? pipeline.createdAt === null ? yield* sampledAt : formatDate(pipeline.createdAt)
    : formatDate(pipeline.updatedAt)
  const revision = `${pipeline.version}:${pipeline.updatedAt === null ? "undated" : formatDate(pipeline.updatedAt)}`
  return yield* decodeOutput("codepipeline-normalize-pipeline", NormalizedPluginEventV1, {
    _tag: "UpsertEntity",
    eventId: `${pipeline.name}:pipeline:${revision}`,
    observedAt,
    revision,
    entityType: "aws.codepipeline.pipeline",
    vendorImmutableId: pipeline.arn,
    sourceUrl: pipelineConsoleUrl(configuration),
    title: pipeline.name,
    attributes: {
      schemaVersion: 1,
      provider: "aws.codepipeline",
      region: configuration.region,
      pipelineArn: pipeline.arn,
      pipelineName: pipeline.name,
      pipelineVersion: pipeline.version,
      pipelineType: pipeline.pipelineType,
      executionMode: pipeline.executionMode,
      createdAt: pipeline.createdAt === null ? null : formatDate(pipeline.createdAt),
      updatedAt: pipeline.updatedAt === null ? null : formatDate(pipeline.updatedAt),
      sampledAt: observedAt,
      stages: pipeline.stages.map((stage) => ({
        name: stage.name,
        actions: stage.actions.map((action) => ({
          name: action.name,
          actionType: action.actionType,
          runOrder: action.runOrder,
          region: action.region,
          roleArn: action.roleArn,
          inputArtifactNames: action.inputArtifactNames,
          outputArtifactNames: action.outputArtifactNames
        }))
      }))
    }
  })
})

const actionObservedAt = (action: CodePipelineActionExecution, fallback: string): string =>
  action.updatedAt === null
    ? action.startedAt === null ? fallback : formatDate(action.startedAt)
    : formatDate(action.updatedAt)

const actionRevision = (action: CodePipelineActionExecution): string =>
  `${action.status}:${action.updatedAt === null ? "undated" : formatDate(action.updatedAt)}`

const pipelineRevision = (pipeline: CodePipelinePipeline): string =>
  `${pipeline.version}:${pipeline.updatedAt === null ? "undated" : formatDate(pipeline.updatedAt)}`

const executionRevision = (snapshot: CodePipelineExecutionSnapshot): string =>
  `${snapshot.execution.pipelineVersion}:${snapshot.execution.status}:${
    snapshot.execution.updatedAt === null
      ? "undated"
      : formatDate(snapshot.execution.updatedAt)
  }`

const impactFor = (
  kind: CodePipelineActionKind,
  payload: unknown
): { readonly level: "low" | "medium" | "high" | "critical"; readonly summary: string } => {
  switch (kind) {
    case "pipeline.start":
      return { level: "high", summary: "Starts a new execution at explicit source revisions" }
    case "pipeline.stop":
      return {
        level: Schema.is(StopActionPayload)(payload) && payload.mode === "abandon"
          ? "critical"
          : "high",
        summary: "Stops one in-progress pipeline execution"
      }
    case "pipeline.approve":
      return { level: "high", summary: "Approves one pending manual approval action" }
    case "pipeline.reject":
      return { level: "high", summary: "Rejects one pending manual approval action" }
    case "pipeline.retry":
      return { level: "high", summary: "Starts a distinct retry execution at the original revisions" }
  }
}

const summaryFor = (kind: CodePipelineActionKind, target: string): string => {
  switch (kind) {
    case "pipeline.start":
      return `Start pipeline ${target}`
    case "pipeline.stop":
      return `Stop pipeline execution ${target}`
    case "pipeline.approve":
      return `Approve manual pipeline action ${target}`
    case "pipeline.reject":
      return `Reject manual pipeline action ${target}`
    case "pipeline.retry":
      return `Retry pipeline execution ${target} as a distinct execution`
  }
}

const actionEvent = Effect.fn("CodePipelinePlugin.actionEvent")(function*(
  configuration: CodePipelineConfiguration,
  pipeline: CodePipelinePipeline,
  action: CodePipelineActionExecution,
  fallbackObservedAt: string
) {
  const revision = actionRevision(action)
  const observedAt = actionObservedAt(action, fallbackObservedAt)
  return yield* decodeOutput("codepipeline-normalize-action", NormalizedPluginEventV1, {
    _tag: "UpsertEntity",
    eventId: `${action.actionExecutionId}:${revision}`,
    observedAt,
    revision,
    entityType: "aws.codepipeline.action",
    vendorImmutableId: `${action.executionId}#${action.actionExecutionId}`,
    sourceUrl: executionConsoleUrl(configuration, action.executionId),
    title: `${pipeline.name} · ${action.stageName} · ${action.actionName}`,
    attributes: {
      schemaVersion: 1,
      provider: "aws.codepipeline",
      region: configuration.region,
      pipelineArn: pipeline.arn,
      pipelineName: pipeline.name,
      executionId: action.executionId,
      actionExecutionId: action.actionExecutionId,
      stageName: action.stageName,
      actionName: action.actionName,
      status: action.status,
      actionType: action.actionType,
      startedAt: action.startedAt === null ? null : formatDate(action.startedAt),
      updatedAt: action.updatedAt === null ? null : formatDate(action.updatedAt),
      updatedBy: action.updatedBy,
      roleArn: action.roleArn,
      actionRegion: action.region,
      inputArtifacts: action.inputArtifacts.map(({ access, name }) => ({ access, name })),
      outputArtifacts: action.outputArtifacts.map(({ access, name }) => ({ access, name })),
      externalExecutionId: action.externalExecutionId,
      externalExecutionSummary: action.externalExecutionSummary,
      errorCode: action.errorCode,
      errorMessage: action.errorMessage,
      sampledAt: observedAt
    }
  })
})

const stageStatus = (actions: ReadonlyArray<CodePipelineActionExecution>): string => {
  const statuses = new Set(actions.map(({ status }) => status))
  for (const status of ["Failed", "InProgress", "Abandoned", "Succeeded"]) {
    if (statuses.has(status)) return status
  }
  return [...statuses].sort()[0] ?? "Unknown"
}

const latestActionDate = (actions: ReadonlyArray<CodePipelineActionExecution>): Date | null => {
  let latest: Date | null = null
  for (const action of actions) {
    const candidate = action.updatedAt ?? action.startedAt
    if (candidate !== null && (latest === null || candidate.getTime() > latest.getTime())) latest = candidate
  }
  return latest
}

const stageEvent = Effect.fn("CodePipelinePlugin.stageEvent")(function*(
  configuration: CodePipelineConfiguration,
  pipeline: CodePipelinePipeline,
  executionId: string,
  stageName: string,
  actions: ReadonlyArray<CodePipelineActionExecution>,
  actionsTruncated: boolean,
  fallbackObservedAt: string
) {
  const status = stageStatus(actions)
  const latest = latestActionDate(actions)
  const observedAt = latest === null ? fallbackObservedAt : formatDate(latest)
  const revision = `${status}:${latest === null ? "undated" : formatDate(latest)}`
  return yield* decodeOutput("codepipeline-normalize-stage", NormalizedPluginEventV1, {
    _tag: "UpsertEntity",
    eventId: `${executionId}:stage:${stageName}:${revision}`,
    observedAt,
    revision,
    entityType: "aws.codepipeline.stage",
    vendorImmutableId: `${executionId}#${stageName}`,
    sourceUrl: executionConsoleUrl(configuration, executionId),
    title: `${pipeline.name} · ${stageName}`,
    attributes: {
      schemaVersion: 1,
      provider: "aws.codepipeline",
      region: configuration.region,
      pipelineArn: pipeline.arn,
      pipelineName: pipeline.name,
      executionId,
      stageName,
      status,
      actionExecutionIds: actions.map(({ actionExecutionId }) => actionExecutionId),
      actionCount: actions.length,
      actionsTruncated,
      sampledAt: observedAt
    }
  })
})

const executionEvent = Effect.fn("CodePipelinePlugin.executionEvent")(function*(
  configuration: CodePipelineConfiguration,
  pipeline: CodePipelinePipeline,
  snapshot: CodePipelineExecutionSnapshot,
  observedAt: string
) {
  const execution = snapshot.execution
  const summary = snapshot.summary
  const updatedAt = execution.updatedAt
  const revision = `${execution.pipelineVersion}:${execution.status}:${
    updatedAt === null ? "undated" : formatDate(updatedAt)
  }`
  return yield* decodeOutput("codepipeline-normalize-execution", NormalizedPluginEventV1, {
    _tag: "UpsertEntity",
    eventId: `${pipeline.name}:execution:${execution.executionId}:${revision}`,
    observedAt,
    revision,
    entityType: "aws.codepipeline.execution",
    vendorImmutableId: execution.executionId,
    sourceUrl: executionConsoleUrl(configuration, execution.executionId),
    title: `${pipeline.name} · ${execution.executionId}`,
    attributes: {
      schemaVersion: 1,
      provider: "aws.codepipeline",
      region: configuration.region,
      pipelineArn: pipeline.arn,
      pipelineName: execution.pipelineName,
      pipelineVersion: execution.pipelineVersion,
      executionId: execution.executionId,
      status: execution.status,
      statusSummary: execution.statusSummary ?? summary?.statusSummary ?? null,
      startedAt: summary === null ? null : formatDate(summary.startedAt),
      updatedAt: updatedAt === null ? null : formatDate(updatedAt),
      sourceRevisions: summary?.sourceRevisions ?? [],
      triggerType: execution.triggerType ?? summary?.triggerType ?? null,
      triggerDetail: execution.triggerDetail ?? summary?.triggerDetail ?? null,
      executionMode: execution.executionMode ?? summary?.executionMode ?? null,
      executionType: execution.executionType ?? summary?.executionType ?? null,
      rollbackTargetExecutionId: execution.rollbackTargetExecutionId ?? summary?.rollbackTargetExecutionId ?? null,
      artifactRevisions: execution.artifactRevisions.map((artifact) => ({
        name: artifact.name,
        revisionId: artifact.revisionId,
        revisionSummary: artifact.revisionSummary,
        createdAt: artifact.createdAt === null ? null : formatDate(artifact.createdAt)
      })),
      actionCount: snapshot.actionCollection.actions.length,
      actionsTruncated: snapshot.actionCollection.truncated,
      actionPagesRead: snapshot.actionCollection.pagesRead,
      sampledAt: observedAt
    }
  })
})

const snapshotEvents = Effect.fn("CodePipelinePlugin.snapshotEvents")(function*(
  configuration: CodePipelineConfiguration,
  pipeline: CodePipelinePipeline,
  snapshot: CodePipelineExecutionSnapshot,
  includePipeline: boolean
): Effect.fn.Return<ReadonlyArray<NormalizedPluginEventV1>, PluginMalformedResponseFailure> {
  const updatedAt = snapshot.execution.updatedAt ?? snapshot.summary?.updatedAt ?? null
  const fallbackObservedAt = updatedAt === null
    ? snapshot.summary === null ? yield* sampledAt : formatDate(snapshot.summary.startedAt)
    : formatDate(updatedAt)
  const events: Array<NormalizedPluginEventV1> = []
  if (includePipeline) events.push(yield* pipelineEvent(configuration, pipeline))
  events.push(yield* executionEvent(configuration, pipeline, snapshot, fallbackObservedAt))
  const byStage = new Map<string, Array<CodePipelineActionExecution>>()
  for (const action of snapshot.actionCollection.actions) {
    const stage = byStage.get(action.stageName)
    if (stage === undefined) byStage.set(action.stageName, [action])
    else stage.push(action)
  }
  for (const [stageName, actions] of [...byStage.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    events.push(
      yield* stageEvent(
        configuration,
        pipeline,
        snapshot.execution.executionId,
        stageName,
        actions,
        snapshot.actionCollection.truncated,
        fallbackObservedAt
      )
    )
  }
  for (
    const action of [...snapshot.actionCollection.actions].sort((left, right) =>
      left.actionExecutionId.localeCompare(right.actionExecutionId)
    )
  ) {
    events.push(yield* actionEvent(configuration, pipeline, action, fallbackObservedAt))
  }
  return events
})

const providerTokenFromCheckpoint = (
  checkpoint: PluginSyncRequestV1["checkpoint"]
): Effect.Effect<string | null, PluginConfigurationFailure> => {
  if (checkpoint === null || checkpoint === COMPLETE_CHECKPOINT) return Effect.succeed(null)
  if (!checkpoint.startsWith(NEXT_CHECKPOINT_PREFIX)) {
    return Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "codepipeline-sync-checkpoint-invalid" }))
  }
  const token = checkpoint.slice(NEXT_CHECKPOINT_PREFIX.length)
  return token.length === 0
    ? Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "codepipeline-sync-checkpoint-invalid" }))
    : Effect.succeed(token)
}

const checkpointFromToken = (token: string | null): string =>
  token === null ? COMPLETE_CHECKPOINT : `${NEXT_CHECKPOINT_PREFIX}${token}`

interface SyncState {
  readonly includePipeline: boolean
  readonly remaining: number
  readonly seenTokens: ReadonlySet<string>
  readonly token: string | null
}

const syncStep = (
  page: typeof PluginSyncPageV1.Type,
  next: Option.Option<SyncState>
): readonly [ReadonlyArray<typeof PluginSyncPageV1.Type>, Option.Option<SyncState>] => [[page], next]

const childReference = (value: string): { readonly executionId: string; readonly childId: string } | null => {
  const separator = value.indexOf("#")
  if (separator <= 0 || separator === value.length - 1) return null
  return { executionId: value.slice(0, separator), childId: value.slice(separator + 1) }
}

const missingResult = Effect.fn("CodePipelinePlugin.missingResult")(function*(
  request: ReadPluginEntityRequestV1
) {
  return yield* decodeOutput("codepipeline-read-entity", ReadPluginEntityResultV1, {
    _tag: "missing",
    reference: request,
    observedAt: yield* sampledAt
  })
})

const notFoundAsConfiguration = (operation: string) =>
  new PluginConfigurationFailure({ diagnosticCode: `${operation}-not-found` })

const makeConnection = Effect.fn("CodePipelinePlugin.makeConnection")(function*(
  configuration: CodePipelineConfiguration,
  descriptor: PluginConnectionV1["descriptor"]
): Effect.fn.Return<
  { readonly connection: PluginConnectionV1; readonly executor: AuthorizedPluginExecutorV1 },
  PluginFailure,
  CodePipelineReadClient | Crypto.Crypto
> {
  const readClient = yield* CodePipelineReadClient
  const cryptoService = yield* Crypto.Crypto
  const awsAccount = account(configuration)
  const dispatches = yield* SynchronizedRef.make(HashMap.empty<string, {
    readonly payloadDigest: string
    readonly result: Result.Result<PluginActionDispatchResultV1, PluginFailure>
  }>())

  const loadPipeline = readClient.getPipeline({
    account: awsAccount,
    pipelineName: configuration.pipelineName
  })
  const actionProvider = <A>(
    operation: string,
    effect: Effect.Effect<A, CodePipelineProviderFailure>
  ): Effect.Effect<A, PluginFailure> =>
    effect.pipe(
      Effect.catchTag(
        "CodePipelineProviderNotFoundFailure",
        () =>
          Effect.fail(
            new PluginConflictFailure({
              operation,
              diagnosticCode: "codepipeline-provider-object-not-found"
            })
          )
      )
    )
  const mutationProvider = <A>(
    operation: string,
    effect: Effect.Effect<A, CodePipelineMutationProviderFailure>
  ): Effect.Effect<A, PluginFailure | CodePipelinePreDispatchTimeoutFailure> =>
    effect.pipe(
      Effect.catchTag(
        "CodePipelineProviderNotFoundFailure",
        () =>
          Effect.fail(
            new PluginConflictFailure({
              operation,
              diagnosticCode: "codepipeline-provider-object-not-found"
            })
          )
      )
    )
  const runtimeIdentity = configuration.runtimeIdentity ??
    (yield* actionProvider(
      "runtime-identity",
      readClient.discoverAccount(awsAccount)
    ))
  const actionActorIdentity = yield* decodeOutput("codepipeline-action-actor", PluginActionActorIdentityV1, {
    providerId: "codepipeline",
    providerAccountId: runtimeIdentity.accountId,
    principal: runtimeIdentity.arn
  })
  const verifyRuntimeIdentity = Effect.fn("CodePipelinePlugin.verifyRuntimeIdentity")(function*() {
    const current = yield* actionProvider(
      "runtime-identity",
      readClient.discoverAccount(awsAccount)
    )
    if (
      current.accountId !== runtimeIdentity.accountId ||
      canonicalCodePipelinePrincipalArn(current.arn) !== canonicalCodePipelinePrincipalArn(runtimeIdentity.arn)
    ) {
      return yield* new PluginConflictFailure({
        operation: "runtime-identity",
        diagnosticCode: "codepipeline-runtime-identity-changed"
      })
    }
  })
  const clientRequestToken = Effect.fn("CodePipelinePlugin.clientRequestToken")(function*(
    request: AuthorizedPluginActionV1
  ) {
    const digest = yield* digestGovernedActionPayload({
      authorizationId: request.authorizationId,
      idempotencyKey: request.idempotencyKey,
      payloadDigest: request.payloadDigest
    }).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => new PluginOutageFailure({ operation: "codepipeline-client-token" }))
    )
    return `cc-${digest}`
  })
  const privateDigest = (operation: string, value: typeof PluginPayloadJson.Type) =>
    digestGovernedActionPayload(value).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => new PluginOutageFailure({ operation }))
    )
  const approvalTokenDigest = (token: string) =>
    privateDigest("codepipeline-approval-token-digest", { approvalToken: token })
  const logCursorScope = (action: CodePipelineActionExecution) =>
    privateDigest("codepipeline-log-cursor-scope", {
      executionId: action.executionId,
      actionExecutionId: action.actionExecutionId,
      logStreamArn: action.logStreamArn
    })
  const encodeLogCursor = (
    scope: string,
    eventOffset: number,
    token: string | null
  ): string => `${scope}${LOG_CURSOR_SEPARATOR}${eventOffset}${LOG_CURSOR_SEPARATOR}${token ?? ""}`
  const decodeLogCursor = Effect.fn("CodePipelinePlugin.decodeLogCursor")(function*(
    cursor: string,
    expectedScope: string
  ) {
    const scopeSeparator = cursor.indexOf(LOG_CURSOR_SEPARATOR)
    const offsetSeparator = scopeSeparator < 0
      ? -1
      : cursor.indexOf(LOG_CURSOR_SEPARATOR, scopeSeparator + LOG_CURSOR_SEPARATOR.length)
    const token = offsetSeparator < 0
      ? null
      : cursor.slice(offsetSeparator + LOG_CURSOR_SEPARATOR.length)
    const decoded = yield* Schema.decodeUnknownEffect(LogCursorParts)({
      scope: scopeSeparator < 0 ? "" : cursor.slice(0, scopeSeparator),
      eventOffset: scopeSeparator < 0 || offsetSeparator < 0
        ? -1
        : Number(cursor.slice(scopeSeparator + LOG_CURSOR_SEPARATOR.length, offsetSeparator)),
      token: token === "" ? null : token
    }).pipe(
      Effect.mapError(() =>
        new PluginConflictFailure({
          operation: "pipeline-logs",
          diagnosticCode: "codepipeline-log-cursor-invalid"
        })
      )
    )
    if (decoded.scope !== expectedScope) {
      return yield* new PluginConflictFailure({
        operation: "pipeline-logs",
        diagnosticCode: "codepipeline-log-cursor-scope-mismatch"
      })
    }
    return {
      eventOffset: decoded.eventOffset,
      providerCursor: decoded.token
    }
  })

  const loadSnapshot = (executionId: string) =>
    readClient.getExecutionSnapshot({
      account: awsAccount,
      pipelineName: configuration.pipelineName,
      pipelineExecutionId: executionId,
      actionBounds: actionBounds(configuration),
      summary: null
    })

  const exactAction = Effect.fn("CodePipelinePlugin.exactAction")(function*(
    reference: {
      readonly executionId: string
      readonly actionExecutionId: string
      readonly expectedRevision: string
    }
  ) {
    yield* verifyRuntimeIdentity()
    const snapshot = yield* actionProvider(
      "codepipeline-action-read",
      loadSnapshot(reference.executionId)
    )
    const action = snapshot.actionCollection.actions.find(
      (candidate) => candidate.actionExecutionId === reference.actionExecutionId
    )
    if (action === undefined) {
      if (snapshot.actionCollection.truncated) {
        return yield* new PluginConfigurationFailure({
          diagnosticCode: "codepipeline-action-read-bound-exhausted"
        })
      }
      return yield* new PluginConflictFailure({
        operation: "codepipeline-action-read",
        diagnosticCode: "codepipeline-action-not-found"
      })
    }
    if (actionRevision(action) !== reference.expectedRevision) {
      return yield* new PluginConflictFailure({
        operation: "codepipeline-action-read",
        diagnosticCode: "codepipeline-action-revision-changed"
      })
    }
    return action
  })

  const discover = Effect.gen(function*() {
    const response = yield* Effect.all({
      identity: readClient.discoverAccount(awsAccount),
      pipeline: loadPipeline
    }, { concurrency: 2 }).pipe(
      Effect.catchTag(
        "CodePipelineProviderNotFoundFailure",
        () => Effect.fail(notFoundAsConfiguration("codepipeline-discover-pipeline"))
      )
    )
    return yield* decodeOutput("codepipeline-discover", PluginDiscoveryV1, {
      account: {
        providerImmutableId: response.identity.accountId,
        displayName: response.identity.accountId
      },
      workspace: null,
      resource: {
        providerImmutableId: response.pipeline.arn,
        displayName: response.pipeline.name
      },
      endpoints: [{ kind: "web", url: pipelineConsoleUrl(configuration), label: "AWS CodePipeline" }],
      discoveredAt: yield* sampledAt
    })
  })

  const health = loadPipeline.pipe(
    Effect.catchTag(
      "CodePipelineProviderNotFoundFailure",
      () => Effect.fail(notFoundAsConfiguration("codepipeline-health-pipeline"))
    ),
    Effect.andThen(sampledAt),
    Effect.flatMap((checkedAt) => decodeOutput("codepipeline-health", PluginHealth, { _tag: "healthy", checkedAt }))
  )

  const sync = (request: PluginSyncRequestV1) => {
    if (request.streamKey !== EXECUTION_STREAM_KEY) {
      return Stream.fail(
        new PluginConfigurationFailure({ diagnosticCode: "codepipeline-sync-stream-unsupported" })
      )
    }
    return Stream.unwrap(
      Effect.all({ pipeline: loadPipeline, token: providerTokenFromCheckpoint(request.checkpoint) }).pipe(
        Effect.catchTag(
          "CodePipelineProviderNotFoundFailure",
          () => Effect.fail(notFoundAsConfiguration("codepipeline-sync-pipeline"))
        ),
        Effect.map(({ pipeline, token }) =>
          Stream.paginate<
            SyncState,
            typeof PluginSyncPageV1.Type,
            PluginFailure
          >(
            {
              includePipeline: true,
              remaining: configuration.maximumExecutionPages,
              seenTokens: new Set(token === null ? [] : [token]),
              token
            },
            (state) =>
              Effect.gen(function*() {
                const page = yield* readClient.listExecutionsPage({
                  account: awsAccount,
                  pipelineName: configuration.pipelineName,
                  nextToken: state.token
                }).pipe(
                  Effect.catchTag(
                    "CodePipelineProviderNotFoundFailure",
                    () => Effect.fail(notFoundAsConfiguration("codepipeline-sync-executions"))
                  )
                )
                const summary = page.executions[0]
                if (summary === undefined) {
                  if (page.nextToken !== null) {
                    return yield* new PluginMalformedResponseFailure({
                      operation: "codepipeline-sync",
                      diagnosticCode: "codepipeline-empty-execution-page-with-cursor"
                    })
                  }
                  const onlyPipeline = state.includePipeline ? [yield* pipelineEvent(configuration, pipeline)] : []
                  const normalized = yield* decodeOutput("codepipeline-sync", Schema.toType(PluginSyncPageV1), {
                    events: onlyPipeline,
                    checkpointAfterPage: COMPLETE_CHECKPOINT,
                    hasMore: false
                  })
                  return syncStep(normalized, Option.none())
                }
                const snapshot = yield* readClient.getExecutionSnapshot({
                  account: awsAccount,
                  pipelineName: configuration.pipelineName,
                  pipelineExecutionId: summary.executionId,
                  actionBounds: actionBounds(configuration),
                  summary
                }).pipe(
                  Effect.catchTag(
                    "CodePipelineProviderNotFoundFailure",
                    () => Effect.fail(notFoundAsConfiguration("codepipeline-sync-execution"))
                  )
                )
                const events = yield* snapshotEvents(configuration, pipeline, snapshot, state.includePipeline)
                if (page.nextToken !== null && state.seenTokens.has(page.nextToken)) {
                  return yield* new PluginMalformedResponseFailure({
                    operation: "codepipeline-sync",
                    diagnosticCode: "codepipeline-execution-cursor-repeated"
                  })
                }
                const remaining = state.remaining - 1
                // A bounded run is terminal even when its persisted checkpoint can resume the provider cursor later.
                const hasMore = page.nextToken !== null && remaining > 0
                const normalized = yield* decodeOutput("codepipeline-sync", Schema.toType(PluginSyncPageV1), {
                  events,
                  checkpointAfterPage: checkpointFromToken(page.nextToken),
                  hasMore
                })
                const next = !hasMore
                  ? Option.none<typeof state>()
                  : Option.some({
                    includePipeline: false,
                    remaining,
                    seenTokens: new Set(state.seenTokens).add(page.nextToken),
                    token: page.nextToken
                  })
                return syncStep(normalized, next)
              })
          )
        )
      )
    )
  }

  const readEntity = Effect.fn("CodePipelinePlugin.readEntity")(function*(
    request: ReadPluginEntityRequestV1
  ): Effect.fn.Return<typeof ReadPluginEntityResultV1.Type, PluginFailure> {
    const pipelineResult = yield* loadPipeline.pipe(Effect.result)
    if (pipelineResult._tag === "Failure") {
      if (Predicate.isTagged(pipelineResult.failure, "CodePipelineProviderNotFoundFailure")) {
        return yield* missingResult(request)
      }
      return yield* pipelineResult.failure
    }
    const pipeline = pipelineResult.success
    if (request.entityType === "aws.codepipeline.pipeline") {
      if (request.vendorImmutableId !== pipeline.arn) return yield* missingResult(request)
      return yield* decodeOutput("codepipeline-read-entity", Schema.toType(ReadPluginEntityResultV1), {
        _tag: "found",
        event: yield* pipelineEvent(configuration, pipeline)
      })
    }

    const reference = request.entityType === "aws.codepipeline.execution"
      ? { executionId: request.vendorImmutableId, childId: "" }
      : childReference(request.vendorImmutableId)
    if (reference === null) return yield* missingResult(request)
    if (
      request.entityType !== "aws.codepipeline.execution" &&
      request.entityType !== "aws.codepipeline.stage" &&
      request.entityType !== "aws.codepipeline.action"
    ) {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "entity.read",
        requestedVersion: 1,
        diagnosticCode: "codepipeline-entity-type-unsupported"
      })
    }
    const snapshotResult = yield* readClient.getExecutionSnapshot({
      account: awsAccount,
      pipelineName: configuration.pipelineName,
      pipelineExecutionId: reference.executionId,
      actionBounds: actionBounds(configuration),
      summary: null
    }).pipe(Effect.result)
    if (snapshotResult._tag === "Failure") {
      if (Predicate.isTagged(snapshotResult.failure, "CodePipelineProviderNotFoundFailure")) {
        return yield* missingResult(request)
      }
      return yield* snapshotResult.failure
    }
    const snapshot = snapshotResult.success
    const events = yield* snapshotEvents(configuration, pipeline, snapshot, false)
    const event = events.find((candidate) => {
      if (candidate._tag !== "UpsertEntity") return false
      return candidate.entityType === request.entityType && candidate.vendorImmutableId === request.vendorImmutableId
    })
    if (event === undefined && snapshot.actionCollection.truncated) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "codepipeline-read-bound-exhausted"
      })
    }
    if (event === undefined) return yield* missingResult(request)
    return yield* decodeOutput("codepipeline-read-entity", Schema.toType(ReadPluginEntityResultV1), {
      _tag: "found",
      event
    })
  })

  const readLogPage = Effect.fn("CodePipelinePlugin.readLogPage")(function*(
    request: PluginPipelineLogPageRequestV1
  ) {
    if (request.action.entity.entityType !== "aws.codepipeline.action") {
      return yield* new PluginConflictFailure({
        operation: "pipeline-logs",
        diagnosticCode: "codepipeline-log-target-invalid"
      })
    }
    const action = yield* exactAction(request.action)
    if (`${action.executionId}#${action.actionExecutionId}` !== request.action.entity.vendorImmutableId) {
      return yield* new PluginConflictFailure({
        operation: "pipeline-logs",
        diagnosticCode: "codepipeline-log-target-mismatch"
      })
    }
    const coordinates = action.logStreamArn === null
      ? null
      : cloudWatchLogCoordinates(
        action.logStreamArn,
        runtimeIdentity.accountId,
        runtimeIdentity.arn,
        action.region
      )
    if (coordinates === null) {
      return yield* new PluginConflictFailure({
        operation: "pipeline-logs",
        diagnosticCode: "codepipeline-log-stream-unavailable"
      })
    }
    const cursorScope = yield* logCursorScope(action)
    const cursor = request.cursor === null
      ? { eventOffset: 0, providerCursor: null }
      : yield* decodeLogCursor(request.cursor, cursorScope)
    const page = yield* actionProvider(
      "pipeline-logs",
      readClient.getLogPage({
        account: { ...awsAccount, region: coordinates.region },
        logGroupName: coordinates.logGroupName,
        logStreamName: coordinates.logStreamName,
        nextToken: cursor.providerCursor,
        limit: LOG_PROVIDER_PAGE_SIZE
      })
    )
    if (cursor.eventOffset > page.events.length) {
      return yield* new PluginConflictFailure({
        operation: "pipeline-logs",
        diagnosticCode: "codepipeline-log-cursor-offset-invalid"
      })
    }
    const events = []
    let messageBytes = 0
    for (const event of page.events.slice(cursor.eventOffset)) {
      if (events.length >= request.limit) break
      const eventBytes = utf8Encoder.encode(event.message).byteLength
      if (eventBytes > configuration.maximumLogBytes && events.length === 0) {
        return yield* new PluginMalformedResponseFailure({
          operation: "pipeline-logs",
          diagnosticCode: "codepipeline-log-event-byte-bound-exceeded"
        })
      }
      if (messageBytes + eventBytes > configuration.maximumLogBytes) break
      events.push(event)
      messageBytes += eventBytes
    }
    const nextEventOffset = cursor.eventOffset + events.length
    if (events.length === 0 && nextEventOffset < page.events.length) {
      return yield* new PluginMalformedResponseFailure({
        operation: "pipeline-logs",
        diagnosticCode: "codepipeline-log-event-byte-bound-exceeded"
      })
    }
    return yield* decodeOutput("pipeline-logs", PluginPipelineLogPageV1, {
      events: events.map((event) => ({
        timestamp: formatDate(event.timestamp),
        ingestionTimestamp: event.ingestionTimestamp === null ? null : formatDate(event.ingestionTimestamp),
        message: event.message
      })),
      nextCursor: nextEventOffset < page.events.length
        ? encodeLogCursor(cursorScope, nextEventOffset, cursor.providerCursor)
        : page.nextToken === null
        ? null
        : encodeLogCursor(cursorScope, 0, page.nextToken)
    })
  })

  const readArtifactRange = Effect.fn("CodePipelinePlugin.readArtifactRange")(function*(
    request: PluginPipelineArtifactRangeRequestV1
  ) {
    if (request.action.entity.entityType !== "aws.codepipeline.action") {
      return yield* new PluginConflictFailure({
        operation: "pipeline-artifact",
        diagnosticCode: "codepipeline-artifact-target-invalid"
      })
    }
    const action = yield* exactAction(request.action)
    if (`${action.executionId}#${action.actionExecutionId}` !== request.action.entity.vendorImmutableId) {
      return yield* new PluginConflictFailure({
        operation: "pipeline-artifact",
        diagnosticCode: "codepipeline-artifact-target-mismatch"
      })
    }
    const artifacts = request.direction === "input" ? action.inputArtifacts : action.outputArtifacts
    const matchingArtifacts = artifacts.filter(({ name }) => name === request.artifactName)
    if (matchingArtifacts.length > 1) {
      return yield* new PluginMalformedResponseFailure({
        operation: "pipeline-artifact",
        diagnosticCode: "codepipeline-artifact-name-ambiguous"
      })
    }
    const artifact = matchingArtifacts[0]
    if (artifact?.bucket === null || artifact?.key === null || artifact === undefined) {
      return yield* new PluginConflictFailure({
        operation: "pipeline-artifact",
        diagnosticCode: "codepipeline-artifact-unavailable"
      })
    }
    const range = yield* actionProvider(
      "pipeline-artifact",
      readClient.getArtifactRange({
        account: action.region === null ? awsAccount : { ...awsAccount, region: action.region },
        bucket: artifact.bucket,
        key: artifact.key,
        offset: request.offset,
        length: request.length
      })
    )
    return yield* decodeOutput("pipeline-artifact", PluginPipelineArtifactRangeV1, {
      ...range,
      contentType: "application/octet-stream",
      filename: `${request.artifactName.replaceAll(/[^A-Za-z0-9._-]/gu, "_")}.zip`
    })
  })

  const sourceRevisionTypes = (
    pipeline: CodePipelinePipeline,
    actionName: string
  ): ReadonlySet<typeof SourceRevisionType.Type> | null => {
    const source = pipeline.stages
      .flatMap(({ actions }) => actions)
      .find((action) => action.name === actionName && action.actionType.category === "Source")
    if (source?.actionType.owner !== "AWS") return null
    switch (source.actionType.provider) {
      case "CodeCommit":
        return new Set(["COMMIT_ID"])
      case "ECR":
        return new Set(["IMAGE_DIGEST"])
      case "S3":
        return new Set(
          source.allowS3ObjectKeyOverride
            ? ["S3_OBJECT_VERSION_ID", "S3_OBJECT_KEY"]
            : ["S3_OBJECT_VERSION_ID"]
        )
      default:
        return null
    }
  }

  const retrySourceRevisionType = (
    pipeline: CodePipelinePipeline,
    actionName: string
  ): typeof SourceRevisionType.Type | null => {
    const allowed = sourceRevisionTypes(pipeline, actionName)
    if (allowed?.has("COMMIT_ID")) return "COMMIT_ID"
    if (allowed?.has("IMAGE_DIGEST")) return "IMAGE_DIGEST"
    if (allowed?.has("S3_OBJECT_VERSION_ID")) return "S3_OBJECT_VERSION_ID"
    return null
  }

  const validSourceRevisions = (
    pipeline: CodePipelinePipeline,
    sourceRevisions: ReadonlyArray<typeof SourceRevision.Type>
  ): boolean => {
    const sourceActions = pipeline.stages.flatMap(({ actions }) =>
      actions.filter(({ actionType }) => actionType.category === "Source")
    )
    const sourceNames = new Set(sourceActions.map(({ name }) => name))
    const requestedNames = new Set(sourceRevisions.map(({ actionName }) => actionName))
    return (
      sourceNames.size > 0 &&
      sourceNames.size === sourceActions.length &&
      requestedNames.size === sourceNames.size &&
      sourceRevisions.length === sourceNames.size &&
      sourceRevisions.every(({ actionName, revisionType }) =>
        sourceNames.has(actionName) &&
        sourceRevisionTypes(pipeline, actionName)?.has(revisionType) === true
      )
    )
  }

  const resolvedStartVariables = (
    pipeline: CodePipelinePipeline,
    overrides: ReadonlyArray<typeof PipelineVariable.Type>
  ): ReadonlyArray<typeof PipelineVariable.Type> | null => {
    const declarations = new Map(pipeline.variables.map((variable) => [variable.name, variable]))
    if (
      declarations.size !== pipeline.variables.length ||
      overrides.some(({ name }) => !declarations.has(name))
    ) {
      return null
    }
    const overrideValues = new Map(overrides.map(({ name, value }) => [name, value]))
    const variables = pipeline.variables.flatMap((declaration) => {
      const value = overrideValues.get(declaration.name) ?? declaration.defaultValue
      return value === null || value === undefined
        ? []
        : [{ name: declaration.name, value }]
    })
    return variables.length === pipeline.variables.length
      ? [...variables].sort((left, right) => compareText(left.name, right.name))
      : null
  }

  const validResolvedVariables = (
    pipeline: CodePipelinePipeline,
    variables: ReadonlyArray<typeof PipelineVariable.Type>
  ): boolean => {
    const expectedNames = new Set(pipeline.variables.map(({ name }) => name))
    return (
      expectedNames.size === pipeline.variables.length &&
      variables.length === expectedNames.size &&
      new Set(variables.map(({ name }) => name)).size === variables.length &&
      variables.every(({ name }) => expectedNames.has(name))
    )
  }

  const retryPayload = Effect.fn("CodePipelinePlugin.retryPayload")(function*(
    pipeline: CodePipelinePipeline,
    snapshot: CodePipelineExecutionSnapshot
  ) {
    const sourceActions = pipeline.stages.flatMap(({ actions }) =>
      actions.filter((action) => action.actionType.category === "Source")
    )
    if (
      sourceActions.length === 0 ||
      new Set(sourceActions.map(({ name }) => name)).size !== sourceActions.length
    ) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "codepipeline-source-action-set-invalid"
      })
    }
    const sourceRevisions = sourceActions.flatMap((action) => {
      const revision = snapshot.execution.artifactRevisions.find(
        (candidate) =>
          candidate.name !== null &&
          action.outputArtifactNames.includes(candidate.name)
      )
      const revisionType = retrySourceRevisionType(pipeline, action.name)
      return revision?.revisionId === null || revision === undefined || revisionType === null
        ? []
        : [{
          actionName: action.name,
          revisionType,
          revisionValue: revision.revisionId
        }]
    })
    if (sourceRevisions.length !== sourceActions.length) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "codepipeline-retry-source-revision-incomplete"
      })
    }
    if (!validResolvedVariables(pipeline, snapshot.execution.variables)) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "codepipeline-retry-variable-set-incomplete"
      })
    }
    return yield* decodeOutput("codepipeline-retry-payload", RetryActionPayload, {
      retryOf: snapshot.execution.executionId,
      pipelineRevision: pipelineRevision(pipeline),
      sourceRevisions: [...sourceRevisions].sort((left, right) => compareText(left.actionName, right.actionName)),
      variables: [...snapshot.execution.variables].sort((left, right) => compareText(left.name, right.name))
    })
  })

  const normalizeProposalPayload = Effect.fn("CodePipelinePlugin.normalizeProposalPayload")(function*(
    request: ProposePluginActionRequestV1,
    pipeline: CodePipelinePipeline
  ) {
    if (!isActionKind(request.actionKind)) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "codepipeline-proposal-action-kind-invalid"
      })
    }
    switch (request.actionKind) {
      case "pipeline.start": {
        if (
          request.target.entityType !== "pipeline" ||
          request.target.vendorImmutableId !== pipeline.arn ||
          request.expectedRevision !== pipelineRevision(pipeline)
        ) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-start-target-changed"
          })
        }
        const payload = yield* Schema.decodeUnknownEffect(StartActionPayloadInput)(request.payload).pipe(
          Effect.mapError(() =>
            new PluginConflictFailure({
              operation: "propose-action",
              diagnosticCode: "codepipeline-start-payload-invalid"
            })
          )
        )
        if (!validSourceRevisions(pipeline, payload.sourceRevisions)) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-start-source-set-invalid"
          })
        }
        const variables = resolvedStartVariables(pipeline, payload.variables ?? [])
        if (variables === null) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-start-variable-set-invalid"
          })
        }
        return {
          ...payload,
          pipelineRevision: pipelineRevision(pipeline),
          sourceRevisions: [...payload.sourceRevisions].sort((left, right) =>
            compareText(left.actionName, right.actionName)
          ),
          variables
        }
      }
      case "pipeline.stop": {
        if (request.target.entityType !== "pipeline-execution") {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-stop-target-invalid"
          })
        }
        const payload = yield* Schema.decodeUnknownEffect(StopActionPayload)(request.payload).pipe(
          Effect.mapError(() =>
            new PluginConflictFailure({
              operation: "propose-action",
              diagnosticCode: "codepipeline-stop-payload-invalid"
            })
          )
        )
        const snapshot = yield* actionProvider(
          "propose-action",
          loadSnapshot(request.target.vendorImmutableId)
        )
        if (snapshot.execution.status !== "InProgress" || request.expectedRevision !== executionRevision(snapshot)) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-stop-execution-changed"
          })
        }
        return {
          ...payload,
          pipelineRevision: pipelineRevision(pipeline)
        }
      }
      case "pipeline.approve":
      case "pipeline.reject": {
        if (request.target.entityType !== "pipeline-execution") {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-approval-target-invalid"
          })
        }
        const payload = yield* Schema.decodeUnknownEffect(ApprovalActionPayload)(request.payload).pipe(
          Effect.mapError(() =>
            new PluginConflictFailure({
              operation: "propose-action",
              diagnosticCode: "codepipeline-approval-payload-invalid"
            })
          )
        )
        const snapshot = yield* actionProvider(
          "propose-action",
          loadSnapshot(request.target.vendorImmutableId)
        )
        if (request.expectedRevision !== executionRevision(snapshot)) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-approval-target-mismatch"
          })
        }
        const action = snapshot.actionCollection.actions.find(
          (candidate) => candidate.actionExecutionId === payload.actionExecutionId
        )
        if (action === undefined) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-action-not-found"
          })
        }
        const state = yield* actionProvider(
          "propose-action",
          readClient.getPipelineState({
            account: awsAccount,
            pipelineName: configuration.pipelineName
          })
        )
        const current = state.actions.find(
          (candidate) =>
            candidate.stageName === payload.stageName &&
            candidate.actionName === payload.actionName &&
            candidate.actionExecutionId === payload.actionExecutionId
        )
        if (
          action.actionType?.category !== "Approval" ||
          action.stageName !== payload.stageName ||
          action.actionName !== payload.actionName ||
          action.status !== "InProgress" ||
          current === undefined ||
          current?.status !== "InProgress" ||
          current.token === null
        ) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-approval-not-pending"
          })
        }
        const approvalStatus: "Approved" | "Rejected" = request.actionKind === "pipeline.approve"
          ? "Approved"
          : "Rejected"
        return {
          ...payload,
          actionRevision: actionRevision(action),
          approvalStatus,
          approvalTokenDigest: yield* approvalTokenDigest(Redacted.value(current.token)),
          pipelineRevision: pipelineRevision(pipeline)
        }
      }
      case "pipeline.retry": {
        if (request.target.entityType !== "pipeline-execution") {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-retry-target-invalid"
          })
        }
        const snapshot = yield* actionProvider(
          "propose-action",
          loadSnapshot(request.target.vendorImmutableId)
        )
        if (
          !["Failed", "Stopped", "Cancelled", "Abandoned", "Superseded"].includes(snapshot.execution.status) ||
          request.expectedRevision !== executionRevision(snapshot)
        ) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "codepipeline-retry-execution-changed"
          })
        }
        return yield* retryPayload(pipeline, snapshot)
      }
    }
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "codepipeline-proposal-action-kind-invalid"
    })
  })

  const proposeAction = Effect.fn("CodePipelinePlugin.proposeAction")(function*(
    request: ProposePluginActionRequestV1
  ) {
    if (!isActionKind(request.actionKind)) {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.propose",
        requestedVersion: 1,
        diagnosticCode: "codepipeline-action-kind-unsupported"
      })
    }
    const pipeline = yield* actionProvider("propose-action", loadPipeline)
    const payload = yield* normalizeProposalPayload(request, pipeline)
    const payloadDigest = yield* digestGovernedActionPayload(payload).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => new PluginOutageFailure({ operation: "propose-action" }))
    )
    return yield* decodeOutput("propose-action", PluginActionProposalV1, {
      proposalKey: `cp:${request.actionKind}:${request.target.vendorImmutableId}:${payloadDigest}`,
      capabilityVersion: 1,
      request: { ...request, payload },
      payloadDigest,
      summary: summaryFor(request.actionKind, request.target.vendorImmutableId),
      impact: impactFor(request.actionKind, payload),
      proposedAt: yield* sampledAt
    })
  })

  type ResolvedAuthorizedAction =
    | {
      readonly _tag: "start"
      readonly sourceRevisions: ReadonlyArray<typeof SourceRevision.Type>
      readonly variables: ReadonlyArray<typeof PipelineVariable.Type>
      readonly checkedRevision: string
    }
    | {
      readonly _tag: "stop"
      readonly executionId: string
      readonly abandon: boolean
      readonly reason: string
      readonly checkedRevision: string
    }
    | {
      readonly _tag: "approval"
      readonly stageName: string
      readonly actionName: string
      readonly actionExecutionId: string
      readonly token: string
      readonly status: "Approved" | "Rejected"
      readonly summary: string
      readonly checkedRevision: string
    }
    | {
      readonly _tag: "retry"
      readonly retryOf: string
      readonly sourceRevisions: ReadonlyArray<typeof SourceRevision.Type>
      readonly variables: ReadonlyArray<typeof PipelineVariable.Type>
      readonly checkedRevision: string
    }

  const resolveAuthorized = Effect.fn("CodePipelinePlugin.resolveAuthorized")(function*(
    request: AuthorizedPluginActionV1
  ): Effect.fn.Return<ResolvedAuthorizedAction, PluginFailure> {
    if (!isActionKind(request.proposal.request.actionKind)) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "codepipeline-authorized-action-kind-invalid"
      })
    }
    const recomputed = yield* digestGovernedActionPayload(request.proposal.request.payload).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => new PluginOutageFailure({ operation: "authorized-action-digest" }))
    )
    if (recomputed !== request.payloadDigest) {
      return yield* new PluginConflictFailure({
        operation: "authorized-action",
        diagnosticCode: "codepipeline-authorized-payload-mismatch"
      })
    }
    const actionRequest = request.proposal.request
    const pipeline = yield* actionProvider("authorized-action", loadPipeline)
    switch (actionRequest.actionKind) {
      case "pipeline.start": {
        const payload = yield* Schema.decodeUnknownEffect(StartActionPayload)(actionRequest.payload).pipe(
          Effect.mapError(() =>
            new PluginConfigurationFailure({ diagnosticCode: "codepipeline-start-payload-invalid" })
          )
        )
        const revision = pipelineRevision(pipeline)
        if (
          actionRequest.target.entityType !== "pipeline" ||
          actionRequest.target.vendorImmutableId !== pipeline.arn ||
          actionRequest.expectedRevision !== revision ||
          payload.pipelineRevision === undefined ||
          payload.pipelineRevision !== revision ||
          !validSourceRevisions(pipeline, payload.sourceRevisions) ||
          !validResolvedVariables(pipeline, payload.variables)
        ) {
          return yield* new PluginConflictFailure({
            operation: "authorized-action",
            diagnosticCode: "codepipeline-start-target-changed"
          })
        }
        return {
          _tag: "start",
          sourceRevisions: payload.sourceRevisions,
          variables: payload.variables,
          checkedRevision: revision
        }
      }
      case "pipeline.stop": {
        const payload = yield* Schema.decodeUnknownEffect(StopActionPayload)(actionRequest.payload).pipe(
          Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "codepipeline-stop-payload-invalid" }))
        )
        const snapshot = yield* actionProvider(
          "authorized-action",
          loadSnapshot(actionRequest.target.vendorImmutableId)
        )
        const revision = executionRevision(snapshot)
        if (
          snapshot.execution.status !== "InProgress" ||
          revision !== actionRequest.expectedRevision ||
          payload.pipelineRevision === undefined ||
          payload.pipelineRevision !== pipelineRevision(pipeline)
        ) {
          return yield* new PluginConflictFailure({
            operation: "authorized-action",
            diagnosticCode: "codepipeline-stop-execution-changed"
          })
        }
        return {
          _tag: "stop",
          executionId: snapshot.execution.executionId,
          abandon: payload.mode === "abandon",
          reason: payload.reason,
          checkedRevision: revision
        }
      }
      case "pipeline.approve":
      case "pipeline.reject": {
        const payload = yield* Schema.decodeUnknownEffect(ApprovalActionPayload)(actionRequest.payload).pipe(
          Effect.mapError(() =>
            new PluginConfigurationFailure({ diagnosticCode: "codepipeline-approval-payload-invalid" })
          )
        )
        const snapshot = yield* actionProvider(
          "authorized-action",
          loadSnapshot(actionRequest.target.vendorImmutableId)
        )
        const revision = executionRevision(snapshot)
        const action = snapshot.actionCollection.actions.find(
          (candidate) => candidate.actionExecutionId === payload.actionExecutionId
        )
        if (
          actionRequest.target.entityType !== "pipeline-execution" ||
          actionRequest.expectedRevision !== revision ||
          payload.pipelineRevision === undefined ||
          payload.pipelineRevision !== pipelineRevision(pipeline) ||
          payload.actionRevision === undefined ||
          payload.approvalStatus === undefined ||
          payload.approvalStatus !==
            (actionRequest.actionKind === "pipeline.approve" ? "Approved" : "Rejected") ||
          payload.approvalTokenDigest === undefined ||
          action === undefined ||
          payload.actionRevision !== actionRevision(action)
        ) {
          return yield* new PluginConflictFailure({
            operation: "authorized-action",
            diagnosticCode: "codepipeline-approval-target-mismatch"
          })
        }
        const state = yield* actionProvider(
          "authorized-action",
          readClient.getPipelineState({
            account: awsAccount,
            pipelineName: configuration.pipelineName
          })
        )
        const current = state.actions.find(
          (candidate) =>
            candidate.stageName === payload.stageName &&
            candidate.actionName === payload.actionName &&
            candidate.actionExecutionId === payload.actionExecutionId
        )
        if (
          action.actionType?.category !== "Approval" ||
          action.status !== "InProgress" ||
          current === undefined ||
          current.status !== "InProgress" ||
          current.token === null
        ) {
          return yield* new PluginConflictFailure({
            operation: "authorized-action",
            diagnosticCode: "codepipeline-approval-not-pending"
          })
        }
        const token = Redacted.value(current.token)
        if ((yield* approvalTokenDigest(token)) !== payload.approvalTokenDigest) {
          return yield* new PluginConflictFailure({
            operation: "authorized-action",
            diagnosticCode: "codepipeline-approval-token-changed"
          })
        }
        return {
          _tag: "approval",
          stageName: payload.stageName,
          actionName: payload.actionName,
          actionExecutionId: payload.actionExecutionId,
          token,
          status: payload.approvalStatus,
          summary: payload.summary,
          checkedRevision: revision
        }
      }
      case "pipeline.retry": {
        const payload = yield* Schema.decodeUnknownEffect(RetryActionPayload)(actionRequest.payload).pipe(
          Effect.mapError(() =>
            new PluginConfigurationFailure({ diagnosticCode: "codepipeline-retry-payload-invalid" })
          )
        )
        const snapshot = yield* actionProvider(
          "authorized-action",
          loadSnapshot(payload.retryOf)
        )
        const revision = executionRevision(snapshot)
        if (
          payload.retryOf !== actionRequest.target.vendorImmutableId ||
          !["Failed", "Stopped", "Cancelled", "Abandoned", "Superseded"].includes(snapshot.execution.status) ||
          revision !== actionRequest.expectedRevision ||
          payload.pipelineRevision === undefined ||
          payload.pipelineRevision !== pipelineRevision(pipeline)
        ) {
          return yield* new PluginConflictFailure({
            operation: "authorized-action",
            diagnosticCode: "codepipeline-retry-execution-changed"
          })
        }
        const currentPayload = yield* retryPayload(pipeline, snapshot)
        const sameSourceRevisions = currentPayload.sourceRevisions.length === payload.sourceRevisions.length &&
          currentPayload.sourceRevisions.every((expected, index) => {
            const actual = payload.sourceRevisions[index]
            return actual !== undefined &&
              actual.actionName === expected.actionName &&
              actual.revisionType === expected.revisionType &&
              actual.revisionValue === expected.revisionValue
          })
        const sameVariables = currentPayload.variables.length === payload.variables.length &&
          currentPayload.variables.every((expected, index) => {
            const actual = payload.variables[index]
            return actual !== undefined &&
              actual.name === expected.name &&
              actual.value === expected.value
          })
        if (!sameSourceRevisions || !sameVariables) {
          return yield* new PluginConflictFailure({
            operation: "authorized-action",
            diagnosticCode: "codepipeline-retry-inputs-changed"
          })
        }
        return {
          _tag: "retry",
          retryOf: payload.retryOf,
          sourceRevisions: payload.sourceRevisions,
          variables: payload.variables,
          checkedRevision: revision
        }
      }
    }
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "codepipeline-authorized-action-kind-invalid"
    })
  })

  const preflight = Effect.fn("CodePipelinePlugin.preflight")(function*(request: AuthorizedPluginActionV1) {
    yield* verifyRuntimeIdentity()
    const resolved = yield* resolveAuthorized(request).pipe(Effect.result)
    const checkedAt = yield* sampledAt
    if (Result.isFailure(resolved)) {
      if (Predicate.isTagged(resolved.failure, "PluginConflictFailure")) {
        return yield* decodeOutput("preflight", PluginActionPreflightV1, {
          _tag: "blocked",
          reasons: [`CodePipeline action blocked: ${resolved.failure.diagnosticCode}`],
          checkedAt
        })
      }
      return yield* resolved.failure
    }
    return yield* decodeOutput("preflight", PluginActionPreflightV1, {
      _tag: "ready",
      checkedRevision: Revision.make(resolved.success.checkedRevision),
      checkedAt
    })
  })

  const dispatch = Effect.fn("CodePipelinePlugin.dispatch")(function*(
    request: AuthorizedPluginActionV1
  ): Effect.fn.Return<PluginActionDispatchResultV1, PluginFailure> {
    const action = yield* resolveAuthorized(request)
    const observedAt = yield* DateTime.now
    const reconciliationKey = PluginActionReconciliationKey.make(
      `codepipeline:${action._tag}:${request.payloadDigest}`
    )
    const result = yield* (() => {
      switch (action._tag) {
        case "start":
        case "retry":
          return Effect.flatMap(
            clientRequestToken(request),
            (token) =>
              mutationProvider(
                "execute-authorized-action",
                readClient.startPipelineExecution({
                  account: awsAccount,
                  pipelineName: configuration.pipelineName,
                  clientRequestToken: token,
                  sourceRevisions: action.sourceRevisions,
                  variables: action.variables
                })
              )
          ).pipe(Effect.map((operationId) => ({
            operationId,
            summary: action._tag === "retry"
              ? `Started distinct retry execution ${operationId} for ${action.retryOf}`
              : `Started pipeline execution ${operationId}`
          })))
        case "stop":
          return mutationProvider(
            "execute-authorized-action",
            readClient.stopPipelineExecution({
              account: awsAccount,
              pipelineName: configuration.pipelineName,
              pipelineExecutionId: action.executionId,
              abandon: action.abandon,
              reason: action.reason
            })
          ).pipe(Effect.map((operationId) => ({
            operationId,
            summary: `Accepted stop for pipeline execution ${operationId}`
          })))
        case "approval":
          return mutationProvider(
            "execute-authorized-action",
            readClient.putApprovalResult({
              account: awsAccount,
              pipelineName: configuration.pipelineName,
              stageName: action.stageName,
              actionName: action.actionName,
              token: action.token,
              status: action.status,
              summary: action.summary
            })
          ).pipe(Effect.as({
            operationId: `approval:${action.actionExecutionId}`,
            summary: `${action.status} manual pipeline action ${action.actionExecutionId}`
          }))
      }
    })().pipe(Effect.result)
    if (Result.isFailure(result)) {
      if (Predicate.isTagged(result.failure, "CodePipelinePreDispatchTimeoutFailure")) {
        return yield* new PluginTimeoutFailure({ operation: result.failure.operation })
      }
      if (
        Predicate.isTagged(result.failure, "PluginTimeoutFailure") ||
        Predicate.isTagged(result.failure, "PluginOutageFailure") ||
        Predicate.isTagged(result.failure, "PluginMalformedResponseFailure")
      ) {
        return yield* new PluginUnknownOutcomeFailure({
          operation: "execute-authorized-action",
          reconciliationKey
        })
      }
      if (Predicate.isTagged(result.failure, "PluginConflictFailure")) {
        return {
          _tag: "confirmed",
          receipt: {
            status: "failed",
            providerOperationId: PluginProviderOperationId.make(
              `rejected:${action._tag}:${request.payloadDigest}`
            ),
            safeSummary: "CodePipeline rejected the authorized action without applying it",
            observedAt
          }
        }
      }
      return yield* result.failure
    }
    const providerOperationId = PluginProviderOperationId.make(result.success.operationId)
    return action._tag === "approval"
      ? {
        _tag: "confirmed",
        receipt: {
          status: "succeeded",
          providerOperationId,
          safeSummary: result.success.summary,
          observedAt
        }
      }
      : {
        _tag: "confirmed",
        receipt: {
          status: "accepted",
          providerOperationId,
          reconciliationKey,
          safeSummary: result.success.summary,
          observedAt
        }
      }
  })

  const executeAuthorizedAction = Effect.fn("CodePipelinePlugin.executeAuthorizedAction")(function*(
    request: AuthorizedPluginActionV1
  ) {
    yield* verifyRuntimeIdentity()
    const result = yield* SynchronizedRef.modifyEffect(dispatches, (current) => {
      const previous = HashMap.get(current, request.idempotencyKey)
      if (Option.isSome(previous)) {
        const replay = previous.value.payloadDigest === request.payloadDigest
          ? previous.value.result
          : Result.fail(
            new PluginConflictFailure({
              operation: "execute-authorized-action",
              diagnosticCode: "codepipeline-idempotency-payload-mismatch"
            })
          )
        const transition: readonly [typeof replay, typeof current] = [replay, current]
        return Effect.succeed(transition)
      }
      return dispatch(request).pipe(
        Effect.result,
        Effect.map((dispatched) => {
          const cache = Result.isSuccess(dispatched) ||
              Predicate.isTagged(dispatched.failure, "PluginUnknownOutcomeFailure")
            ? HashMap.set(current, request.idempotencyKey, {
              payloadDigest: request.payloadDigest,
              result: dispatched
            })
            : current
          const transition: readonly [typeof dispatched, typeof current] = [dispatched, cache]
          return transition
        })
      )
    })
    return Result.isSuccess(result) ? result.success : yield* result.failure
  })

  const reconcile = Effect.fn("CodePipelinePlugin.reconcile")(function*(
    request: PluginActionReconciliationRequestV1
  ): Effect.fn.Return<PluginActionReconciliationResultV1, PluginFailure> {
    if (request.authorizedAction === undefined) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "codepipeline-reconciliation-authorized-action-missing"
      })
    }
    const actionKind = request.authorizedAction.proposal.request.actionKind
    if (!isActionKind(actionKind)) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "codepipeline-reconciliation-action-kind-invalid"
      })
    }
    if (request.reconciliationKey !== null) {
      const locator = yield* Schema.decodeUnknownEffect(ReconciliationLocator)(
        request.reconciliationKey
      ).pipe(
        Effect.mapError(() =>
          new PluginConfigurationFailure({
            diagnosticCode: "codepipeline-reconciliation-key-invalid"
          })
        )
      )
      const [, locatorKind, , locatorDigest] = locator
      if (
        locatorKind !== reconciliationActionKind(actionKind) ||
        locatorDigest !== request.authorizedAction.payloadDigest
      ) {
        return yield* new PluginConflictFailure({
          operation: "reconcile",
          diagnosticCode: "codepipeline-reconciliation-key-mismatch"
        })
      }
    }
    yield* verifyRuntimeIdentity()
    const checkedAt = yield* DateTime.now
    if (actionKind === "pipeline.start" || actionKind === "pipeline.retry") {
      const resolved = yield* resolveAuthorized(request.authorizedAction)
      if (resolved._tag !== "start" && resolved._tag !== "retry") {
        return yield* new PluginConfigurationFailure({
          diagnosticCode: "codepipeline-reconciliation-action-kind-invalid"
        })
      }
      const token = yield* clientRequestToken(request.authorizedAction)
      const executionId = yield* mutationProvider(
        "reconcile",
        readClient.startPipelineExecution({
          account: awsAccount,
          pipelineName: configuration.pipelineName,
          clientRequestToken: token,
          sourceRevisions: resolved.sourceRevisions,
          variables: resolved.variables
        })
      ).pipe(
        Effect.catchTag(
          "CodePipelinePreDispatchTimeoutFailure",
          (failure) => Effect.fail(new PluginTimeoutFailure({ operation: failure.operation }))
        )
      )
      const snapshot = yield* actionProvider("reconcile", loadSnapshot(executionId))
      if (["InProgress", "Stopping"].includes(snapshot.execution.status)) {
        return { _tag: "pending", checkedAt }
      }
      const succeeded = snapshot.execution.status === "Succeeded"
      return {
        _tag: succeeded ? "succeeded" : "failed",
        receipt: {
          status: succeeded ? "succeeded" : "failed",
          providerOperationId: PluginProviderOperationId.make(executionId),
          safeSummary: succeeded && actionKind === "pipeline.retry"
            ? `Distinct retry execution ${executionId} is linked to ${request.authorizedAction.proposal.request.target.vendorImmutableId}`
            : succeeded
            ? `Pipeline execution ${executionId} succeeded`
            : `Pipeline execution ${executionId} ended with status ${snapshot.execution.status}`,
          observedAt: checkedAt
        }
      }
    }
    if (actionKind === "pipeline.stop") {
      const executionId = request.authorizedAction.proposal.request.target.vendorImmutableId
      const snapshot = yield* actionProvider("reconcile", loadSnapshot(executionId))
      if (["InProgress", "Stopping"].includes(snapshot.execution.status)) {
        return { _tag: "pending", checkedAt }
      }
      const succeeded = ["Stopped", "Abandoned"].includes(snapshot.execution.status)
      return {
        _tag: succeeded ? "succeeded" : "failed",
        receipt: {
          status: succeeded ? "succeeded" : "failed",
          providerOperationId: PluginProviderOperationId.make(executionId),
          safeSummary: succeeded
            ? `Pipeline execution ${executionId} is ${snapshot.execution.status}`
            : `Stop did not produce a stopped execution; ${executionId} is ${snapshot.execution.status}`,
          observedAt: checkedAt
        }
      }
    }
    const payload = yield* Schema.decodeUnknownEffect(ApprovalActionPayload)(
      request.authorizedAction.proposal.request.payload
    ).pipe(
      Effect.mapError(() =>
        new PluginConfigurationFailure({ diagnosticCode: "codepipeline-reconciliation-payload-invalid" })
      )
    )
    const executionId = request.authorizedAction.proposal.request.target.vendorImmutableId
    const snapshot = yield* actionProvider("reconcile", loadSnapshot(executionId))
    const current = snapshot.actionCollection.actions.find(
      (candidate) =>
        candidate.executionId === executionId &&
        candidate.stageName === payload.stageName &&
        candidate.actionName === payload.actionName &&
        candidate.actionExecutionId === payload.actionExecutionId
    )
    if (current === undefined && snapshot.actionCollection.truncated) return { _tag: "pending", checkedAt }
    if (payload.approvalStatus === undefined) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "codepipeline-reconciliation-approval-status-missing"
      })
    }
    if (current === undefined) {
      return {
        _tag: "failed",
        receipt: {
          status: "failed",
          providerOperationId: PluginProviderOperationId.make(`approval:${payload.actionExecutionId}`),
          safeSummary: `Manual pipeline action ${payload.actionExecutionId} is absent from its execution history`,
          observedAt: checkedAt
        }
      }
    }
    if (current.status === "InProgress") return { _tag: "pending", checkedAt }
    const expectedStatus = payload.approvalStatus === "Approved" ? "Succeeded" : "Failed"
    const succeeded = current.status === expectedStatus
    return {
      _tag: succeeded ? "succeeded" : "failed",
      receipt: {
        status: succeeded ? "succeeded" : "failed",
        providerOperationId: PluginProviderOperationId.make(`approval:${payload.actionExecutionId}`),
        safeSummary: succeeded
          ? `Manual pipeline action ${payload.actionExecutionId} completed as ${payload.approvalStatus}`
          : `Manual pipeline action ${payload.actionExecutionId} ended with status ${current.status}`,
        observedAt: checkedAt
      }
    }
  })

  const connection: PluginConnectionV1 = {
    descriptor,
    actionActorIdentity: Effect.succeed(actionActorIdentity),
    discover,
    health,
    sync,
    readEntity,
    diff: Option.none(),
    pipeline: Option.some({ readLogPage, readArtifactRange }),
    proposeAction
  }

  return {
    connection,
    executor: {
      preflight,
      executeAuthorizedAction,
      requestCancellation: () => Effect.fail(unsupported("action.cancel")),
      reconcile
    }
  }
})

/** Requirement-preserving definition used by server composition and tests. @internal */
export const codePipelinePluginDefinition = definePluginV1({
  rawDescriptor: descriptor,
  configurationSchema: CodePipelinePluginConfiguration,
  capabilityCodecs: {
    entityRead: pluginCapabilityCodecsV1.entityRead,
    syncIncremental: pluginCapabilityCodecsV1.syncIncremental,
    actionPropose: pluginCapabilityCodecsV1.actionPropose,
    actionExecute: pluginCapabilityCodecsV1.actionExecute,
    actionReconcile: pluginCapabilityCodecsV1.actionReconcile,
    pipelineLogs: pluginCapabilityCodecsV1.pipelineLogs,
    pipelineArtifact: pluginCapabilityCodecsV1.pipelineArtifact
  },
  make: ({ configuration, descriptor: negotiatedDescriptor }) => makeConnection(configuration, negotiatedDescriptor)
})

/** Opaque production CodePipeline plugin registration. */
export const CodePipelinePluginDefinition: PluginDefinitionV1 = codePipelinePluginDefinition
