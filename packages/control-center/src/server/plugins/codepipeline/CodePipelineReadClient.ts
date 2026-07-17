/**
 * Schema-decoded, bounded CodePipeline reads.
 *
 * Provider-shaped values cross one `unknown` boundary here. Downstream plugin
 * normalization receives only the narrow models declared in this module.
 *
 * @internal
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { PluginMalformedResponseFailure } from "../failures.js"
import {
  type CodePipelineAwsAccount,
  type CodePipelineProviderFailure,
  CodePipelineReadProvider,
  CodePipelineReadProviderLive,
  type GetPipelineExecutionProviderRequest,
  type GetPipelineProviderRequest,
  type ListPipelineExecutionsProviderRequest
} from "./CodePipelineReadProvider.js"

const EXECUTION_PROVIDER_PAGE_LIMIT = 1
const ACTION_PROVIDER_PAGE_LIMIT = 100
const PIPELINE_STAGE_LIMIT = 50
const STAGE_ACTION_LIMIT = 50
// Plugin checkpoints allow 2,048 characters and sync prefixes provider cursors with `next:`.
const CHECKPOINT_PROVIDER_TOKEN_LIMIT = 2_043

const Identifier = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const Summary = Schema.String.check(Schema.isMaxLength(4_000))
const PageToken = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(CHECKPOINT_PROVIDER_TOKEN_LIMIT)
)
const AwsStatus = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))

const RawCallerIdentity = Schema.Struct({
  Account: Identifier,
  Arn: Identifier
})

const RawActionType = Schema.Struct({
  category: Identifier,
  owner: Identifier,
  provider: Identifier,
  version: Identifier
})

const RawArtifactDeclaration = Schema.Struct({ name: Identifier })

const RawActionDeclaration = Schema.Struct({
  name: Identifier,
  actionTypeId: RawActionType,
  runOrder: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  region: Schema.optionalKey(Identifier),
  roleArn: Schema.optionalKey(Identifier),
  inputArtifacts: Schema.optionalKey(Schema.Array(RawArtifactDeclaration).check(Schema.isMaxLength(50))),
  outputArtifacts: Schema.optionalKey(Schema.Array(RawArtifactDeclaration).check(Schema.isMaxLength(50)))
})

const RawStageDeclaration = Schema.Struct({
  name: Identifier,
  actions: Schema.Array(RawActionDeclaration).check(Schema.isMaxLength(STAGE_ACTION_LIMIT))
})

const RawPipelineOutput = Schema.Struct({
  pipeline: Schema.Struct({
    name: Identifier,
    version: Schema.Int.check(Schema.isGreaterThan(0)),
    pipelineType: Schema.optionalKey(Identifier),
    executionMode: Schema.optionalKey(Identifier),
    stages: Schema.Array(RawStageDeclaration).check(Schema.isMaxLength(PIPELINE_STAGE_LIMIT))
  }),
  metadata: Schema.Struct({
    pipelineArn: Identifier,
    created: Schema.optionalKey(Schema.Date),
    updated: Schema.optionalKey(Schema.Date)
  })
})

const RawSourceRevision = Schema.Struct({
  actionName: Identifier,
  revisionId: Schema.optionalKey(Identifier),
  revisionSummary: Schema.optionalKey(Summary)
})

const RawExecutionSummary = Schema.Struct({
  pipelineExecutionId: Identifier,
  status: AwsStatus,
  statusSummary: Schema.optionalKey(Summary),
  startTime: Schema.Date,
  lastUpdateTime: Schema.optionalKey(Schema.Date),
  sourceRevisions: Schema.optionalKey(Schema.Array(RawSourceRevision).check(Schema.isMaxLength(50))),
  trigger: Schema.optionalKey(Schema.Struct({
    triggerType: Schema.optionalKey(Identifier),
    triggerDetail: Schema.optionalKey(Summary)
  })),
  executionMode: Schema.optionalKey(Identifier),
  executionType: Schema.optionalKey(Identifier),
  rollbackMetadata: Schema.optionalKey(Schema.Struct({
    rollbackTargetPipelineExecutionId: Schema.optionalKey(Identifier)
  }))
})

const RawExecutionPage = Schema.Struct({
  pipelineExecutionSummaries: Schema.optionalKey(
    Schema.Array(RawExecutionSummary).check(Schema.isMaxLength(EXECUTION_PROVIDER_PAGE_LIMIT))
  ),
  nextToken: Schema.optionalKey(PageToken)
})

const RawArtifactRevision = Schema.Struct({
  name: Schema.optionalKey(Identifier),
  revisionId: Schema.optionalKey(Identifier),
  revisionSummary: Schema.optionalKey(Summary),
  created: Schema.optionalKey(Schema.Date)
})

const RawExecutionOutput = Schema.Struct({
  pipelineExecution: Schema.Struct({
    pipelineName: Identifier,
    pipelineVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    pipelineExecutionId: Identifier,
    status: AwsStatus,
    statusSummary: Schema.optionalKey(Summary),
    artifactRevisions: Schema.optionalKey(Schema.Array(RawArtifactRevision).check(Schema.isMaxLength(100))),
    trigger: Schema.optionalKey(Schema.Struct({
      triggerType: Schema.optionalKey(Identifier),
      triggerDetail: Schema.optionalKey(Summary)
    })),
    executionMode: Schema.optionalKey(Identifier),
    executionType: Schema.optionalKey(Identifier),
    rollbackMetadata: Schema.optionalKey(Schema.Struct({
      rollbackTargetPipelineExecutionId: Schema.optionalKey(Identifier)
    }))
  })
})

const RawArtifactLocation = Schema.Struct({
  bucket: Schema.optionalKey(Identifier),
  key: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)))
})

const RawArtifactDetail = Schema.Struct({
  name: Schema.optionalKey(Identifier),
  s3location: Schema.optionalKey(RawArtifactLocation)
})

const RawActionDetail = Schema.Struct({
  pipelineExecutionId: Identifier,
  actionExecutionId: Identifier,
  pipelineVersion: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  stageName: Identifier,
  actionName: Identifier,
  startTime: Schema.optionalKey(Schema.Date),
  lastUpdateTime: Schema.optionalKey(Schema.Date),
  updatedBy: Schema.optionalKey(Identifier),
  status: AwsStatus,
  input: Schema.optionalKey(Schema.Struct({
    actionTypeId: Schema.optionalKey(RawActionType),
    roleArn: Schema.optionalKey(Identifier),
    region: Schema.optionalKey(Identifier),
    inputArtifacts: Schema.optionalKey(Schema.Array(RawArtifactDetail).check(Schema.isMaxLength(50)))
  })),
  output: Schema.optionalKey(Schema.Struct({
    outputArtifacts: Schema.optionalKey(Schema.Array(RawArtifactDetail).check(Schema.isMaxLength(50))),
    executionResult: Schema.optionalKey(Schema.Struct({
      externalExecutionId: Schema.optionalKey(Identifier),
      externalExecutionSummary: Schema.optionalKey(Summary),
      errorDetails: Schema.optionalKey(Schema.Struct({
        code: Schema.optionalKey(Identifier),
        message: Schema.optionalKey(Summary)
      })),
      logStreamARN: Schema.optionalKey(Identifier)
    }))
  }))
})

const RawActionPage = Schema.Struct({
  actionExecutionDetails: Schema.optionalKey(
    Schema.Array(RawActionDetail).check(Schema.isMaxLength(ACTION_PROVIDER_PAGE_LIMIT))
  ),
  nextToken: Schema.optionalKey(PageToken)
})

/** Secret-free AWS identity used for discovery. @internal */
export const CodePipelineAccountIdentity = Schema.Struct({ accountId: Identifier, arn: Identifier })
/** @internal */
export type CodePipelineAccountIdentity = typeof CodePipelineAccountIdentity.Type

