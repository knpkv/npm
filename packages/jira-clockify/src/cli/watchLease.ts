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
 * - **Staleness belongs to the holder.** The lease carries the holder's own poll interval, so a
 *   contender started with `--interval 1` cannot declare a live hourly watch abandoned after three
 *   seconds.
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
import * as Schema from "effect/Schema"
import { ConfigService } from "../services/ConfigService.js"

const LEASE_FILE = "watch.lease"

/** How many of the *holder's* poll intervals of silence make a lease abandoned rather than held. */
const STALE_INTERVALS = 3

const Lease = Schema.Struct({
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
    /** Where to resume, or null when there is nothing legitimate to resume. */
    readonly resumeFromMs: number | null
  }
  | { readonly _tag: "Taken"; readonly sinceMs: number }

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
 * Take the lease, unless a live watch holds it.
 *
 * The happy path is a single exclusive create: two watches starting together cannot both win it. An
 * existing file is then judged on the holder's own interval, and an abandoned one is replaced —
 * a race there is narrow and self-correcting, because the loser's next look finds a lease it does
 * not own and stops.
 */
export const acquire = (options: { readonly intervalSeconds: number }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* ConfigService
    const dir = yield* config.configDir
    const file = path.join(dir, LEASE_FILE)
    const now = yield* Clock.currentTimeMillis

    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catch(() => Effect.void))

    const mine: Lease = {
      heldSinceMs: now,
      refreshedAtMs: now,
      intervalSeconds: options.intervalSeconds,
      lookedUpToMs: now,
      unresolvedFromMs: now
    }

    // Exclusive create: the filesystem decides the winner, not a read this process performed earlier.
    const created = yield* fs.writeFileString(file, encode(mine), { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    )
    if (created) return { _tag: "Held", path: file, resumeFromMs: null } satisfies LeaseOutcome

    const existing = yield* fs.readFileString(file).pipe(
      Effect.map(decodeLease),
      // Unreadable or malformed is not evidence that anybody holds it.
      Effect.catch(() => Effect.succeed(Option.none<Lease>()))
    )
    if (Option.isSome(existing)) {
      const held = existing.value
      const staleAfterMs = Math.max(held.intervalSeconds, 1) * STALE_INTERVALS * 1000
      if (now - held.refreshedAtMs < staleAfterMs) {
        return { _tag: "Taken", sinceMs: held.heldSinceMs } satisfies LeaseOutcome
      }
      const resumeFromMs = resumePoint(held, now)
      yield* fs.writeFileString(file, encode({ ...mine, unresolvedFromMs: resumeFromMs ?? now })).pipe(
        Effect.catch(() => Effect.void)
      )
      return { _tag: "Held", path: file, resumeFromMs } satisfies LeaseOutcome
    }

    yield* fs.writeFileString(file, encode(mine)).pipe(Effect.catch(() => Effect.void))
    return { _tag: "Held", path: file, resumeFromMs: null } satisfies LeaseOutcome
  })

/**
 * Say the lease is still held, and record what is still unresolved.
 *
 * Written every look, so a watch killed outright still leaves an accurate cursor. `unresolvedFromMs`
 * is the earliest instant this run has *not* finished with — the start of the oldest block it is
 * still holding, or the settle horizon when it holds none.
 */
export const refresh = (options: {
  readonly path: string
  readonly heldSinceMs: number
  readonly intervalSeconds: number
  readonly unresolvedFromMs: number
}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const now = yield* Clock.currentTimeMillis
    yield* fs.writeFileString(
      options.path,
      encode({
        heldSinceMs: options.heldSinceMs,
        refreshedAtMs: now,
        intervalSeconds: options.intervalSeconds,
        lookedUpToMs: now,
        unresolvedFromMs: options.unresolvedFromMs
      })
    ).pipe(Effect.catch(() => Effect.void))
  })

/**
 * Stop holding the lease, keeping the cursor.
 *
 * Not deleted: the record of what was still unresolved is what makes the next run's resume
 * legitimate rather than a blanket licence to back-date. `refreshedAtMs: 0` says nobody holds this,
 * so the next watch takes it at once instead of waiting out the stale window.
 */
export const release = (options: {
  readonly path: string
  readonly heldSinceMs: number
  readonly intervalSeconds: number
  readonly unresolvedFromMs: number
}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const now = yield* Clock.currentTimeMillis
    yield* fs.writeFileString(
      options.path,
      encode({
        heldSinceMs: options.heldSinceMs,
        refreshedAtMs: 0,
        intervalSeconds: options.intervalSeconds,
        lookedUpToMs: now,
        unresolvedFromMs: options.unresolvedFromMs
      })
    ).pipe(Effect.catch(() => Effect.void))
  })
