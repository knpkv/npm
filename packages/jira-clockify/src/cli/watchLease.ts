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
 * - **Every lease is signed.** Taking over an *abandoned* lease cannot be an exclusive create — the
 *   file is already there — so that path stays a write, and the writer's own token is what makes it
 *   decidable afterwards. Two contenders can briefly both believe they won; exactly one of them is
 *   named on disk, and the other finds out at its next refresh and stops. Without the signature
 *   there is nothing to find out, which is what made the first version of this comment a fiction.
 * - **Staleness belongs to the holder.** The lease carries the holder's own poll interval, so a
 *   contender started with `--interval 1` cannot declare a live hourly watch abandoned after three
 *   seconds.
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
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import { ConfigService } from "../services/ConfigService.js"

const LEASE_FILE = "watch.lease"

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
 * Take the lease, unless a live watch holds it.
 *
 * The happy path is a single exclusive create: two watches starting together cannot both win it.
 * An existing file is judged on its holder's own interval, and an abandoned one is overwritten —
 * that step cannot be exclusive, since the file is there, so it is followed by a read back. Whatever
 * name the file carries afterwards is the holder; anyone else stands down.
 */
export const acquire = (options: { readonly intervalSeconds: number }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* ConfigService
    const dir = yield* config.configDir
    const file = path.join(dir, LEASE_FILE)
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
      return { _tag: "Held", path: file, owner, resumeFromMs: null } satisfies LeaseOutcome
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
    if (held !== undefined) {
      const staleAfterMs = Math.max(held.intervalSeconds, 1) * STALE_INTERVALS * 1000
      if (now - held.refreshedAtMs < staleAfterMs) {
        return { _tag: "Taken", sinceMs: held.heldSinceMs } satisfies LeaseOutcome
      }
    }
    const resumeFromMs = held === undefined ? null : resumePoint(held, now)

    const claim = { ...mine, unresolvedFromMs: resumeFromMs ?? now }
    const claimed = yield* fs.writeFileString(file, encode(claim)).pipe(
      Effect.as(true),
      Effect.catch((error) => Effect.logDebug(`Could not claim ${file}: ${error.message}`).pipe(Effect.as(false)))
    )
    if (!claimed) {
      return {
        _tag: "Unavailable",
        reason: `could not claim ${file} — nothing would stop a second watch writing the same hours`
      } satisfies LeaseOutcome
    }

    // Read back rather than assumed. Of two watches overwriting the same abandoned lease, both
    // writes succeed and only one name survives; this is where the other one learns that.
    const standing = yield* readStanding(file, owner)
    if (standing._tag === "Lost") {
      return { _tag: "Taken", sinceMs: now } satisfies LeaseOutcome
    }
    return { _tag: "Held", path: file, owner, resumeFromMs } satisfies LeaseOutcome
  })

/** Whether the lease on disk still carries this owner's name. */
const readStanding = (file: string, owner: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const current = yield* fs.readFileString(file).pipe(
      Effect.map(decodeLease),
      Effect.catch(() => Effect.succeed(Option.none<Lease>()))
    )
    const lease = Option.getOrUndefined(current)
    // An unreadable or missing lease is not proof of loss: a transient read error must not stop a
    // watch that is in fact the only one running. A *different* name is proof.
    if (lease === undefined || lease.owner === undefined) return { _tag: "Mine" } satisfies LeaseStanding
    return lease.owner === owner
      ? ({ _tag: "Mine" } satisfies LeaseStanding)
      : ({ _tag: "Lost", reason: "another jcf watch took over this lease" } satisfies LeaseStanding)
  })

/**
 * Say the lease is still held, and record what is still unresolved.
 *
 * Written every look, so a watch killed outright still leaves an accurate cursor. `unresolvedFromMs`
 * is the earliest instant this run has *not* finished with — the start of the oldest block it is
 * still holding, or the settle horizon when it holds none.
 *
 * Checks before it writes, and that ordering is the point. A tick that outlives its own stale window
 * — a `--interval 1` watch spending four seconds on Jira, say — can be declared abandoned and taken
 * over while it is still working. Reading first is how the displaced holder finds out before it
 * writes anything, so the caller must stop on `Lost` rather than treat this as best-effort.
 */
export const refresh = (options: {
  readonly path: string
  readonly owner: string
  readonly heldSinceMs: number
  readonly intervalSeconds: number
  readonly unresolvedFromMs: number
}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const standing = yield* readStanding(options.path, options.owner)
    if (standing._tag === "Lost") return standing
    const now = yield* Clock.currentTimeMillis
    yield* fs.writeFileString(
      options.path,
      encode({
        owner: options.owner,
        heldSinceMs: options.heldSinceMs,
        refreshedAtMs: now,
        intervalSeconds: options.intervalSeconds,
        lookedUpToMs: now,
        unresolvedFromMs: options.unresolvedFromMs
      })
    ).pipe(Effect.catch(() => Effect.void))
    return { _tag: "Mine" } satisfies LeaseStanding
  })

/**
 * Stop holding the lease, keeping the cursor.
 *
 * Not deleted: the record of what was still unresolved is what makes the next run's resume
 * legitimate rather than a blanket licence to back-date. `refreshedAtMs: 0` says nobody holds this,
 * so the next watch takes it at once instead of waiting out the stale window.
 *
 * Silent when the lease is no longer this run's. Standing down is about the holder's own claim, and
 * writing `refreshedAtMs: 0` over a live successor's lease would invite a third watch straight in.
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
    const standing = yield* readStanding(options.path, options.owner)
    if (standing._tag === "Lost") return
    const now = yield* Clock.currentTimeMillis
    yield* fs.writeFileString(
      options.path,
      encode({
        owner: options.owner,
        heldSinceMs: options.heldSinceMs,
        refreshedAtMs: 0,
        intervalSeconds: options.intervalSeconds,
        lookedUpToMs: now,
        unresolvedFromMs: options.unresolvedFromMs
      })
    ).pipe(Effect.catch(() => Effect.void))
  })
