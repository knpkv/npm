import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import * as ChildEnv from "@knpkv/codecommit-core/ChildEnv.js"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { makeCodeCommitGitFixture } from "../src/GitFixture.js"
import { CODECOMMIT_MOCK_REVIEW_MODEL } from "../src/ReviewModelFixture.js"
import { makeGitFixtureScenario } from "../src/Scenario.js"
import { startCodeCommitMock } from "../src/Server.js"

const ReviewCompletion = Schema.Struct({
  choices: Schema.Tuple([
    Schema.Struct({
      message: Schema.Struct({ content: Schema.String })
    })
  ]),
  usage: Schema.Struct({
    prompt_tokens: Schema.Number,
    completion_tokens: Schema.Number,
    total_tokens: Schema.Number
  })
})

const ReviewReport = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  orientation: Schema.Struct({
    cohorts: Schema.Array(
      Schema.Struct({
        layers: Schema.Array(Schema.Struct({ kind: Schema.String }))
      })
    )
  }),
  suggestions: Schema.Tuple([
    Schema.Struct({
      evidence: Schema.Struct({
        path: Schema.String,
        startLine: Schema.Number,
        excerpt: Schema.String
      })
    })
  ])
})

const CleanReviewReport = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  suggestions: Schema.Tuple([])
})

const testRuntimeLayer = Layer.merge(NodeServices.layer, ChildEnv.layerHostEnvironment(process.env))

