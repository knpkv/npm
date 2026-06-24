import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import type { PageId } from "../src/Brand.js"
import { ConfluenceClient } from "../src/ConfluenceClient.js"
import { makeFetchCommand } from "../src/commands/fetch.js"
import type { PageResponse } from "../src/Schemas.js"
import { CommandHarnessLayer, runConfluenceCommand } from "./commandHarness.js"

const page: PageResponse = {
  id: "2333334354",
  title: "Harness Page",
  version: { number: 1 },
  body: {
    atlas_doc_format: {
      representation: "atlas_doc_format",
      value: JSON.stringify({ type: "doc", version: 1, content: [] })
    }
  }
}

const FetchClientLayer = Layer.succeed(
  ConfluenceClient,
  ConfluenceClient.of({
    getPage: (pageId: PageId) => pageId === "2333334354"
      ? Effect.succeed(page)
      : Effect.die(`unexpected page ID: ${pageId}`),
    getChildren: () => Effect.die("unused"),
    getAllChildren: () => Effect.die("unused"),
    createPage: () => Effect.die("unused"),
    updatePage: () => Effect.die("unused"),
    deletePage: () => Effect.die("unused"),
    getPageVersions: () => Effect.die("unused"),
    getUser: () => Effect.die("unused"),
    getSpaceId: () => Effect.die("unused"),
    setEditorVersion: () => Effect.die("unused")
  })
)

describe("command harness", () => {
  it.effect("runs fetch through the root command without calling GitService", () =>
    Effect.gen(function*() {
      const gitCalls = yield* Ref.make(0)
      const stdout = yield* Ref.make("")
      const fetch = makeFetchCommand({ makeClientLayer: () => FetchClientLayer })

      const exit = yield* runConfluenceCommand([
        "fetch",
        "--url",
        "https://example.atlassian.net/wiki/pages/2333334354"
      ], { fetch }).pipe(Effect.provide(CommandHarnessLayer({ gitCalls, stdout })))
      const calls = yield* Ref.get(gitCalls)
      const output = yield* Ref.get(stdout)

      expect(exit._tag).toBe("Success")
      expect(output).toBe("# Harness Page\n")
      expect(calls).toBe(0)
    }))

  it.effect("rejects conflicting clone URL input before calling GitService", () =>
    Effect.gen(function*() {
      const gitCalls = yield* Ref.make(0)
      const stdout = yield* Ref.make("")

      const exit = yield* runConfluenceCommand([
        "clone",
        "--url",
        "https://example.atlassian.net/wiki/pages/2333334354",
        "--base-url",
        "https://example.atlassian.net"
      ]).pipe(Effect.provide(CommandHarnessLayer({ gitCalls, stdout })))
      const calls = yield* Ref.get(gitCalls)

      expect(exit._tag).toBe("Failure")
      expect(calls).toBe(0)
    }))
})
