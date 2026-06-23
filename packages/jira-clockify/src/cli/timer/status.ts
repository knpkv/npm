/**
 * Timer `status` command.
 *
 * @module
 */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { StateWriter } from "../../services/StateWriter.js"

export const statusCmd = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function*() {
      const stateWriter = yield* StateWriter
      const state = yield* stateWriter.read

      // Verify against Clockify — timer may have been stopped externally
      if (state.active) {
        const clockifyAuth = yield* ClockifyAuth
        const clockifyClient = yield* ClockifyApiClient
        const auth = yield* clockifyAuth.getConfig.pipe(Effect.catch(() => Effect.succeed(null)))
        if (auth) {
          let apiReachable = false
          const running = yield* clockifyClient.getRunningTimer(auth.workspaceId, auth.userId).pipe(
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
              elapsed: state.startedAt_unix ? Math.floor(Date.now() / 1000) - state.startedAt_unix : 0
            })
          }
        }
      }

      if (!state.active) {
        yield* Console.log("No active timer")
        return
      }

      const elapsed = state.startedAt_unix
        ? Math.floor(Date.now() / 1000) - state.startedAt_unix
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
          Effect.catch(() => Effect.succeed(null))
        )
        if (entry) {
          let projectName = "none"
          if (entry.projectId) {
            const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
              Effect.catch(() => Effect.succeed([] as const))
            )
            projectName = projects.find((p) => p.id === entry.projectId)?.name ?? entry.projectId
          }
          yield* Console.log(`  Project:  ${projectName}`)
          yield* Console.log(`  Billable: ${entry.billable ? "yes" : "no"}`)

          // Show tags
          if (entry.tagIds && entry.tagIds.length > 0) {
            const allTags = yield* clockifyClient.getTags(auth.workspaceId).pipe(
              Effect.catch(() => Effect.succeed([] as const))
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
