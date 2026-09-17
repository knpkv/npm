/**
 * Account visibility for cached pull requests.
 *
 * A pull request stays in the cache after its account is switched off, so
 * re-enabling the account restores it without a provider round trip. Every
 * read surface must therefore hide the rows whose account is currently
 * disabled, rather than each view re-deriving the rule.
 *
 * Enablement is read from the persisted config, never from
 * `AppState.accounts`: that snapshot is rebuilt from AWS profile detection,
 * which can transiently come back empty and would blank the whole queue.
 *
 * @internal
 */
import { Effect, Option, Schema } from "effect"
import { ConfigService } from "../ConfigService/index.js"

/**
 * The persisted account config could not be read, so which accounts are on is
 * unknown. `ConfigService.load` fails with `unknown`; naming the failure here
 * keeps the callers' decision — hide, or skip the publish — a typed one.
 */
export class AccountVisibilityUnavailable extends Schema.TaggedError<AccountVisibilityUnavailable>()(
  "AccountVisibilityUnavailable",
  { cause: Schema.Defect() }
) {}

/** Enabled profile names of already-loaded account config. */
export const enabledProfilesOf = (
  accounts: ReadonlyArray<{ readonly profile: string; readonly enabled: boolean }>
): ReadonlySet<string> => new Set(accounts.filter((account) => account.enabled).map((account) => account.profile))

/** Profiles the user currently has switched on in `~/.codecommit/config.json`. */
export const enabledProfiles: Effect.Effect<
  ReadonlySet<string>,
  AccountVisibilityUnavailable,
  ConfigService
> = Effect.gen(function*() {
  const configService = yield* ConfigService
  const config = yield* configService.load
  return enabledProfilesOf(config.accounts)
}).pipe(Effect.mapError((cause) => new AccountVisibilityUnavailable({ cause })))

/**
 * Enablement as of now, or `None` when the config cannot be read.
 *
 * Long-running work must not filter its final publish with the set it opened
 * with: a toggle in the meantime would republish rows the user has already
 * switched off. When the current set is unavailable the honest answer is to
 * publish nothing and leave the last correctly filtered list standing, so
 * callers skip their republish on `None` rather than falling back.
 */
export const currentEnabledProfiles: Effect.Effect<
  Option.Option<ReadonlySet<string>>,
  never,
  ConfigService
> = enabledProfiles.pipe(
  Effect.map(Option.some),
  Effect.tapError((cause) => Effect.logWarning("PRService: enablement unreadable, skipping republish", cause)),
  Effect.catch(() => Effect.succeed(Option.none<ReadonlySet<string>>()))
)

/** Drop cache rows whose account is not enabled. */
export const retainEnabledAccountRows = <A extends { readonly accountProfile: string }>(
  rows: ReadonlyArray<A>,
  enabled: ReadonlySet<string>
): Array<A> => rows.filter((row) => enabled.has(row.accountProfile))

/** Shown when a publish was skipped because enablement could not be read. */
export const staleListMessage = "Account settings could not be read — the list may be out of date"
