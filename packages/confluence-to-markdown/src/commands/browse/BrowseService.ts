/**
 * Effect service for browse data operations.
 */
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { ContentHash, PageId, SpaceId } from "../../Brand.js"
import { ConfluenceClient } from "../../ConfluenceClient.js"
import { ConfluenceConfig } from "../../ConfluenceConfig.js"
import { ApiError, type ConversionError, type FileSystemError, type RateLimitError } from "../../ConfluenceError.js"
import { LocalFileSystem } from "../../LocalFileSystem.js"
import { MarkdownConverter } from "../../MarkdownConverter.js"
import { SyncEngine } from "../../SyncEngine.js"
import type { BrowseItem, PageBrowseItem, ParentResult, SpaceBrowseItem } from "./BrowseItem.js"

/**
 * Errors that can occur during browse operations.
 */
export type BrowseError = ApiError | RateLimitError | ConversionError | FileSystemError

/**
 * Browse mode: 'configured' starts at rootPageId, 'spaces' lists all spaces.
 */
export type BrowseMode = "configured" | "spaces"

/**
 * Service interface for browse operations.
 */
export interface BrowseService {
  readonly mode: BrowseMode
  readonly getChildren: (item: BrowseItem) => Effect.Effect<ReadonlyArray<BrowseItem>, BrowseError>
  readonly getParentAndSiblings: (item: BrowseItem) => Effect.Effect<Option.Option<ParentResult>, BrowseError>
  readonly getPreview: (item: BrowseItem) => Effect.Effect<string, BrowseError>
  readonly openInBrowser: (item: BrowseItem) => Effect.Effect<void>
  readonly getStatus: Effect.Effect<string>
  readonly getRootItem: Effect.Effect<BrowseItem, BrowseError>
  readonly pullPage: (item: BrowseItem) => Effect.Effect<string, BrowseError>
  readonly createNewPage: (parentId: PageId, title: string) => Effect.Effect<string, BrowseError>
  readonly siteName: string
  /** Get all spaces (only in spaces mode) */
  readonly getSpaces: Effect.Effect<ReadonlyArray<SpaceBrowseItem>, BrowseError>
}

export const BrowseService = Context.GenericTag<BrowseService>("@knpkv/confluence-to-markdown/BrowseService")

/**
 * Live implementation of BrowseService.
 */
/** Slugify a title for use as filename */
const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

