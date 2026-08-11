/**
 * Git-mode `push` bookkeeping.
 *
 * `origin/confluence` is the record of what Confluence already has: advancing
 * it is what makes `findUnpushedCommits` stop reporting a file. If it moves
 * after a refused push, the refusal becomes permanent — the retry sees nothing
 * to push and even `--force` prints "Nothing to push" — so the guard that was
 * meant to protect a page ends up stranding it.
 *
 * Holding the branch back has a mirror-image failure, which is why the
 * two-run cases below exist: deletions are derived from the same unmoved diff,
 * so they replay on every retry. If a replayed deletion counts as an error the
 * workspace wedges in the other direction and no flag can free it.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Ref from "effect/Ref"
import { ContentHash, PageId } from "../src/Brand.js"
import { ConfluenceClient } from "../src/ConfluenceClient.js"
import { layerFromValues as ConfluenceConfigLayerFromValues } from "../src/ConfluenceConfig.js"
import { ApiError } from "../src/ConfluenceError.js"
import { GitService } from "../src/GitService.js"
import { computeHash, HashServiceLive } from "../src/internal/hashUtils.js"
import { UserCache } from "../src/internal/userCache.js"
import { LocalFileSystem } from "../src/LocalFileSystem.js"
import { MarkdownConverter } from "../src/MarkdownConverter.js"
import type { PageFrontMatter, PageResponse } from "../src/Schemas.js"
import { layer as SyncEngineLayer, SyncEngine } from "../src/SyncEngine.js"

const DOCS_PATH = ".confluence/docs"
const PAGE_ID = PageId("123456")
const DELETED_PAGE_ID = "999888"
const DELETED_PATH = "docs/retired.md"
const CONTENT = "# Release notes\n\nBody text.\n"

/** A macro `AdfWalker` has no case for at all — its bodies would be dropped. */
const UNSAFE_REMOTE_ADF = JSON.stringify({
  type: "doc",
  version: 1,
  content: [{ type: "multiBodiedExtension", attrs: { extensionKey: "tabs" } }]
})

const SAFE_REMOTE_ADF = JSON.stringify({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body text." }] }]
})

const remotePage = (adf: string): PageResponse => ({
  id: PAGE_ID,
  title: "Release notes",
  version: { number: 7, createdAt: "2026-01-01T00:00:00.000Z" },
  body: { atlas_doc_format: { value: adf, representation: "atlas_doc_format" } }
})

interface GitCalls {
  readonly updateBranch: number
  readonly addAll: number
}

/**
 * The pages Confluence still holds, shared across runs so a replayed deletion
 * meets the same 404 a real retry would.
 */
type RemoteState = Ref.Ref<ReadonlySet<string>>

interface DeleteCalls {
  readonly attempted: ReadonlyArray<string>
  readonly succeeded: ReadonlyArray<string>
}

const frontMatter = (contentHash: ContentHash): PageFrontMatter => ({
  pageId: PAGE_ID,
  version: 7,
  title: "Release notes",
  updated: new Date("2026-01-01T00:00:00.000Z"),
  contentHash,
  // The flag a previous pull wrote, which a --force push has to reconsider.
  roundTrip: "unsafe"
})

