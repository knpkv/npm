/**
 * Cross-account PR fan-out for `pr list` and `pr open`.
 *
 * Extracts the fan-out workflow out of the CLI entrypoint (`bin.ts`) so the
 * entrypoint keeps only presentation. The service depends on
 * {@link AwsClient.AwsClient} and {@link ConfigService.ConfigService} and
 * reuses the pure `matchesPreset` / `matchesRepoAuthor` predicates from
 * `./filterPresets.ts`.
 *
 * - {@link FilterService.Service.resolveTargets} loads config, keeps only
 *   enabled accounts, and flattens to `{ profile, region }` targets.
 * - {@link FilterService.Service.collect} resolves caller identity once per
 *   profile (for the identity-comparing presets), then fans out through the
 *   shared `fanOut` helper filtering by preset + repo/author.
 * - {@link FilterService.Service.collectOpen} is the preset-free counterpart
 *   backing `pr open`: the same fan-out narrowed only by repo/author, so it
 *   resolves no caller identity and its `unresolvedProfiles` is always empty.
 *
 * Both collectors fan out OPEN-only fetches across targets (concurrency 4),
 * collect per-account failures rather than coalescing them to "no matches", and
 * return PRs sorted by `lastModifiedDate` desc.
 *
 * @category Service
 * @module
 */
import { AwsClient, ConfigService, type Domain, type Errors } from "@knpkv/codecommit-core"
import type { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Clock, Context, Effect, Layer, type Option, Stream } from "effect"
import { type FilterPreset, matchesPreset, matchesRepoAuthor } from "./filterPresets.js"

/** A single `{ profile, region }` account/region pair to scan. */
export interface FilterTarget {
  readonly profile: AwsProfileName
  readonly region: AwsRegion
}

/** Repo/author narrowing options applied on top of the preset. */
export interface FilterOptions {
  readonly repo: Option.Option<string>
  readonly author: Option.Option<string>
}

/**
 * Structured outcome of a cross-account scan.
 *
 * - `prs`               — matching PRs, sorted by `lastModifiedDate` desc.
 * - `failures`          — `"<profile>/<region>: <message>"` per failed account.
 * - `unresolvedProfiles` — profiles whose caller identity didn't resolve, so
 *   identity-comparing presets may have incomplete results for them.
 */
export interface FilterResult {
  readonly prs: ReadonlyArray<Domain.PullRequest>
  readonly failures: ReadonlyArray<string>
  readonly unresolvedProfiles: ReadonlyArray<string>
}

/**
 * What a fan-out can still fail with once per-account failures are collected.
 *
 * Exported because the commands built on this service have to name it in their
 * own contracts rather than claim a fan-out cannot fail.
 */
export type FilterCollectError = Errors.AwsApiError | Errors.AwsCredentialError | Errors.AwsThrottleError

interface CallerLookup {
  readonly profile: AwsProfileName
  readonly username: string | null
}

interface AccountCollection {
  readonly ok: ReadonlyArray<Domain.PullRequest>
  readonly failed: string | null
}

const unresolvedCaller = (profile: AwsProfileName): CallerLookup => ({ profile, username: null })

const collectedPullRequests = (prs: Iterable<Domain.PullRequest>): AccountCollection => ({
  ok: Array.from(prs),
  failed: null
})

const failedAccount = (acct: FilterTarget, message: string): AccountCollection => ({
  ok: [],
  failed: `${acct.profile}/${acct.region}: ${message}`
})

/**
 * Cross-account filter orchestration service.
 *
 * @category models
 */
export interface FilterServiceContract {
  readonly resolveTargets: Effect.Effect<ReadonlyArray<FilterTarget>, unknown>
  readonly collect: (
    preset: FilterPreset,
    targets: ReadonlyArray<FilterTarget>,
    opts: FilterOptions,
    now?: Date
  ) => Effect.Effect<FilterResult, FilterCollectError>
  /**
   * Every OPEN PR across the targets, narrowed only by repo/author.
   *
   * The preset-free counterpart to {@link FilterServiceContract.collect}: no
   * caller identity is resolved, because no predicate here compares against
   * "me". That is what `pr open` needs — a branch checked out for review belongs
   * to someone else's PR, and an identity-scoped scan would never find it.
   */
  readonly collectOpen: (
    targets: ReadonlyArray<FilterTarget>,
    opts: FilterOptions
  ) => Effect.Effect<FilterResult, FilterCollectError>
}

const make: Effect.Effect<
  FilterServiceContract,
  Errors.AwsApiError | Errors.AwsCredentialError | Errors.AwsThrottleError,
  AwsClient.AwsClient | ConfigService.ConfigService
