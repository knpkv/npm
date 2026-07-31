import { assert } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const LiveAwsProbeDiagnosticCode = Schema.Literals([
  "configuration-role-arn-invalid",
  "codecommit-account-mismatch",
  "codecommit-repository-missing",
  "codecommit-pull-request-missing",
  "codecommit-diff-mismatch",
  "codepipeline-account-mismatch",
  "codepipeline-pipeline-missing",
  "codepipeline-definition-mismatch",
  "codepipeline-successful-execution-missing",
  "codepipeline-action-history-truncated",
  "codepipeline-source-action-mismatch",
  "codepipeline-approval-action-mismatch",
  "codepipeline-state-mismatch"
])

type LiveAwsProbeDiagnosticCode = typeof LiveAwsProbeDiagnosticCode.Type

/** Provider-independent failure exposed to the live test runner. */
export class LiveAwsProbeFailure extends Schema.TaggedErrorClass<LiveAwsProbeFailure>()(
  "LiveAwsProbeFailure",
  {
    diagnosticCode: Schema.Literal("live-aws-provider-probe-failed")
  }
) {}

/** Fail a live assertion with a fixed diagnostic and no provider-derived operands. */
export function assertLiveAwsProbe(
  condition: boolean,
  diagnosticCode: LiveAwsProbeDiagnosticCode
): asserts condition {
  assert.isTrue(condition, diagnosticCode)
}

export interface BoundedResourcePage {
  readonly names: ReadonlyArray<string>
  readonly nextToken: string | null
}

export interface BoundedSearchPage<A> {
  readonly values: ReadonlyArray<A>
  readonly nextToken: string | null
}

export interface LiveAwsDiffPage {
  readonly files: ReadonlyArray<{
    readonly after: null | {
      readonly path: string
    }
  }>
  readonly nextToken: string | null
}

export interface LiveAwsPipelineDefinition {
  readonly stages: ReadonlyArray<{
    readonly name: string
    readonly actions: ReadonlyArray<{
      readonly name: string
      readonly actionType: {
        readonly category: string
        readonly owner: string
        readonly provider: string
        readonly version: string
      }
      readonly codeCommitSource: null | {
        readonly repositoryName: string
        readonly branchName: string
        readonly pollForSourceChanges: boolean
      }
    }>
  }>
}

export interface LiveAwsPipelineExecutionVersion {
  readonly pipelineVersion: number
  readonly status: string
}

/** Attest the exact safe subset of the deployed fixture pipeline definition. */
export const matchesLiveAwsPipelineDefinition = (
  pipeline: LiveAwsPipelineDefinition,
  expectedRepositoryName: string
): boolean => {
  if (pipeline.stages.length !== 2) return false
  const [sourceStage, approvalStage] = pipeline.stages
  if (
    sourceStage?.name !== "Source" ||
    sourceStage.actions.length !== 1 ||
    approvalStage?.name !== "Approval" ||
    approvalStage.actions.length !== 1
  ) return false
  const [sourceAction] = sourceStage.actions
  const [approvalAction] = approvalStage.actions
  return (
    sourceAction?.name === "ReadFixture" &&
    sourceAction.actionType.category === "Source" &&
    sourceAction.actionType.owner === "AWS" &&
    sourceAction.actionType.provider === "CodeCommit" &&
    sourceAction.actionType.version === "1" &&
    sourceAction.codeCommitSource?.repositoryName === expectedRepositoryName &&
    sourceAction.codeCommitSource.branchName === "main" &&
    sourceAction.codeCommitSource.pollForSourceChanges === false &&
    approvalAction?.name === "ConfirmFixture" &&
    approvalAction.actionType.category === "Approval" &&
    approvalAction.actionType.owner === "AWS" &&
    approvalAction.actionType.provider === "Manual" &&
    approvalAction.actionType.version === "1"
  )
}

/** Bind successful execution evidence to the attested current pipeline version. */
export const isSuccessfulExecutionForPipelineVersion = (
  execution: LiveAwsPipelineExecutionVersion,
  currentPipelineVersion: number
): boolean =>
  execution.status === "Succeeded" &&
  execution.pipelineVersion === currentPipelineVersion

/** Find one matching provider value within a fixed number of pages. */
export const findValueInBoundedPages = <A, E, R>(options: {
  readonly maximumPages: number
  readonly listPage: (
    nextToken: string | null
  ) => Effect.Effect<BoundedSearchPage<A>, E, R>
  readonly matches: (value: A) => boolean
}): Effect.Effect<A | undefined, E, R> =>
  Effect.gen(function*() {
    let nextToken: string | null = null
    for (let pageNumber = 0; pageNumber < options.maximumPages; pageNumber += 1) {
      const page: BoundedSearchPage<A> = yield* options.listPage(nextToken)
      const match = page.values.find(options.matches)
      if (match !== undefined) return match
      nextToken = page.nextToken
      if (nextToken === null) return undefined
    }
    return undefined
  })

/** Require the complete CodeCommit diff to be exactly the stable fixture file. */
export const isExactLiveAwsFixtureDiff = (page: LiveAwsDiffPage): boolean =>
  page.nextToken === null &&
  page.files.length === 1 &&
  page.files[0]?.after?.path === "fixture.txt"

/** Search a fixed number of provider pages without collecting provider-owned names. */
export const resourceExistsInBoundedPages = <E, R>(options: {
  readonly expectedName: string
  readonly maximumPages: number
  readonly listPage: (
    nextToken: string | null
  ) => Effect.Effect<BoundedResourcePage, E, R>
}): Effect.Effect<boolean, E, R> =>
  Effect.gen(function*() {
    let nextToken: string | null = null
    for (let pageNumber = 0; pageNumber < options.maximumPages; pageNumber += 1) {
      const page: BoundedResourcePage = yield* options.listPage(nextToken)
      if (page.names.includes(options.expectedName)) return true
      nextToken = page.nextToken
      if (nextToken === null) return false
    }
    return false
  })

/** Discard provider failures and defects while preserving interruption. */
export const sanitizeLiveAwsProbe = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, LiveAwsProbeFailure, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const interruptions = cause.reasons.filter(Cause.isInterruptReason)
      return interruptions.length > 0
        ? Effect.failCause(Cause.fromReasons(interruptions))
        : Effect.fail(
          new LiveAwsProbeFailure({
            diagnosticCode: "live-aws-provider-probe-failed"
          })
        )
    })
  )