const TestLayer = (params: {
  readonly filePath: string
  readonly remoteAdf: string
  readonly localContentHash: ContentHash
  readonly gitCalls: Ref.Ref<GitCalls>
  readonly updates: Ref.Ref<number>
  readonly deletedFiles: ReadonlyArray<string>
  readonly remoteState: RemoteState
  readonly deleteCalls: Ref.Ref<DeleteCalls>
  readonly deleteStatus: number
  readonly remoteAdfAfterWrite: string | undefined
  readonly writtenFrontMatter: Ref.Ref<ReadonlyArray<PageFrontMatter>>
}) => {
  const filePath = params.filePath
  // Reads before the write see the stored body; reads after it see what
  // Confluence now holds, which is what push canonicalizes the file from.
  let written = false

  const deletePage = (id: string): Effect.Effect<void, ApiError> =>
    Effect.gen(function*() {
      yield* Ref.update(params.deleteCalls, (c) => ({ ...c, attempted: [...c.attempted, id] }))
      const live = yield* Ref.get(params.remoteState)
      if (!live.has(id)) {
        return yield* Effect.fail(
          new ApiError({
            status: params.deleteStatus,
            message: params.deleteStatus === 404 ? "Not Found" : "Forbidden",
            endpoint: `/pages/${id}`,
            pageId: id
          })
        )
      }
      yield* Ref.update(params.remoteState, (s) => new Set([...s].filter((x) => x !== id)))
      yield* Ref.update(params.deleteCalls, (c) => ({ ...c, succeeded: [...c.succeeded, id] }))
    })

  const ClientLayer = Layer.succeed(
    ConfluenceClient,
    ConfluenceClient.of({
      getSpaceId: () => Effect.succeed("space-1"),
      getPage: () =>
        Effect.succeed(
          remotePage(
            written && params.remoteAdfAfterWrite !== undefined ? params.remoteAdfAfterWrite : params.remoteAdf
          )
        ),
      updatePage: () =>
        Ref.update(params.updates, (n) => n + 1).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              written = true
            })
          ),
          Effect.as(remotePage(params.remoteAdfAfterWrite ?? params.remoteAdf))
        ),
      getChildren: () => Effect.die("not used"),
      getAllChildren: () => Effect.die("not used"),
      createPage: () => Effect.die("not used"),
      deletePage,
      getPageVersions: () => Effect.die("not used"),
      getPageAttachments: () => Effect.succeed([]),
      uploadAttachmentToPage: () => Effect.die("not used"),
      getUser: () => Effect.die("not used"),
      setEditorVersion: () => Effect.void
    })
  )

  const LocalFsLayer = Layer.succeed(
    LocalFileSystem,
    LocalFileSystem.of({
      listMarkdownFiles: () => Effect.succeed([filePath]),
      readMarkdownFile: () =>
        Effect.succeed({
          path: filePath,
          frontMatter: frontMatter(params.localContentHash),
          content: CONTENT,
          contentHash: params.localContentHash,
          isNew: false
        }),
      exists: () => Effect.succeed(true),
      writeMarkdownFile: (_path, frontMatter) => Ref.update(params.writtenFrontMatter, (all) => [...all, frontMatter]),
      ensureDir: () => Effect.void,
      deleteFile: () => Effect.void,
      getPagePath: () => Effect.succeed(filePath),
      getPageDir: () => Effect.succeed(DOCS_PATH),
      writeFile: () => Effect.void,
      buildPageTree: () => Effect.die("not used"),
      writeNewPageFile: () => Effect.die("not used")
    })
  )

  const GitLayer = Layer.succeed(
    GitService,
    GitService.of({
      isInitialized: () => Effect.succeed(true),
      branchExists: () => Effect.succeed(true),
      logRange: () =>
        Effect.succeed([
          { hash: "abc123", author: "A", email: "a@example.com", date: new Date(0), message: "Edit page" }
        ]),
      getDeletedFiles: () => Effect.succeed(params.deletedFiles),
      addAll: () => Ref.update(params.gitCalls, (c) => ({ ...c, addAll: c.addAll + 1 })),
      amend: () => Effect.void,
      updateBranch: () => Ref.update(params.gitCalls, (c) => ({ ...c, updateBranch: c.updateBranch + 1 })),
      validateGit: () => Effect.void,
      init: () => Effect.void,
      status: () => Effect.die("not used"),
      commit: () => Effect.die("not used"),
      log: () => Effect.succeed([]),
      diff: () => Effect.die("not used"),
      hasConflicts: () => Effect.succeed(false),
      mergeContinue: () => Effect.die("not used"),
      syncFromDocs: () => Effect.die("not used"),
      syncToDocs: () => Effect.die("not used"),
      getHead: () => Effect.die("not used"),
      getCurrentBranch: () => Effect.succeed("confluence"),
      createBranch: () => Effect.die("not used"),
      checkout: () => Effect.die("not used"),
      reset: () => Effect.die("not used"),
      deleteBranch: () => Effect.die("not used"),
      getParent: () => Effect.die("not used"),
      cherryPick: () => Effect.die("not used"),
      getChangedFiles: () => Effect.succeed([]),
      showFile: () => Effect.die("not used"),
      merge: () => Effect.die("not used"),
      // The blob origin/confluence still holds for the deleted file; push reads
      // the pageId back out of its front matter.
      getFileContentAt: () => Effect.succeed(`---\npageId: ${DELETED_PAGE_ID}\ntitle: Retired\n---\n`)
    })
  )

  const ConverterLayer = Layer.succeed(
    MarkdownConverter,
    MarkdownConverter.of({
      adfToMarkdown: () => Effect.succeed(CONTENT),
      markdownToAdf: () => Effect.succeed(SAFE_REMOTE_ADF)
    })
  )

  const UserCacheLayer = Layer.succeed(
    UserCache,
    UserCache.of({ get: () => Effect.die("not used"), clear: () => Effect.void })
  )

  const ConfigLayer = ConfluenceConfigLayerFromValues({
    rootPageId: PageId("root"),
    baseUrl: "https://example.atlassian.net",
    docsPath: DOCS_PATH,
    excludePatterns: [],
    saveSource: false,
    trackedPaths: ["**/*.md"]
  })

  return SyncEngineLayer.pipe(
    Layer.provide(Layer.mergeAll(
      ClientLayer,
      LocalFsLayer,
      GitLayer,
      ConverterLayer,
      UserCacheLayer,
      ConfigLayer,
      NodePath.layer,
      NodeFileSystem.layer
    ))
  )
}

