/**
 * Timer `edit` command.
 *
 * @module
 */
import { ClockifyApiClient, type Project, type Tag } from "@knpkv/clockify-api-client"
import { Console, Data, Effect, Runtime, SubscriptionRef } from "effect"
import { Command, Prompt } from "effect/unstable/cli"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { TimerService } from "../../services/TimerService.js"
import * as WriterGuard from "../writerGuard.js"

/** A guarded edit was refused after its reason was printed; fails so a script sees non-zero. */
export class TimerEditFailedError extends Data.TaggedError("TimerEditFailedError")<{
  readonly message: string
}> {
  override readonly [Runtime.errorReported] = false
}

type EditableField = "project" | "billable" | "tags"
type TagEditAction = "add" | "remove"

const projectField: EditableField = "project"
const billableField: EditableField = "billable"
const tagsField: EditableField = "tags"
const addTagAction: TagEditAction = "add"
const removeTagAction: TagEditAction = "remove"
const emptyProjects = (): ReadonlyArray<Project> => []
const emptyTags = (): ReadonlyArray<Tag> => []

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
      if (auth === null || current.clockifyEntryId === null) {
        yield* Console.log("Cannot edit: missing Clockify auth or entry ID.")
        return
      }
      const clockifyEntryId = current.clockifyEntryId

      const what = yield* Prompt.select({
        message: "What to edit?",
        choices: [
          {
            title: `Project (current: ${current.projectName ?? current.projectId ?? "none"})`,
            value: projectField
          },
          {
            title: `Billable (current: ${
              current.billable === true ? "yes" : current.billable === false ? "no" : "unset"
            })`,
            value: billableField
          },
          { title: "Tags", value: tagsField }
        ]
      })

      if (what === "project") {
        const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
          Effect.catch(() => Effect.succeed(emptyProjects()))
        )
        const selected = yield* Prompt.select({
          message: "Select project:",
          choices: [
            ...projects.map((p) => ({ title: p.name, value: p.id })),
            { title: "(none)", value: "" }
          ]
        })
        const startedAt = current.startedAt
        if (startedAt === null) return
        yield* WriterGuard.mutate(Effect.gen(function*() {
          const entry = yield* clockifyClient.getTimeEntry(auth.workspaceId, clockifyEntryId)
          yield* clockifyClient.updateTimeEntry(auth.workspaceId, clockifyEntryId, {
            start: startedAt.toISOString(),
            ...(selected && { projectId: selected }),
            ...((entry?.tagIds && entry.tagIds.length > 0) && { tagIds: [...entry.tagIds] }),
            ...((entry?.billable !== undefined) && { billable: entry.billable })
          })
        })).pipe(
          Effect.catch((error) =>
            Console.log(`Error: ${error.message}`).pipe(
              Effect.andThen(Effect.fail(new TimerEditFailedError({ message: error.message })))
            )
          )
        )

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
        const startedAt = current.startedAt
        if (startedAt === null) return
        yield* WriterGuard.mutate(Effect.gen(function*() {
          const entry = yield* clockifyClient.getTimeEntry(auth.workspaceId, clockifyEntryId)
          yield* clockifyClient.updateTimeEntry(auth.workspaceId, clockifyEntryId, {
            start: startedAt.toISOString(),
            billable: val,
            ...((entry?.projectId) && { projectId: entry.projectId }),
            ...((entry?.tagIds && entry.tagIds.length > 0) && { tagIds: [...entry.tagIds] })
          })
        })).pipe(
          Effect.catch((error) =>
            Console.log(`Error: ${error.message}`).pipe(
              Effect.andThen(Effect.fail(new TimerEditFailedError({ message: error.message })))
            )
          )
        )

        yield* Console.log(`Billable updated: ${val ? "yes" : "no"}`)
      }

      if (what === "tags") {
        const allTags = yield* clockifyClient.getTags(auth.workspaceId).pipe(
          Effect.catch(() => Effect.succeed(emptyTags()))
        )
        const entry = yield* clockifyClient.getTimeEntry(auth.workspaceId, clockifyEntryId).pipe(
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
            { title: "Add tag", value: addTagAction },
            { title: "Remove tag", value: removeTagAction }
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
          const startedAt = current.startedAt
          if (startedAt === null) return
          yield* WriterGuard.mutate(Effect.gen(function*() {
            const latest = yield* clockifyClient.getTimeEntry(auth.workspaceId, clockifyEntryId)
            const newTagIds = [...new Set([...(latest?.tagIds ?? []), tagId])]
            yield* clockifyClient.updateTimeEntry(auth.workspaceId, clockifyEntryId, {
              start: startedAt.toISOString(),
              tagIds: newTagIds,
              ...((latest?.projectId) && { projectId: latest.projectId }),
              ...((latest?.billable !== undefined) && { billable: latest.billable })
            })
          })).pipe(
            Effect.catch((error) =>
              Console.log(`Error: ${error.message}`).pipe(
                Effect.andThen(Effect.fail(new TimerEditFailedError({ message: error.message })))
              )
            )
          )
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
          const startedAt = current.startedAt
          if (startedAt === null) return
          yield* WriterGuard.mutate(Effect.gen(function*() {
            const latest = yield* clockifyClient.getTimeEntry(auth.workspaceId, clockifyEntryId)
            const newTagIds = (latest?.tagIds ?? []).filter((id) => id !== tagId)
            yield* clockifyClient.updateTimeEntry(auth.workspaceId, clockifyEntryId, {
              start: startedAt.toISOString(),
              tagIds: newTagIds,
              ...((latest?.projectId) && { projectId: latest.projectId }),
              ...((latest?.billable !== undefined) && { billable: latest.billable })
            })
          })).pipe(
            Effect.catch((error) =>
              Console.log(`Error: ${error.message}`).pipe(
                Effect.andThen(Effect.fail(new TimerEditFailedError({ message: error.message })))
              )
            )
          )
          yield* Console.log(`Tag removed: ${allTags.find((t) => t.id === tagId)?.name}`)
        }
      }
    })
)
