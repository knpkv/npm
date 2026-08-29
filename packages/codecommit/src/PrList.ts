/**
 * `codecommit pr list` — two ways of finding pull requests behind one command.
 *
 * Without `--filter` the command lists one account. With it, the named preset
 * fans out across every enabled account and the single-account flags stop
 * meaning anything. Those are different queries, so the service exposes them as
 * two operations and the command chooses; both hand back plain arrays and print
 * nothing, so the list format lives in {@link PrListOutput}.
 *
 * @category Command
 * @module
 */
import { NodeHttpClient } from "@effect/platform-node"
import { AwsClient, CacheService, ConfigService, type Domain } from "@knpkv/codecommit-core"
import { Console, Context, Effect, Layer, type Option, Stream } from "effect"
import { Command, Flag as Options } from "effect/unstable/cli"
import { makeAccount } from "./CliAccount.js"
import { FILTER_PRESETS, type FilterPreset, matchesRepoAuthor } from "./filterPresets.js"
import { type FilterCollectError, FilterService, FilterServiceLive, type FilterTarget } from "./FilterService.js"
import { accountSuffix, renderPullRequestEntry, statusPrefix } from "./PrListOutput.js"

const DEFAULT_PR_STATUS: "OPEN" = "OPEN"

/** What a cross-account preset scan found, and which accounts could not answer. */
export interface PresetListing {
  readonly failures: ReadonlyArray<string>
  readonly prs: ReadonlyArray<Domain.PullRequest>
  readonly unresolvedProfiles: ReadonlyArray<string>
}

export interface PrListServiceContract {
  /** Lists one account, newest first when both statuses are requested. */
  readonly listAccount: (input: {
    readonly all: boolean
    readonly author: Option.Option<string>
    readonly profile: string
    readonly region: string
    readonly repo: Option.Option<string>
    readonly status: "OPEN" | "CLOSED"
  }) => Effect.Effect<ReadonlyArray<Domain.PullRequest>, AwsClient.AwsClientError>

  /**
   * The enabled accounts a preset would scan.
   *
   * Separate from {@link PrListServiceContract.listPreset} because the command
   * announces how many accounts it is about to scan, and that line has to
   * precede the scan it describes rather than report it afterwards.
   */
  readonly resolveTargets: Effect.Effect<ReadonlyArray<FilterTarget>>

  /** Fans a named preset out across the given accounts. */
  readonly listPreset: (input: {
    readonly author: Option.Option<string>
    readonly preset: FilterPreset
    readonly repo: Option.Option<string>
    readonly targets: ReadonlyArray<FilterTarget>
  }) => Effect.Effect<PresetListing, FilterCollectError>
}

const make = Effect.gen(function*() {
  const aws = yield* AwsClient.AwsClient
  const filterService = yield* FilterService

  const collectMatching = (
    prStream: Stream.Stream<Domain.PullRequest, AwsClient.AwsClientError>,
    repo: Option.Option<string>,
    author: Option.Option<string>
  ) =>
    prStream.pipe(
      Stream.filter((pr) => matchesRepoAuthor(pr, repo, author)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk))
    )

  const listAccount: PrListServiceContract["listAccount"] = Effect.fn("PrListService.listAccount")(
    function*(input) {
      const account = makeAccount(input.profile, input.region)
      if (!input.all) {
        return yield* collectMatching(
          aws.getPullRequests(account, { status: input.status }),
          input.repo,
          input.author
        )
      }

      const [openPrs, closedPrs] = yield* Effect.all([
        collectMatching(aws.getPullRequests(account, { status: "OPEN" }), input.repo, input.author),
        collectMatching(aws.getPullRequests(account, { status: "CLOSED" }), input.repo, input.author)
      ])
      return [...openPrs, ...closedPrs].sort((a, b) => b.lastModifiedDate.getTime() - a.lastModifiedDate.getTime())
    }
  )

  const resolveTargets: PrListServiceContract["resolveTargets"] = filterService.resolveTargets.pipe(Effect.orDie)

  const listPreset: PrListServiceContract["listPreset"] = (input) =>
    filterService.collect(input.preset, input.targets, {
      repo: input.repo,
      author: input.author
    })

  return { listAccount, listPreset, resolveTargets } satisfies PrListServiceContract
})

/** @category Service */
export class PrListService extends Context.Service<PrListService, PrListServiceContract>()(
  "@knpkv/codecommit/PrListService"
) {
  static readonly live: Layer.Layer<PrListService, never, AwsClient.AwsClient | FilterService> = Layer.effect(
    PrListService,
    make
  )
}

/**
 * @category Layer
 *
 * FilterService draws AwsClient/ConfigService from the base layers, which are
 * also merged into the output so the single-account path keeps them.
 */
export const PrListLive = PrListService.live.pipe(
  Layer.provide(
    FilterServiceLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          AwsClient.AwsClientLive,
          ConfigService.ConfigServiceLive.pipe(Layer.provide(CacheService.EventsHub.Default))
        ).pipe(Layer.provideMerge(NodeHttpClient.layerFetch))
      )
    )
  )
)

