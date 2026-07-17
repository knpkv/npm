/**
 * Production AWS CodePipeline read adapter for one configured pipeline.
 *
 * The MVP negotiates only entity reads and incremental synchronization. Start,
 * stop, approval, retry, log-content, and artifact-content capabilities remain
 * outside the public contract until their governed execution paths exist.
 *
 * @internal
 */
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { PluginHealth } from "../../../domain/freshness.js"
import {
  NormalizedPluginEventV1,
  PluginDiscoveryV1,
  PluginSyncPageV1,
  type PluginSyncRequestV1,
  type ReadPluginEntityRequestV1,
  ReadPluginEntityResultV1
} from "../../../domain/plugins/index.js"
import {
  PluginConfigurationFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import { pluginCapabilityCodecsV1 } from "../PluginCapabilityCodecs.js"
import type { PluginConnectionV1 } from "../PluginConnection.js"
import { definePluginV1 } from "../PluginDefinition.js"
import type { PluginDefinitionV1 } from "../PluginDefinitionV1.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import {
  type CodePipelineActionExecution,
  type CodePipelineExecutionSnapshot,
  type CodePipelinePipeline,
  CodePipelineReadClient
} from "./CodePipelineReadClient.js"

const EXECUTION_STREAM_KEY = "executions"
const COMPLETE_CHECKPOINT = "complete"
const NEXT_CHECKPOINT_PREFIX = "next:"

const AwsProfile = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))
const AwsRegion = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))
const PipelineName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))

/** Secret-free production adapter configuration. @internal */
export const CodePipelinePluginConfiguration = Schema.Struct({
  profile: AwsProfile,
  region: AwsRegion,
  pipelineName: PipelineName,
  maximumExecutionPages: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  actionPageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  maximumActionPages: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  maximumActionsPerExecution: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  operationTimeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 }))
})

type CodePipelineConfiguration = typeof CodePipelinePluginConfiguration.Type

const descriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.aws-codepipeline",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
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
      key: "operationTimeoutMillis",
      label: "Request timeout",
      description: "Maximum milliseconds for credential and CodePipeline provider requests.",
      required: true,
      minimum: 1_000,
      maximum: 120_000
    }
  ],
  capabilities: ["entity.read", "sync.incremental"].map((capabilityId) => ({
    capabilityId,
    supportedVersions: [1],
    requirement: "required"
  }))
} satisfies unknown

const unsupported = (
  capabilityId: "action.propose" | "action.execute" | "action.cancel" | "action.reconcile"
) =>
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
      inputArtifacts: action.inputArtifacts,
      outputArtifacts: action.outputArtifacts,
      externalExecutionId: action.externalExecutionId,
      externalExecutionSummary: action.externalExecutionSummary,
      errorCode: action.errorCode,
      errorMessage: action.errorMessage,
      logStreamArn: action.logStreamArn,
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
  const revision = `${execution.pipelineVersion}:${execution.status}:${
    summary?.updatedAt === null || summary?.updatedAt === undefined ? "undated" : formatDate(summary.updatedAt)
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
      updatedAt: summary?.updatedAt === null || summary?.updatedAt === undefined
        ? null
        : formatDate(summary.updatedAt),
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
  const fallbackObservedAt = snapshot.summary?.updatedAt === null || snapshot.summary?.updatedAt === undefined
    ? snapshot.summary === null ? yield* sampledAt : formatDate(snapshot.summary.startedAt)
    : formatDate(snapshot.summary.updatedAt)
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
): Effect.fn.Return<PluginConnectionV1, never, CodePipelineReadClient> {
  const readClient = yield* CodePipelineReadClient
  const awsAccount = account(configuration)

  const loadPipeline = readClient.getPipeline({
    account: awsAccount,
    pipelineName: configuration.pipelineName
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
      workspace: {
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

  return {
    descriptor,
    discover,
    health,
    sync,
    readEntity,
    diff: Option.none(),
    proposeAction: () => Effect.fail(unsupported("action.propose"))
  }
})

const executor: AuthorizedPluginExecutorV1 = {
  preflight: () => Effect.fail(unsupported("action.execute")),
  executeAuthorizedAction: () => Effect.fail(unsupported("action.execute")),
  requestCancellation: () => Effect.fail(unsupported("action.cancel")),
  reconcile: () => Effect.fail(unsupported("action.reconcile"))
}

/** Requirement-preserving definition used by server composition and tests. @internal */
export const codePipelinePluginDefinition = definePluginV1({
  rawDescriptor: descriptor,
  configurationSchema: CodePipelinePluginConfiguration,
  capabilityCodecs: {
    entityRead: pluginCapabilityCodecsV1.entityRead,
    syncIncremental: pluginCapabilityCodecsV1.syncIncremental
  },
  make: ({ configuration, descriptor: negotiatedDescriptor }) =>
    makeConnection(configuration, negotiatedDescriptor).pipe(
      Effect.map((connection) => ({ connection, executor }))
    )
})

/** Opaque production CodePipeline plugin registration. */
export const CodePipelinePluginDefinition: PluginDefinitionV1 = codePipelinePluginDefinition