export const BrowseServiceLive = Layer.effect(
  BrowseService,
  Effect.gen(function*() {
    const client = yield* ConfluenceClient
    const config = yield* ConfluenceConfig
    const converter = yield* MarkdownConverter
    const syncEngine = yield* SyncEngine
    const localFs = yield* LocalFileSystem
    const pathService = yield* Path.Path

    const docsPath = pathService.join(process.cwd(), config.docsPath)

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
      mode: "configured",
      siteName,

      getSpaces: Effect.succeed([]),

      getRootItem: Effect.gen(function*() {
        const rootPage = yield* client.getPage(config.rootPageId)
        return {
          type: "page",
          id: config.rootPageId,
          title: rootPage.title,
          synced: isSynced(rootPage.title),
          ...(rootPage.parentId ? { parentId: rootPage.parentId as PageId } : {})
        } as PageBrowseItem
      }),

      getChildren: (item) =>
        Effect.gen(function*() {
          if (item.type === "space") {
            // Get root pages in space
            const pages = yield* client.getRootPagesInSpace(item.id)
            return pages.map((p): PageBrowseItem => ({
              type: "page",
              id: p.id as PageId,
              title: p.title,
              synced: isSynced(p.title),
              spaceId: item.id
            }))
          }
          // Page item - get children
          const response = yield* client.getChildren(item.id)
          return response.results.map((child): PageBrowseItem => ({
            type: "page",
            id: child.id as PageId,
            title: child.title,
            synced: isSynced(child.title),
            parentId: item.id
          }))
        }),

      getParentAndSiblings: (item) =>
        Effect.gen(function*() {
          if (item.type === "space") {
            return Option.none()
          }
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
              type: "page",
              id: parentPage.id as PageId,
              title: parentPage.title,
              synced: isSynced(parentPage.title),
              ...(parentPage.parentId ? { parentId: parentPage.parentId as PageId } : {})
            } as PageBrowseItem,
            siblings: siblingsResponse.results.map((s): PageBrowseItem => ({
              type: "page",
              id: s.id as PageId,
              title: s.title,
              synced: isSynced(s.title),
              parentId
            }))
          })
        }),

      getPreview: (item) =>
        Effect.gen(function*() {
          if (item.type === "space") {
            return `Space: ${item.title}\nKey: ${item.key}`
          }
          const page = yield* client.getPage(item.id)
          const html = page.body?.storage?.value ?? ""
          return yield* converter.htmlToMarkdown(html)
        }),

      openInBrowser: (item) =>
        Effect.sync(() => {
          const url = item.type === "space"
            ? `${config.baseUrl}/wiki/spaces/${item.key}`
            : `${config.baseUrl}/wiki/spaces/${config.spaceKey}/pages/${item.id}`
          import("child_process").then(({ exec }) => exec(`open "${url}"`))
        }),

      getStatus: Effect.gen(function*() {
        const result = yield* syncEngine.status()
        const lines = [
          `Synced:          ${result.synced}`,
          `Local Modified:  ${result.localModified}`,
          `Remote Modified: ${result.remoteModified}`,
          `Conflicts:       ${result.conflicts}`,
          `Local Only:      ${result.localOnly}`,
          `Remote Only:     ${result.remoteOnly}`
        ]
        if (result.files.length > 0 && result.synced < result.files.length) {
          lines.push("", "Changed files:")
          for (const file of result.files) {
            if (file._tag !== "Synced" && file._tag !== "RemoteOnly") {
              lines.push(`  [${file._tag}] ${file.path}`)
            } else if (file._tag === "RemoteOnly") {
              lines.push(`  [${file._tag}] ${file.page.title}`)
            }
          }
        }
        return lines.join("\n")
      }).pipe(Effect.catchAll(() => Effect.succeed("Error getting status"))),

      pullPage: (item) =>
        Effect.gen(function*() {
          if (item.type === "space") {
            return "Cannot pull a space"
          }
          const page = yield* client.getPage(item.id)
          const html = page.body?.storage?.value ?? ""
          const markdown = yield* converter.htmlToMarkdown(html)

          // Determine file path - check if page has children
          const children = yield* client.getChildren(item.id)
          const hasChildren = children.results.length > 0

          const filename = `${slugify(page.title)}.md`
          const filePath = hasChildren
            ? pathService.join(docsPath, slugify(page.title), filename)
            : pathService.join(docsPath, filename)

          // Ensure parent directory exists
          const dir = pathService.dirname(filePath)
          yield* localFs.ensureDir(dir)

          // Write markdown file with front-matter
          yield* localFs.writeMarkdownFile(filePath, {
            pageId: item.id,
            version: page.version.number,
            title: page.title,
            updated: page.version.createdAt ? new Date(page.version.createdAt) : new Date(),
            ...(page.parentId ? { parentId: page.parentId as PageId } : {}),
            contentHash: "" as unknown as ContentHash
          }, markdown)

          return `Pulled: ${page.title}`
        }),

      createNewPage: (parentId, title) =>
        Effect.gen(function*() {
          // Find parent page path
          const parentPage = yield* client.getPage(parentId)
          const parentSlug = slugify(parentPage.title)

          // Create file in parent's directory
          const filename = `${slugify(title)}.md`
          const filePath = pathService.join(docsPath, parentSlug, filename)

          // Ensure directory exists
          const dir = pathService.dirname(filePath)
          yield* localFs.ensureDir(dir)

          // Write new page file
          yield* localFs.writeNewPageFile(
            filePath,
            { title, parentId },
            "\n<!-- Write your page content here -->\n"
          )

          return `Created: ${title}`
        })
    })
  })
)

/**
 * Spaces mode layer - browse all spaces without config.
 */
export const BrowseServiceSpacesLive = Layer.effect(
  BrowseService,
  Effect.gen(function*() {
    const client = yield* ConfluenceClient
    const converter = yield* MarkdownConverter

    return BrowseService.of({
      mode: "spaces",
      siteName: "All Spaces",

      getSpaces: Effect.gen(function*() {
        // Don't filter by type - get all spaces
        const response = yield* client.getSpaces()
        return response.results.map((s): SpaceBrowseItem => ({
          type: "space",
          id: s.id as SpaceId,
          key: s.key,
          title: s.name
        }))
      }),

      getRootItem: Effect.fail(
        new ApiError({ status: 0, message: "No root in spaces mode - use getSpaces", endpoint: "" })
      ) as Effect.Effect<BrowseItem, BrowseError>,

      getChildren: (item) =>
        Effect.gen(function*() {
          if (item.type === "space") {
            // Get root pages in space
            const pages = yield* client.getRootPagesInSpace(item.id)
            return pages.map((p): PageBrowseItem => ({
              type: "page",
              id: p.id as PageId,
              title: p.title,
              synced: false,
              spaceId: item.id
            }))
          }
          // Page item - get children
          const response = yield* client.getChildren(item.id)
          return response.results.map((child): PageBrowseItem => ({
            type: "page",
            id: child.id as PageId,
            title: child.title,
            synced: false,
            parentId: item.id
          }))
        }),

      getParentAndSiblings: () => Effect.succeed(Option.none()),

      getPreview: (item) =>
        Effect.gen(function*() {
          if (item.type === "space") {
            return `Space: ${item.title}\nKey: ${item.key}`
          }
          const page = yield* client.getPage(item.id)
          const html = page.body?.storage?.value ?? ""
          return yield* converter.htmlToMarkdown(html)
        }),

      openInBrowser: () => Effect.void,

      getStatus: Effect.succeed("Spaces mode - no sync status"),

      pullPage: () => Effect.succeed("Run 'confluence clone' to set up syncing first"),

      createNewPage: () => Effect.succeed("Run 'confluence clone' to set up syncing first")
    })
  })
)
