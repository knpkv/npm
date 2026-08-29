/**
 * `codecommit pr export` — write a pull request and its comments as markdown.
 *
 * Two loads rather than one, because the command narrates each and a progress
 * line has to precede the request it describes: a failed pull-request fetch must
 * not have already claimed it was fetching comments. Document shape lives in
 * {@link PullRequestMarkdown}, so the format is assertable on its own.
 *
 * @category Command
 * @module
 */
import { AwsClient, type Domain } from "@knpkv/codecommit-core"
import { Console, Context, Effect, Layer, Option } from "effect"
import * as FileSystem from "effect/FileSystem"
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli"
import { makeAccount } from "./CliAccount.js"
import { countComments, type RenderablePullRequest, renderPullRequestMarkdown } from "./PullRequestMarkdown.js"

interface ExportTarget {
  readonly profile: string
  readonly pullRequestId: string
  readonly region: string
  readonly repositoryName: string
}

export interface PrExportServiceContract {
  readonly loadPullRequest: (
    input: ExportTarget
  ) => Effect.Effect<RenderablePullRequest, AwsClient.AwsClientError>
  readonly loadComments: (
    input: ExportTarget
  ) => Effect.Effect<ReadonlyArray<Domain.PRCommentLocation>, AwsClient.AwsClientError>
  /** The commercial-partition console link this export embeds in its header. */
  readonly consoleLink: (input: ExportTarget) => string
}

const make = Effect.gen(function*() {
  const aws = yield* AwsClient.AwsClient

  const loadPullRequest: PrExportServiceContract["loadPullRequest"] = Effect.fn("PrExportService.loadPullRequest")(
    (input) =>
      aws.getPullRequest({
        account: makeAccount(input.profile, input.region),
        pullRequestId: input.pullRequestId
      })
  )

  const loadComments: PrExportServiceContract["loadComments"] = Effect.fn("PrExportService.loadComments")((input) =>
    aws.getCommentsForPullRequest({
      account: makeAccount(input.profile, input.region),
      pullRequestId: input.pullRequestId,
      repositoryName: input.repositoryName
    })
  )

  const consoleLink: PrExportServiceContract["consoleLink"] = (input) =>
    `https://${input.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${input.repositoryName}/pull-requests/${input.pullRequestId}?region=${input.region}`

  return { consoleLink, loadComments, loadPullRequest } satisfies PrExportServiceContract
})

/** @category Service */
export class PrExportService extends Context.Service<PrExportService, PrExportServiceContract>()(
  "@knpkv/codecommit/PrExportService"
) {
  static readonly live: Layer.Layer<PrExportService, never, AwsClient.AwsClient> = Layer.effect(PrExportService, make)
}

/** @category Layer */
export const PrExportLive = PrExportService.live

/** @category Command */
export const prExportCommand = Command.make("export", {
  prId: Args.string("pr-id").pipe(Args.withDescription("Pull request ID")),
  repo: Args.string("repository").pipe(Args.withDescription("Repository name")),
  output: Options.file("output").pipe(
    Options.withAlias("o"),
    Options.withDescription("Output file path"),
    Options.optional
  ),
  profile: Options.string("profile").pipe(
    Options.withAlias("p"),
    Options.withDescription("AWS profile"),
    Options.withDefault("default")
  ),
  region: Options.string("region").pipe(
    Options.withAlias("r"),
    Options.withDescription("AWS region"),
    Options.withDefault("us-east-1")
  )
}, ({ output, prId, profile, region, repo }) =>
  Effect.gen(function*() {
    const service = yield* PrExportService
    const fs = yield* FileSystem.FileSystem
    const target = { profile, pullRequestId: prId, region, repositoryName: repo }

    yield* Console.log(`Fetching PR ${prId}...`)
    const pullRequest = yield* service.loadPullRequest(target)

    yield* Console.log(`Fetching comments...`)
    const locations = yield* service.loadComments(target)

    yield* Console.log(`Found ${countComments(locations)} comment(s) in ${locations.length} location(s)`)

    const markdown = renderPullRequestMarkdown({
      link: service.consoleLink(target),
      locations,
      profile,
      pullRequest,
      repositoryName: repo
    })

    if (Option.isSome(output)) {
      yield* fs.writeFileString(output.value, markdown)
      yield* Console.log(`Saved to ${output.value}`)
    } else {
      yield* Console.log("")
      yield* Console.log(markdown)
    }
  }).pipe(
    // The command owns its service layer. The executable supplies the selected
    // AWS transport so fixture and production calls share one boundary.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(PrExportLive)
  )).pipe(Command.withDescription("Export PR comments as markdown"))
