import { expect, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { PageId } from "../src/Brand.js"
import { makeCloneOperationLayer } from "../src/commands/clone.js"
import { CloneLayer } from "../src/commands/layers.js"
import { ConfluenceClient } from "../src/ConfluenceClient.js"
import { layerFromValues as ConfluenceConfigLayerFromValues } from "../src/ConfluenceConfig.js"
import { UserCache } from "../src/internal/userCache.js"

const notCalled = Effect.die("unexpected Confluence client call")

const OperationClient = ConfluenceClient.of({
  getPage: () => notCalled,
  getChildren: () => notCalled,
  getAllChildren: () => notCalled,
  createPage: () => notCalled,
  updatePage: () => notCalled,
  deletePage: () => notCalled,
  getPageVersions: () => notCalled,
  getPageAttachments: () => notCalled,
  uploadAttachmentToPage: () => notCalled,
  getUser: (accountId) => Effect.succeed({ accountId, displayName: "Operation User" }),
  getSpaceId: () => notCalled,
  setEditorVersion: () => notCalled
})

const OperationClientLayer = Layer.succeed(ConfluenceClient, OperationClient)

const OperationConfigLayer = ConfluenceConfigLayerFromValues({
  rootPageId: PageId("root"),
  baseUrl: "https://operation.atlassian.net",
  docsPath: ".confluence/docs",
  excludePatterns: [],
  saveSource: false,
  trackedPaths: ["**/*.md"]
})

it.effect("binds clone author lookups to the operation client", () =>
  Effect.gen(function*() {
    const user = yield* Effect.gen(function*() {
      const cache = yield* UserCache
      return yield* cache.get("account-1")
    }).pipe(
      Effect.provide(makeCloneOperationLayer(OperationConfigLayer, OperationClientLayer)),
      Effect.provide(CloneLayer)
    )

    expect(user.displayName).toBe("Operation User")
  }))

it.effect("owns the operation client until the clone operation scope closes", () =>
  Effect.gen(function*() {
    const finalized = yield* Ref.make(false)
    const scopedClientLayer = Layer.effect(
      ConfluenceClient,
      Effect.acquireRelease(
        Effect.succeed(
          ConfluenceClient.of({
            ...OperationClient,
            getUser: (accountId) =>
              Ref.get(finalized).pipe(
                Effect.flatMap((isFinalized) =>
                  isFinalized
                    ? Effect.die("operation client finalized before user lookup")
                    : Effect.succeed({ accountId, displayName: "Scoped Operation User" })
                )
              )
          })
        ),
        () => Ref.set(finalized, true)
      )
    )

    const user = yield* Effect.scoped(
      Effect.gen(function*() {
        const cache = yield* UserCache
        const loaded = yield* cache.get("account-2")
        expect(yield* Ref.get(finalized)).toBe(false)
        return loaded
      }).pipe(
        Effect.provide(makeCloneOperationLayer(OperationConfigLayer, scopedClientLayer)),
        Effect.provide(CloneLayer)
      )
    )

    expect(user.displayName).toBe("Scoped Operation User")
    expect(yield* Ref.get(finalized)).toBe(true)
  }))
