/**
 * Effect service for browse data operations.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { PageId } from "../../Brand.js"
import { ConfluenceClient } from "../../ConfluenceClient.js"
import { ConfluenceConfig } from "../../ConfluenceConfig.js"
import type { ApiError, ConversionError, RateLimitError } from "../../ConfluenceError.js"
import { MarkdownConverter } from "../../MarkdownConverter.js"
import { SyncEngine } from "../../SyncEngine.js"
import type { BrowseItem, ParentResult } from "./BrowseItem.js"

/**
 * Errors that can occur during browse operations.
 */
export type BrowseError = ApiError | RateLimitError | ConversionError

/**
 * Service interface for browse operations.
 */
export interface BrowseService {
  readonly getChildren: (item: BrowseItem) => Effect.Effect<ReadonlyArray<BrowseItem>, BrowseError>
  readonly getParentAndSiblings: (item: BrowseItem) => Effect.Effect<Option.Option<ParentResult>, BrowseError>
  readonly getPreview: (item: BrowseItem) => Effect.Effect<string, BrowseError>
  readonly openInBrowser: (item: BrowseItem) => Effect.Effect<void>
  readonly getRootItem: Effect.Effect<BrowseItem, BrowseError>
  readonly siteName: string
}

export const BrowseService = Context.GenericTag<BrowseService>("@knpkv/confluence-to-markdown/BrowseService")

/**
 * Live implementation of BrowseService.
 */
export const BrowseServiceLive = Layer.effect(
  BrowseService,
  Effect.gen(function*() {
    const client = yield* ConfluenceClient
    const config = yield* ConfluenceConfig
    const converter = yield* MarkdownConverter
    const syncEngine = yield* SyncEngine

    // Get sync status to determine which pages are synced
    const statusResult = yield* syncEngine.status().pipe(
      Effect.catchAll(() => Effect.succeed({ files: [] as const }))
    )

    // Build set of synced titles
    const syncedTitles = new Set(
      statusResult.files
        .filter((f) => f._tag === "Synced" || f._tag === "LocalModified" || f._tag === "RemoteModified")
        .map((f) => {
          const path = "path" in f ? f.path : ""
          const filename = path.split("/").pop() ?? ""
          return filename.replace(/\.md$/, "").toLowerCase()
        })
    )

    const isSynced = (title: string): boolean => syncedTitles.has(title.toLowerCase().replace(/[^a-z0-9]+/g, "-"))

    const siteName = config.baseUrl.replace("https://", "").replace(".atlassian.net/wiki", "")

    return BrowseService.of({
      siteName,

      getRootItem: Effect.gen(function*() {
        const rootPage = yield* client.getPage(config.rootPageId)
        return {
          id: config.rootPageId,
          title: rootPage.title,
          synced: isSynced(rootPage.title),
          ...(rootPage.parentId ? { parentId: rootPage.parentId as PageId } : {})
        }
      }),

      getChildren: (item) =>
        Effect.gen(function*() {
          const response = yield* client.getChildren(item.id)
          return response.results.map((child): BrowseItem => ({
            id: child.id as PageId,
            title: child.title,
            synced: isSynced(child.title),
            parentId: item.id
          }))
        }),

      getParentAndSiblings: (item) =>
        Effect.gen(function*() {
          // Use cached parentId if available
          let parentId = item.parentId
          if (!parentId) {
            const page = yield* client.getPage(item.id)
            parentId = page.parentId as PageId | undefined
          }
          if (!parentId) {
            return Option.none()
          }
          // Fetch parent and siblings in parallel
          const [parentPage, siblingsResponse] = yield* Effect.all([
            client.getPage(parentId),
            client.getChildren(parentId)
          ], { concurrency: 2 })

          return Option.some({
            parent: {
              id: parentPage.id as PageId,
              title: parentPage.title,
              synced: isSynced(parentPage.title),
              ...(parentPage.parentId ? { parentId: parentPage.parentId as PageId } : {})
            },
            siblings: siblingsResponse.results.map((s): BrowseItem => ({
              id: s.id as PageId,
              title: s.title,
              synced: isSynced(s.title),
              parentId
            }))
          })
        }),

      getPreview: (item) =>
        Effect.gen(function*() {
          const page = yield* client.getPage(item.id)
          const html = page.body?.storage?.value ?? ""
          return yield* converter.htmlToMarkdown(html)
        }),

      openInBrowser: (item) =>
        Effect.sync(() => {
          const url = `${config.baseUrl}/wiki/spaces/${config.spaceKey}/pages/${item.id}`
          import("child_process").then(({ exec }) => exec(`open "${url}"`))
        })
    })
  })
)
