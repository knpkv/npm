/**
 * TUI Service - provides all actions for the unified TUI.
 */
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { ContentHash, PageId, SpaceId } from "../../Brand.js"
import { ConfluenceAuth } from "../../ConfluenceAuth.js"
import { ConfluenceClient } from "../../ConfluenceClient.js"
import { ConfluenceConfig } from "../../ConfluenceConfig.js"
import { ApiError, type ConversionError, type FileSystemError, type RateLimitError } from "../../ConfluenceError.js"
import { LocalFileSystem } from "../../LocalFileSystem.js"
import { MarkdownConverter } from "../../MarkdownConverter.js"
import { SyncEngine } from "../../SyncEngine.js"
import type { PageTuiItem, ParentResult, SpaceTuiItem, TuiItem } from "./TuiItem.js"

/**
 * Errors that can occur during TUI operations.
 */
export type TuiError = ApiError | RateLimitError | ConversionError | FileSystemError

/**
 * App mode - determines which screen to show.
 */
export type AppMode =
  | { readonly type: "unauthenticated" }
  | { readonly type: "authenticated"; readonly cloudId: string }
  | { readonly type: "configured" }

/**
 * Service interface for TUI operations.
 */
export interface TuiService {
  readonly mode: AppMode
  readonly siteName: string

  // Auth actions
  readonly createOAuthClient: Effect.Effect<void>
  readonly login: Effect.Effect<void, TuiError>
  readonly logout: Effect.Effect<void, TuiError>

  // Navigation
  readonly getSpaces: Effect.Effect<ReadonlyArray<SpaceTuiItem>, TuiError>
  readonly getChildren: (item: TuiItem) => Effect.Effect<ReadonlyArray<TuiItem>, TuiError>
  readonly getParentAndSiblings: (item: TuiItem) => Effect.Effect<Option.Option<ParentResult>, TuiError>
  readonly getPreview: (item: TuiItem) => Effect.Effect<string, TuiError>
  readonly getRootItem: Effect.Effect<TuiItem, TuiError>

  // Page actions
  readonly openInBrowser: (item: TuiItem) => Effect.Effect<void>
  readonly pullPage: (item: TuiItem) => Effect.Effect<string, TuiError>
  readonly createNewPage: (parentId: PageId, title: string) => Effect.Effect<string, TuiError>

  // Clone action (creates config from selected page)
  readonly clonePage: (item: PageTuiItem) => Effect.Effect<string, TuiError>

  // Sync status
  readonly getStatus: Effect.Effect<string>
}

export const TuiService = Context.GenericTag<TuiService>("@knpkv/confluence-to-markdown/TuiService")

/** Slugify a title for use as filename */
const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

/**
 * Unauthenticated mode - only auth actions available.
 */
export const TuiServiceUnauthenticated = Layer.effect(
  TuiService,
  Effect.gen(function*() {
    const auth = yield* ConfluenceAuth

    return TuiService.of({
      mode: { type: "unauthenticated" },
      siteName: "Confluence",

      createOAuthClient: Effect.sync(() => {
        import("child_process").then(({ exec }) => exec("open \"https://developer.atlassian.com/console/myapps/\""))
      }),

      login: auth.login().pipe(
        Effect.asVoid,
        Effect.mapError((e) => new ApiError({ status: 0, message: String(e), endpoint: "login" }))
      ),

      logout: auth.logout().pipe(
        Effect.mapError((e) => new ApiError({ status: 0, message: String(e), endpoint: "logout" }))
      ),

      // Not available in unauthenticated mode
      getSpaces: Effect.fail(new ApiError({ status: 401, message: "Not authenticated", endpoint: "" })),
      getChildren: () => Effect.fail(new ApiError({ status: 401, message: "Not authenticated", endpoint: "" })),
      getParentAndSiblings: () => Effect.succeed(Option.none()),
      getPreview: () => Effect.succeed("Not authenticated"),
      getRootItem: Effect.fail(new ApiError({ status: 401, message: "Not authenticated", endpoint: "" })),
      openInBrowser: () => Effect.void,
      pullPage: () => Effect.fail(new ApiError({ status: 401, message: "Not authenticated", endpoint: "" })),
      createNewPage: () => Effect.fail(new ApiError({ status: 401, message: "Not authenticated", endpoint: "" })),
      clonePage: () => Effect.fail(new ApiError({ status: 401, message: "Not authenticated", endpoint: "" })),
      getStatus: Effect.succeed("Not authenticated")
    })
  })
)

