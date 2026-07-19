import { assert, describe, it } from "@effect/vitest"
import { AwsApiError, AwsCredentialError } from "@knpkv/codecommit-core/Errors.js"
import * as CodeCommit from "@knpkv/codecommit-core/ReadClient.js"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { AwsResourceDiscoveryRequest } from "../../src/api/plugins.js"
import { AwsResourceDiscovery, makeAwsResourceDiscovery } from "../../src/server/application/awsResourceDiscovery.js"
import {
  CodePipelineNamePage,
  CodePipelineReadClient,
  type CodePipelineReadClientService
} from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import { PluginAuthorizationFailure } from "../../src/server/plugins/failures.js"

const request = Schema.decodeUnknownSync(AwsResourceDiscoveryRequest)({
  profile: "production",
  region: "eu-west-1"
})

const repositoryPage = (repositoryNames: ReadonlyArray<string>, nextToken: string | null = null) =>
  Schema.decodeUnknownSync(CodeCommit.CodeCommitRepositoryPage)({ repositoryNames, nextToken })

const pipelinePage = (pipelineNames: ReadonlyArray<string>, nextToken: string | null = null) =>
  Schema.decodeUnknownSync(CodePipelineNamePage)({ pipelineNames, nextToken, providerPageLimit: 100 })

const codeCommitClient = (
  overrides: Partial<CodeCommit.CodeCommitReadClientService> = {}
): CodeCommit.CodeCommitReadClientService => ({
  discoverAccount: () =>
    Effect.succeed(
      new CodeCommit.CodeCommitAccountIdentity({
        accountId: "123456789012",
        arn: "arn:aws:sts::123456789012:assumed-role/Developer/alice"
      })
    ),
  getBlob: () => Effect.die("unused"),
  getChangedFilesPage: () => Effect.die("unused"),
  getPullRequest: () => Effect.die("unused"),
  listPullRequestsPage: () => Effect.die("unused"),
  listRepositoriesPage: () => Effect.succeed(repositoryPage([])),
  streamChangedFiles: () => Stream.die("unused"),
  streamPullRequests: () => Stream.die("unused"),
  ...overrides
})

const codePipelineClient = (
  overrides: Partial<CodePipelineReadClientService> = {}
): CodePipelineReadClientService => ({
  discoverAccount: () => Effect.die("unused"),
  getExecutionSnapshot: () => Effect.die("unused"),
  getPipeline: () => Effect.die("unused"),
  listExecutionsPage: () => Effect.die("unused"),
  listPipelinesPage: () => Effect.succeed(pipelinePage([])),
  ...overrides
})

const runDiscovery = <Success, Failure>(
  codeCommit: CodeCommit.CodeCommitReadClientService,
  codePipeline: CodePipelineReadClientService,
  effect: Effect.Effect<Success, Failure, AwsResourceDiscovery>
) =>
  effect.pipe(
    Effect.provide(
      Layer.effect(AwsResourceDiscovery, makeAwsResourceDiscovery()).pipe(
        Layer.provide(Layer.merge(
          Layer.succeed(CodeCommit.CodeCommitReadClient, codeCommit),
          Layer.succeed(CodePipelineReadClient, codePipeline)
        ))
      )
    )
  )

