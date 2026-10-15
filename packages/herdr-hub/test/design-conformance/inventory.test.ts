import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { loadReferences } from "../../../design-conformance/src/references.js"
import { readReviewCapability, reviewInventory, reviewRoute } from "./inventory.js"

const build = Effect.fn("CodeReviewConformance.testBuild")(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repository = yield* fs.makeTempDirectoryScoped({ prefix: "code-review-capability-" })
  const hub = path.join(repository, "packages/herdr-hub/dist")
  const web = path.join(repository, "packages/codecommit-web/dist")
  yield* fs.makeDirectory(hub, { recursive: true })
  yield* fs.makeDirectory(path.join(web, "dts"), { recursive: true })
  yield* fs.makeDirectory(path.join(web, "views"), { recursive: true })
  const approval = path.join(hub, "approval.js")
  const contract = path.join(web, "dts/host-contract.d.ts")
  const views = path.join(web, "views/index.js")
  yield* fs.writeFileString(approval, "const owner = \"data-code-review-owner data-code-review-page\"")
  yield* fs.writeFileString(contract, "export declare const CodeReviewResult: unknown")
  yield* fs.writeFileString(views, "export { workspace as ReviewWorkspaceView }")
  return { repository, approval, contract, views }
})

it.layer(NodeServices.layer)("Code built capability", (it) => {
  it.effect("discovers implemented Review only when both built UI and contract expose it", () =>
    Effect.gen(function*() {
      const built = yield* build()
      expect(yield* readReviewCapability(built.repository)).toBe("review")
    }).pipe(Effect.scoped))

  it.effect("refuses the old dialog embedding when only the workspace marker is built", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const built = yield* build()
      yield* fs.writeFileString(built.approval, "const owner = \"data-code-review-owner\"")
      expect(yield* readReviewCapability(built.repository).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RunnerFailure" }
      })
    }).pipe(Effect.scoped))

  it.effect("captures no new Review states on a complete legacy build", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const built = yield* build()
      yield* fs.writeFileString(built.approval, "const queue = true")
      yield* fs.writeFileString(built.contract, "export declare const CodeQueue: unknown")
      yield* fs.writeFileString(built.views, "export { queue as CodeHostView }")
      expect(yield* readReviewCapability(built.repository)).toBe("legacy")
    }).pipe(Effect.scoped))

  const outputs: ReadonlyArray<"approval" | "contract" | "views"> = ["approval", "contract", "views"]
  for (const missing of outputs) {
    it.effect(`refuses a partial Review build with an old ${missing}`, () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const built = yield* build()
        yield* fs.writeFileString(built[missing], "export const legacy = true")
        expect(yield* readReviewCapability(built.repository).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "RunnerFailure", detail: "Built Code review UI, view exports and host contract disagree" }
        })
      }).pipe(Effect.scoped))

    it.effect(`refuses missing ${missing} output instead of claiming an empty inventory`, () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const built = yield* build()
        yield* fs.remove(built[missing])
        expect(yield* readReviewCapability(built.repository).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "RunnerFailure",
            detail: expect.stringContaining("Cannot inspect required Code product build")
          }
        })
      }).pipe(Effect.scoped))
  }
})

it("enumerates actual read routes independently of references, with dark-only reachable Hub states", () => {
  const inventory = reviewInventory()
  expect(inventory.states).toHaveLength(33)
  expect(inventory.states.some(({ state }) => state === "review-history-not-saved")).toBe(false)
  expect(reviewRoute("deleted-comment")).toContain("view=conversation")
  expect(reviewRoute("diff-rejected")).toContain("file=0")
  expect(reviewRoute("review-ready-readonly-legacy")).not.toContain("view=")
  for (const state of inventory.states) {
    expect(state.viewports).toEqual([390, 1280])
    expect(state.themes).toEqual(["dark"])
  }
})

it.layer(NodeServices.layer)("Code frozen reference inputs", (it) => {
  it.effect("declares the actual retry button for every combined history and comment fallback", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../../../design-refs/code-review", import.meta.url))
      const refs = yield* loadReferences(root)
      const states = [
        "review-run-unavailable-no-comments",
        "review-run-unavailable-comments-over-limit",
        "review-run-unavailable-comments-corrupt",
        "review-conversation-comments-unavailable",
        "review-threads-conflict",
        "review-conversation-threads-conflict"
      ]
      for (const state of states) {
        const reference = refs.manifest.states.find((candidate) => candidate.state === state)
        expect(reference?.regions, state).toContain("action")
      }
      expect(refs.manifest.states.find(({ state }) => state === "review-clean-readonly")?.regions)
        .not.toContain("action")
    }))

  it.effect("declares both existing notice owners when history and comments fail together", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../../../design-refs/code-review", import.meta.url))
      const refs = yield* loadReferences(root)
      const states = [
        "review-run-unavailable-no-comments",
        "review-run-unavailable-comments-over-limit",
        "review-run-unavailable-comments-corrupt",
        "review-conversation-comments-unavailable"
      ]
      for (const state of states) {
        const reference = refs.manifest.states.find((candidate) => candidate.state === state)
        expect(reference?.regions, state).toContain("history-notice")
        expect(reference?.regions, state).toContain("notice")
      }
      expect(refs.manifest.states.find(({ state }) => state === "review-run-unavailable")?.regions)
        .not.toContain("history-notice")
    }))

  it.effect("verifies frozen bytes and covers actual Hub routes without inventing the standalone history owner", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../../../design-refs/code-review", import.meta.url))
      const refs = yield* loadReferences(root)
      const implemented = refs.manifest.states.filter(({ status }) => status === "implemented")
      expect(
        implemented.map(({ route, screen, state, themes, viewports }) => ({ screen, state, route, viewports, themes }))
      )
        .toEqual(reviewInventory().states)
      expect(refs.manifest.states.filter(({ status }) => status === "designed"))
        .toMatchObject([{ screen: "code-review-owner", state: "review-history-not-saved" }])
    }))
})