const CodePipelineActionType = Schema.Struct({
  category: Identifier,
  owner: Identifier,
  provider: Identifier,
  version: Identifier
})

const CodePipelineActionDeclaration = Schema.Struct({
  name: Identifier,
  actionType: CodePipelineActionType,
  runOrder: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  region: Schema.NullOr(Identifier),
  roleArn: Schema.NullOr(Identifier),
  inputArtifactNames: Schema.Array(Identifier),
  outputArtifactNames: Schema.Array(Identifier)
})

const CodePipelineStageDeclaration = Schema.Struct({
  name: Identifier,
  actions: Schema.Array(CodePipelineActionDeclaration)
})

/** One decoded pipeline definition with stable AWS provenance. @internal */
export const CodePipelinePipeline = Schema.Struct({
  name: Identifier,
  arn: Identifier,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  pipelineType: Schema.NullOr(Identifier),
  executionMode: Schema.NullOr(Identifier),
  createdAt: Schema.NullOr(Schema.Date),
  updatedAt: Schema.NullOr(Schema.Date),
  stages: Schema.Array(CodePipelineStageDeclaration)
})
/** @internal */
export type CodePipelinePipeline = typeof CodePipelinePipeline.Type

const CodePipelineSourceRevision = Schema.Struct({
  actionName: Identifier,
  revisionId: Schema.NullOr(Identifier),
  revisionSummary: Schema.NullOr(Summary)
})