describe("AWS resource discovery", () => {
  it.effect("verifies identity and returns independently decoded resource lists", () =>
    runDiscovery(
      codeCommitClient({ listRepositoriesPage: () => Effect.succeed(repositoryPage(["risk", "payments"])) }),
      codePipelineClient({ listPipelinesPage: () => Effect.succeed(pipelinePage(["deploy", "release"])) }),
      Effect.gen(function*() {
        const discovery = yield* AwsResourceDiscovery
        const result = yield* discovery.discover(request)
        assert.deepStrictEqual(result, {
          accountId: "123456789012",
          codeCommit: { _tag: "available", names: ["payments", "risk"], truncated: false },
          codePipeline: { _tag: "available", names: ["deploy", "release"], truncated: false }
        })
        assert.notProperty(result, "arn")
      })
    ))

  it.effect("represents empty provider accounts without treating them as failures", () =>
    runDiscovery(
      codeCommitClient(),
      codePipelineClient(),
      Effect.gen(function*() {
        const discovery = yield* AwsResourceDiscovery
        const result = yield* discovery.discover(request)
        assert.deepStrictEqual(result.codeCommit, { _tag: "available", names: [], truncated: false })
        assert.deepStrictEqual(result.codePipeline, { _tag: "available", names: [], truncated: false })
      })
    ))

  it.effect("keeps CodePipeline results when CodeCommit permission is denied", () =>
    runDiscovery(
      codeCommitClient({
        listRepositoriesPage: ({ account }) =>
          Effect.fail(
            new AwsApiError({
              operation: "listRepositoriesPage",
              profile: account.profile,
              region: account.region,
              cause: { _tag: "AccessDeniedException", secret: "must-not-cross-api" }
            })
          )
      }),
      codePipelineClient({ listPipelinesPage: () => Effect.succeed(pipelinePage(["release"])) }),
      Effect.gen(function*() {
        const discovery = yield* AwsResourceDiscovery
        const result = yield* discovery.discover(request)
        assert.deepStrictEqual(result.codeCommit, { _tag: "failed", failureClass: "authorization" })
        assert.deepStrictEqual(result.codePipeline, {
          _tag: "available",
          names: ["release"],
          truncated: false
        })
      })
    ))

  it.effect("deduplicates, sorts, and truncates each service at twenty names", () => {
    const names = Array.from({ length: 25 }, (_, index) => `repository-${String(24 - index).padStart(2, "0")}`)
    return runDiscovery(
      codeCommitClient({ listRepositoriesPage: () => Effect.succeed(repositoryPage([...names, names[0] ?? ""])) }),
      codePipelineClient({ listPipelinesPage: () => Effect.succeed(pipelinePage(names)) }),
      Effect.gen(function*() {
        const discovery = yield* AwsResourceDiscovery
        const result = yield* discovery.discover(request)
        assert.strictEqual(result.codeCommit._tag, "available")
        assert.strictEqual(result.codePipeline._tag, "available")
        if (result.codeCommit._tag === "available" && result.codePipeline._tag === "available") {
          assert.lengthOf(result.codeCommit.names, 20)
          assert.lengthOf(result.codePipeline.names, 20)
          assert.isTrue(result.codeCommit.truncated)
          assert.isTrue(result.codePipeline.truncated)
          assert.deepStrictEqual(result.codeCommit.names, [...result.codeCommit.names].sort())
        }
      })
    )
  })

  it.effect("stops repository pagination after five provider pages", () =>
    Effect.gen(function*() {
      const pageCalls = yield* Ref.make(0)
      const commitClient = codeCommitClient({
        listRepositoriesPage: () =>
          Ref.getAndUpdate(pageCalls, (count) => count + 1).pipe(
            Effect.map((count) => repositoryPage([`repository-${count}`], `next-${count}`))
          )
      })
      const result = yield* runDiscovery(
        commitClient,
        codePipelineClient(),
        Effect.gen(function*() {
          const discovery = yield* AwsResourceDiscovery
          return yield* discovery.discover(request)
        })
      )
      assert.strictEqual(yield* Ref.get(pageCalls), 5)
      assert.deepStrictEqual(result.codeCommit, {
        _tag: "available",
        names: ["repository-0", "repository-1", "repository-2", "repository-3", "repository-4"],
        truncated: true
      })
    }))

  it.effect("treats identity failure as terminal before either resource list runs", () =>
    Effect.gen(function*() {
      const listCalls = yield* Ref.make(0)
      const commitClient = codeCommitClient({
        discoverAccount: (account) =>
          Effect.fail(
            new AwsCredentialError({
              profile: account.profile,
              region: account.region,
              cause: { secretAccessKey: "must-not-cross-api" }
            })
          ),
        listRepositoriesPage: () =>
          Ref.update(listCalls, (count) => count + 1).pipe(
            Effect.andThen(Effect.succeed(repositoryPage([])))
          )
      })
      const pipelineClient = codePipelineClient({
        listPipelinesPage: () =>
          Ref.update(listCalls, (count) => count + 1).pipe(
            Effect.andThen(Effect.succeed(pipelinePage([])))
          )
      })
      const result = yield* runDiscovery(
        commitClient,
        pipelineClient,
        Effect.gen(function*() {
          const discovery = yield* AwsResourceDiscovery
          return yield* discovery.discover(request)
        })
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(yield* Ref.get(listCalls), 0)
    }))

  it.effect("redacts a typed CodePipeline permission failure independently", () =>
    runDiscovery(
      codeCommitClient({ listRepositoriesPage: () => Effect.succeed(repositoryPage(["payments"])) }),
      codePipelineClient({
        listPipelinesPage: () => Effect.fail(new PluginAuthorizationFailure({ operation: "list-pipelines" }))
      }),
      Effect.gen(function*() {
        const discovery = yield* AwsResourceDiscovery
        const result = yield* discovery.discover(request)
        assert.deepStrictEqual(result.codeCommit, {
          _tag: "available",
          names: ["payments"],
          truncated: false
        })
        assert.deepStrictEqual(result.codePipeline, { _tag: "failed", failureClass: "authorization" })
      })
    ))
})
