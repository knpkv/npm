/**
 * The lease that keeps two watches from writing the same hours.
 *
 * **Mental model**
 *
 * - **One writer per machine.** `jcf watch` derives what to write by subtracting what the two sides
 *   already hold. That makes a *later* tick safe, and says nothing about a *simultaneous* one: two
 *   processes can read the same gap before either writes, and then both write it. An accidental
 *   second terminal is enough.
 * - **A timestamp, not a lock.** The holder refreshes the lease on every tick; a lease older than a
 *   few intervals is treated as abandoned. A watch killed with `SIGKILL` therefore blocks the next
 *   one for a few minutes rather than forever, which is the failure a pid file gets wrong.
 *
 * **Gotchas**
 *
 * - Machine-local. Two watches on two machines against one Clockify account are not covered by
 *   this, and cannot be without a server-side idempotency key.
 * - The lease is advisory for *writing*, not for reading. `--dry-run` takes one too, so that a dry
 *   run and a real one cannot disagree about who is describing what.
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

/** How many poll intervals of silence make a lease abandoned rather than held. */
const STALE_INTERVALS = 3

const Lease = Schema.Struct({
  heldSinceMs: Schema.Number,
  refreshedAtMs: Schema.Number
})

const decodeLease = Schema.decodeUnknownOption(Schema.fromJsonString(Lease))

/** Whether this process may write, and where its lease lives. */
export type LeaseOutcome =
  | { readonly _tag: "Held"; readonly path: string }
  | { readonly _tag: "Taken"; readonly sinceMs: number }

/**
 * Take the lease, unless a live watch already holds it.
 *
 * `staleAfterMs` is derived from the caller's poll interval rather than fixed: a watch looking every
 * minute should reclaim an abandoned lease sooner than one looking every hour.
 */
export const acquire = (options: { readonly intervalSeconds: number }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* ConfigService
    const dir = yield* config.configDir
    const file = path.join(dir, LEASE_FILE)
    const now = yield* Clock.currentTimeMillis
    const staleAfterMs = options.intervalSeconds * STALE_INTERVALS * 1000

    const existing = yield* fs.readFileString(file).pipe(
      Effect.map((content) => decodeLease(content)),
      // No lease, an unreadable one, or garbage all mean the same thing: nobody demonstrably holds it.
      Effect.catch(() => Effect.succeed(Option.none<typeof Lease.Type>()))
    )
    if (Option.isSome(existing) && now - existing.value.refreshedAtMs < staleAfterMs) {
      return { _tag: "Taken", sinceMs: existing.value.heldSinceMs } satisfies LeaseOutcome
    }

    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catch(() => Effect.void))
    yield* fs.writeFileString(file, JSON.stringify({ heldSinceMs: now, refreshedAtMs: now })).pipe(
      Effect.catch(() => Effect.void)
    )
    return { _tag: "Held", path: file } satisfies LeaseOutcome
  })

/** Say the lease is still held. Called every tick; a failure to write is not worth stopping over. */
export const refresh = (options: { readonly path: string; readonly heldSinceMs: number }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const now = yield* Clock.currentTimeMillis
    yield* fs.writeFileString(
      options.path,
      JSON.stringify({ heldSinceMs: options.heldSinceMs, refreshedAtMs: now })
    ).pipe(Effect.catch(() => Effect.void))
  })

/** Give the lease up, so the next watch does not wait out the stale window. */
export const release = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(path).pipe(Effect.catch(() => Effect.void))
  })
