/**
 * Timer `status` command.
 *
 * @module
 */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Clock, Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { StateWriter } from "../../services/StateWriter.js"

/**
 * Every Clockify call here is best-effort: on failure the command degrades to
 * printing local state. Without a bound, though, a stalled request keeps the
 * process alive forever — and `status` is what the nvim statusline polls on a
 * timer, so hung processes accumulate rather than being noticed. Bound them.
 */
const API_TIMEOUT = "10 seconds"

export const statusCmd = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function*() {
      const stateWriter = yield* StateWriter
      const state = yield* stateWriter.read
      const nowMs = yield* Clock.currentTimeMillis
      const nowUnix = Math.floor(nowMs / 1000)

      // Verify against Clockify — timer may have been stopped externally
      if (state.active) {
        const clockifyAuth = yield* ClockifyAuth
        const clockifyClient = yield* ClockifyApiClient
        const auth = yield* clockifyAuth.getConfig.pipe(Effect.catch(() => Effect.succeed(null)))
        if (auth) {
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
          if (apiReachable && !running) {
            yield* stateWriter.clear
            yield* Console.log("Timer was stopped externally. State cleared.")
            return
          }
          // If timer still running, update state file (refreshes mtime for Lua statusline)
          if (running) {
            yield* stateWriter.write({
              ...state,
              elapsed: state.startedAt_unix ? nowUnix - state.startedAt_unix : 0
            })
          }
        }
      }

      if (!state.active) {
        yield* Console.log("No active timer")
        return
      }

      const elapsed = state.startedAt_unix
        ? nowUnix - state.startedAt_unix
        : 0
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
      if (auth && state.clockifyEntryId) {
        const entry = yield* clockifyClient.getTimeEntry(auth.workspaceId, state.clockifyEntryId).pipe(
          Effect.timeout(API_TIMEOUT),
          Effect.catch(() => Effect.succeed(null))
        )
        if (entry) {
          let projectName = "none"
          if (entry.projectId) {
            const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
              Effect.timeout(API_TIMEOUT),
              Effect.catch(() => Effect.succeed([]))
            )
            projectName = projects.find((p) => p.id === entry.projectId)?.name ?? entry.projectId
          }
          yield* Console.log(`  Project:  ${projectName}`)
          yield* Console.log(`  Billable: ${entry.billable ? "yes" : "no"}`)

          // Show tags
          if (entry.tagIds && entry.tagIds.length > 0) {
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
)
