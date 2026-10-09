/**
 * Child process for CodeCommit web's Relay crash test. It runs the real mount: the codecommit capabilities,
 * the comment poster, and the Relay store under a throwaway HOME. Only AWS and the model are fakes.
 * `run` confirms a comment and dies inside the post (the parent sends SIGKILL). `resume` reopens the
 * store and prints once the interrupted run has settled.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { CacheService, ConfigService, Domain, PRService, ReadClient, ReviewClient } from "@knpkv/codecommit-core"
import { ObjectRef } from "@knpkv/relay"
import { ConfigProvider, Console, Effect, FileSystem, Layer, Option, Schedule, Schema, Stdio, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import { commentPosterLayer, RelayMount, relayMountLayerWith } from "../../src/server/relay/RelayMount.ts"
import { RelayFindingPublisher } from "../../src/server/review/RelayFindingPublisher.ts"

const Arguments = Schema.Tuple([Schema.Literals(["run", "resume"]), Schema.String, Schema.String])

const coordinates = { accountId: "111122223333", region: "eu-west-1", repositoryName: "payments", pullRequestId: "42" }
const pr = ObjectRef.make({ product: "codecommit", kind: "pull-request", id: "111122223333/eu-west-1/payments/42" })

const pullRequest = new Domain.PullRequest({
  account: new Domain.Account({
    profile: Domain.AwsProfileName.make("production"),
    region: Domain.AwsRegion.make("eu-west-1"),
    awsAccountId: "111122223333"
  }),
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "reviewer",
  commentedBy: [],
  creationDate: new Date(0),
  destinationBranch: "main",
  id: Domain.PullRequestId.make("42"),
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: new Date(1_000),
  link: "https://example.invalid/pr/42",
  repositoryName: Domain.RepositoryName.make("payments"),
  sourceBranch: "feature",
  status: "OPEN",
  title: "Review"
})

const revision = new ReadClient.CodeCommitPullRequestRevision({
  authorArn: null,
  creationDate: new Date(0),
  destinationCommit: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
  destinationReference: "refs/heads/main",
  lastActivityDate: new Date(1_000),
  mergeBase: null,
  pullRequestId: pullRequest.id,
  repositoryName: pullRequest.repositoryName,
  revisionId: "revision-1",
  sourceCommit: ReadClient.CodeCommitCommitId.make("b".repeat(40)),
  sourceReference: "refs/heads/feature",
  status: "OPEN",
  title: pullRequest.title
})

/** Calls post_comment once, then answers from whatever result the interrupted call left. */
const model = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: (request) =>
      Effect.sync(() => {
        const settled = /TOOL (RESULT|ERROR) post_comment \(/u.test(JSON.stringify(request.prompt.content))
        const turn = settled
          ? { reply: "The comment may not have been posted; I did not repost it.", toolCalls: [] }
          : {
            reply: "",
            toolCalls: [{ name: "post_comment", arguments: { pullRequest: coordinates, content: "LGTM" } }]
          }
        const part: Response.TextPartEncoded = { type: "text", text: JSON.stringify(turn) }
        return [part]
      }),
    streamText: () => Stream.die("not used")
  })
)

const services = (markerPath: string) =>
  Layer.mergeAll(
    Layer.mock(CacheService.PullRequestRepo, {
      findByCoordinates: () =>
        Effect.succeed(Option.some(Schema.encodeSync(PRService.CachedPRToPullRequest)(pullRequest)))
    }),
    Layer.mock(ConfigService.ConfigService, {}),
    Layer.mock(ReadClient.CodeCommitReadClient, { getPullRequest: () => Effect.succeed(revision) }),
    Layer.effect(
      RelayFindingPublisher,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return {
          post: (action) =>
            fs.writeFileString(markerPath, `posted ${action.content}\n`, { flag: "a" }).pipe(
              // The parent kills this process here, after the provider accepted the comment.
              Effect.andThen(Effect.sleep("30 seconds")),
              Effect.as(new ReviewClient.CodeCommitReviewReceipt({ operationId: "comment:1", summary: "posted" })),
              Effect.orDie
            )
        }
      })
    )
  )

const program = (phase: "run" | "resume") =>
  Effect.gen(function*() {
    const mount = yield* RelayMount
    const relay = yield* mount.harness
    if (phase === "run") {
      yield* Effect.forkChild(Stream.runDrain(
        relay.events(pr).pipe(
          Stream.tap((event) =>
            event._tag === "ConfirmationRequired" ? Effect.orDie(relay.decide(pr, event.call, true)) : Effect.void
          ),
          Stream.tap((event) => Console.log(JSON.stringify(event)))
        )
      ))
      yield* Effect.sleep("200 millis")
      yield* relay.send(pr, "Say LGTM on this pull request", "req-crash")
      return yield* Effect.never
    }
    const answered = relay.events(pr).pipe(
      Stream.take(1),
      Stream.runHead,
      Effect.map((head) =>
        head._tag === "Some" && head.value._tag === "Snapshot" &&
        head.value.messages.some((message) => message.role === "relay" && message.text.includes("not have been posted"))
      )
    )
    yield* answered.pipe(
      Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("200 millis") }),
      Effect.timeout("15 seconds")
    )
    yield* Console.log("RESUMED_AND_ANSWERED")
  })

const main = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const [phase, home, markerPath] = yield* Schema.decodeUnknownEffect(Arguments)(yield* stdio.args)
  const mount = relayMountLayerWith(() =>
    Effect.succeed([{
      id: "claude-code",
      name: "Claude Code",
      model,
      probe: Effect.succeed("test"),
      signInFix: "Sign in."
    }])
  ).pipe(
    Layer.provide(commentPosterLayer),
    Layer.provide(services(markerPath)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })))
  )
  const context = yield* Layer.build(mount)
  return yield* Effect.provide(program(phase), context)
})

NodeRuntime.runMain(Effect.scoped(main).pipe(Effect.provide(NodeServices.layer)))
