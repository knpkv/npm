/**
 * The lease that keeps two watches from writing the same hours, and the cursor that lets one resume.
 *
 * **Mental model**
 *
 * - **One writer per machine.** `jcf watch` derives what to write by subtracting what the two sides
 *   already hold. That makes a *later* look safe, and says nothing about a *simultaneous* one: two
 *   processes can read the same gap before either writes, and then both write it. An accidental
 *   second terminal is enough.
 * - **Won by creating the file, not by reading it.** Acquisition is an exclusive create, so of two
 *   watches starting together exactly one succeeds. A read-then-write would let both conclude the
 *   lease was free.
 * - **A held lease is immutable.** There is no safe read-then-overwrite takeover: two contenders can
 *   both read the same old value and each overwrite it. A lease is removed only by its owner during
 *   orderly shutdown. After an ungraceful process death it must be removed manually, after checking
 *   that no watch is running. Availability loses to duplicate provider writes here.
 * - **A failure to claim is not a claim.** An unwritable config directory means no lease exists, not
 *   that this process holds one. It stops rather than running unprotected.
 * - **The cursor is the earliest *unresolved* instant**, not where the holder's clock was. A watch
 *   stopped mid-block was holding prompts that had not settled; resuming from the shutdown time
 *   would filter exactly those out and lose the block it was trying to protect.
 *
 * **Gotchas**
 *
 * - Machine-local. Two watches on two machines against one Clockify account are not covered by this,
 *   and cannot be without an idempotency key the remote side honours.
 * - A resume is offered only when the previous holder stopped *recently*. A cursor left behind
 *   yesterday describes work that has long since settled, and reaching back to it would be backfill
 *   wearing a cursor's clothes.
 *
 * @module
 */
import * as Clock from "effect/Clock"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import { ConfigService } from "../services/ConfigService.js"

const LEASE_FILE = "watch.lease"
const CURSOR_FILE = "watch.cursor"

/** How many of the *holder's* poll intervals of silence make a lease abandoned rather than held. */
const STALE_INTERVALS = 3

const Lease = Schema.Struct({
  /** Who wrote this. The only way a watch can tell its own lease from one that replaced it. */
  owner: Schema.optional(Schema.String),
  heldSinceMs: Schema.Number,
  /** Last time the holder said it was alive. */
  refreshedAtMs: Schema.Number,
  /** The holder's poll interval, so staleness is judged on its terms rather than a contender's. */
  intervalSeconds: Schema.Number,
  /** Wall clock at the holder's last look — how long it has been down, when it is. */
  lookedUpToMs: Schema.optional(Schema.Number),
  /** Earliest instant the holder had not yet resolved. Where a prompt resume must begin. */
  unresolvedFromMs: Schema.optional(Schema.Number)
})

type Lease = typeof Lease.Type

const decodeLease = Schema.decodeUnknownOption(Schema.fromJsonString(Lease))

/** Whether this process may write, and what the last one left behind. */
export type LeaseOutcome =
  | {
    readonly _tag: "Held"
    readonly path: string
    readonly owner: string
    /** Where to resume, or null when there is nothing legitimate to resume. */
    readonly resumeFromMs: number | null
  }
  | { readonly _tag: "Taken"; readonly sinceMs: number }
  /** No lease could be written, so nothing is protecting a write. Distinct from losing the race. */
  | { readonly _tag: "Unavailable"; readonly reason: string }

/** Whether this process still holds what it took. */
export type LeaseStanding =
  | { readonly _tag: "Mine" }
  | { readonly _tag: "Lost"; readonly reason: string }
  | { readonly _tag: "Unavailable"; readonly reason: string }

const encode = (lease: Lease): string => JSON.stringify(lease)

/**
 * What a previous holder leaves for the next one, if anything.
 *
 * Two conditions, and both matter. The holder must have stopped recently — judged on *its* interval,
 * since that is how often it was proving liveness — because a cursor from yesterday describes work
 * that has settled and belongs to `reconcile`. And it must have said where it had got to; a lease
 * written by an older version has no cursor and offers no resume.
 */
const resumePoint = (previous: Lease, nowMs: number): number | null => {
  const downMs = nowMs - (previous.lookedUpToMs ?? previous.refreshedAtMs)
  const graceMs = Math.max(previous.intervalSeconds, 1) * STALE_INTERVALS * 1000
  if (downMs > graceMs) return null
  return previous.unresolvedFromMs ?? null
}

/**
 * Whether a failed exclusive create means "someone got there first" or "this cannot be written".
 *
 * The distinction is the difference between standing down and running unprotected. A read-only or
 * full config directory used to look exactly like a lease already existing, and the fallback writes
 * that followed were swallowed too — so the watch went on to write hours with no lease on disk at
 * all, which is precisely the situation this file exists to prevent.
 */
const isAlreadyExists = (error: { readonly message?: string | undefined }): boolean =>
  (error.message ?? "").includes("EEXIST") || (error.message ?? "").includes("AlreadyExists")

/**
 * Take the lease, unless another watch holds it.
 *
 * The happy path is a single exclusive create: two watches starting together cannot both win it.
 * An existing file is never overwritten. A stale-looking timestamp cannot make a read-then-write
 * takeover atomic, so an ungraceful crash requires explicit human cleanup.
 */
