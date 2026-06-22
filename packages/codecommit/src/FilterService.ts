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
import { AwsClient, ConfigService, type Domain } from "@knpkv/codecommit-core"
import type { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Context, Effect, Layer, type Option, Stream } from "effect"
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

const make = Effect.gen(function*() {
  const aws = yield* AwsClient.AwsClient
  const cs = yield* ConfigService.ConfigService

  const resolveTargets = Effect.gen(function*() {
    const config = yield* cs.load
    return config.accounts
      .filter((a) => a.enabled)
      .flatMap((a) => a.regions.map((r): FilterTarget => ({ profile: a.profile, region: r })))
  })

  const collect = (
    preset: FilterPreset,
    targets: ReadonlyArray<FilterTarget>,
    opts: FilterOptions,
    now: Date = new Date()
  ): Effect.Effect<FilterResult> =>
    Effect.gen(function*() {
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
              Effect.map((id): { profile: string; username: string | null } => ({
                profile: acct.profile,
                username: id.username
              })),
              Effect.catchAll(() => Effect.succeed({ profile: acct.profile, username: null as string | null }))
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
              matchesPreset(preset, pr, callerByProfile, now) && matchesRepoAuthor(pr, opts.repo, opts.author)
            ),
            Stream.runCollect,
            Effect.map((chunk) => ({ ok: Array.from(chunk), failed: null as string | null })),
            // Don't silently coalesce auth/permission failures to "no matches" —
            // collect the failure so it can be surfaced after the results.
            Effect.catchAll((e) =>
              Effect.succeed({
                ok: [] as Array<Domain.PullRequest>,
                failed: `${acct.profile}/${acct.region}: ${e.message}`
              })
            )
          ),
        { concurrency: 4 }
      )
      const prs = collected.flatMap((r) => r.ok).sort((a, b) =>
        b.lastModifiedDate.getTime() - a.lastModifiedDate.getTime()
      )
      const failures = collected.flatMap((r) => (r.failed === null ? [] : [r.failed]))

      return { prs, failures, unresolvedProfiles: unresolvedCallerProfiles }
    })

  return { resolveTargets, collect } as const
})

/**
 * Cross-account filter orchestration service.
 *
 * @category models
 */
export interface FilterServiceShape extends Effect.Effect.Success<typeof make> {}

/**
 * Cross-account filter orchestration service.
 *
 * @category Service
 */
export class FilterService extends Context.Tag("@knpkv/codecommit/FilterService")<
  FilterService,
  FilterServiceShape
>() {}

/**
 * Live layer. Requires {@link AwsClient.AwsClient} and
 * {@link ConfigService.ConfigService} (wired by the caller).
 *
 * @category Layer
 */
export const FilterServiceLive = Layer.effect(FilterService, make)