/** One decoded execution-list entry. @internal */
export const CodePipelineExecutionSummary = Schema.Struct({
  executionId: Identifier,
  status: AwsStatus,
  statusSummary: Schema.NullOr(Summary),
  startedAt: Schema.Date,
  updatedAt: Schema.NullOr(Schema.Date),
  sourceRevisions: Schema.Array(CodePipelineSourceRevision),
  triggerType: Schema.NullOr(Identifier),
  triggerDetail: Schema.NullOr(Summary),
  executionMode: Schema.NullOr(Identifier),
  executionType: Schema.NullOr(Identifier),
  rollbackTargetExecutionId: Schema.NullOr(Identifier)
})
/** @internal */
export type CodePipelineExecutionSummary = typeof CodePipelineExecutionSummary.Type

/** One decoded execution-list page. @internal */
export const CodePipelineExecutionPage = Schema.Struct({
  executions: Schema.Array(CodePipelineExecutionSummary).check(Schema.isMaxLength(EXECUTION_PROVIDER_PAGE_LIMIT)),
  nextToken: Schema.NullOr(PageToken),
  providerPageLimit: Schema.Literal(EXECUTION_PROVIDER_PAGE_LIMIT)
})
/** @internal */
export type CodePipelineExecutionPage = typeof CodePipelineExecutionPage.Type

const CodePipelineArtifactRevision = Schema.Struct({
  name: Schema.NullOr(Identifier),
  revisionId: Schema.NullOr(Identifier),
  revisionSummary: Schema.NullOr(Summary),
  createdAt: Schema.NullOr(Schema.Date)
})

/** One decoded execution detail. @internal */
export const CodePipelineExecution = Schema.Struct({
  pipelineName: Identifier,
  pipelineVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  executionId: Identifier,
  status: AwsStatus,
  statusSummary: Schema.NullOr(Summary),
  artifactRevisions: Schema.Array(CodePipelineArtifactRevision),
  triggerType: Schema.NullOr(Identifier),
  triggerDetail: Schema.NullOr(Summary),
  executionMode: Schema.NullOr(Identifier),
  executionType: Schema.NullOr(Identifier),
  rollbackTargetExecutionId: Schema.NullOr(Identifier)
})
/** @internal */
export type CodePipelineExecution = typeof CodePipelineExecution.Type

const CodePipelineArtifactReference = Schema.Struct({
  name: Schema.NullOr(Identifier),
  bucket: Schema.NullOr(Identifier),
  key: Schema.NullOr(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096))),
  access: Schema.Literal("proxy-required")
})
type CodePipelineArtifactReference = typeof CodePipelineArtifactReference.Type

/** One decoded action execution with credential-free artifact metadata. @internal */
export const CodePipelineActionExecution = Schema.Struct({
  executionId: Identifier,
  actionExecutionId: Identifier,
  pipelineVersion: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  stageName: Identifier,
  actionName: Identifier,
  status: AwsStatus,
  startedAt: Schema.NullOr(Schema.Date),
  updatedAt: Schema.NullOr(Schema.Date),
  updatedBy: Schema.NullOr(Identifier),
  actionType: Schema.NullOr(CodePipelineActionType),
  roleArn: Schema.NullOr(Identifier),
  region: Schema.NullOr(Identifier),
  inputArtifacts: Schema.Array(CodePipelineArtifactReference),
  outputArtifacts: Schema.Array(CodePipelineArtifactReference),
  externalExecutionId: Schema.NullOr(Identifier),
  externalExecutionSummary: Schema.NullOr(Summary),
  errorCode: Schema.NullOr(Identifier),
  errorMessage: Schema.NullOr(Summary),
  logStreamArn: Schema.NullOr(Identifier)
})
/** @internal */
export type CodePipelineActionExecution = typeof CodePipelineActionExecution.Type