/**
 * Authenticated mode (no config) - can browse spaces, clone.
 */
export const TuiServiceAuthenticated = Layer.effect(
  TuiService,
  Effect.gen(function*() {
    const auth = yield* ConfluenceAuth
    const client = yield* ConfluenceClient
    const converter = yield* MarkdownConverter

    const cloudId = yield* auth.getCloudId()

    return TuiService.of({
      mode: { type: "authenticated", cloudId },
      siteName: "All Spaces",

      createOAuthClient: Effect.sync(() => {
        import("child_process").then(({ exec }) => exec("open \"https://developer.atlassian.com/console/myapps/\""))
      }),

      login: Effect.void, // Already logged in

      logout: auth.logout().pipe(
        Effect.mapError((e) => new ApiError({ status: 0, message: String(e), endpoint: "logout" }))
      ),

      getSpaces: Effect.gen(function*() {
        const response = yield* client.getSpaces()
        return response.results.map((s): SpaceTuiItem => ({
          type: "space",
          id: s.id as SpaceId,
          key: s.key,
          title: s.name
        }))
      }),

      getChildren: (item) =>
        Effect.gen(function*() {
          if (item.type === "auth-menu") return []
          if (item.type === "space") {
            const pages = yield* client.getRootPagesInSpace(item.id)
            return pages.map((p): PageTuiItem => ({
              type: "page",
              id: p.id as PageId,
              title: p.title,
              synced: false,
              spaceId: item.id,
              spaceKey: item.key
            }))
          }
          const response = yield* client.getChildren(item.id)
          return response.results.map((child): PageTuiItem => ({
            type: "page",
            id: child.id as PageId,
            title: child.title,
            synced: false,
            parentId: item.id,
            ...(item.spaceId ? { spaceId: item.spaceId } : {}),
            ...(item.spaceKey ? { spaceKey: item.spaceKey } : {})
          }))
        }),

      getParentAndSiblings: () => Effect.succeed(Option.none()),

      getPreview: (item) =>
        Effect.gen(function*() {
          if (item.type === "auth-menu") return ""
          if (item.type === "space") {
            return `Space: ${item.title}\nKey: ${item.key}`
          }
          const page = yield* client.getPage(item.id)
          const html = page.body?.storage?.value ?? ""
          return yield* converter.htmlToMarkdown(html)
        }),

      getRootItem: Effect.fail(new ApiError({ status: 0, message: "No root in authenticated mode", endpoint: "" })),

      openInBrowser: (item) =>
        Effect.sync(() => {
          if (item.type === "auth-menu") return
          const url = item.type === "space"
            ? `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/spaces/${item.key}`
            : `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/pages/${item.id}`
          import("child_process").then(({ exec }) => exec(`open "${url}"`))
        }),

      pullPage: () => Effect.succeed("Run 'confluence clone' to set up syncing first"),

      createNewPage: () => Effect.succeed("Run 'confluence clone' to set up syncing first"),

      clonePage: (item) =>
        Effect.gen(function*() {
          // TODO: Implement clone - create .confluence/ config and sync
          // For now, just return instructions
          const spaceKey = item.spaceKey ?? "unknown"
          return `To clone, run:\nconfluence clone --root-page-id ${item.id} --space-key ${spaceKey}`
        }),

      getStatus: Effect.succeed("Authenticated - no project configured")
    })
  })
)

