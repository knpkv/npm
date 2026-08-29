/**
 * `codecommit pr create` — open a pull request between two branches.
 *
 * The service owns the AWS call and the link it produces and never prints; the
 * command owns the flags, the help text and the printing. That split is what
 * lets the outcome be asserted without capturing stdout.
 *
 * @category Command
 * @module
 */
import { AwsClient } from "@knpkv/codecommit-core"
import { Console, Context, Effect, Layer, Option } from "effect"
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli"
import { makeAccount } from "./CliAccount.js"

/** Where the created pull request lives, once CodeCommit has assigned it an id. */
export interface CreatedPullRequest {
  readonly link: string
  readonly pullRequestId: string
}

export interface PrCreateServiceContract {
  readonly create: (input: {
    readonly description: Option.Option<string>
    readonly destinationReference: string
    readonly profile: string
    readonly region: string
    readonly repositoryName: string
    readonly sourceReference: string
    readonly title: string
  }) => Effect.Effect<CreatedPullRequest, AwsClient.AwsClientError>
}

const make = Effect.gen(function*() {
  const aws = yield* AwsClient.AwsClient

  const create: PrCreateServiceContract["create"] = (input) =>
    aws.createPullRequest({
      account: makeAccount(input.profile, input.region),
      repositoryName: input.repositoryName,
      title: input.title,
      ...(Option.isSome(input.description) && { description: input.description.value }),
      sourceReference: input.sourceReference,
      destinationReference: input.destinationReference
    }).pipe(
      Effect.map((pullRequestId) => ({
        pullRequestId,
        link:
          `https://${input.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${input.repositoryName}/pull-requests/${pullRequestId}?region=${input.region}`
      }))
    )

  return { create } satisfies PrCreateServiceContract
})

/** @category Service */
export class PrCreateService extends Context.Service<PrCreateService, PrCreateServiceContract>()(
  "@knpkv/codecommit/PrCreateService"
) {
  static readonly live: Layer.Layer<PrCreateService, never, AwsClient.AwsClient> = Layer.effect(PrCreateService, make)
}

/** @category Layer */
export const PrCreateLive = PrCreateService.live

/** @category Command */
export const prCreateCommand = Command.make("create", {
  repo: Args.string("repository").pipe(Args.withDescription("Repository name")),
  title: Args.string("title").pipe(Args.withDescription("PR title")),
  source: Options.string("source").pipe(
    Options.withAlias("s"),
    Options.withDescription("Source branch")
  ),
  destination: Options.string("destination").pipe(
    Options.withAlias("d"),
    Options.withDescription("Destination branch"),
    Options.withDefault("main")
  ),
  description: Options.string("description").pipe(
    Options.withDescription("PR description"),
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
}, ({ description, destination, profile, region, repo, source, title }) =>
  Effect.gen(function*() {
    const service = yield* PrCreateService
    yield* Console.log(`Creating PR: ${source} -> ${destination} in ${repo}`)

    const created = yield* service.create({
      description,
      destinationReference: destination,
      profile,
      region,
      repositoryName: repo,
      sourceReference: source,
      title
    })

    yield* Console.log(`Created PR: ${created.pullRequestId}`)
    yield* Console.log(created.link)
  }).pipe(
    // The command owns its service layer. The executable supplies the selected
    // AWS transport so fixture and production calls share one boundary.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(PrCreateLive)
  )).pipe(Command.withDescription("Create a pull request"))