export const acquire = (options: { readonly intervalSeconds: number }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* ConfigService
    const dir = yield* config.configDir
    const file = path.join(dir, LEASE_FILE)
    const cursorFile = path.join(dir, CURSOR_FILE)
    const now = yield* Clock.currentTimeMillis
    // Two watches can start in the same millisecond, so the clock alone does not identify a holder.
    const token = yield* Random.nextInt
    const owner = `${now.toString(36)}-${Math.abs(token).toString(36)}`

    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catch(() => Effect.void))

    const mine: Lease = {
      owner,
      heldSinceMs: now,
      refreshedAtMs: now,
      intervalSeconds: options.intervalSeconds,
      lookedUpToMs: now,
      unresolvedFromMs: now
    }

    // Read recovery state before taking ownership. Once exclusive creation succeeds there must be
    // no interruptible work before returning the lease to the caller that installs its finalizer.
    const previous = yield* fs.readFileString(cursorFile).pipe(
      Effect.map(decodeLease),
      Effect.catch(() => Effect.succeed(Option.none<Lease>()))
    )
    const resumeFromMs = Option.match(previous, {
      onNone: () => null,
      onSome: (cursor) => resumePoint(cursor, now)
    })

    // Exclusive create: the filesystem decides the winner, not a read this process performed earlier.
    type Create = { readonly _tag: "Won" } | { readonly _tag: "Exists" } | { readonly _tag: "Failed" }
    const created: Create = yield* fs.writeFileString(file, encode(mine), { flag: "wx" }).pipe(
      Effect.as<Create>({ _tag: "Won" }),
      Effect.catch((error) =>
        Effect.succeed<Create>(isAlreadyExists(error) ? { _tag: "Exists" } : { _tag: "Failed" }).pipe(
          Effect.tap(() =>
            isAlreadyExists(error)
              ? Effect.void
              : Effect.logDebug(`Could not create ${file}: ${error.message}`)
          )
        )
      )
    )
    if (created._tag === "Won") {
      return { _tag: "Held", path: file, owner, resumeFromMs } satisfies LeaseOutcome
    }
    if (created._tag === "Failed") {
      return {
        _tag: "Unavailable",
        reason: `could not write ${file} — nothing would stop a second watch writing the same hours`
      } satisfies LeaseOutcome
    }

    const existing = yield* fs.readFileString(file).pipe(
      Effect.map(decodeLease),
      // Unreadable or malformed is not evidence that anybody holds it.
      Effect.catch(() => Effect.succeed(Option.none<Lease>()))
    )
    const held = Option.getOrUndefined(existing)
    if (held === undefined || held.owner === undefined) {
      return {
        _tag: "Unavailable",
        reason: `could not verify ownership of existing ${file}`
      } satisfies LeaseOutcome
    }
    return { _tag: "Taken", sinceMs: held.heldSinceMs } satisfies LeaseOutcome
  })

/** Whether the lease on disk still carries this owner's name. */
const readStanding = (file: string, owner: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    type LeaseRead = { readonly _tag: "Read"; readonly lease: Option.Option<Lease> } | {
      readonly _tag: "Unavailable"
      readonly reason: string
    }
    const current: LeaseRead = yield* fs.readFileString(file).pipe(
      Effect.map((value): LeaseRead => ({ _tag: "Read", lease: decodeLease(value) })),
      Effect.catch((error) =>
        Effect.succeed<LeaseRead>({
          _tag: "Unavailable",
          reason: `could not read ${file}: ${error.message}`
        })
      )
    )
    if (current._tag === "Unavailable") return current
    const lease = Option.getOrUndefined(current.lease)
    if (lease === undefined || lease.owner === undefined) {
      return {
        _tag: "Unavailable",
        reason: `could not verify ownership of ${file}`
      } satisfies LeaseStanding
    }
    return lease.owner === owner
      ? ({ _tag: "Mine" } satisfies LeaseStanding)
      : ({ _tag: "Lost", reason: "another jcf watch took over this lease" } satisfies LeaseStanding)
  })

/**
 * Verify that this process still owns the immutable lease.
 *
 * The cursor is persisted only on orderly release. Rewriting the lock while held would reintroduce
 * a write race and buys no exclusion: ownership is the unchanged token on disk.
 */
export const refresh = (options: {
  readonly path: string
  readonly owner: string
  readonly heldSinceMs: number
  readonly intervalSeconds: number
  readonly unresolvedFromMs: number
}) =>
  Effect.gen(function*() {
    const standing = yield* readStanding(options.path, options.owner)
    return standing
  })

/**
 * Stop holding the lease, keeping the cursor in a separate file.
 *
 * Silent when the lease is no longer this run's. A displaced process must not remove another
 * owner's lock or publish its cursor as the next run's resume boundary.
 */
export const release = (options: {
  readonly path: string
  readonly owner: string
  readonly heldSinceMs: number
  readonly intervalSeconds: number
  readonly unresolvedFromMs: number
}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const standing = yield* readStanding(options.path, options.owner)
    if (standing._tag !== "Mine") return
    const now = yield* Clock.currentTimeMillis
    const cursorPath = path.join(path.dirname(options.path), CURSOR_FILE)
    const persisted = yield* fs.writeFileString(
      cursorPath,
      encode({
        owner: options.owner,
        heldSinceMs: options.heldSinceMs,
        refreshedAtMs: 0,
        intervalSeconds: options.intervalSeconds,
        lookedUpToMs: now,
        unresolvedFromMs: options.unresolvedFromMs
      })
    ).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Console.error(`Could not persist the watch cursor at ${cursorPath}: ${error.message}. Lease retained.`).pipe(
          Effect.as(false)
        )
      )
    )
    if (!persisted) return
    yield* fs.remove(options.path).pipe(Effect.catch(() => Effect.void))
  })

/** Release a short-lived non-watch writer without publishing a watch resume cursor. */
export const releaseGuard = (options: { readonly path: string; readonly owner: string }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const standing = yield* readStanding(options.path, options.owner)
    if (standing._tag !== "Mine") return
    yield* fs.remove(options.path).pipe(Effect.catch(() => Effect.void))
  })
