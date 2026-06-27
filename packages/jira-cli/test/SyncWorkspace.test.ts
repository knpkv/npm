import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { SyncBaseline } from "../src/internal/sync/types.js"
import { layer as SyncWorkspaceLayer, SyncWorkspace } from "../src/SyncWorkspace.js"

const TestLayer = SyncWorkspaceLayer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer)
)

const makeTempRoot = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped()
})

describe("SyncWorkspace", () => {
  it.effect("initializes workspace metadata and visible documents directory", () =>
    Effect.gen(function*() {
      const root = yield* makeTempRoot
      const workspace = yield* SyncWorkspace
      const paths = yield* workspace.init({ root, siteUrl: "https://example.atlassian.net" })
      const fs = yield* FileSystem.FileSystem

      expect(yield* fs.exists(paths.documentsDir)).toBe(true)
      expect(yield* fs.exists(paths.configFile)).toBe(true)
      expect(yield* fs.exists(paths.manifestFile)).toBe(true)
      expect(yield* fs.exists(paths.baselinesDir)).toBe(true)
      expect(yield* fs.exists(paths.historyDir)).toBe(true)

      const config = yield* workspace.readConfig(root)
      const manifest = yield* workspace.readManifest(root)
      expect(config.siteUrl).toBe("https://example.atlassian.net")
      expect(config.documentsDir).toBe("issues")
      expect(manifest.issues).toEqual([])
    }).pipe(Effect.provide(TestLayer), Effect.scoped))

  it.effect("writes and reads baselines by issue id", () =>
    Effect.gen(function*() {
      const root = yield* makeTempRoot
      const workspace = yield* SyncWorkspace
      yield* workspace.init({ root, siteUrl: "https://example.atlassian.net" })

      const baseline: SyncBaseline = {
        version: 1,
        issueId: "100123",
        issueKey: "PROJ-123",
        fields: {
          summary: "Fix checkout copy",
          description: "Description",
          labels: ["copy"],
          customFields: {}
        },
        comments: []
      }

      yield* workspace.writeBaseline(root, baseline)
      expect(yield* workspace.readBaseline(root, "100123")).toEqual(baseline)
    }).pipe(Effect.provide(TestLayer), Effect.scoped))

  it.effect("uses configured documents directory for convention document paths", () =>
    Effect.gen(function*() {
      const root = yield* makeTempRoot
      const workspace = yield* SyncWorkspace
      const path = yield* Path.Path
      yield* workspace.init({ root, siteUrl: "https://example.atlassian.net" })
      const config = yield* workspace.readConfig(root)
      yield* workspace.writeConfig(root, { ...config, documentsDir: "issue-docs" })

      const filePath = yield* workspace.conventionDocumentPath(root, "PROJ-123")
      expect(filePath).toBe(path.join(root, "issue-docs", "PROJ-123.md"))
    }).pipe(Effect.provide(TestLayer), Effect.scoped))
})
