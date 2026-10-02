import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"
import { Command } from "effect/unstable/cli"
import { root } from "../src/cli/root.js"
import { FAKE_WORKSPACE_ID, makeFakeHeadless } from "../src/testing/fakeHeadless.js"

// @effect-diagnostics strictEffectProvide:off

const START = "2026-07-01T10:00:00.000Z"
type PromptKey = "up" | "down" | "space" | "enter"
const tagActions: ReadonlyArray<"add" | "remove"> = ["add", "remove"]
const editableFields: ReadonlyArray<"project" | "billable"> = ["project", "billable"]
const tags = ["tag-a", "tag-b", "tag-c"].map((id) => ({
  id,
  name: id.toUpperCase(),
  workspaceId: FAKE_WORKSPACE_ID,
  archived: false
}))

const editOptions = (action: "add" | "remove", failFinalRead: boolean) => {
  let prompt = 0
  const promptInputs: ReadonlyArray<ReadonlyArray<PromptKey>> = [
    ["down", "down", "enter"],
    action === "add" ? ["enter"] : ["down", "enter"],
    ["enter"]
  ]
  return {
    clockifyEntries: [{
      id: "running-1",
      description: "[PROJ-1] synthetic task",
      start: START,
      projectId: "project-1",
      billable: false,
      tagIds: ["tag-a", "tag-b"]
    }],
    clockifyTags: tags,
    runningTimer: { description: "[PROJ-1] synthetic task", start: START },
    promptInputs,
    beforePromptInput: (world: ReturnType<typeof makeFakeHeadless>["world"]) => {
      prompt++
      if (failFinalRead && prompt === 3) world.clockifyEntryReadFailuresRemaining = 1
    }
  }
}

const runEdit = (action: "add" | "remove", failFinalRead: boolean) => {
  const fake = makeFakeHeadless(editOptions(action, failFinalRead))
  return TestClock.setTime(Date.parse("2026-07-01T11:00:00.000Z")).pipe(
    Effect.andThen(Command.runWith(root, { version: "0.0.0-test" })(["timer", "edit"])),
    Effect.exit,
    Effect.provide(fake.layer),
    Effect.as(fake.world)
  )
}

const runFieldEdit = (field: "project" | "billable", failFinalRead: boolean) => {
  let prompt = 0
  const fake = makeFakeHeadless({
    clockifyEntries: [{
      id: "running-1",
      description: "[PROJ-1] synthetic task",
      start: START,
      projectId: "project-1",
      billable: false,
      tagIds: ["tag-a", "tag-b"]
    }],
    clockifyProjects: [{
      id: "project-2",
      name: "Project Two",
      workspaceId: FAKE_WORKSPACE_ID,
      archived: false,
      billable: true,
      color: "#123456"
    }],
    runningTimer: { description: "[PROJ-1] synthetic task", start: START },
    promptInputs: field === "project"
      ? [["enter"], ["enter"]]
      : [["down", "enter"], ["enter"]],
    beforePromptInput: (world) => {
      prompt++
      if (failFinalRead && prompt === 2) world.clockifyEntryReadFailuresRemaining = 1
    }
  })
  return TestClock.setTime(Date.parse("2026-07-01T11:00:00.000Z")).pipe(
    Effect.andThen(Command.runWith(root, { version: "0.0.0-test" })(["timer", "edit"])),
    Effect.exit,
    Effect.provide(fake.layer),
    Effect.as(fake.world)
  )
}

describe("timer edit", () => {
  for (const action of tagActions) {
    it.effect(`does not ${action} tags when the required final entry read fails`, () =>
      runEdit(action, true).pipe(
        Effect.map((world) => {
          expect(world.updatedClockifyEntries).toEqual([])
          expect(world.stdout.join("\n")).toContain("Error:")
        })
      ))
  }

  it.effect("adds a tag from the fresh entry while preserving unrelated fields", () =>
    runEdit("add", false).pipe(
      Effect.map((world) => {
        expect(world.updatedClockifyEntries).toHaveLength(1)
        expect(world.updatedClockifyEntries[0]?.payload).toMatchObject({
          projectId: "project-1",
          billable: false,
          tagIds: ["tag-a", "tag-b", "tag-c"]
        })
      })
    ))

  it.effect("removes one tag from the fresh entry while preserving unrelated fields", () =>
    runEdit("remove", false).pipe(
      Effect.map((world) => {
        expect(world.updatedClockifyEntries).toHaveLength(1)
        expect(world.updatedClockifyEntries[0]?.payload).toMatchObject({
          projectId: "project-1",
          billable: false,
          tagIds: ["tag-b"]
        })
      })
    ))

  for (const field of editableFields) {
    it.effect(`does not edit ${field} when its preserving entry read fails`, () =>
      runFieldEdit(field, true).pipe(
        Effect.map((world) => {
          expect(world.updatedClockifyEntries).toEqual([])
          expect(world.stdout.join("\n")).toContain("Error:")
        })
      ))
  }

  it.effect("changes the project without dropping billable or tags", () =>
    runFieldEdit("project", false).pipe(
      Effect.map((world) => {
        expect(world.updatedClockifyEntries[0]?.payload).toMatchObject({
          projectId: "project-2",
          billable: false,
          tagIds: ["tag-a", "tag-b"]
        })
      })
    ))

  it.effect("changes billable without dropping the project or tags", () =>
    runFieldEdit("billable", false).pipe(
      Effect.map((world) => {
        expect(world.updatedClockifyEntries[0]?.payload).toMatchObject({
          projectId: "project-1",
          billable: true,
          tagIds: ["tag-a", "tag-b"]
        })
      })
    ))
})
