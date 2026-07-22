import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { DeliveryEntityDetails } from "../../domain/deliveryGraph.js"
import type { NormalizedPluginEventV1 } from "../../domain/plugins/events.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"

type EntityUpsert = Extract<NormalizedPluginEventV1, { readonly _tag: "UpsertEntity" }>

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String))
const OptionalUnknown = Schema.optionalKey(Schema.NullOr(Schema.Unknown))
const InputDirection: "input" = "input"
const OutputDirection: "output" = "output"
const ProxyRequired: "proxy-required" = "proxy-required"
const NamedText = Schema.Union([
  Schema.String,
  Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) })
])
const PipelineSourceRevisionAttributes = Schema.Struct({
  actionName: OptionalText,
  revisionId: OptionalText,
  revisionSummary: OptionalText
})
const PipelineArtifactRevisionAttributes = Schema.Struct({
  name: OptionalText,
  revisionId: OptionalText,
  revisionSummary: OptionalText,
  createdAt: OptionalUnknown
})
const PipelineActionArtifactAttributes = Schema.Struct({
  name: OptionalText,
  access: Schema.optionalKey(Schema.Literal("proxy-required"))
})
const PipelineActionTypeAttributes = Schema.Struct({
  category: OptionalText,
  owner: OptionalText,
  provider: OptionalText,
  version: OptionalText
})
const PipelineDeclarationActionAttributes = Schema.Struct({
  name: OptionalText,
  runOrder: Schema.optionalKey(Schema.NullOr(Schema.Int))
})
const PipelineDeclarationStageAttributes = Schema.Struct({
  name: OptionalText,
  actions: Schema.optionalKey(Schema.Array(PipelineDeclarationActionAttributes))
})

/** Pipeline fields decoded only inside the CodePipeline projection boundary. */
const PipelineEntityAttributeFields = {
  pipelineName: OptionalText,
  pipelineVersion: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  executionId: OptionalText,
  triggerRevision: OptionalText,
  statusSummary: OptionalText,
  startedAt: OptionalUnknown,
  updatedAt: OptionalUnknown,
  sourceRevisions: Schema.optionalKey(Schema.Array(PipelineSourceRevisionAttributes)),
  triggerType: OptionalText,
  triggerDetail: OptionalText,
  executionMode: OptionalText,
  executionType: OptionalText,
  rollbackTargetExecutionId: OptionalText,
  artifactRevisions: Schema.optionalKey(Schema.Array(PipelineArtifactRevisionAttributes)),
  actionCount: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  actionsTruncated: Schema.optionalKey(Schema.Boolean),
  actionPagesRead: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  actionExecutionId: OptionalText,
  stageName: OptionalText,
  actionName: OptionalText,
  actionType: Schema.optionalKey(Schema.NullOr(PipelineActionTypeAttributes)),
  updatedBy: OptionalText,
  actionRegion: OptionalText,
  inputArtifacts: Schema.optionalKey(Schema.Array(PipelineActionArtifactAttributes)),
  outputArtifacts: Schema.optionalKey(Schema.Array(PipelineActionArtifactAttributes)),
  externalExecutionSummary: OptionalText,
  errorCode: OptionalText,
  errorMessage: OptionalText,
  stages: Schema.optionalKey(Schema.Array(PipelineDeclarationStageAttributes))
}

/** Provider-owned field names that unrelated entity decoders may safely ignore. */
export const PipelineEntityAttributeNames: ReadonlySet<string> = new Set(Object.keys(PipelineEntityAttributeFields))

const PipelineEntityAttributes = Schema.Struct({
  status: Schema.optionalKey(Schema.NullOr(NamedText)),
  ...PipelineEntityAttributeFields
})
type PipelineEntityAttributes = typeof PipelineEntityAttributes.Type

/** Redacted failure raised while correlating one bounded execution page. */
export class PipelineExecutionProjectionError extends Schema.TaggedErrorClass<PipelineExecutionProjectionError>()(
  "PipelineExecutionProjectionError",
  {
    diagnosticCode: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
    eventId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
  }
) {}

const malformed = (diagnosticCode: string, eventId: string) =>
  new PipelineExecutionProjectionError({ diagnosticCode, eventId })

