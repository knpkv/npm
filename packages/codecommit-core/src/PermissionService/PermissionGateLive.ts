/**
 * @title PermissionGateLive — Deferred-based prompt flow
 *
 * One `Deferred<PermissionResponse>` per prompt.
 *
 * Flow:
 *   1. API call fiber creates Deferred, stores in pending Map
 *   2. Publishes PermissionRequired → SSE rebuilds payload with prompt
 *   3. Fiber blocks on Deferred.await (up to 30s)
 *   4. User clicks modal → POST /api/permissions/respond
 *   5. HTTP handler calls resolve() → Deferred.succeed → fiber unblocks
 *   6. Publishes PermissionResolved → SSE removes prompt from payload
 *
 * Multi-tab: Deferred.succeed is idempotent — first responder wins,
 * second tab's POST is a no-op. Both see prompt disappear via SSE.
 *
 * Separate Effect.Service tag (not just PermissionGate) because the
 * HTTP handler and SSE builder need `resolve` and `getFirstPending`
 * which the abstract interface doesn't expose.
 *
 * @module
 */
import { Context, Deferred, Effect, Layer, Ref } from "effect"
import { EventsHub, RepoChange } from "../CacheService/EventsHub.js"
import { PermissionDeniedError } from "../Errors.js"
import { PermissionGate, type PermissionPrompt, type PermissionResponse } from "./PermissionGate.js"

interface PendingEntry {
  readonly deferred: Deferred.Deferred<PermissionResponse>
  readonly prompt: PermissionPrompt
}

export interface PermissionGateLive {
  readonly request: (prompt: PermissionPrompt) => Effect.Effect<PermissionResponse, PermissionDeniedError>
  readonly resolve: (promptId: string, response: PermissionResponse) => Effect.Effect<void>
  readonly getFirstPending: () => Effect.Effect<PermissionPrompt | undefined>
}

const makePermissionGateLive = Effect.gen(function*() {
  const hub = yield* EventsHub
  // Map<promptId, { deferred, prompt }>. Concurrent-safe via Ref.
  // Multiple prompts can be pending simultaneously (e.g. initial
  // refresh triggers getCallerIdentity + listRepositories at once).
  const pending = yield* Ref.make(new Map<string, PendingEntry>())

  const removePending = (promptId: string): Effect.Effect<void> =>
    Ref.update(pending, (m) => {
      const next = new Map(m)
      next.delete(promptId)
      return next
    }).pipe(Effect.andThen(hub.publish(RepoChange.PermissionResolved())))

  const request = (prompt: PermissionPrompt): Effect.Effect<PermissionResponse, PermissionDeniedError> =>
    Effect.gen(function*() {
      const deferred = yield* Deferred.make<PermissionResponse>()
      const response = yield* Effect.acquireUseRelease(
        Ref.update(pending, (m) => new Map(m).set(prompt.id, { deferred, prompt })),
        () =>
          hub.publish(RepoChange.PermissionRequired()).pipe(
            Effect.andThen(Deferred.await(deferred)),
            Effect.timeout("30 seconds"),
            Effect.catchTag(
              "TimeoutError",
              () => Effect.fail(new PermissionDeniedError({ operation: prompt.operation, reason: "timeout" }))
            )
          ),
        () => removePending(prompt.id)
      )

      if (response === "deny") {
        return yield* Effect.fail(new PermissionDeniedError({ operation: prompt.operation, reason: "denied" }))
      }
      return response
    })

  // Called by POST /api/permissions/respond handler.
  // Deferred.succeed is idempotent — second call is a no-op.
  // This is how multi-tab "first responder wins" works.
  const resolve = (promptId: string, response: PermissionResponse): Effect.Effect<void> =>
    Ref.get(pending).pipe(
      Effect.flatMap((m) => {
        const entry = m.get(promptId)
        return entry ? Deferred.succeed(entry.deferred, response) : Effect.void
      })
    )

  // For SSE payload builder — shows one prompt at a time (FIFO).
  // Remaining prompts queue behind; they'll surface as each resolves.
  const getFirstPending = (): Effect.Effect<PermissionPrompt | undefined> =>
    Ref.get(pending).pipe(
      Effect.map((m) => {
        const first = m.values().next()
        return first.done ? undefined : first.value.prompt
      })
    )

  return { request, resolve, getFirstPending } satisfies PermissionGateLive
})

export class PermissionGateLiveTag extends Context.Service<
  PermissionGateLiveTag,
  PermissionGateLive
>()("PermissionGateLive") {
  /** Testable composition seam; production supplies the concrete event hub below. */
  static readonly layer = Layer.effect(PermissionGateLiveTag, makePermissionGateLive)

  // EventsHub needed to publish PermissionRequired/Resolved events
  // that trigger SSE payload rebuilds.
  static readonly Default = PermissionGateLiveTag.layer.pipe(
    Layer.provide(EventsHub.Default)
  )
}

// Bridge: concrete service → abstract Context.Tag.
// Handlers use PermissionGateLiveTag (for resolve/getFirstPending),
// AwsClientGated uses PermissionGate (for request only).
export const PermissionGateLiveLayer = Layer.effect(
  PermissionGate,
  Effect.map(PermissionGateLiveTag, (live) => ({ request: live.request }))
)
