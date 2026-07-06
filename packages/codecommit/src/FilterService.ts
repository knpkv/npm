/**
 * Cross-account `--filter` orchestration for `pr list`.
 *
 * Extracts the fan-out workflow that backs the named filter presets out of the
 * CLI entrypoint (`bin.ts`) so the entrypoint keeps only presentation. The
 * service depends on {@link AwsClient.AwsClient} and
 * {@link ConfigService.ConfigService} and reuses the pure `matchesPreset` /
 * `matchesRepoAuthor` predicates from `./filterPresets.ts`.
 *
 * Behaviour mirrors the original inline block exactly:
 *
 * - {@link FilterService.Service.resolveTargets} loads config, keeps only
 *   enabled accounts, and flattens to `{ profile, region }` targets.
 * - {@link FilterService.Service.collect} resolves caller identity once per
 *   profile (for the identity-comparing presets), fans out OPEN-only PR fetches
 *   across targets (concurrency 4), filters by preset + repo/author, collects
 *   per-account failures, and returns PRs sorted by `lastModifiedDate` desc.
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

type FilterCollectError = Errors.AwsApiError | Errors.AwsCredentialError | Errors.AwsThrottleError

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
export interface FilterServiceShape {
  readonly resolveTargets: Effect.Effect<ReadonlyArray<FilterTarget>, unknown>
  readonly collect: (
    preset: FilterPreset,
    targets: ReadonlyArray<FilterTarget>,
    opts: FilterOptions,
    now?: Date
  ) => Effect.Effect<FilterResult, FilterCollectError>
}

const make: Effect.Effect<
  FilterServiceShape,
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

  const collect: FilterServiceShape["collect"] = (preset, targets, opts, now) =>
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
          if (username) callerByProfile.set(p, username)
          else unresolvedCallerProfiles.push(p)
        }
      }

      const collected = yield* Effect.forEach(
        targets,
        (acct) =>
          aws.getPullRequests(acct, { status: "OPEN" }).pipe(
            Stream.filter((pr) =>
              matchesPreset(preset, pr, callerByProfile, effectiveNow) &&
              matchesRepoAuthor(pr, opts.repo, opts.author)
            ),
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
      const failures = collected.flatMap((r) => (r.failed === null ? [] : [r.failed]))

      return { prs, failures, unresolvedProfiles: unresolvedCallerProfiles }
    })

  const service: FilterServiceShape = { resolveTargets, collect }
  return service
})

/**
 * Cross-account filter orchestration service.
 *
 * @category models
 */
export declare namespace FilterService {
  export interface Service extends FilterServiceShape {}
}

/**
 * Cross-account filter orchestration service.
 *
 * @category Service
 */
export class FilterService extends Context.Service<
  FilterService,
  FilterServiceShape
>()("@knpkv/codecommit/FilterService") {}

/**
 * Live layer. Requires {@link AwsClient.AwsClient} and
 * {@link ConfigService.ConfigService} (wired by the caller).
 *
 * @category Layer
 */
export const FilterServiceLive = Layer.effect(FilterService, make)