const runPush = (params: {
  readonly remoteAdf: string
  readonly localContentHash: ContentHash
  readonly deletedFiles?: ReadonlyArray<string>
  readonly remoteState?: RemoteState
  readonly deleteStatus?: number
  readonly force?: boolean
  readonly remoteAdfAfterWrite?: string
  readonly dryRun?: boolean
}) =>
  Effect.gen(function*() {
    const gitCalls = yield* Ref.make<GitCalls>({ updateBranch: 0, addAll: 0 })
    const updates = yield* Ref.make(0)
    const deleteCalls = yield* Ref.make<DeleteCalls>({ attempted: [], succeeded: [] })
    const writtenFrontMatter = yield* Ref.make<ReadonlyArray<PageFrontMatter>>([])
    const remoteState = params.remoteState ?? (yield* Ref.make<ReadonlySet<string>>(new Set([DELETED_PAGE_ID])))

    // SyncEngine derives docsPath from the process cwd, so the fake file has to
    // sit under it or the structure check reads it as an orphaned subdirectory.
    const pathService = yield* Path.Path
    const filePath = pathService.join(pathService.resolve("."), DOCS_PATH, "release-notes.md")

    const result = yield* Effect.gen(function*() {
      const engine = yield* SyncEngine
      return yield* engine.push({
        dryRun: params.dryRun ?? false,
        ...(params.force === undefined ? {} : { force: params.force })
      })
    }).pipe(
      Effect.provide(TestLayer({
        ...params,
        filePath,
        gitCalls,
        updates,
        deletedFiles: params.deletedFiles ?? [],
        remoteState,
        deleteCalls,
        deleteStatus: params.deleteStatus ?? 404,
        remoteAdfAfterWrite: params.remoteAdfAfterWrite,
        writtenFrontMatter
      }))
    )

    return {
      result,
      git: yield* Ref.get(gitCalls),
      updates: yield* Ref.get(updates),
      deletes: yield* Ref.get(deleteCalls),
      frontMatter: yield* Ref.get(writtenFrontMatter),
      remoteState
    }
  }).pipe(Effect.provide(NodePath.layer))