describe("CodeCommit Git and review fixtures", () => {
  it.effect("moves the advertised source ref with push and reset", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const fixture = yield* makeCodeCommitGitFixture()
        const repeatedFixture = yield* makeCodeCommitGitFixture()
        const scenario = makeGitFixtureScenario(fixture.revisions)
        const mock = yield* startCodeCommitMock(scenario, {
          revisionControl: {
            advance: () => fixture.advance,
            reset: fixture.reset
          }
        })
        const client = Context.get(yield* Layer.build(NodeHttpClient.layerFetch), HttpClient.HttpClient)
        const clonesRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-mock-clones-" })

        const runGit = Effect.fn("CodeCommitGitFixtureTest.runGit")(function*(args: ReadonlyArray<string>) {
          return yield* spawner
            .string(
              ChildProcess.make("git", args, {
                stderr: "pipe",
                stdout: "pipe"
              })
            )
            .pipe(Effect.map((output) => output.trim()))
        })
        const clone = Effect.fn("CodeCommitGitFixtureTest.clone")(function*(name: string) {
          const destination = path.join(clonesRoot, name)
          yield* runGit(["clone", "--quiet", "--no-checkout", "--", fixture.cloneUrl, destination])
          return destination
        })
        const hasObject = Effect.fn("CodeCommitGitFixtureTest.hasObject")(function*(
          repository: string,
          objectId: string
        ) {
          const exitCode = yield* spawner.exitCode(
            ChildProcess.make("git", ["-C", repository, "cat-file", "-e", `${objectId}^{commit}`], {
              stderr: "pipe",
              stdout: "pipe"
            })
          )
          return exitCode === ChildProcessSpawner.ExitCode(0)
        })

        expect(new URL(fixture.cloneUrl).protocol).toBe("file:")
        expect(fixture.revisions.base).toMatch(/^[a-f0-9]{40}$/u)
        expect(fixture.revisions.firstHead).toMatch(/^[a-f0-9]{40}$/u)
        expect(fixture.revisions.secondHead).toMatch(/^[a-f0-9]{40}$/u)
        expect(repeatedFixture.revisions).toEqual(fixture.revisions)

        const beforePush = yield* clone("before-push")
        expect(yield* hasObject(beforePush, fixture.revisions.base)).toBe(true)
        expect(yield* hasObject(beforePush, fixture.revisions.firstHead)).toBe(true)
        expect(yield* hasObject(beforePush, fixture.revisions.secondHead)).toBe(false)
        yield* runGit(["-C", beforePush, "checkout", "--quiet", fixture.revisions.firstHead])
        const brokenFixtureTestExit = yield* spawner.exitCode(
          ChildProcess.make("node", ["--experimental-strip-types", path.join(beforePush, "test", "retry.test.ts")], {
            stderr: "pipe",
            stdout: "pipe"
          })
        )
        expect(brokenFixtureTestExit).not.toBe(ChildProcessSpawner.ExitCode(0))

        const pushed = yield* client.execute(
          HttpClientRequest.post(`${mock.origin}/__mock/push`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ pullRequestId: "17" })
          )
        )
        expect(pushed.status).toBe(200)
        const afterPush = yield* clone("after-push")
        expect(yield* hasObject(afterPush, fixture.revisions.secondHead)).toBe(true)
        expect(yield* runGit(["-C", afterPush, "show", `${fixture.revisions.secondHead}:src/retry.ts`])).toContain(
          "outcomes.set(key, outcome)"
        )
        yield* runGit(["-C", afterPush, "checkout", "--quiet", fixture.revisions.secondHead])
        const fixtureTestExit = yield* spawner.exitCode(
          ChildProcess.make("node", ["--experimental-strip-types", path.join(afterPush, "test", "retry.test.ts")], {
            stderr: "pipe",
            stdout: "pipe"
          })
        )
        expect(fixtureTestExit).toBe(ChildProcessSpawner.ExitCode(0))

        const reset = yield* client.execute(HttpClientRequest.post(`${mock.origin}/__mock/reset`))
        expect(reset.status).toBe(200)
        const afterReset = yield* clone("after-reset")
        expect(yield* hasObject(afterReset, fixture.revisions.firstHead)).toBe(true)
        expect(yield* hasObject(afterReset, fixture.revisions.secondHead)).toBe(false)
        const state = yield* mock.state
        expect(state.activeRevisionByPullRequest["17"]).toBe(0)
      })
    ).pipe(
      // The test runner supplies the complete merged runtime layer.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(testRuntimeLayer)
    ))

  it.effect("keeps Git and provider revisions aligned when a push request is interrupted", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fixture = yield* makeCodeCommitGitFixture()
        const advanced = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const mock = yield* startCodeCommitMock(makeGitFixtureScenario(fixture.revisions), {
          revisionControl: {
            advance: () =>
              fixture.advance.pipe(
                Effect.andThen(Deferred.succeed(advanced, undefined)),
                Effect.andThen(Deferred.await(release))
              ),
            reset: fixture.reset
          }
        })
        const client = Context.get(yield* Layer.build(NodeHttpClient.layerFetch), HttpClient.HttpClient)
        const push = yield* client
          .execute(
            HttpClientRequest.post(`${mock.origin}/__mock/push`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ pullRequestId: "17" })
            )
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(advanced)
        const interruption = yield* Fiber.interrupt(push).pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interruption)

        const state = yield* mock.state
        expect(state.activeRevisionByPullRequest["17"]).toBe(1)
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const advertised = yield* spawner.string(
          ChildProcess.make("git", ["ls-remote", fixture.cloneUrl, "refs/heads/feature/idempotency"], {
            stderr: "pipe",
            stdout: "pipe"
          })
        )
        expect(advertised.trim().split(/\s+/u)[0]).toBe(fixture.revisions.secondHead)
      })
    ).pipe(
      // The test runner supplies the complete merged runtime layer.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(testRuntimeLayer)
    ))

  it.effect("ignores inherited Git control variables when constructing the fixture", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const canary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-mock-git-canary-" })
        yield* spawner.string(
          ChildProcess.make("git", ["init", "--quiet", "--", canary], {
            stderr: "pipe",
            stdout: "pipe"
          })
        )
        const canaryGitDirectory = path.join(canary, ".git")
        const fixture = yield* makeCodeCommitGitFixture().pipe(
          Effect.provideService(ChildEnv.HostEnvironment, {
            variables: {
              ...process.env,
              GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(canary, "objects"),
              GIT_DIR: canaryGitDirectory,
              GIT_INDEX_FILE: path.join(canary, "outside-index"),
              GIT_WORK_TREE: canary
            }
          })
        )

        expect(fixture.revisions.base).toMatch(/^[a-f0-9]{40}$/u)
        expect(yield* fileSystem.exists(path.join(canary, "outside-index"))).toBe(false)
        const canaryRefs = yield* spawner.string(
          ChildProcess.make("git", [`--git-dir=${canaryGitDirectory}`, "show-ref"], {
            stderr: "pipe",
            stdout: "pipe"
          })
        )
        expect(canaryRefs.trim()).toBe("")
      })
    ).pipe(
      // The test runner owns the Node service lifetime.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    ))

  it.effect("returns one schema-v3 review with token usage", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fixture = yield* makeCodeCommitGitFixture()
        const mock = yield* startCodeCommitMock(makeGitFixtureScenario(fixture.revisions), {
          cleanReviewHead: fixture.revisions.secondHead
        })
        const client = Context.get(yield* Layer.build(NodeHttpClient.layerFetch), HttpClient.HttpClient)
        const response = yield* client.execute(
          HttpClientRequest.post(`${mock.origin}/v1/chat/completions`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              model: CODECOMMIT_MOCK_REVIEW_MODEL,
              messages: [
                {
                  role: "user",
                  content: JSON.stringify({
                    context: {
                      operatorRequest: `Compare with ${fixture.revisions.secondHead}.`,
                      subject: { headRevision: fixture.revisions.firstHead }
                    }
                  })
                }
              ]
            })
          )
        )
        expect(response.status).toBe(200)
        const completion = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ReviewCompletion)))
        expect(completion.usage).toEqual({
          prompt_tokens: 128,
          completion_tokens: 64,
          total_tokens: 192
        })
        const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewReport))(
          completion.choices[0].message.content
        )
        expect(report.schemaVersion).toBe(3)
        expect(report.orientation.cohorts[0]?.layers.map(({ kind }) => kind)).toEqual([
          "contract",
          "data-flow",
          "implementation",
          "tests"
        ])
        expect(report.suggestions[0].evidence).toEqual({
          path: "src/retry.ts",
          startLine: 1,
          excerpt: "export const retry = (key: string, run: () => Promise<void>) => run()"
        })

        const cleanResponse = yield* client.execute(
          HttpClientRequest.post(`${mock.origin}/v1/chat/completions`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              model: CODECOMMIT_MOCK_REVIEW_MODEL,
              messages: [
                {
                  role: "user",
                  content: JSON.stringify({
                    context: {
                      operatorRequest: "Review the exact PR head.",
                      subject: { headRevision: fixture.revisions.secondHead }
                    }
                  })
                }
              ]
            })
          )
        )
        const cleanCompletion = yield* cleanResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ReviewCompletion))
        )
        const cleanReport = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CleanReviewReport))(
          cleanCompletion.choices[0].message.content
        )
        expect(cleanReport.suggestions).toEqual([])
      })
    ).pipe(
      // The test runner supplies the complete merged runtime layer.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(testRuntimeLayer)
    ))
})
