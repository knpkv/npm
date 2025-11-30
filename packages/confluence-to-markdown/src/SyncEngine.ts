/**
 * Sync engine for bidirectional Confluence <-> Markdown synchronization.
 *
 * @module
 */
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { PageId } from "./Brand.js"
import { ConfluenceClient } from "./ConfluenceClient.js"
import { ConfluenceConfig } from "./ConfluenceConfig.js"
import type {
  ApiError,
  ConflictError,
  ConversionError,
  FileSystemError,
  FrontMatterError,
  RateLimitError
} from "./ConfluenceError.js"
import { computeHash } from "./internal/hashUtils.js"
import { LocalFileSystem } from "./LocalFileSystem.js"
import { MarkdownConverter } from "./MarkdownConverter.js"
import type { PageFrontMatter, PageListItem, PageResponse } from "./Schemas.js"

/**
 * Sync status for a single page.
 */
export type SyncStatus =
  | { readonly _tag: "Synced"; readonly path: string }
  | { readonly _tag: "LocalOnly"; readonly path: string; readonly title: string }
  | { readonly _tag: "RemoteOnly"; readonly page: PageResponse }
  | { readonly _tag: "LocalModified"; readonly path: string; readonly page: PageResponse }
  | { readonly _tag: "RemoteModified"; readonly path: string; readonly page: PageResponse }
  | {
    readonly _tag: "Conflict"
    readonly path: string
    readonly page: PageResponse
    readonly localVersion: number
    readonly remoteVersion: number
  }

/**
 * Result of a pull operation.
 */
export interface PullResult {
  readonly pulled: number
  readonly skipped: number
  readonly errors: ReadonlyArray<string>
}

/**
 * Result of a push operation.
 */
export interface PushResult {
  readonly pushed: number
  readonly created: number
  readonly skipped: number
  readonly errors: ReadonlyArray<string>
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  readonly pulled: number
  readonly pushed: number
  readonly created: number
  readonly conflicts: number
  readonly errors: ReadonlyArray<string>
}

/**
 * Result of a status operation.
 */
export interface StatusResult {
  readonly synced: number
  readonly localModified: number
  readonly remoteModified: number
  readonly conflicts: number
  readonly localOnly: number
  readonly remoteOnly: number
  readonly files: ReadonlyArray<SyncStatus>
}

type SyncError = ApiError | RateLimitError | ConversionError | FileSystemError | FrontMatterError

/**
 * Sync engine service for Confluence <-> Markdown operations.
 *
 * @example
 * ```typescript
 * import { SyncEngine } from "@knpkv/confluence-to-markdown/SyncEngine"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const engine = yield* SyncEngine
 *   const result = yield* engine.pull({ force: false })
 *   console.log(`Pulled ${result.pulled} pages`)
 * })
 * ```
 *
 * @category Sync
 */
export class SyncEngine extends Context.Tag(
  "@knpkv/confluence-to-markdown/SyncEngine"
)<
  SyncEngine,
  {
    /**
     * Pull pages from Confluence to local markdown.
     */
    readonly pull: (options: { force: boolean }) => Effect.Effect<PullResult, SyncError>

    /**
     * Push local markdown changes to Confluence.
     */
    readonly push: (options: { dryRun: boolean }) => Effect.Effect<PushResult, SyncError>

    /**
     * Bidirectional sync with conflict detection.
     */
    readonly sync: () => Effect.Effect<SyncResult, SyncError | ConflictError>

    /**
     * Get sync status for all files.
     */
    readonly status: () => Effect.Effect<StatusResult, SyncError>
  }
>() {}

/**
 * Layer that provides SyncEngine.
 *
 * @category Layers
 */
export const layer: Layer.Layer<
  SyncEngine,
  never,
  ConfluenceClient | ConfluenceConfig | MarkdownConverter | LocalFileSystem | Path.Path