describe("SyncEngine.push (git mode)", () => {
  it.effect("does not advance origin/confluence when a page was refused", () =>
    Effect.gen(function*() {
      // Local content differs from the recorded hash, so the file is a push
      // candidate; the live page holds a node markdown cannot represent.
      const { git, result, updates } = yield* runPush({
        remoteAdf: UNSAFE_REMOTE_ADF,
        localContentHash: ContentHash("0".repeat(64))
      })

      expect(result.errors).toHaveLength(1)
      expect(result.pushed).toBe(0)
      expect(updates).toBe(0)
      // The commit stays unpushed, so a retry (or --force) still has something
      // to push instead of reporting "Nothing to push".
      expect(git.updateBranch).toBe(0)
    }))

  it.effect("advances origin/confluence when every page succeeded", () =>
    Effect.gen(function*() {
      // Hash matches, so pushFile short-circuits: nothing to write, no errors.
      const hash = yield* computeHash(CONTENT).pipe(Effect.provide(HashServiceLive))
      const { git, result } = yield* runPush({ remoteAdf: SAFE_REMOTE_ADF, localContentHash: hash })

      expect(result.errors).toEqual([])
      expect(git.updateBranch).toBe(1)
    }))

  // --force is the documented escape hatch past the refusal above, and the only
  // path that knowingly degrades remote content. Nothing asserted it worked.
  it.effect("--force pushes the refused page and advances the branch", () =>
    Effect.gen(function*() {
      const { git, result, updates } = yield* runPush({
        remoteAdf: UNSAFE_REMOTE_ADF,
        localContentHash: ContentHash("0".repeat(64)),
        force: true
      })

      expect(result.errors).toEqual([])
      expect(result.pushed).toBe(1)
      expect(updates).toBe(1)
      expect(git.updateBranch).toBe(1)
    }))

  // A preview that cannot surface the one failure the guard exists to raise is
  // the least useful place for it to stay quiet — especially now that the real
  // push parks the branch on any error. `page patch --dry-run` validates for
  // the same reason; these two must not drift apart.
  it.effect("--dry-run reports the refusal instead of a clean preview", () =>
    Effect.gen(function*() {
      const { git, result, updates } = yield* runPush({
        remoteAdf: UNSAFE_REMOTE_ADF,
        localContentHash: ContentHash("0".repeat(64)),
        dryRun: true
      })

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain("markdown cannot")
      // Still a dry run.
      expect(updates).toBe(0)
      expect(git.updateBranch).toBe(0)
    }))

  // The nearby valid fixture: a safe page still previews as pushable.
  it.effect("--dry-run reports a safe page as pushable", () =>
    Effect.gen(function*() {
      const { result, updates } = yield* runPush({
        remoteAdf: SAFE_REMOTE_ADF,
        localContentHash: ContentHash("0".repeat(64)),
        dryRun: true
      })

      expect(result.errors).toEqual([])
      expect(result.pushed).toBe(1)
      expect(updates).toBe(0)
    }))

  // Deletions come from the origin/confluence↔HEAD diff, not from the files
  // still on disk, so a preview that walks only the disk reported nothing for a
  // workspace whose one pending change was a deletion — and `sync push` prints
  // "Nothing to push" for a zero count, right before the real run deletes the
  // page for good.
  it.effect("--dry-run counts a pending deletion", () =>
    Effect.gen(function*() {
      const hash = yield* computeHash(CONTENT).pipe(Effect.provide(HashServiceLive))
      const { deletes, result } = yield* runPush({
        remoteAdf: SAFE_REMOTE_ADF,
        localContentHash: hash,
        deletedFiles: [DELETED_PATH],
        dryRun: true
      })

      expect(result.deleted).toBe(1)
      // Still a dry run: nothing was deleted remotely.
      expect(deletes.attempted).toEqual([])
    }))

  // The nearby valid fixture: no deletion in the diff still previews as zero.
  it.effect("--dry-run reports no deletions when the diff has none", () =>
    Effect.gen(function*() {
      const hash = yield* computeHash(CONTENT).pipe(Effect.provide(HashServiceLive))
      const { result } = yield* runPush({
        remoteAdf: SAFE_REMOTE_ADF,
        localContentHash: hash,
        dryRun: true
      })

      expect(result.deleted).toBe(0)
    }))

  // --force degrades the unsafe nodes, so the page Confluence ends up holding
  // is no longer unsafe. Inheriting `roundTrip` through the `...fm` spread kept
  // warning about a page that had already been flattened, until the next pull
  // happened to rewrite the front matter.
  it.effect("--force clears roundTrip once the remote no longer holds unsafe nodes", () =>
    Effect.gen(function*() {
      const { frontMatter: written } = yield* runPush({
        remoteAdf: UNSAFE_REMOTE_ADF,
        remoteAdfAfterWrite: SAFE_REMOTE_ADF,
        localContentHash: ContentHash("0".repeat(64)),
        force: true
      })

      expect(written).toHaveLength(1)
      expect(written[0]?.roundTrip).toBeUndefined()
    }))

  // The nearby valid fixture: a page that is still unsafe afterwards keeps the
  // flag, so the warning is not simply dropped on every push.
  it.effect("keeps roundTrip when the remote is still unsafe after the write", () =>
    Effect.gen(function*() {
      const { frontMatter: written } = yield* runPush({
        remoteAdf: UNSAFE_REMOTE_ADF,
        localContentHash: ContentHash("0".repeat(64)),
        force: true
      })

      expect(written[0]?.roundTrip).toBe("unsafe")
    }))

  // Two runs against one remote. The first deletes a page and is then refused
  // elsewhere, so the branch stays put and the deletion is still in the diff.
  // The second replays it against a Confluence that no longer has the page.
  it.effect("a replayed deletion does not wedge the retry", () =>
    Effect.gen(function*() {
      const remoteState = yield* Ref.make<ReadonlySet<string>>(new Set([DELETED_PAGE_ID]))

      const first = yield* runPush({
        remoteAdf: UNSAFE_REMOTE_ADF,
        localContentHash: ContentHash("0".repeat(64)),
        deletedFiles: [DELETED_PATH],
        remoteState
      })

      expect(first.deletes.succeeded).toEqual([DELETED_PAGE_ID])
      expect(first.result.deleted).toBe(1)
      expect(first.result.errors).toHaveLength(1)
      expect(first.git.updateBranch).toBe(0)

      const second = yield* runPush({
        remoteAdf: UNSAFE_REMOTE_ADF,
        localContentHash: ContentHash("0".repeat(64)),
        deletedFiles: [DELETED_PATH],
        remoteState,
        force: true
      })

      // The page is already gone, so the replay 404s — and that must not count
      // as a failure, or the branch could never advance again.
      expect(second.deletes.attempted).toEqual([DELETED_PAGE_ID])
      expect(second.deletes.succeeded).toEqual([])
      expect(second.result.deleted).toBe(0)
      expect(second.result.errors).toEqual([])
      expect(second.git.updateBranch).toBe(1)
    }))

  // The nearby valid fixture: a deletion that fails for any other reason is
  // still a real failure and must keep the branch parked.
  it.effect("a deletion refused with 403 still blocks the branch", () =>
    Effect.gen(function*() {
      const hash = yield* computeHash(CONTENT).pipe(Effect.provide(HashServiceLive))
      const remoteState = yield* Ref.make<ReadonlySet<string>>(new Set())

      const { deletes, git, result } = yield* runPush({
        remoteAdf: SAFE_REMOTE_ADF,
        localContentHash: hash,
        deletedFiles: [DELETED_PATH],
        remoteState,
        deleteStatus: 403
      })

      expect(deletes.attempted).toEqual([DELETED_PAGE_ID])
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain(DELETED_PAGE_ID)
      expect(git.updateBranch).toBe(0)
    }))
})
