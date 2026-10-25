/**
 * Dismiss and Try again for a failed fleet job in the Needs-you inbox: {@link fleetFailureRoutes}.
 *
 * **Mental model**
 *
 * - **The job is read from its own host.** The body names the host; the route reads the job there (this hub's
 *   store, or the peer's) and acts only on a job that ended `failed`, `interrupted` or `expired`. Dismiss alone still
 *   proceeds when the host can't be read: the flag only hides a row on this hub.
 * - **Try again is a new submission by the person pressing it.** It submits the same payload, or `nix.apply main`
 *   for "Apply main instead", with the caller's own login and provenance, exactly as `POST /v1/jobs` would. A kind
 *   that needs an approval asks again; nothing here approves.
 * - **Only generic requests retry.** `nix.check`, `nix.apply`, `agent.delegate` and `agent.message`. Work jobs carry
 *   expected revisions and would fail again by construction; sandbox jobs retry from Sandboxes.
 * - **One retry per failure.** The claim is taken before the submit ({@link NeedsYouStore.claimRetry}), so a second
 *   press answers `AlreadyRetried` with the first retry's job, and submits nothing.
 *
 * @module
 */
import { FleetHostName, JobIdentifier, type JobPayload, type JobRecord, type JobStatus } from "@knpkv/herdr-fleet/model"
import { type ModuleCaller, ModuleRouteFailure, moduleWriteRoute } from "@knpkv/hub-app"
import { Effect, Schema } from "effect"
import type { FleetJobKey, NeedsYouStore } from "./needs-you-store.js"

const retryableKinds = new Set<JobPayload["kind"]>(["nix.check", "nix.apply", "agent.delegate", "agent.message"])
const endedUnsuccessfully = new Set<JobStatus>(["failed", "interrupted", "expired"])

/** A job read failed: no such job (or host), or the host couldn't answer. */
export type FleetJobReadFailure = "not_found" | "unavailable"

export interface FleetFailureRoutesOptions {
  readonly store: NeedsYouStore
  /** The job on its host: this hub's store, or a peer's. */
  readonly readJob: (key: FleetJobKey) => Effect.Effect<JobRecord, FleetJobReadFailure>
  /** Submit to `host` as `caller`, with the caller's own provenance. */
  readonly submit: (
    host: string,
    payload: JobPayload,
    caller: ModuleCaller
  ) => Effect.Effect<{ readonly jobId: string; readonly status: JobStatus }, ModuleRouteFailure>
}

const JobKey = Schema.Struct({ host: FleetHostName, jobId: JobIdentifier })
const RetryRequest = Schema.Struct({ ...JobKey.fields, apply: Schema.Literals(["same", "main"]) })

export const RetryResult = Schema.Union([
  Schema.TaggedStruct("Retried", { host: Schema.String, jobId: Schema.String, status: Schema.String }),
  Schema.TaggedStruct("AlreadyRetried", { retryJobId: Schema.NullOr(Schema.String) })
])
export type RetryResult = typeof RetryResult.Type

const NoQuery = Schema.fromURLSearchParams(Schema.Struct({}))

const ended = Effect.fn("FleetFailures.ended")(function*(options: FleetFailureRoutesOptions, key: FleetJobKey) {
  const record = yield* options.readJob(key).pipe(
    Effect.mapError((failure) => new ModuleRouteFailure({ status: failure === "not_found" ? 404 : 503, code: failure }))
  )
  if (!endedUnsuccessfully.has(record.status)) return yield* new ModuleRouteFailure({ status: 409, code: "not_failed" })
  return record
})

const storeFailure = () => new ModuleRouteFailure({ status: 503, code: "unavailable" })

/** The payload Try again submits, or a refusal for a kind that doesn't retry. */
const retryPayload = (record: JobRecord, apply: "same" | "main") => {
  if (!retryableKinds.has(record.payload.kind)) {
    return Effect.fail(new ModuleRouteFailure({ status: 409, code: "not_retryable" }))
  }
  if (apply === "same") return Effect.succeed(record.payload)
  return record.payload.kind === "nix.apply"
    ? Effect.succeed<JobPayload>({ kind: "nix.apply", ref: "main" })
    : Effect.fail(new ModuleRouteFailure({ status: 409, code: "not_retryable" }))
}

export const fleetFailureRoutes = (options: FleetFailureRoutesOptions) => [
  moduleWriteRoute(
    "POST",
    "/failures/dismiss",
    NoQuery,
    JobKey,
    Schema.Struct({ dismissed: Schema.Literal(true) }),
    (key, _query, caller) =>
      Effect.gen(function*() {
        // A host that can't answer can't vouch either way; the flag is the hub's own and only hides a row, so a stale
        // failure on an offline host can still be cleared. A host that answers decides.
        yield* ended(options, key).pipe(
          Effect.catchIf((failure) => failure.code === "unavailable", () => Effect.void)
        )
        yield* options.store.dismiss(key, caller.login).pipe(Effect.mapError(storeFailure))
        return { dismissed: true }
      })
  ),
  moduleWriteRoute(
    "POST",
    "/failures/retry",
    NoQuery,
    RetryRequest,
    RetryResult,
    ({ apply, ...key }, _query, caller) =>
      Effect.gen(function*() {
        const record = yield* ended(options, key)
        const payload = yield* retryPayload(record, apply)
        const held = yield* options.store.claimRetry(key, caller.login).pipe(
          Effect.as<RetryResult | null>(null),
          Effect.catchTag(
            "RetryAlreadyClaimed",
            (claim) => Effect.succeed<RetryResult>({ _tag: "AlreadyRetried", retryJobId: claim.retryJobId })
          ),
          Effect.mapError(storeFailure)
        )
        if (held !== null) return held
        const submitted = yield* options.submit(key.host, payload, caller).pipe(
          Effect.tapError(() => options.store.releaseRetry(key).pipe(Effect.ignore({ log: true })))
        )
        // The job exists now; a failed fill only costs the inbox link, so it's logged, never answered as failure.
        yield* options.store.fillRetry(key, submitted.jobId).pipe(
          Effect.catch((cause) => Effect.logWarning("Needs-you retry link not recorded", cause))
        )
        return {
          _tag: "Retried",
          host: key.host,
          jobId: submitted.jobId,
          status: submitted.status
        } satisfies RetryResult
      })
  )
]