/** @category Command */
export const prListCommand = Command.make("list", {
  profile: Options.string("profile").pipe(
    Options.withAlias("p"),
    Options.withDescription("AWS profile (ignored when --filter is set — presets fan out across all enabled accounts)"),
    Options.withDefault("default")
  ),
  region: Options.string("region").pipe(
    Options.withAlias("r"),
    Options.withDescription("AWS region (ignored when --filter is set — presets fan out across all enabled accounts)"),
    Options.withDefault("us-east-1")
  ),
  status: Options.choice("status", ["OPEN", "CLOSED"]).pipe(
    Options.withAlias("s"),
    Options.withDescription("Filter by PR status (ignored when --filter is set — presets are OPEN-only)"),
    Options.withDefault(DEFAULT_PR_STATUS)
  ),
  all: Options.boolean("all").pipe(
    Options.withAlias("a"),
    Options.withDescription(
      "Show all PRs (both OPEN and CLOSED; ignored when --filter is set — presets are OPEN-only)"
    ),
    Options.withDefault(false)
  ),
  repo: Options.string("repo").pipe(
    Options.withDescription("Filter by repository name"),
    Options.optional
  ),
  author: Options.string("author").pipe(
    Options.withDescription("Filter by author"),
    Options.optional
  ),
  filter: Options.choice("filter", FILTER_PRESETS).pipe(
    Options.withDescription(
      "Named preset (fans out across all enabled accounts, OPEN PRs only — ignores --status/--all): " +
        "mine | needs-my-review | stale | conflicting"
    ),
    Options.optional
  ),
  json: Options.boolean("json").pipe(
    Options.withDescription("Output as JSON"),
    Options.withDefault(false)
  )
}, ({ all, author, filter, json, profile, region, repo, status }) =>
  Effect.gen(function*() {
    const service = yield* PrListService

    // ── Filter-preset path: fan out across all enabled accounts ──────────────
    if (filter._tag === "Some") {
      const preset = filter.value
      const targets = yield* service.resolveTargets

      if (targets.length === 0) {
        yield* Console.log("No enabled accounts in ~/.codecommit/config.json. Enable some with `codecommit tui`.")
        return
      }

      // Progress/status text goes to stderr so `--json` emits only the JSON document on stdout.
      if (!json) yield* Console.error(`Scanning ${targets.length} account(s) with filter '${preset}'...`)

      const listing = yield* service.listPreset({ author, preset, repo, targets })

      // Warn (on stderr, so `--json` stdout stays clean) when caller identity
      // couldn't be resolved for an identity-comparing preset — those accounts'
      // results may be incomplete because no PR can match an unknown "me".
      const reportWarnings = Effect.gen(function*() {
        for (const p of listing.unresolvedProfiles) {
          yield* Console.error(
            `⚠ could not resolve caller identity for profile ${p}; '${preset}' results for it may be incomplete`
          )
        }
        if (listing.failures.length > 0) {
          yield* Console.error(`\n⚠ ${listing.failures.length} account(s) failed:`)
          for (const f of listing.failures) yield* Console.error(`  ${f}`)
        }
      })

      if (listing.prs.length === 0) {
        if (json) yield* Console.log("[]")
        else yield* Console.error(`No PRs match filter '${preset}'.`)
        yield* reportWarnings
        return
      }

      if (json) {
        yield* Console.log(JSON.stringify(listing.prs, null, 2))
      } else {
        yield* Console.log(`\nFound ${listing.prs.length} PR(s) matching filter '${preset}':\n`)
        for (const pr of listing.prs) {
          for (const line of renderPullRequestEntry(pr, { suffix: accountSuffix(pr) })) {
            yield* Console.log(line)
          }
        }
      }
      yield* reportWarnings
      return
    }

    // ── Single-account path (original behaviour) ─────────────────────────────
    const statusLabel = all ? "all" : status.toLowerCase()
    yield* Console.log(`Fetching ${statusLabel} PRs...`)

    const prs = yield* service.listAccount({ all, author, profile, region, repo, status })

    if (prs.length === 0) {
      yield* Console.log(`No ${statusLabel} PRs found.`)
      return
    }

    if (json) {
      yield* Console.log(JSON.stringify(prs, null, 2))
    } else {
      yield* Console.log(`\nFound ${prs.length} ${statusLabel} PR(s):\n`)
      for (const pr of prs) {
        for (const line of renderPullRequestEntry(pr, { prefix: statusPrefix(pr, all) })) {
          yield* Console.log(line)
        }
      }
    }
  }).pipe(
    // Each subcommand is its own entry point: exactly one runs per process, and
    // it owns the layers it needs. Hoisting them into `bin.ts` would build the
    // AWS and config stacks for every invocation, including `codecommit tui`.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(PrListLive)
  )).pipe(
    Command.withDescription("List pull requests (use --filter for cross-account presets)")
  )