/** Bounded action collection for one execution. @internal */
export const CodePipelineActionCollection = Schema.Struct({
  actions: Schema.Array(CodePipelineActionExecution).check(Schema.isMaxLength(200)),
  truncated: Schema.Boolean,
  pagesRead: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(5))
})
/** @internal */
export type CodePipelineActionCollection = typeof CodePipelineActionCollection.Type

/** Execution detail and its bounded action history. @internal */
export const CodePipelineExecutionSnapshot = Schema.Struct({
  execution: CodePipelineExecution,
  summary: Schema.NullOr(CodePipelineExecutionSummary),
  actionCollection: CodePipelineActionCollection
})
/** @internal */
export type CodePipelineExecutionSnapshot = typeof CodePipelineExecutionSnapshot.Type

const malformed = (operation: string, diagnosticCode = "codepipeline-provider-response-invalid") =>
  new PluginMalformedResponseFailure({ operation, diagnosticCode })

const decodeProvider = <Codec extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: Codec,
  value: unknown
): Effect.Effect<Codec["Type"], PluginMalformedResponseFailure> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError(() => malformed(operation))
  )

const decodeModel = <Codec extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: Codec,
  value: unknown
): Effect.Effect<Codec["Type"], PluginMalformedResponseFailure> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError(() => malformed(operation, "codepipeline-normalized-model-invalid"))
  )

const artifactReference = (artifact: typeof RawArtifactDetail.Type): CodePipelineArtifactReference => ({
  name: artifact.name ?? null,
  bucket: artifact.s3location?.bucket ?? null,
  key: artifact.s3location?.key ?? null,
  access: "proxy-required"
})

const normalizeAction = (action: typeof RawActionDetail.Type) =>
  decodeModel("codepipeline-list-actions", CodePipelineActionExecution, {
    executionId: action.pipelineExecutionId,
    actionExecutionId: action.actionExecutionId,
    pipelineVersion: action.pipelineVersion ?? null,
    stageName: action.stageName,
    actionName: action.actionName,
    status: action.status,
    startedAt: action.startTime ?? null,
    updatedAt: action.lastUpdateTime ?? null,
    updatedBy: action.updatedBy ?? null,
    actionType: action.input?.actionTypeId ?? null,
    roleArn: action.input?.roleArn ?? null,
    region: action.input?.region ?? null,
    inputArtifacts: (action.input?.inputArtifacts ?? []).map(artifactReference),
    outputArtifacts: (action.output?.outputArtifacts ?? []).map(artifactReference),
    externalExecutionId: action.output?.executionResult?.externalExecutionId ?? null,
    externalExecutionSummary: action.output?.executionResult?.externalExecutionSummary ?? null,
    errorCode: action.output?.executionResult?.errorDetails?.code ?? null,
    errorMessage: action.output?.executionResult?.errorDetails?.message ?? null,
    logStreamArn: action.output?.executionResult?.logStreamARN ?? null
  })

/** Bounds for action pagination under one execution read. @internal */
export interface CodePipelineActionReadBounds {
  readonly pageSize: number
  readonly maximumPages: number
  readonly maximumActions: number
}

/** Schema-decoded CodePipeline read operations. @internal */
export interface CodePipelineReadClientService {
  readonly discoverAccount: (
    account: CodePipelineAwsAccount
  ) => Effect.Effect<CodePipelineAccountIdentity, CodePipelineProviderFailure>
  readonly getPipeline: (
    request: GetPipelineProviderRequest
  ) => Effect.Effect<CodePipelinePipeline, CodePipelineProviderFailure>
  readonly listExecutionsPage: (
    request: Omit<ListPipelineExecutionsProviderRequest, "maximumResults">
  ) => Effect.Effect<CodePipelineExecutionPage, CodePipelineProviderFailure>
  readonly getExecutionSnapshot: (
    request: GetPipelineExecutionProviderRequest & {
      readonly actionBounds: CodePipelineActionReadBounds
      readonly summary: CodePipelineExecutionSummary | null
    }
  ) => Effect.Effect<CodePipelineExecutionSnapshot, CodePipelineProviderFailure>
}

/** Injectable Schema-decoded CodePipeline read client. @internal */
export class CodePipelineReadClient extends Context.Service<
  CodePipelineReadClient,
  CodePipelineReadClientService
