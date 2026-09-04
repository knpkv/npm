import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  type PullRequestAtomicObservation,
  pullRequestEvidenceLayer,
  PullRequestEvidenceProvider,
  PullRequestEvidenceSource,
  PullRequestGateInput
} from "../src/index.js"

const head = "a".repeat(40)

const observation = (overrides: Partial<PullRequestAtomicObservation> = {}): PullRequestAtomicObservation => ({
  checks: [{ conclusion: "success", head, name: "Types" }],
  headAtEnd: head,
  headAtStart: head,
  observedAt: 1_000,
  owner: { id: "owner:andrey", name: "Andrey" },
  pullRequest: 417,
  repository: "knpkv/npm",
  requiredChecks: ["Types"],
  reviews: [{ head, id: "review:1", reviewer: "codex", state: "approved", submittedAt: 1_000 }],
  threads: [{ head, id: "thread:1", outdated: false, resolved: true }],
  work: { goalId: "goal:package", relation: "current", releaseGoalId: "goal:release" },
  ...overrides
})

const withSource = <A, E>(
  observe: () => Effect.Effect<PullRequestAtomicObservation, E>,
  effect: Effect.Effect<A, unknown, PullRequestEvidenceProvider>
) =>
  effect.pipe(
    // Test entry point: source and provider layers share the enclosing @effect/vitest scope.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(
      pullRequestEvidenceLayer.pipe(
        Layer.provide(Layer.succeed(PullRequestEvidenceSource, PullRequestEvidenceSource.of({ observe })))
      )
    )
  )

