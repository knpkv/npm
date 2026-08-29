/**
 * `codecommit pr open` — open the console page for the branch checked out here.
 *
 * The caller is a keypress rather than a person reading a list: a Herdr space
 * holds one worktree, and the question is which console page belongs to it. So
 * every failure has to arrive as one sentence, which is why the service answers
 * with tagged errors and the command turns each into a line rather than letting
 * a Cause reach the popup.
 *
 * The remote names the repository (and usually the region), never the AWS
 * profile. The profile is therefore not guessed: the enabled accounts are
 * scanned and the account that actually holds the matching PR is the answer.
 * Region for the console link comes from that same PR, not from the remote,
 * which keeps the link correct when a repository name exists in more than one
 * region.
 *
 * @category Command
 * @module
 */
import { type Domain } from "@knpkv/codecommit-core"
import { Console, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { Command, Flag as Options } from "effect/unstable/cli"
import { reportFailure } from "./CliFailure.js"
import {
  type CodeCommitRemote,
  NotACodeCommitRemote,
  parseCodeCommitRemote,
  redactRemoteUserInfo
} from "./CodeCommitRemote.js"
import { type FilterCollectError, FilterService, FilterServiceLive, type FilterTarget } from "./FilterService.js"
import { type GitContextError, GitContextService } from "./GitContextService.js"
import { matchOpenPullRequest, NoOpenPullRequest } from "./OpenPullRequest.js"
import { TuiTerminalSession } from "./tui/atoms/applicationScope.js"
import { codecommitPullRequestConsoleUrl, UnsupportedConsoleRegion } from "./tui/browser-command.js"
import { openAssumeConsole } from "./tui/console-launch.js"

/** The config file exists but no longer decodes — usually a hand edit. */
export class ConfigUnreadable extends Schema.TaggedError<ConfigUnreadable>()(
  "ConfigUnreadable",
  { message: Schema.String }
) {}

/** Nothing is enabled, so the scan would have looked at nothing. */
export class NoEnabledAccounts extends Schema.TaggedError<NoEnabledAccounts>()(
  "NoEnabledAccounts",
  { message: Schema.String }
) {}

/** Accounts are enabled, but none in the region the remote names. */
export class NoAccountForRegion extends Schema.TaggedError<NoAccountForRegion>()(
  "NoAccountForRegion",
  { region: Schema.String, message: Schema.String }
) {}

/** The working directory, resolved as far as "which accounts are worth scanning". */
export interface OpenScanPlan {
  readonly branch: string
  readonly remote: CodeCommitRemote
  readonly targets: ReadonlyArray<FilterTarget>
}

export interface PrOpenServiceContract {
  /**
   * Reads the working directory and narrows the accounts worth scanning.
   *
   * Stops short of the scan because the command announces it — several seconds
   * of silence in a popup reads as a hang — and that line has to name a target
   * count it does not yet have.
   */
  readonly plan: (input: {
    readonly cwd: string
    readonly remote: string
  }) => Effect.Effect<
    OpenScanPlan,
    ConfigUnreadable | NoAccountForRegion | NoEnabledAccounts | NotACodeCommitRemote | GitContextError
  >

  /** Scans the planned accounts for open PRs in that repository. */
  readonly scan: (plan: OpenScanPlan) => Effect.Effect<{
    readonly failures: ReadonlyArray<string>
    readonly prs: ReadonlyArray<Domain.PullRequest>
  }, FilterCollectError>
}

const make = Effect.gen(function*() {
  const gitContext = yield* GitContextService
  const filterService = yield* FilterService

  const plan: PrOpenServiceContract["plan"] = Effect.fn("PrOpenService.plan")(function*(input) {
    const context = yield* gitContext.resolve(input)
    const remote = parseCodeCommitRemote(context.remoteUrl)
    if (remote === null) {
      // Redacted on both fields: `message` reaches stderr and the popup, and
      // `remoteUrl` is on a Schema error that anything downstream may render.
      const shown = redactRemoteUserInfo(context.remoteUrl)
      return yield* new NotACodeCommitRemote({
        remoteUrl: shown,
        message: `'${input.remote}' is not a CodeCommit remote: ${shown}`
      })
    }

    // A hand-edited config that no longer decodes is a realistic failure, and
    // dying on it would render a Cause in the popup — the one shape this command
    // is written to avoid.
    const allTargets = yield* filterService.resolveTargets.pipe(
      Effect.catch((error) =>
        new ConfigUnreadable({
          message: `Unable to read ~/.codecommit/config.json: ${
            Predicate.isError(error) ? error.message : String(error)
          }`
        })
      )
    )

    // An empty scan is not "no PR": nothing was looked at. Reporting it as an
    // absent pull request sends the user to CodeCommit when the answer is in
    // their config.
    if (allTargets.length === 0) {
      return yield* new NoEnabledAccounts({
        message: "No enabled accounts in ~/.codecommit/config.json. Enable some with `codecommit tui`."
      })
    }

    // The remote's region, when it names one, is part of the repository's identity:
    // a same-named repository in another region is a different repository, and
    // skipping those accounts also spends fewer API calls per keypress.
    const targets = remote.region === null
      ? allTargets
      : allTargets.filter((target) => target.region === remote.region)

    if (targets.length === 0) {
      return yield* new NoAccountForRegion({
        region: remote.region ?? "",
        message: `No enabled account is configured for region ${remote.region}, which '${input.remote}' names.`
      })
    }

    return { branch: context.branch, remote, targets }
  })

  const scan: PrOpenServiceContract["scan"] = (input) =>
    filterService.collectOpen(input.targets, {
      repo: Option.some(input.remote.repositoryName),
      author: Option.none()
    }).pipe(Effect.map(({ failures, prs }) => ({ failures, prs })))

  return { plan, scan } satisfies PrOpenServiceContract
})

/** @category Service */
export class PrOpenService extends Context.Service<PrOpenService, PrOpenServiceContract>()(
  "@knpkv/codecommit/PrOpenService"
) {
  static readonly live: Layer.Layer<PrOpenService, never, FilterService | GitContextService> = Layer.effect(
    PrOpenService,
    make
  )
}

/**
 * No-op terminal handover for the plain CLI.
 *
 * `openAssumeConsole` suspends the terminal because the TUI owns the alternate
 * screen and `assume` may need to print an SSO verification URL into it. Here
 * there is no screen to leave: the command already runs on the caller's
 * terminal, so the correct handover is to do nothing.
 */
const CliTerminalSession = Layer.succeed(TuiTerminalSession)({
  resume: Effect.void,
  suspend: Effect.void
})

/** @category Layer */
export const PrOpenLive = Layer.mergeAll(
  CliTerminalSession,
  PrOpenService.live.pipe(
    Layer.provide(Layer.mergeAll(
      GitContextService.live,
      FilterServiceLive
    ))
  )
)

/** @category Command */
export const prOpenCommand = Command.make("open", {
  cwd: Options.string("cwd").pipe(
    Options.withDescription("Directory inside the repository (default: current directory)"),
    Options.withDefault(".")
  ),
  remote: Options.string("remote").pipe(
    Options.withDescription("Git remote naming the CodeCommit repository"),
    Options.withDefault("origin")
  ),
  json: Options.boolean("json").pipe(
    Options.withDescription("Print the resolved PR as JSON instead of opening it"),
    Options.withDefault(false)
  ),
  url: Options.boolean("url").pipe(
    Options.withDescription("Print the console URL instead of opening it"),
    Options.withDefault(false)
  )
}, ({ cwd, json, remote, url }) =>
  Effect.gen(function*() {
    // Two flags, two mutually exclusive stdout shapes. Picking one by precedence
    // hands a script the shape it did not ask for, and silently — so refuse
    // before spending a scan on it.
    if (json && url) {
      return yield* reportFailure("--json and --url select different output; pass one.")
    }

    const service = yield* PrOpenService
    const plan = yield* service.plan({ cwd, remote })

    // The scan is several seconds of silence otherwise, and the usual caller is a
    // popup where silence reads as a hang. On stderr, and suppressed for the
    // machine-readable modes, exactly like `pr list`'s progress line.
    if (!json && !url) {
      yield* Console.error(
        `Looking for an open PR on '${plan.branch}' in ${plan.remote.repositoryName} ` +
          `across ${plan.targets.length} account(s)...`
      )
    }

    const { failures, prs } = yield* service.scan(plan)
    // Warnings go to stderr so `--json`/`--url` stdout stays machine-readable.
    for (const failure of failures) yield* Console.error(`⚠ ${failure}`)

    const match = matchOpenPullRequest(prs, {
      branch: plan.branch,
      repositoryName: plan.remote.repositoryName
    })
    if (match === null) {
      // Same reasoning as the empty-target check in `plan`, applied to the scan's
      // own outcome: an account that failed was not searched. With several
      // profiles a stale SSO session is the ordinary state, not an edge case,
      // and reporting that as an absent pull request sends the caller to
      // CodeCommit when the answer is `aws sso login`.
      if (failures.length > 0) {
        return yield* reportFailure(
          `Could not determine whether ${plan.remote.repositoryName} branch '${plan.branch}' has an open PR: ` +
            `${failures.length} of ${plan.targets.length} account(s) could not be searched.`
        )
      }
      return yield* new NoOpenPullRequest({
        branch: plan.branch,
        repositoryName: plan.remote.repositoryName,
        message: `No open PR for ${plan.remote.repositoryName} branch '${plan.branch}'`
      })
    }

    const link = codecommitPullRequestConsoleUrl({
      prId: match.id,
      region: match.account.region,
      repositoryName: match.repositoryName
    })
    if (link === null) {
      return yield* new UnsupportedConsoleRegion({
        region: match.account.region,
        message: `No known AWS console host for region ${match.account.region}`
      })
    }

    if (json) {
      return yield* Console.log(JSON.stringify(
        {
          pr_id: match.id,
          repo: match.repositoryName,
          branch: plan.branch,
          title: match.title,
          author: match.author,
          profile: match.account.profile,
          region: match.account.region,
          url: link
        },
        null,
        2
      ))
    }
    if (url) return yield* Console.log(link)

    yield* Console.error(`Opening PR ${match.id} (${match.repositoryName}) via ${match.account.profile}...`)
    yield* openAssumeConsole({ link, profile: match.account.profile, requestId: `pr-open-${match.id}` })
  }).pipe(
    // Every failure here is something to tell the user in one sentence, not a
    // Cause to render: the usual caller is a keybinding showing this in a popup.
    Effect.catchTags({
      ConfigUnreadable: (error) => reportFailure(error.message),
      ConsoleLaunchError: (error) => reportFailure(error.message),
      GitContextError: (error) => reportFailure(error.message),
      NoAccountForRegion: (error) => reportFailure(error.message),
      NoEnabledAccounts: (error) => reportFailure(error.message),
      NoOpenPullRequest: (error) => reportFailure(error.message),
      NotACodeCommitRemote: (error) => reportFailure(error.message),
      UnsupportedConsoleRegion: (error) => reportFailure(error.message)
    }),
    // The command owns its service layer. The executable supplies the selected
    // AWS transport and configuration services.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(PrOpenLive)
  )).pipe(Command.withDescription("Open the console page for the PR on the branch checked out here"))
