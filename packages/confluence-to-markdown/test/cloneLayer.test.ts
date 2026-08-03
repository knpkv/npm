import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
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
    const operationClient = yield* ConfluenceClient.pipe(Effect.provide(OperationClientLayer))
    const user = yield* Effect.gen(function*() {
      const cache = yield* UserCache
      return yield* cache.get("account-1")
    }).pipe(Effect.provide(makeCloneOperationLayer(OperationConfigLayer, operationClient)))

    expect(user.displayName).toBe("Operation User")
  }).pipe(Effect.provide(CloneLayer)))