describe("atomic pull request evidence", () => {
  it.effect("binds one bounded source observation to the exact expected head", () =>
    // @effect-diagnostics-next-line missingEffectContext:off
    Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const calls = yield* Ref.make(0)
      const evidence = yield* withSource(
        () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(observation())),
        Effect.gen(function*() {
          const provider = yield* PullRequestEvidenceProvider
          return yield* provider.exactHeadGateEvidence("knpkv/npm", 417, head)
        })
      )
      expect(yield* Ref.get(calls)).toBe(1)
      expect(evidence).toMatchObject({
        checks: [{ head, name: "Types" }],
        expectedHead: head,
        freshUntil: 61_000,
        observedHead: head,
        projectedAt: 1_000,
        reviews: [{ head, id: "review:1", reviewer: "codex" }],
        threads: [{ head, id: "thread:1" }]
      })
      expect(Schema.decodeUnknownResult(PullRequestGateInput)(evidence)._tag).toBe("Success")
    }))

  it.effect("fails stale when the head changes during the atomic observation", () =>
    // @effect-diagnostics-next-line missingEffectContext:off
    Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const result = yield* withSource(
        () => Effect.succeed(observation({ headAtEnd: "b".repeat(40) })),
        Effect.gen(function*() {
          const provider = yield* PullRequestEvidenceProvider
          return yield* Effect.result(provider.exactHeadGateEvidence("knpkv/npm", 417, head))
        })
      )
      expect(result).toMatchObject({
        failure: { _tag: "PullRequestEvidenceStale", expectedHead: head, headAtStart: head }
      })
    }))

  it.effect("rejects missing and duplicate required-check evidence", () =>
    // @effect-diagnostics-next-line missingEffectContext:off
    Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const missing = yield* withSource(
        () => Effect.succeed(observation({ checks: [], requiredChecks: ["Types"] })),
        Effect.gen(function*() {
          const provider = yield* PullRequestEvidenceProvider
          return yield* Effect.result(provider.exactHeadGateEvidence("knpkv/npm", 417, head))
        })
      )
      const duplicate = yield* withSource(
        () => Effect.succeed(observation({ requiredChecks: ["Types", "Types"] })),
        Effect.gen(function*() {
          const provider = yield* PullRequestEvidenceProvider
          return yield* Effect.result(provider.exactHeadGateEvidence("knpkv/npm", 417, head))
        })
      )
      const duplicateThreads = yield* withSource(
        () =>
          Effect.succeed(observation({
            threads: [
              { head, id: "thread:1", outdated: false, resolved: true },
              { head, id: "thread:1", outdated: false, resolved: false }
            ]
          })),
        Effect.gen(function*() {
          const provider = yield* PullRequestEvidenceProvider
          return yield* Effect.result(provider.exactHeadGateEvidence("knpkv/npm", 417, head))
        })
      )
      const duplicateReviews = yield* withSource(
        () =>
          Effect.succeed(observation({
            reviews: [
              { head, id: "review:1", reviewer: "codex", state: "approved", submittedAt: 900 },
              { head, id: "review:1", reviewer: "codex", state: "changes_requested", submittedAt: 1_000 }
            ]
          })),
        Effect.gen(function*() {
          const provider = yield* PullRequestEvidenceProvider
          return yield* Effect.result(provider.exactHeadGateEvidence("knpkv/npm", 417, head))
        })
      )
      expect(missing).toMatchObject({
        failure: { _tag: "PullRequestEvidenceInvalid", detail: "required check evidence is incomplete" }
      })
      expect(duplicate).toMatchObject({
        failure: { _tag: "PullRequestEvidenceInvalid", detail: "required check names are duplicated" }
      })
      expect(duplicateThreads).toMatchObject({
        failure: { _tag: "PullRequestEvidenceInvalid", detail: "thread evidence is duplicated" }
      })
      expect(duplicateReviews).toMatchObject({
        failure: { _tag: "PullRequestEvidenceInvalid", detail: "review evidence is duplicated" }
      })
    }))

  it.effect("rejects source-sensitive evidence observed for another head", () =>
    // @effect-diagnostics-next-line missingEffectContext:off
    Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const staleEvidence = yield* withSource(
        () =>
          Effect.succeed(observation({
            reviews: [{
              head: "b".repeat(40),
              id: "review:1",
              reviewer: "codex",
              state: "approved",
              submittedAt: 1_000
            }]
          })),
        Effect.gen(function*() {
          const provider = yield* PullRequestEvidenceProvider
          return yield* Effect.result(provider.exactHeadGateEvidence("knpkv/npm", 417, head))
        })
      )
      expect(staleEvidence).toMatchObject({
        failure: {
          _tag: "PullRequestEvidenceInvalid",
          detail: "source-sensitive evidence is not bound to the expected head"
        }
      })
    }))

  it("rejects directly decoded gate evidence with mixed heads or incomplete checks", () => {
    const gate = {
      ...observation(),
      expectedHead: head,
      freshUntil: 61_000,
      observedHead: head,
      projectedAt: 1_000
    }
    expect(Schema.decodeUnknownResult(PullRequestGateInput)(gate)._tag).toBe("Success")
    expect(
      Schema.decodeUnknownResult(PullRequestGateInput)({
        ...gate,
        checks: [{ conclusion: "success", head: "b".repeat(40), name: "Types" }]
      })._tag
    ).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(PullRequestGateInput)({
        ...gate,
        requiredChecks: ["Types", "Lint"]
      })._tag
    ).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(PullRequestGateInput)({
        ...gate,
        threads: [
          { head, id: "thread:duplicate", outdated: false, resolved: true },
          { head, id: "thread:duplicate", outdated: false, resolved: false }
        ]
      })._tag
    ).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(PullRequestGateInput)({
        ...gate,
        reviews: [
          { head, id: "review:duplicate", reviewer: "codex", state: "approved", submittedAt: 900 },
          { head, id: "review:duplicate", reviewer: "codex", state: "changes_requested", submittedAt: 1_000 }
        ]
      })._tag
    ).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(PullRequestGateInput)({
        ...gate,
        reviews: [
          { head, id: "review:first", reviewer: "codex", state: "commented", submittedAt: 900 },
          { head, id: "review:second", reviewer: "codex", state: "approved", submittedAt: 1_000 }
        ]
      })._tag
    ).toBe("Success")
  })
})
