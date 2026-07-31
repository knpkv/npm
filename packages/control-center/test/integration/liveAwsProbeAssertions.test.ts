import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"

import {
  assertLiveAwsProbe,
  findValueInBoundedPages,
  isExactLiveAwsFixtureDiff,
  isSuccessfulExecutionForPipelineVersion,
  matchesLiveAwsPipelineDefinition,
  resourceExistsInBoundedPages,
  sanitizeLiveAwsProbe
} from "./liveAwsProbeAssertions.js"

const renderFailure = (action: () => void): string => {
  try {
    action()
  } catch (failure) {
    return [
      String(failure),
      JSON.stringify(failure),
      Predicate.isError(failure) ? failure.stack : ""
    ].join("\n")
  }
  assert.fail("expected the live AWS assertion to fail")
}

describe("live AWS probe assertions", () => {
  it("does not render identity operands on mismatch", () => {
    const expectedAccount: string = "111122223333"
    const observedAccount: string = "999988887777"
    const rendered = renderFailure(() =>
      assertLiveAwsProbe(
        observedAccount === expectedAccount,
        "codecommit-account-mismatch"
      )
    )

    assert.include(rendered, "codecommit-account-mismatch")
    assert.notInclude(rendered, expectedAccount)
    assert.notInclude(rendered, observedAccount)
  })

  it("does not render configured or discovered resources on mismatch", () => {
    const configuredRepository = "fixture-repository"
    const discoveredRepositories = ["customer-records", "payroll-private"]
    const rendered = renderFailure(() =>
      assertLiveAwsProbe(
        discoveredRepositories.includes(configuredRepository),
        "codecommit-repository-missing"
      )
    )

    assert.include(rendered, "codecommit-repository-missing")
    assert.notInclude(rendered, configuredRepository)
    for (const repository of discoveredRepositories) {
      assert.notInclude(rendered, repository)
    }
  })

  it.effect("discards CodeCommit and CodePipeline provider causes", () =>
    Effect.gen(function*() {
      const sentinels = [
        "999988887777",
        "arn:aws:sts::999988887777:assumed-role/private/session",
        "customer-records",
        "payroll-deployment",
        "raw-provider-request",
        "raw-provider-response"
      ]
      for (
        const providerFailure of [
          {
            _tag: "AwsApiError",
            cause: {
              account: sentinels[0],
              arn: sentinels[1],
              repository: sentinels[2],
              request: sentinels[4],
              response: sentinels[5]
            }
          },
          {
            _tag: "PluginOutageFailure",
            cause: {
              account: sentinels[0],
              arn: sentinels[1],
              pipeline: sentinels[3],
              request: sentinels[4],
              response: sentinels[5]
            }
          }
        ]
      ) {
        const cases = [
          {
            providerEffect: Effect.fail(providerFailure),
            expectedFailureKind: providerFailure._tag === "AwsApiError"
              ? "unknown"
              : "PluginOutageFailure",
            expectedDiagnosticCode: "not-applicable"
          },
          {
            providerEffect: Effect.die(providerFailure),
            expectedFailureKind: "defect",
            expectedDiagnosticCode: "not-applicable"
          }
        ] satisfies ReadonlyArray<{
          readonly providerEffect: Effect.Effect<never, unknown>
          readonly expectedFailureKind: "PluginOutageFailure" | "defect" | "unknown"
          readonly expectedDiagnosticCode: "not-applicable"
        }>
        for (
          const {
            expectedDiagnosticCode,
            expectedFailureKind,
            providerEffect
          } of cases
        ) {
          const result = yield* sanitizeLiveAwsProbe(
            providerEffect,
            "codecommit-list-repositories"
          ).pipe(
            Effect.result
          )
          assert.isTrue(Result.isFailure(result))
          if (Result.isSuccess(result)) continue
          const rendered = [
            String(result.failure),
            JSON.stringify(result.failure),
            Predicate.isError(result.failure) ? result.failure.stack : "",
            Predicate.isError(result.failure) ? String(result.failure.cause) : ""
          ].join("\n")
          assert.include(rendered, "live-aws-provider-probe-failed")
          assert.include(rendered, "codecommit-list-repositories")
          assert.include(rendered, expectedFailureKind)
          assert.include(rendered, expectedDiagnosticCode)
          for (const sentinel of sentinels) assert.notInclude(rendered, sentinel)
        }
      }
    }))

  it.effect("preserves interruption instead of converting it to a provider failure", () =>
    Effect.gen(function*() {
      const exit = yield* sanitizeLiveAwsProbe(
        Effect.interrupt,
        "codepipeline-get-state"
      ).pipe(Effect.exit)
      assert.isTrue(Exit.hasInterrupts(exit))
    }))

  it.effect("reports only allowlisted provider diagnostic codes", () =>
    Effect.gen(function*() {
      const privateDiagnostic = "customer-pipeline-schema-failure"
      const cases = [
        {
          diagnosticCode: "codepipeline-distilled-response-invalid",
          expected: "codepipeline-distilled-response-invalid"
        },
        {
          diagnosticCode: privateDiagnostic,
          expected: "redacted"
        }
      ] satisfies ReadonlyArray<{
        readonly diagnosticCode: string
        readonly expected: "codepipeline-distilled-response-invalid" | "redacted"
      }>
      for (const testCase of cases) {
        const result = yield* sanitizeLiveAwsProbe(
          Effect.fail({
            _tag: "PluginMalformedResponseFailure",
            operation: "codepipeline-get-state",
            diagnosticCode: testCase.diagnosticCode
          }),
          "codepipeline-get-state"
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isSuccess(result)) continue
        assert.strictEqual(result.failure.providerFailureKind, "PluginMalformedResponseFailure")
        assert.strictEqual(result.failure.providerDiagnosticCode, testCase.expected)
        assert.notInclude(JSON.stringify(result.failure), privateDiagnostic)
      }
    }))

  it("preserves first-party assertion diagnostics outside provider sanitization", () => {
    const rendered = renderFailure(() =>
      Effect.runSync(
        sanitizeLiveAwsProbe(
          Effect.succeed(false),
          "codepipeline-get-pipeline"
        ).pipe(
          Effect.map((matches) => assertLiveAwsProbe(matches, "codepipeline-definition-mismatch"))
        )
      )
    )
    assert.include(rendered, "codepipeline-definition-mismatch")
    assert.notInclude(rendered, "live-aws-provider-probe-failed")
  })

  it("attests the exact fixture pipeline source and approval definition", () => {
    const fixture = {
      stages: [
        {
          name: "Source",
          actions: [{
            name: "ReadFixture",
            actionType: {
              category: "Source",
              owner: "AWS",
              provider: "CodeCommit",
              version: "1"
            },
            codeCommitSource: {
              repositoryName: "fixture-repository",
              branchName: "main",
              pollForSourceChanges: false
            }
          }]
        },
        {
          name: "Approval",
          actions: [{
            name: "ConfirmFixture",
            actionType: {
              category: "Approval",
              owner: "AWS",
              provider: "Manual",
              version: "1"
            },
            codeCommitSource: null
          }]
        }
      ]
    }
    assert.isTrue(matchesLiveAwsPipelineDefinition(fixture, "fixture-repository"))

    const invalidFixtures = [
      {
        ...fixture,
        stages: fixture.stages.map((stage) =>
          stage.name !== "Source"
            ? stage
            : {
              ...stage,
              actions: stage.actions.map((action) => ({
                ...action,
                codeCommitSource: action.codeCommitSource === null
                  ? null
                  : { ...action.codeCommitSource, repositoryName: "foreign-repository" }
              }))
            }
        )
      },
      {
        ...fixture,
        stages: fixture.stages.map((stage) =>
          stage.name !== "Source"
            ? stage
            : {
              ...stage,
              actions: stage.actions.map((action) => ({
                ...action,
                codeCommitSource: action.codeCommitSource === null
                  ? null
                  : { ...action.codeCommitSource, branchName: "release" }
              }))
            }
        )
      },
      {
        ...fixture,
        stages: fixture.stages.map((stage) =>
          stage.name !== "Source"
            ? stage
            : {
              ...stage,
              actions: stage.actions.map((action) => ({
                ...action,
                codeCommitSource: action.codeCommitSource === null
                  ? null
                  : { ...action.codeCommitSource, pollForSourceChanges: true }
              }))
            }
        )
      }
    ]
    for (const invalidFixture of invalidFixtures) {
      assert.isFalse(matchesLiveAwsPipelineDefinition(invalidFixture, "fixture-repository"))
    }
  })

  it.effect("finds a pull request on the first or a later bounded page", () =>
    Effect.gen(function*() {
      const requestedTokens: Array<string | null> = []
      const match = yield* findValueInBoundedPages({
        maximumPages: 5,
        listPage: (nextToken) => {
          requestedTokens.push(nextToken)
          return Effect.succeed(
            nextToken === null
              ? {
                values: [{ source: "unrelated", destination: "main" }],
                nextToken: "page-2"
              }
              : {
                values: [{ source: "fixture-change", destination: "main" }],
                nextToken: null
              }
          )
        },
        matches: ({ destination, source }) => source === "fixture-change" && destination === "main"
      })
      assert.deepEqual(match, { source: "fixture-change", destination: "main" })
      assert.deepEqual(requestedTokens, [null, "page-2"])
    }))

  it("rejects an exact first diff page when a continuation page remains", () => {
    const fixturePage = {
      files: [{ after: { path: "fixture.txt" } }],
      nextToken: null
    }
    assert.isTrue(isExactLiveAwsFixtureDiff(fixturePage))
    assert.isFalse(
      isExactLiveAwsFixtureDiff({
        ...fixturePage,
        nextToken: "hidden-drift"
      })
    )
  })

  it("accepts successful execution evidence only for the current pipeline version", () => {
    assert.isTrue(
      isSuccessfulExecutionForPipelineVersion(
        { pipelineVersion: 7, status: "Succeeded" },
        7
      )
    )
    assert.isFalse(
      isSuccessfulExecutionForPipelineVersion(
        { pipelineVersion: 6, status: "Succeeded" },
        7
      )
    )
    assert.isFalse(
      isSuccessfulExecutionForPipelineVersion(
        { pipelineVersion: 7, status: "Failed" },
        7
      )
    )
  })

  it.effect("finds a configured resource on the first or a later bounded page", () =>
    Effect.gen(function*() {
      const firstPage = yield* resourceExistsInBoundedPages({
        expectedName: "fixture",
        maximumPages: 5,
        listPage: () =>
          Effect.succeed({
            names: ["fixture"],
            nextToken: "unused"
          })
      })
      assert.isTrue(firstPage)

      const requestedTokens: Array<string | null> = []
      const laterPage = yield* resourceExistsInBoundedPages({
        expectedName: "fixture",
        maximumPages: 5,
        listPage: (nextToken) => {
          requestedTokens.push(nextToken)
          return Effect.succeed(
            nextToken === null
              ? { names: ["other"], nextToken: "page-2" }
              : { names: ["fixture"], nextToken: null }
          )
        }
      })
      assert.isTrue(laterPage)
      assert.deepEqual(requestedTokens, [null, "page-2"])
    }))

  it.effect("stops after the configured discovery bound", () =>
    Effect.gen(function*() {
      let requestedPages = 0
      const found = yield* resourceExistsInBoundedPages({
        expectedName: "fixture",
        maximumPages: 5,
        listPage: () => {
          requestedPages += 1
          return Effect.succeed({
            names: ["other"],
            nextToken: `page-${requestedPages + 1}`
          })
        }
      })
      assert.isFalse(found)
      assert.strictEqual(requestedPages, 5)
    }))
})