>()("@knpkv/control-center/CodePipelineReadClient") {
  static readonly layer = Layer.effect(
    CodePipelineReadClient,
    Effect.gen(function*() {
      const provider = yield* CodePipelineReadProvider

      const discoverAccount = Effect.fn("CodePipelineReadClient.discoverAccount")(function*(
        account: CodePipelineAwsAccount
      ) {
        const raw = yield* provider.getCallerIdentity(account)
        const identity = yield* decodeProvider("codepipeline-discover-account", RawCallerIdentity, raw)
        return yield* decodeModel("codepipeline-discover-account", CodePipelineAccountIdentity, {
          accountId: identity.Account,
          arn: identity.Arn
        })
      })

      const getPipeline = Effect.fn("CodePipelineReadClient.getPipeline")(function*(
        request: GetPipelineProviderRequest
      ) {
        const raw = yield* provider.getPipeline(request)
        const response = yield* decodeProvider("codepipeline-get-pipeline", RawPipelineOutput, raw)
        if (response.pipeline.name !== request.pipelineName) {
          return yield* malformed("codepipeline-get-pipeline", "codepipeline-pipeline-identity-mismatch")
        }
        return yield* decodeModel("codepipeline-get-pipeline", CodePipelinePipeline, {
          name: response.pipeline.name,
          arn: response.metadata.pipelineArn,
          version: response.pipeline.version,
          pipelineType: response.pipeline.pipelineType ?? null,
          executionMode: response.pipeline.executionMode ?? null,
          createdAt: response.metadata.created ?? null,
          updatedAt: response.metadata.updated ?? null,
          stages: response.pipeline.stages.map((stage) => ({
            name: stage.name,
            actions: stage.actions.map((action) => ({
              name: action.name,
              actionType: action.actionTypeId,
              runOrder: action.runOrder ?? null,
              region: action.region ?? null,
              roleArn: action.roleArn ?? null,
              inputArtifactNames: (action.inputArtifacts ?? []).map(({ name }) => name),
              outputArtifactNames: (action.outputArtifacts ?? []).map(({ name }) => name)
            }))
          }))
        })
      })

      const listExecutionsPage = Effect.fn("CodePipelineReadClient.listExecutionsPage")(function*(
        request: Omit<ListPipelineExecutionsProviderRequest, "maximumResults">
      ) {
        const raw = yield* provider.listPipelineExecutionsPage({
          ...request,
          maximumResults: EXECUTION_PROVIDER_PAGE_LIMIT
        })
        const response = yield* decodeProvider("codepipeline-list-executions", RawExecutionPage, raw)
        const executions = yield* Effect.forEach(
          response.pipelineExecutionSummaries ?? [],
          (execution) =>
            decodeModel("codepipeline-list-executions", CodePipelineExecutionSummary, {
              executionId: execution.pipelineExecutionId,
              status: execution.status,
              statusSummary: execution.statusSummary ?? null,
              startedAt: execution.startTime,
              updatedAt: execution.lastUpdateTime ?? null,
              sourceRevisions: (execution.sourceRevisions ?? []).map((revision) => ({
                actionName: revision.actionName,
                revisionId: revision.revisionId ?? null,
                revisionSummary: revision.revisionSummary ?? null
              })),
              triggerType: execution.trigger?.triggerType ?? null,
              triggerDetail: execution.trigger?.triggerDetail ?? null,
              executionMode: execution.executionMode ?? null,
              executionType: execution.executionType ?? null,
              rollbackTargetExecutionId: execution.rollbackMetadata?.rollbackTargetPipelineExecutionId ?? null
            })
        )
        return yield* decodeModel("codepipeline-list-executions", CodePipelineExecutionPage, {
          executions,
          nextToken: response.nextToken ?? null,
          providerPageLimit: EXECUTION_PROVIDER_PAGE_LIMIT
        })
      })

      const collectActions = Effect.fn("CodePipelineReadClient.collectActions")(function*(
        request: GetPipelineExecutionProviderRequest,
        bounds: CodePipelineActionReadBounds
      ): Effect.fn.Return<CodePipelineActionCollection, CodePipelineProviderFailure> {
        const actions: Array<CodePipelineActionExecution> = []
        const actionIds = new Set<string>()
        const seenTokens = new Set<string>()
        let nextToken: string | null = null
        let pagesRead = 0
        let truncated = false

        while (pagesRead < bounds.maximumPages && actions.length < bounds.maximumActions) {
          const maximumResults = Math.min(
            ACTION_PROVIDER_PAGE_LIMIT,
            bounds.pageSize,
            bounds.maximumActions - actions.length
          )
          const raw: unknown = yield* provider.listActionExecutionsPage({
            ...request,
            maximumResults,
            nextToken
          })
          const response: typeof RawActionPage.Type = yield* decodeProvider(
            "codepipeline-list-actions",
            RawActionPage,
            raw
          )
          const details: ReadonlyArray<typeof RawActionDetail.Type> = response.actionExecutionDetails ?? []
          if (details.length > maximumResults) {
            return yield* malformed("codepipeline-list-actions", "codepipeline-action-page-limit-exceeded")
          }
          const normalized = yield* Effect.forEach(details, (action) => normalizeAction(action))
          for (const action of normalized) {
            if (action.executionId !== request.pipelineExecutionId) {
              return yield* malformed("codepipeline-list-actions", "codepipeline-action-execution-mismatch")
            }
            if (actionIds.has(action.actionExecutionId)) {
              return yield* malformed("codepipeline-list-actions", "codepipeline-action-identity-duplicate")
            }
            actionIds.add(action.actionExecutionId)
            actions.push(action)
          }
          pagesRead += 1
          const followingToken: string | null = response.nextToken ?? null
          if (followingToken === null) {
            nextToken = null
            break
          }
          if (seenTokens.has(followingToken) || followingToken === nextToken) {
            return yield* malformed("codepipeline-list-actions", "codepipeline-action-cursor-repeated")
          }
          seenTokens.add(followingToken)
          nextToken = followingToken
        }
        if (nextToken !== null) truncated = true
        return yield* decodeModel("codepipeline-list-actions", CodePipelineActionCollection, {
          actions,
          truncated,
          pagesRead
        })
      })

      const getExecutionSnapshot = Effect.fn("CodePipelineReadClient.getExecutionSnapshot")(function*(
        request: GetPipelineExecutionProviderRequest & {
          readonly actionBounds: CodePipelineActionReadBounds
          readonly summary: CodePipelineExecutionSummary | null
        }
      ): Effect.fn.Return<CodePipelineExecutionSnapshot, CodePipelineProviderFailure> {
        if (request.summary !== null && request.summary.executionId !== request.pipelineExecutionId) {
          return yield* malformed("codepipeline-get-execution", "codepipeline-summary-identity-mismatch")
        }
        const responses = yield* Effect.all({
          actionCollection: collectActions(request, request.actionBounds),
          rawExecution: provider.getPipelineExecution(request)
        }, { concurrency: 2 })
        const response = yield* decodeProvider(
          "codepipeline-get-execution",
          RawExecutionOutput,
          responses.rawExecution
        )
        const execution = response.pipelineExecution
        if (
          execution.pipelineName !== request.pipelineName ||
          execution.pipelineExecutionId !== request.pipelineExecutionId
        ) {
          return yield* malformed("codepipeline-get-execution", "codepipeline-execution-identity-mismatch")
        }
        const normalizedExecution = yield* decodeModel(
          "codepipeline-get-execution",
          CodePipelineExecution,
          {
            pipelineName: execution.pipelineName,
            pipelineVersion: execution.pipelineVersion,
            executionId: execution.pipelineExecutionId,
            status: execution.status,
            statusSummary: execution.statusSummary ?? null,
            artifactRevisions: (execution.artifactRevisions ?? []).map((revision) => ({
              name: revision.name ?? null,
              revisionId: revision.revisionId ?? null,
              revisionSummary: revision.revisionSummary ?? null,
              createdAt: revision.created ?? null
            })),
            triggerType: execution.trigger?.triggerType ?? null,
            triggerDetail: execution.trigger?.triggerDetail ?? null,
            executionMode: execution.executionMode ?? null,
            executionType: execution.executionType ?? null,
            rollbackTargetExecutionId: execution.rollbackMetadata?.rollbackTargetPipelineExecutionId ?? null
          }
        )
        return yield* decodeModel("codepipeline-get-execution", CodePipelineExecutionSnapshot, {
          execution: normalizedExecution,
          summary: request.summary,
          actionCollection: responses.actionCollection
        })
      })

      return {
        discoverAccount,
        getExecutionSnapshot,
        getPipeline,
        listExecutionsPage
      } satisfies CodePipelineReadClientService
    })
  )

  /** Production client using direct distilled-aws operations. @internal */
  static readonly live = CodePipelineReadClient.layer.pipe(Layer.provide(CodePipelineReadProviderLive))
}