/**
 * Configured mode - full functionality.
 */
export const TuiServiceConfigured = Layer.effect(
  TuiService,
  Effect.gen(function*() {
    const auth = yield* ConfluenceAuth
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

    return TuiService.of({
      mode: { type: "configured" },
      siteName,

      createOAuthClient: Effect.sync(() => {
        import("child_process").then(({ exec }) => exec("open \"https://developer.atlassian.com/console/myapps/\""))
      }),

      login: Effect.void, // Already configured

      logout: auth.logout().pipe(
        Effect.mapError((e) => new ApiError({ status: 0, message: String(e), endpoint: "logout" }))
      ),

      getSpaces: Effect.succeed([]),

      getRootItem: Effect.gen(function*() {
        const rootPage = yield* client.getPage(config.rootPageId)
        return {
          type: "page",
          id: config.rootPageId,
          title: rootPage.title,
          synced: isSynced(rootPage.title),
          ...(rootPage.parentId ? { parentId: rootPage.parentId as PageId } : {})
        } as PageTuiItem
      }),

      getChildren: (item) =>
        Effect.gen(function*() {
          if (item.type === "auth-menu") return []
          if (item.type === "space") {
            const pages = yield* client.getRootPagesInSpace(item.id)
            return pages.map((p): PageTuiItem => ({
              type: "page",
              id: p.id as PageId,
              title: p.title,
              synced: isSynced(p.title),
              spaceId: item.id
            }))
          }
          const response = yield* client.getChildren(item.id)
          return response.results.map((child): PageTuiItem => ({
            type: "page",
            id: child.id as PageId,
            title: child.title,
            synced: isSynced(child.title),
            parentId: item.id
          }))
        }),

      getParentAndSiblings: (item) =>
        Effect.gen(function*() {
          if (item.type !== "page") {
            return Option.none()
          }
          let parentId = item.parentId
          if (!parentId) {
            const page = yield* client.getPage(item.id)
            parentId = page.parentId as PageId | undefined
          }
          if (!parentId) {
            return Option.none()
          }
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
            } as PageTuiItem,
            siblings: siblingsResponse.results.map((s): PageTuiItem => ({
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
          if (item.type === "auth-menu") return ""
          if (item.type === "space") {
            return `Space: ${item.title}\nKey: ${item.key}`
          }
          const page = yield* client.getPage(item.id)
          const html = page.body?.storage?.value ?? ""
          return yield* converter.htmlToMarkdown(html)
        }),

      openInBrowser: (item) =>
        Effect.sync(() => {
          if (item.type !== "page") return
          const url = `${config.baseUrl}/wiki/spaces/${config.spaceKey}/pages/${item.id}`
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
          if (item.type !== "page") {
            return "Cannot pull a space"
          }
          const page = yield* client.getPage(item.id)
          const html = page.body?.storage?.value ?? ""
          const markdown = yield* converter.htmlToMarkdown(html)

          const children = yield* client.getChildren(item.id)
          const hasChildren = children.results.length > 0

          const filename = `${slugify(page.title)}.md`
          const filePath = hasChildren
            ? pathService.join(docsPath, slugify(page.title), filename)
            : pathService.join(docsPath, filename)

          const dir = pathService.dirname(filePath)
          yield* localFs.ensureDir(dir)

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
          const parentPage = yield* client.getPage(parentId)
          const parentSlug = slugify(parentPage.title)

          const filename = `${slugify(title)}.md`
          const filePath = pathService.join(docsPath, parentSlug, filename)

          const dir = pathService.dirname(filePath)
          yield* localFs.ensureDir(dir)

          yield* localFs.writeNewPageFile(
            filePath,
            { title, parentId },
            "\n<!-- Write your page content here -->\n"
          )

          return `Created: ${title}`
        }),

      clonePage: () => Effect.succeed("Already configured")
    })
  })
)
