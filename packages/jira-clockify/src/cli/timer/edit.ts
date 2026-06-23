/**
 * Timer `edit` command.
 *
 * @module
 */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Console, Effect, SubscriptionRef } from "effect"
import { Command, Prompt } from "effect/unstable/cli"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { TimerService } from "../../services/TimerService.js"

export const edit = Command.make(
  "edit",
  {},
  () =>
    Effect.gen(function*() {
      const timer = yield* TimerService
      yield* timer.detectRunning

      const current = yield* SubscriptionRef.get(timer.state)
      if (!current.active) {
        yield* Console.log("No active timer to edit.")
        return
      }

      yield* Console.log(`Editing: ${current.ticketKey} — ${current.summary ?? ""}`)
      yield* Console.log("")

      const clockifyAuth = yield* ClockifyAuth
      const clockifyClient = yield* ClockifyApiClient
      const auth = yield* clockifyAuth.getConfig.pipe(Effect.catch(() => Effect.succeed(null)))
      if (!auth || !current.clockifyEntryId) {
        yield* Console.log("Cannot edit: missing Clockify auth or entry ID.")
        return
      }

      const what = yield* Prompt.select({
        message: "What to edit?",
        choices: [
          {
            title: `Project (current: ${current.projectName ?? current.projectId ?? "none"})`,
            value: "project" as const
          },
          {
            title: `Billable (current: ${
              current.billable === true ? "yes" : current.billable === false ? "no" : "unset"
            })`,
            value: "billable" as const
          },
          { title: "Tags", value: "tags" as const }
        ]
      })

      if (what === "project") {
        const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
          Effect.catch(() => Effect.succeed([] as const))
        )
        const selected = yield* Prompt.select({
          message: "Select project:",
          choices: [
            ...projects.map((p) => ({ title: p.name, value: p.id })),
            { title: "(none)", value: "" }
          ]
        })
        if (!current.startedAt) return
        // Fetch existing entry to preserve tags
        const entry = yield* clockifyClient.getTimeEntry(auth.workspaceId, current.clockifyEntryId).pipe(
          Effect.catch(() => Effect.succeed(null))
        )
        yield* clockifyClient.updateTimeEntry(auth.workspaceId, current.clockifyEntryId, {
          start: current.startedAt.toISOString(),
          ...(selected ? { projectId: selected } : {}),
          ...(entry?.tagIds && entry.tagIds.length > 0 ? { tagIds: [...entry.tagIds] } : {})
        }).pipe(Effect.catch((e) => Console.log(`Error: ${e.message}`)))

        const name = projects.find((p) => p.id === selected)?.name ?? null
        yield* Console.log(`Project updated: ${name ?? "(none)"}`)
      }

      if (what === "billable") {
        const val = yield* Prompt.select({
          message: "Billable?",
          choices: [
            { title: "Yes", value: true },
            { title: "No", value: false }
          ]
        })
        if (!current.startedAt) return
        const entry = yield* clockifyClient.getTimeEntry(auth.workspaceId, current.clockifyEntryId).pipe(
          Effect.catch(() => Effect.succeed(null))
        )
        yield* clockifyClient.updateTimeEntry(auth.workspaceId, current.clockifyEntryId, {
          start: current.startedAt.toISOString(),
          billable: val,
          ...(entry?.projectId ? { projectId: entry.projectId } : {}),
          ...(entry?.tagIds && entry.tagIds.length > 0 ? { tagIds: [...entry.tagIds] } : {})
        }).pipe(Effect.catch((e) => Console.log(`Error: ${e.message}`)))

        yield* Console.log(`Billable updated: ${val ? "yes" : "no"}`)
      }

      if (what === "tags") {
        const allTags = yield* clockifyClient.getTags(auth.workspaceId).pipe(
          Effect.catch(() => Effect.succeed([] as const))
        )
        const entry = yield* clockifyClient.getTimeEntry(auth.workspaceId, current.clockifyEntryId).pipe(
          Effect.catch(() => Effect.succeed(null))
        )
        const currentTagIds = new Set(entry?.tagIds ?? [])

        yield* Console.log(
          "Current tags: " + (allTags.filter((t) => currentTagIds.has(t.id)).map((t) => t.name).join(", ") || "none")
        )
        yield* Console.log("")

        const action = yield* Prompt.select({
          message: "Action:",
          choices: [
            { title: "Add tag", value: "add" as const },
            { title: "Remove tag", value: "remove" as const }
          ]
        })

        if (action === "add") {
          const available = allTags.filter((t) => !currentTagIds.has(t.id))
          if (available.length === 0) {
            yield* Console.log("No more tags available.")
            return
          }
          const tagId = yield* Prompt.select({
            message: "Add tag:",
            choices: available.map((t) => ({ title: t.name, value: t.id }))
          })
          if (!current.startedAt) return
          const newTagIds = [...currentTagIds, tagId]
          yield* clockifyClient.updateTimeEntry(auth.workspaceId, current.clockifyEntryId, {
            start: current.startedAt.toISOString(),
            tagIds: newTagIds,
            ...(entry?.projectId ? { projectId: entry.projectId } : {}),
            ...(entry?.billable !== undefined ? { billable: entry.billable } : {})
          }).pipe(Effect.catch((e) => Console.log(`Error: ${e.message}`)))
          yield* Console.log(`Tag added: ${allTags.find((t) => t.id === tagId)?.name}`)
        }

        if (action === "remove") {
          const current_tags = allTags.filter((t) => currentTagIds.has(t.id))
          if (current_tags.length === 0) {
            yield* Console.log("No tags to remove.")
            return
          }
          const tagId = yield* Prompt.select({
            message: "Remove tag:",
            choices: current_tags.map((t) => ({ title: t.name, value: t.id }))
          })
          if (!current.startedAt) return
          const newTagIds = [...currentTagIds].filter((id) => id !== tagId)
          yield* clockifyClient.updateTimeEntry(auth.workspaceId, current.clockifyEntryId, {
            start: current.startedAt.toISOString(),
            tagIds: newTagIds,
            ...(entry?.projectId ? { projectId: entry.projectId } : {}),
            ...(entry?.billable !== undefined ? { billable: entry.billable } : {})
          }).pipe(Effect.catch((e) => Console.log(`Error: ${e.message}`)))
          yield* Console.log(`Tag removed: ${allTags.find((t) => t.id === tagId)?.name}`)
        }
      }
    })
)