> = Effect.gen(function*() {
  const aws = yield* AwsClient.AwsClient
  const cs = yield* ConfigService.ConfigService

  const resolveTargets = Effect.gen(function*() {
    const config = yield* cs.load
    return config.accounts
      .filter((a) => a.enabled)
      .flatMap((a) => a.regions.map((r): FilterTarget => ({ profile: a.profile, region: r })))
  })

  /**
   * Fans OPEN-PR fetches across the targets, keeping whatever `keep` accepts.
   *
   * Shared by both collectors so they cannot drift on the parts that are not
   * about filtering: concurrency, per-account failure capture, and the
   * newest-first ordering the callers render.
   */
  const fanOut = (
    targets: ReadonlyArray<FilterTarget>,
    keep: (pr: Domain.PullRequest) => boolean
  ) =>
    Effect.gen(function*() {
      const collected = yield* Effect.forEach(
        targets,
        (acct) =>
          aws.getPullRequests(acct, { status: "OPEN" }).pipe(
            Stream.filter(keep),
            Stream.runCollect,
            Effect.map(collectedPullRequests),
            // Don't silently coalesce auth/permission failures to "no matches" —
            // collect the failure so it can be surfaced after the results.
            Effect.catchIf(() => true, (e: FilterCollectError) => Effect.succeed(failedAccount(acct, e.message)))
          ),
        { concurrency: 4 }
      )
      const prs = collected.flatMap((r) => r.ok).sort((a, b) =>
        b.lastModifiedDate.getTime() - a.lastModifiedDate.getTime()
      )
      return { prs, failures: collected.flatMap((r) => (r.failed === null ? [] : [r.failed])) }
    })

  const collectOpen: FilterServiceContract["collectOpen"] = (targets, opts) =>
    fanOut(targets, (pr) => matchesRepoAuthor(pr, opts.repo, opts.author)).pipe(
      Effect.map(({ failures, prs }) => ({ prs, failures, unresolvedProfiles: [] }))
    )

  const collect: FilterServiceContract["collect"] = (preset, targets, opts, now) =>
    Effect.gen(function*() {
      const effectiveNow = now ?? new Date(yield* Clock.currentTimeMillis)
      // Resolve caller identity once per profile (deduped per profile within this
      // run, not cached across runs) for presets that compare against "me".
      const callerByProfile = new Map<string, string>()
      // Profiles whose caller-identity didn't resolve (lookup failed or returned
      // no username). For the identity-comparing presets this means their PRs
      // can't be matched, so we surface a warning rather than silently dropping them.
      const unresolvedCallerProfiles: Array<string> = []
      if (preset === "mine" || preset === "needs-my-review") {
        const uniqueProfiles = [...new Map(targets.map((t) => [t.profile, t])).values()]
        const callers = yield* Effect.forEach(
          uniqueProfiles,
          (acct) =>
            aws.getCallerIdentity(acct).pipe(
              Effect.map((id): CallerLookup => ({
                profile: acct.profile,
                username: id.username
              })),
              Effect.catchIf(() => true, () => Effect.succeed(unresolvedCaller(acct.profile)))
            ),
          { concurrency: 4 }
        )
        for (const { profile: p, username } of callers) {
          // An empty username is as unusable as a missing one: no PR author
          // matches "", so treating it as resolved would silently return an
          // empty result for the identity-comparing presets instead of warning.
          if (username !== null && username !== "") callerByProfile.set(p, username)
          else unresolvedCallerProfiles.push(p)
        }
      }

      const { failures, prs } = yield* fanOut(
        targets,
        (pr) =>
          matchesPreset(preset, pr, callerByProfile, effectiveNow) &&
          matchesRepoAuthor(pr, opts.repo, opts.author)
      )

      return { prs, failures, unresolvedProfiles: unresolvedCallerProfiles }
    })

  const service: FilterServiceContract = { resolveTargets, collect, collectOpen }
  return service
})

/**
 * Cross-account filter orchestration service.
 *
 * @category models
 */
export declare namespace FilterService {
  export interface Service extends FilterServiceContract {}
}

/**
 * Cross-account filter orchestration service.
 *
 * @category Service
 */
export class FilterService extends Context.Service<
  FilterService,
  FilterServiceContract
>()("@knpkv/codecommit/FilterService") {}

/**
 * Live layer. Requires {@link AwsClient.AwsClient} and
 * {@link ConfigService.ConfigService} (wired by the caller).
 *
 * @category Layer
 */
export const FilterServiceLive = Layer.effect(FilterService, make)
