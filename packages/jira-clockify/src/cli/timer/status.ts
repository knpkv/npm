/**
 * Timer `status` command.
 *
 * @module
 */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Clock, Console, Data, Effect, FileSystem, Option, Schema } from "effect"
import type * as PlatformError from "effect/PlatformError"
import { Command, Flag as Options } from "effect/unstable/cli"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { StateWriter } from "../../services/StateWriter.js"

/**
 * Every Clockify call here is best-effort: on failure the command degrades to
 * printing local state. Without a bound, though, a stalled request keeps the
 * process alive forever — and `status` is what the nvim statusline polls on a
 * timer, so hung processes accumulate rather than being noticed. Bound them.
 */
const API_TIMEOUT = "10 seconds"

const pollTimestamp = (content: string): number | null => {
  const value = Number(content.trim())
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

type NvimPollGate = Data.TaggedEnum<{
  readonly Unmanaged: {}
  readonly Skip: {}
  readonly Run: { readonly complete: Effect.Effect<void, PlatformError.PlatformError> }
}>
const NvimPollGate = Data.taggedEnum<NvimPollGate>()

const unmanagedPoll = NvimPollGate.Unmanaged()
const skipPoll = NvimPollGate.Skip()
const runPoll = (complete: Effect.Effect<void, PlatformError.PlatformError>): NvimPollGate =>
  NvimPollGate.Run({ complete })

class InvalidNvimPollGate extends Schema.TaggedError<InvalidNvimPollGate>()(
  "InvalidNvimPollGate",
  { message: Schema.String }
) {}

const resolveNvimPollGate = Effect.fn("TimerStatus.resolveNvimPollGate")(function*(
  stampPath: Option.Option<string>,
  intervalMs: Option.Option<number>
): Effect.fn.Return<NvimPollGate, InvalidNvimPollGate | PlatformError.PlatformError, FileSystem.FileSystem> {
  if (Option.isNone(stampPath) && Option.isNone(intervalMs)) {
    return unmanagedPoll
  }
  if (Option.isNone(stampPath) || Option.isNone(intervalMs) || intervalMs.value <= 0) {
    return yield* new InvalidNvimPollGate({
      message: "nvim poll stamp and positive interval must be provided together"
    })
  }

  const fs = yield* FileSystem.FileSystem
  const nowMs = yield* Clock.currentTimeMillis
  const lastPoll = yield* fs.readFileString(stampPath.value).pipe(
    Effect.map(pollTimestamp),
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed(null))
  )
  if (lastPoll !== null) {
    const ageMs = nowMs - lastPoll
    if (ageMs >= 0 && ageMs < intervalMs.value) {
      return skipPoll
    }
  }

  return runPoll(
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((completedAt) => fs.writeFileString(stampPath.value, String(completedAt)))
    )
  )
})

export const statusCmd = Command.make(
  "status",
  {
    nvimPollStamp: Options.string("nvim-poll-stamp").pipe(Options.withHidden, Options.optional),
    nvimPollIntervalMs: Options.integer("nvim-poll-interval-ms").pipe(Options.withHidden, Options.optional)
  },
  ({ nvimPollIntervalMs, nvimPollStamp }) =>
    Effect.gen(function*() {
      const pollGate = yield* resolveNvimPollGate(nvimPollStamp, nvimPollIntervalMs)

      const status = Effect.gen(function*() {
        const stateWriter = yield* StateWriter
        const state = yield* stateWriter.read
        const nowMs = yield* Clock.currentTimeMillis
        const nowUnix = Math.floor(nowMs / 1000)

        // Verify against Clockify — timer may have been stopped externally
        if (state.active) {
          const clockifyAuth = yield* ClockifyAuth
          const clockifyClient = yield* ClockifyApiClient
          const auth = yield* clockifyAuth.getConfig.pipe(Effect.catch(() => Effect.succeed(null)))
          if (auth !== null) {
            let apiReachable = false
            // The bound goes innermost: `apiReachable` gates clearing the state
            // file, so the tap must only be reachable on an answer that actually
            // won its race. Timing out around the tap would let the flag be set
            // by a call the timeout then discards, and the `null` result would
            // read as "API confirmed no timer" — clearing a live timer.
            const running = yield* clockifyClient.getRunningTimer(auth.workspaceId, auth.userId).pipe(
              Effect.timeout(API_TIMEOUT),
              Effect.tap(() =>
                Effect.sync(() => {
                  apiReachable = true
                })
              ),
              Effect.catch(() => Effect.succeed(null))
            )
            // Only clear if API was reachable and confirmed no running timer
            if (apiReachable && running === null) {
              yield* stateWriter.clear
              yield* Console.log("Timer was stopped externally. State cleared.")
              return
            }
            // If timer still running, update state file (refreshes mtime for Lua statusline)
            if (running !== null) {
              yield* stateWriter.write({
                ...state,
                elapsed: state.startedAt_unix === null ? 0 : nowUnix - state.startedAt_unix
              })
            }
          }
        }

        if (!state.active) {
          yield* Console.log("No active timer")
          return
        }

        const elapsed = state.startedAt_unix === null ? 0 : nowUnix - state.startedAt_unix
        const h = Math.floor(elapsed / 3600)
        const m = Math.floor((elapsed % 3600) / 60)
        const s = elapsed % 60

        yield* Console.log(`● ${state.ticketKey}  ${state.summary ?? ""}`)
        yield* Console.log(
          `  Time:     ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
        )
        yield* Console.log(`  Started:  ${state.startedAt ?? "?"}`)

        // Show project/billable from Clockify entry
        const clockifyAuth = yield* ClockifyAuth
        const clockifyClient = yield* ClockifyApiClient
        const auth = yield* clockifyAuth.getConfig.pipe(Effect.catch(() => Effect.succeed(null)))
        if (auth !== null && state.clockifyEntryId !== null) {
          const entry = yield* clockifyClient.getTimeEntry(auth.workspaceId, state.clockifyEntryId).pipe(
            Effect.timeout(API_TIMEOUT),
            Effect.catch(() => Effect.succeed(null))
          )
          if (entry !== null) {
            let projectName = "none"
            if (entry.projectId !== null && entry.projectId !== undefined) {
              const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
                Effect.timeout(API_TIMEOUT),
                Effect.catch(() => Effect.succeed([]))
              )
              projectName = projects.find((p) => p.id === entry.projectId)?.name ?? entry.projectId
            }
            yield* Console.log(`  Project:  ${projectName}`)
            yield* Console.log(`  Billable: ${entry.billable === true ? "yes" : "no"}`)

            // Show tags
            if (entry.tagIds !== null && entry.tagIds !== undefined && entry.tagIds.length > 0) {
              const allTags = yield* clockifyClient.getTags(auth.workspaceId).pipe(
                Effect.timeout(API_TIMEOUT),
                Effect.catch(() => Effect.succeed([]))
              )
              const tagNames = entry.tagIds
                .map((id) => allTags.find((t) => t.id === id)?.name ?? id)
                .join(", ")
              yield* Console.log(`  Tags:     ${tagNames}`)
            } else {
              yield* Console.log("  Tags:     none")
            }
          }
        }
      })

      return yield* NvimPollGate.$match(pollGate, {
        Unmanaged: () => status,
        Skip: () => Effect.void,
        Run: ({ complete }) => status.pipe(Effect.onExit(() => complete))
      })
    })
)