> = Layer.effect(
  SyncEngine,
  Effect.gen(function*() {
    const client = yield* ConfluenceClient
    const config = yield* ConfluenceConfig
    const converter = yield* MarkdownConverter
    const localFs = yield* LocalFileSystem
    const pathService = yield* Path.Path

    const docsPath = pathService.join(process.cwd(), config.docsPath)

    /**
     * Pull a single page and its children recursively.
     */
    const pullPage = (
      page: PageListItem | PageResponse,
      parentPath: string,
      force: boolean
    ): Effect.Effect<number, SyncError> =>
      Effect.gen(function*() {
        // Get children to determine if this is a folder
        const children = yield* client.getAllChildren(page.id as PageId)
        const hasChildren = children.length > 0

        const filePath = localFs.getPagePath(page.title, hasChildren, parentPath)
        const dirPath = hasChildren ? localFs.getPageDir(page.title, parentPath) : parentPath

        // Get page content
        const fullPage = yield* client.getPage(page.id as PageId)
        const htmlContent = fullPage.body?.storage?.value ?? ""
        let markdown = yield* converter.htmlToMarkdown(htmlContent)

        // Add child page links for index pages
        if (hasChildren && config.spaceKey) {
          const childLinks = children
            .map((child) => {
              const pageUrl = `${config.baseUrl}/wiki/spaces/${config.spaceKey}/pages/${child.id}`
              return `- [${child.title}](${pageUrl})`
            })
            .join("\n")
          markdown = markdown.trim() + "\n\n## Child Pages\n\n" + childLinks + "\n"
        }

        const contentHash = computeHash(markdown)

        // Check if we need to update
        if (!force) {
          const exists = yield* localFs.exists(filePath)
          if (exists) {
            const localFile = yield* localFs.readMarkdownFile(filePath)
            if (
              localFile.frontMatter &&
              localFile.frontMatter.version === fullPage.version.number &&
              localFile.frontMatter.contentHash === contentHash
            ) {
              // Skip - already in sync
              let count = 0
              for (const child of children) {
                count += yield* pullPage(child, dirPath, force)
              }
              return count
            }
          }
        }

        // Ensure directory exists
        if (hasChildren) {
          yield* localFs.ensureDir(dirPath)
        }

        // Write file
        const frontMatter: PageFrontMatter = {
          pageId: page.id as PageId,
          version: fullPage.version.number,
          title: fullPage.title,
          updated: new Date(fullPage.version.createdAt ?? new Date().toISOString()),
          ...(page.parentId ? { parentId: page.parentId as PageId } : {}),
          ...(page.position !== undefined ? { position: page.position } : {}),
          contentHash
        }

        yield* localFs.writeMarkdownFile(filePath, frontMatter, markdown)

        // Pull children
        let count = 1
        for (const child of children) {
          count += yield* pullPage(child, dirPath, force)
        }

        return count
      })

    const pull = (options: { force: boolean }): Effect.Effect<PullResult, SyncError> =>
      Effect.gen(function*() {
        yield* localFs.ensureDir(docsPath)

        const rootPage = yield* client.getPage(config.rootPageId)
        const pulled = yield* pullPage(rootPage, docsPath, options.force)

        return {
          pulled,
          skipped: 0,
          errors: [] as ReadonlyArray<string>
        }
      })

    const push = (options: { dryRun: boolean }): Effect.Effect<PushResult, SyncError> =>
      Effect.gen(function*() {
        const files = yield* localFs.listMarkdownFiles(docsPath)
        let pushed = 0
        let created = 0
        let skipped = 0
        const errors: Array<string> = []

        for (const filePath of files) {
          const localFile = yield* localFs.readMarkdownFile(filePath)

          if (localFile.isNew || !localFile.frontMatter) {
            // New file - would create page
            if (!options.dryRun) {
              // TODO: Implement page creation
              errors.push(`Page creation not yet implemented: ${filePath}`)
            }
            created++
            continue
          }

          const fm = localFile.frontMatter
          const currentHash = computeHash(localFile.content)

          if (currentHash === fm.contentHash) {
            skipped++
            continue
          }

          if (!options.dryRun) {
            const html = yield* converter.markdownToHtml(localFile.content)
            yield* client.updatePage({
              id: fm.pageId,
              title: fm.title,
              status: "current",
              version: {
                number: fm.version + 1,
                message: "Updated via confluence-to-markdown"
              },
              body: {
                representation: "storage",
                value: html
              }
            })

            // Update front-matter with new version
            const newFrontMatter: PageFrontMatter = {
              ...fm,
              version: fm.version + 1,
              updated: new Date(),
              contentHash: currentHash
            }
            yield* localFs.writeMarkdownFile(filePath, newFrontMatter, localFile.content)
          }

          pushed++
        }

        return { pushed, created, skipped, errors: errors as ReadonlyArray<string> }
      })

    const sync = (): Effect.Effect<SyncResult, SyncError | ConflictError> =>
      Effect.gen(function*() {
        // First pull to get latest
        const pullResult = yield* pull({ force: false })

        // Then push local changes
        const pushResult = yield* push({ dryRun: false })

        return {
          pulled: pullResult.pulled,
          pushed: pushResult.pushed,
          created: pushResult.created,
          conflicts: 0, // TODO: Implement conflict detection
          errors: [...pullResult.errors, ...pushResult.errors] as ReadonlyArray<string>
        }
      })

    const status = (): Effect.Effect<StatusResult, SyncError> =>
      Effect.gen(function*() {
        const files = yield* localFs.listMarkdownFiles(docsPath)
        const statuses: Array<SyncStatus> = []

        let synced = 0
        let localModified = 0
        let remoteModified = 0
        let conflicts = 0
        let localOnly = 0
        const remoteOnly = 0

        for (const filePath of files) {
          const localFile = yield* localFs.readMarkdownFile(filePath)

          if (localFile.isNew || !localFile.frontMatter) {
            statuses.push({ _tag: "LocalOnly", path: filePath, title: pathService.basename(filePath, ".md") })
            localOnly++
            continue
          }

          const fm = localFile.frontMatter
          const currentHash = computeHash(localFile.content)

          // Fetch remote page
          const remotePage = yield* Effect.either(client.getPage(fm.pageId))

          if (remotePage._tag === "Left") {
            statuses.push({ _tag: "LocalOnly", path: filePath, title: fm.title })
            localOnly++
            continue
          }

          const page = remotePage.right
          const localChanged = currentHash !== fm.contentHash
          const remoteChanged = page.version.number > fm.version

          if (localChanged && remoteChanged) {
            statuses.push({
              _tag: "Conflict",
              path: filePath,
              page,
              localVersion: fm.version,
              remoteVersion: page.version.number
            })
            conflicts++
          } else if (localChanged) {
            statuses.push({ _tag: "LocalModified", path: filePath, page })
            localModified++
          } else if (remoteChanged) {
            statuses.push({ _tag: "RemoteModified", path: filePath, page })
            remoteModified++
          } else {
            statuses.push({ _tag: "Synced", path: filePath })
            synced++
          }
        }

        return {
          synced,
          localModified,
          remoteModified,
          conflicts,
          localOnly,
          remoteOnly,
          files: statuses as ReadonlyArray<SyncStatus>
        }
      })

    return SyncEngine.of({
      pull,
      push,
      sync,
      status
    })
  })
)
