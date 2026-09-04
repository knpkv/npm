import { Clock, Context, Effect, Layer, Schema } from "effect"
import * as EvidenceModel from "./pull-request-evidence-model.js"

const freshnessWindowMillis = 60_000

export interface PullRequestEvidenceSourceService {
  /** Reads all fields in one bounded provider observation, sampling the head before and after the read. */
  readonly observe: (
    repository: string,
    pullRequest: number
  ) => Effect.Effect<EvidenceModel.PullRequestAtomicObservation, EvidenceModel.PullRequestEvidenceSourceError>
}

export class PullRequestEvidenceSource extends Context.Service<
  PullRequestEvidenceSource,
  PullRequestEvidenceSourceService
>()("@knpkv/herdr-coordinator/PullRequestEvidenceSource") {}

export interface PullRequestEvidenceProviderService {
  readonly exactHeadGateEvidence: (
    repository: string,
    pullRequest: number,
    expectedHead: EvidenceModel.CommitSha
  ) => Effect.Effect<
    EvidenceModel.PullRequestGateInput,
    | EvidenceModel.PullRequestEvidenceSourceError
    | EvidenceModel.PullRequestEvidenceInvalid
    | EvidenceModel.PullRequestEvidenceStale
  >
}

export class PullRequestEvidenceProvider extends Context.Service<
  PullRequestEvidenceProvider,
  PullRequestEvidenceProviderService
>()("@knpkv/herdr-coordinator/PullRequestEvidenceProvider") {}

const makePullRequestEvidenceProvider = Effect.gen(function*() {
  const source = yield* PullRequestEvidenceSource
  const clock = yield* Clock.Clock

  return PullRequestEvidenceProvider.of({
    exactHeadGateEvidence: Effect.fn("PullRequestEvidenceProvider.exactHeadGateEvidence")(function*(
      repository,
      pullRequest,
      expectedHead
    ) {
      const request = yield* Schema.decodeUnknownEffect(EvidenceModel.PullRequestEvidenceRequest)({
        repository,
        pullRequest,
        expectedHead
      }).pipe(
        Effect.mapError(() =>
          new EvidenceModel.PullRequestEvidenceInvalid({ detail: "pull request evidence request is invalid" })
        )
      )
      const observation = yield* source.observe(request.repository, request.pullRequest).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(EvidenceModel.PullRequestAtomicObservation)),
        Effect.mapError((error) =>
          error._tag === "PullRequestEvidenceSourceError"
            ? error
            : new EvidenceModel.PullRequestEvidenceInvalid({ detail: "provider observation is invalid" })
        )
      )
      if (observation.repository !== request.repository || observation.pullRequest !== request.pullRequest) {
        return yield* new EvidenceModel.PullRequestEvidenceInvalid({
          detail: "provider observation identifies another pull request"
        })
      }
      if (
        observation.headAtStart !== request.expectedHead ||
        observation.headAtEnd !== request.expectedHead
      ) {
        return yield* new EvidenceModel.PullRequestEvidenceStale({
          expectedHead: request.expectedHead,
          headAtStart: observation.headAtStart,
          headAtEnd: observation.headAtEnd
        })
      }
      if (new Set(observation.requiredChecks).size !== observation.requiredChecks.length) {
        return yield* new EvidenceModel.PullRequestEvidenceInvalid({ detail: "required check names are duplicated" })
      }
      const checkNames = new Set(observation.checks.map(({ name }) => name))
      if (checkNames.size !== observation.checks.length) {
        return yield* new EvidenceModel.PullRequestEvidenceInvalid({ detail: "check evidence is duplicated" })
      }
      if (new Set(observation.threads.map(({ id }) => id)).size !== observation.threads.length) {
        return yield* new EvidenceModel.PullRequestEvidenceInvalid({ detail: "thread evidence is duplicated" })
      }
      if (new Set(observation.reviews.map(({ id }) => id)).size !== observation.reviews.length) {
        return yield* new EvidenceModel.PullRequestEvidenceInvalid({ detail: "review evidence is duplicated" })
      }
      if (observation.requiredChecks.length === 0 || observation.requiredChecks.some((name) => !checkNames.has(name))) {
        return yield* new EvidenceModel.PullRequestEvidenceInvalid({ detail: "required check evidence is incomplete" })
      }
      if (observation.reviews.some(({ submittedAt }) => submittedAt > observation.observedAt)) {
        return yield* new EvidenceModel.PullRequestEvidenceInvalid({
          detail: "review evidence is newer than its observation"
        })
      }
      if (
        observation.checks.some(({ head }) => head !== request.expectedHead) ||
        observation.threads.some(({ head }) => head !== request.expectedHead) ||
        observation.reviews.some(({ head }) => head !== request.expectedHead)
      ) {
        return yield* new EvidenceModel.PullRequestEvidenceInvalid({
          detail: "source-sensitive evidence is not bound to the expected head"
        })
      }
      const projectedAt = yield* clock.currentTimeMillis
      if (projectedAt < observation.observedAt) {
        return yield* new EvidenceModel.PullRequestEvidenceInvalid({
          detail: "provider observation is from the future"
        })
      }
      const freshUntil = observation.observedAt + freshnessWindowMillis
      return yield* Schema.decodeUnknownEffect(EvidenceModel.PullRequestGateInput)({
        repository: request.repository,
        pullRequest: request.pullRequest,
        expectedHead: request.expectedHead,
        observedHead: observation.headAtEnd,
        observedAt: observation.observedAt,
        freshUntil,
        projectedAt,
        requiredChecks: observation.requiredChecks,
        checks: observation.checks,
        threads: observation.threads,
        reviews: observation.reviews,
        owner: observation.owner,
        work: observation.work
      }).pipe(
        Effect.mapError(() => new EvidenceModel.PullRequestEvidenceInvalid({ detail: "gate evidence is invalid" }))
      )
    })
  })
})

/** Supplies exact-head evidence from one atomic source observation. */
export const pullRequestEvidenceLayer: Layer.Layer<
  PullRequestEvidenceProvider,
  never,
  PullRequestEvidenceSource | Clock.Clock
> = Layer.effect(PullRequestEvidenceProvider, makePullRequestEvidenceProvider)