const decodeAttributes = Effect.fn("PipelineExecutionProjection.decodeAttributes")(function*(event: EntityUpsert) {
  return yield* Schema.decodeUnknownEffect(PipelineEntityAttributes)(event.attributes).pipe(
    Effect.mapError(() => malformed("normalized-entity-attributes-invalid", event.eventId))
  )
})

const bounded = (value: string | null | undefined, fallback: string, maximum: number): string => {
  const normalized = value?.trim()
  return (normalized === undefined || normalized.length === 0 ? fallback : normalized).slice(0, maximum)
}

const optionalBounded = (value: string | null | undefined, maximum: number): string | null => {
  const normalized = value?.trim()
  return normalized === undefined || normalized.length === 0 ? null : normalized.slice(0, maximum)
}

const namedText = (value: typeof NamedText.Type | null | undefined): string | null =>
  typeof value === "string" ? value : (value?.name ?? null)

/** Collapse provider statuses into the canonical execution state vocabulary. */
export const pipelineStatus = (
  value: string | null
): "failed" | "queued" | "running" | "stopped" | "succeeded" => {
  switch (value?.toLocaleLowerCase("en-US")) {
    case "failed":
    case "failure":
      return "failed"
    case "in-progress":
    case "inprogress":
    case "running":
      return "running"
    case "succeeded":
    case "success":
    case "successful":
      return "succeeded"
    case "stopped":
    case "stopping":
    case "superseded":
    case "abandoned":
      return "stopped"
    default:
      return "queued"
  }
}

const normalizedTimestamp = Effect.fn("PipelineExecutionProjection.normalizeTimestamp")(function*(
  value: unknown,
  eventId: string
): Effect.fn.Return<string | null, PipelineExecutionProjectionError> {
  if (value === null || value === undefined) return null
  const timestamp = yield* Schema.decodeUnknownEffect(UtcTimestamp)(value).pipe(
    Effect.mapError(() => malformed("normalized-pipeline-timestamp-invalid", eventId))
  )
  return DateTime.formatIso(timestamp)
})

interface PipelineSiblingEvent {
  readonly attributes: PipelineEntityAttributes
  readonly event: EntityUpsert
}

const laterSibling = (
  current: PipelineSiblingEvent | undefined,
  candidate: PipelineSiblingEvent
): PipelineSiblingEvent =>
  current === undefined || DateTime.Order(current.event.observedAt, candidate.event.observedAt) < 0
    ? candidate
    : current

const aggregateStatus = (
  statuses: ReadonlyArray<ReturnType<typeof pipelineStatus>>
): ReturnType<typeof pipelineStatus> => {
  if (statuses.includes("failed")) return "failed"
  if (statuses.includes("running")) return "running"
  if (statuses.includes("stopped")) return "stopped"
  if (statuses.length > 0 && statuses.every((status) => status === "succeeded")) return "succeeded"
  return "queued"
}

