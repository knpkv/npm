/**
 * `codecommit pr update` — change a pull request's title or description.
 *
 * The two fields update independently, and the command narrates each one as it
 * goes, so the service exposes them as two operations rather than one combined
 * call: the progress line has to precede the request it describes, and a failure
 * has to leave the caller knowing which field it got to.
 *
 * @category Command
 * @module
 */
import { AwsClient } from "@knpkv/codecommit-core"
import { Console, Context, Effect, Layer, Option } from "effect"
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli"
import { makeAccount } from "./CliAccount.js"

interface UpdateTarget {
  readonly profile: string
  readonly pullRequestId: string
  readonly region: string
}

export interface PrUpdateServiceContract {
  readonly setTitle: (
    input: UpdateTarget & { readonly title: string }
  ) => Effect.Effect<void, AwsClient.AwsClientError>
  readonly setDescription: (
    input: UpdateTarget & { readonly description: string }
  ) => Effect.Effect<void, AwsClient.AwsClientError>
}

const make = Effect.gen(function*() {
  const aws = yield* AwsClient.AwsClient

  const setTitle: PrUpdateServiceContract["setTitle"] = (input) =>
    aws.updatePullRequestTitle({
      account: makeAccount(input.profile, input.region),
      pullRequestId: input.pullRequestId,
      title: input.title
    })

  const setDescription: PrUpdateServiceContract["setDescription"] = (input) =>
    aws.updatePullRequestDescription({
      account: makeAccount(input.profile, input.region),
      pullRequestId: input.pullRequestId,
      description: input.description
    })

  return { setDescription, setTitle } satisfies PrUpdateServiceContract
})

/** @category Service */
export class PrUpdateService extends Context.Service<PrUpdateService, PrUpdateServiceContract>()(
  "@knpkv/codecommit/PrUpdateService"
) {
  static readonly live: Layer.Layer<PrUpdateService, never, AwsClient.AwsClient> = Layer.effect(PrUpdateService, make)
}

/** @category Layer */
export const PrUpdateLive = PrUpdateService.live

/** @category Command */
export const prUpdateCommand = Command.make("update", {
  prId: Args.string("pr-id").pipe(Args.withDescription("Pull request ID")),
  title: Options.string("title").pipe(
    Options.withAlias("t"),
    Options.withDescription("New PR title"),
    Options.optional
  ),
  description: Options.string("description").pipe(
    Options.withAlias("d"),
    Options.withDescription("New PR description"),
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
}, ({ description, prId, profile, region, title }) =>
  Effect.gen(function*() {
    const service = yield* PrUpdateService
    const target = { profile, pullRequestId: prId, region }

    if (Option.isNone(title) && Option.isNone(description)) {
      yield* Console.log("Error: At least one of --title or --description must be provided")
      return
    }

    if (Option.isSome(title)) {
      yield* Console.log(`Updating title...`)
      yield* service.setTitle({ ...target, title: title.value })
    }

    if (Option.isSome(description)) {
      yield* Console.log(`Updating description...`)
      yield* service.setDescription({ ...target, description: description.value })
    }

    yield* Console.log(`Updated PR ${prId}`)
  }).pipe(
    // The command owns its service layer. The executable supplies the selected
    // AWS transport so fixture and production calls share one boundary.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(PrUpdateLive)
  )).pipe(Command.withDescription("Update PR title or description"))