/** Correlate bounded pipeline, stage, and action siblings into one safe execution projection. */
export const projectPipelineExecution = Effect.fn("PipelineExecutionProjection.project")(function*(
  event: EntityUpsert,
  siblingEvents: ReadonlyArray<NormalizedPluginEventV1>
): Effect.fn.Return<DeliveryEntityDetails, PipelineExecutionProjectionError> {
  const attributes = yield* decodeAttributes(event)
  const executionId = bounded(attributes.executionId, event.vendorImmutableId, 512)
  const pipelineName = bounded(attributes.pipelineName, "unknown", 200)
  const stageEvents = new Map<string, PipelineSiblingEvent>()
  const actionEvents = new Map<string, PipelineSiblingEvent>()
  let declaration: PipelineSiblingEvent | undefined

  for (const sibling of siblingEvents) {
    if (sibling._tag !== "UpsertEntity" || sibling.eventId === event.eventId) continue
    if (
      sibling.entityType !== "aws.codepipeline.pipeline" &&
      sibling.entityType !== "aws.codepipeline.stage" &&
      sibling.entityType !== "aws.codepipeline.action"
    ) continue
    const siblingAttributes = yield* decodeAttributes(sibling)
    if (bounded(siblingAttributes.pipelineName, "unknown", 200) !== pipelineName) continue
    const candidate = { attributes: siblingAttributes, event: sibling }
    if (sibling.entityType === "aws.codepipeline.pipeline") {
      if (
        attributes.pipelineVersion !== null &&
        attributes.pipelineVersion !== undefined &&
        siblingAttributes.pipelineVersion !== null &&
        siblingAttributes.pipelineVersion !== undefined &&
        siblingAttributes.pipelineVersion !== attributes.pipelineVersion
      ) continue
      declaration = laterSibling(declaration, candidate)
      continue
    }
    if (bounded(siblingAttributes.executionId, "", 512) !== executionId) continue
    if (sibling.entityType === "aws.codepipeline.stage") {
      const stageName = optionalBounded(siblingAttributes.stageName, 200)
      if (stageName !== null) stageEvents.set(stageName, laterSibling(stageEvents.get(stageName), candidate))
      continue
    }
    const actionExecutionId = optionalBounded(siblingAttributes.actionExecutionId, 512)
    if (actionExecutionId !== null) {
      actionEvents.set(actionExecutionId, laterSibling(actionEvents.get(actionExecutionId), candidate))
    }
  }

  const declaredStages = (declaration?.attributes.stages ?? []).flatMap((stage) => {
    const name = optionalBounded(stage.name, 200)
    const actionNames = (stage.actions ?? []).flatMap((action, index) => {
      const actionName = optionalBounded(action.name, 200)
      return actionName === null ? [] : [{ index, name: actionName, runOrder: action.runOrder ?? index + 1 }]
    }).sort((left, right) => left.runOrder - right.runOrder || left.index - right.index).map(({ name }) => name)
    return name === null ? [] : [{ actionCount: stage.actions?.length ?? 0, actionNames, name }]
  }).slice(0, 100)
  const stageOrder = new Map(declaredStages.map(({ name }, index) => [name, index]))
  const actionOrder = new Map<string, number>()
  for (const stage of declaredStages) {
    for (let index = 0; index < stage.actionNames.length; index++) {
      const actionName = stage.actionNames[index]
      if (actionName === undefined) continue
      const key = `${stage.name}\u0000${actionName}`
      if (!actionOrder.has(key)) actionOrder.set(key, index)
    }
  }
  const actions = yield* Effect.forEach(
    [...actionEvents.entries()],
    ([actionExecutionId, sibling]) =>
      Effect.gen(function*() {
        const action = sibling.attributes
        const stageName = bounded(action.stageName, "Unknown stage", 200)
        const actionName = bounded(action.actionName, actionExecutionId, 200)
        return {
          actionExecutionId,
          stageName,
          actionName,
          status: pipelineStatus(namedText(action.status)),
          startedAt: yield* normalizedTimestamp(action.startedAt, sibling.event.eventId),
          updatedAt: yield* normalizedTimestamp(action.updatedAt, sibling.event.eventId),
          updatedBy: optionalBounded(action.updatedBy, 512),
          category: optionalBounded(action.actionType?.category, 100),
          provider: optionalBounded(action.actionType?.provider, 100),
          owner: optionalBounded(action.actionType?.owner, 100),
          version: optionalBounded(action.actionType?.version, 100),
          region: optionalBounded(action.actionRegion, 100),
          externalExecutionSummary: optionalBounded(action.externalExecutionSummary, 500),
          errorCode: optionalBounded(action.errorCode, 200),
          errorMessage: optionalBounded(action.errorMessage, 500),
          artifacts: [
            ...(action.inputArtifacts ?? []).map((artifact, index) => ({
              name: bounded(artifact.name, `${actionName} input ${String(index + 1)}`, 200),
              direction: InputDirection,
              access: ProxyRequired
            })),
            ...(action.outputArtifacts ?? []).map((artifact, index) => ({
              name: bounded(artifact.name, `${actionName} output ${String(index + 1)}`, 200),
              direction: OutputDirection,
              access: ProxyRequired
            }))
          ].slice(0, 100)
        }
      }),
    { concurrency: 1 }
  )
  actions.sort((left, right) => {
    const stageComparison = (stageOrder.get(left.stageName) ?? 100) - (stageOrder.get(right.stageName) ?? 100) ||
      left.stageName.localeCompare(right.stageName)
    if (stageComparison !== 0) return stageComparison
    const leftOrder = actionOrder.get(`${left.stageName}\u0000${left.actionName}`)
    const rightOrder = actionOrder.get(`${right.stageName}\u0000${right.actionName}`)
    if (leftOrder !== undefined || rightOrder !== undefined) {
      const declaredComparison = (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER)
      if (declaredComparison !== 0) return declaredComparison
    }
    return left.actionName.localeCompare(right.actionName) ||
      left.actionExecutionId.localeCompare(right.actionExecutionId)
  })

  const allStageNames = [
    ...declaredStages.map(({ name }) => name),
    ...[...stageEvents.keys()].filter((name) => !stageOrder.has(name)).sort(),
    ...actions.map(({ stageName }) => stageName).filter(
      (name, index, names) => !stageOrder.has(name) && !stageEvents.has(name) && names.indexOf(name) === index
    ).sort()
  ].slice(0, 100)
  const declaredStageByName = new Map(declaredStages.map((stage) => [stage.name, stage]))
  const stages = allStageNames.map((name) => {
    const stage = stageEvents.get(name)?.attributes
    const stageActions = actions.filter((action) => action.stageName === name)
    return {
      name,
      status: stage === undefined
        ? aggregateStatus(stageActions.map(({ status }) => status))
        : pipelineStatus(namedText(stage.status)),
      actionCount: Math.max(stage?.actionCount ?? declaredStageByName.get(name)?.actionCount ?? stageActions.length, 0),
      actionsTruncated: stage?.actionsTruncated ?? attributes.actionsTruncated ?? false
    }
  })
  const sourceRevision = attributes.sourceRevisions?.find(({ revisionId }) => optionalBounded(revisionId, 512) !== null)
    ?.revisionId
  const sourceRevisions = (attributes.sourceRevisions ?? []).flatMap((source) => {
    const actionName = optionalBounded(source.actionName, 200)
    return actionName === null ? [] : [{
      actionName,
      revisionId: optionalBounded(source.revisionId, 512),
      revisionSummary: optionalBounded(source.revisionSummary, 500)
    }]
  }).filter((source, index, sources) =>
    sources.findIndex(({ actionName }) => actionName === source.actionName) === index
  ).slice(0, 100)
  const sourceArtifacts = yield* Effect.forEach(
    (attributes.artifactRevisions ?? []).slice(0, 100),
    (artifact, index) =>
      Effect.gen(function*() {
        return {
          name: bounded(artifact.name, `Source artifact ${String(index + 1)}`, 200),
          revisionId: optionalBounded(artifact.revisionId, 512),
          revisionSummary: optionalBounded(artifact.revisionSummary, 500),
          createdAt: yield* normalizedTimestamp(artifact.createdAt, event.eventId),
          access: ProxyRequired
        }
      }),
    { concurrency: 1 }
  )
  return yield* Schema.decodeUnknownEffect(DeliveryEntityDetails)({
    _tag: "pipeline-execution",
    pipelineName,
    executionId,
    status: pipelineStatus(namedText(attributes.status)),
    triggerRevision: bounded(attributes.triggerRevision ?? sourceRevision, event.revision, 512),
    pipelineVersion: attributes.pipelineVersion ?? null,
    statusSummary: optionalBounded(attributes.statusSummary, 500),
    startedAt: yield* normalizedTimestamp(attributes.startedAt, event.eventId),
    updatedAt: yield* normalizedTimestamp(attributes.updatedAt, event.eventId),
    triggerType: optionalBounded(attributes.triggerType, 100),
    triggerDetail: optionalBounded(attributes.triggerDetail, 500),
    executionMode: optionalBounded(attributes.executionMode, 100),
    executionType: optionalBounded(attributes.executionType, 100),
    rollbackTargetExecutionId: optionalBounded(attributes.rollbackTargetExecutionId, 512),
    sourceRevisions,
    stages,
    actions,
    actionCount: Math.max(attributes.actionCount ?? actions.length, 0),
    actionsTruncated: attributes.actionsTruncated ?? false,
    actionPagesRead: Math.max(attributes.actionPagesRead ?? 0, 0),
    sourceArtifacts
  }).pipe(
    Effect.mapError(() => malformed("normalized-pipeline-details-invalid", event.eventId))
  )
})
