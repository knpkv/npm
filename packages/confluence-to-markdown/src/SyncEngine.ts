/**
 * Sync engine for bidirectional Confluence <-> Markdown synchronization.
 *
 * @module
 */
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { PageId } from "./Brand.js"
import { ConfluenceClient } from "./ConfluenceClient.js"
import { ConfluenceConfig } from "./ConfluenceConfig.js"
import type { ApiError, ConversionError, FrontMatterError, RateLimitError } from "./ConfluenceError.js"
import { FileSystemError, StructureError } from "./ConfluenceError.js"
import type { GitServiceError } from "./GitService.js"
import { GitService } from "./GitService.js"
import { computeHash, HashServiceLive } from "./internal/hashUtils.js"
import { UserCache } from "./internal/userCache.js"
import { LocalFileSystem } from "./LocalFileSystem.js"
import { MarkdownConverter } from "./MarkdownConverter.js"
import type { AtlassianUser, PageFrontMatter, PageListItem, PageResponse, PageVersionContent } from "./Schemas.js"

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
 * Progress callback for version replay.
 */
export type ProgressCallback = (current: number, total: number, message: string) => void

/**
 * Options for pull operation.
 */
export interface PullOptions {
  readonly force: boolean
  /**
   * Replay version history as individual git commits.
   * Only applies when git is initialized.
   */
  readonly replayHistory?: boolean
  /**
   * Progress callback for version replay.
   */
  readonly onProgress?: ProgressCallback
}

/**
 * Result of a pull operation.
 */
export interface PullResult {
  readonly pulled: number
  readonly skipped: number
  readonly commits: number
  readonly errors: ReadonlyArray<string>
}

/**
 * Result of a push operation.
 */
export interface PushResult {
  readonly pushed: number
  readonly created: number
  readonly deleted: number
  readonly skipped: number
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

type SyncError =
  | ApiError
  | RateLimitError
  | ConversionError
  | FileSystemError
  | FrontMatterError
  | GitServiceError
  | StructureError

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
    readonly pull: (options: PullOptions) => Effect.Effect<PullResult, SyncError>

    /**
     * Push local markdown changes to Confluence.
     */
    readonly push: (options: { dryRun: boolean; message?: string }) => Effect.Effect<PushResult, SyncError>

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
  ConfluenceClient | ConfluenceConfig | MarkdownConverter | LocalFileSystem | Path.Path | GitService | UserCache
> = Layer.effect(
  SyncEngine,
  Effect.gen(function*() {
    const client = yield* ConfluenceClient
    const config = yield* ConfluenceConfig
    const converter = yield* MarkdownConverter
    const localFs = yield* LocalFileSystem
    const pathService = yield* Path.Path
    const git = yield* GitService
    const userCache = yield* UserCache

    const docsPath = pathService.join(process.cwd(), config.docsPath)

    /**
     * Build a map of relative path (without .md) to pageId for resolving parents.
     * e.g., "guide" -> pageId, "guide/getting-started" -> pageId
     */
    const buildPageIdMap = (): Effect.Effect<Map<string, string>, SyncError> =>
      Effect.gen(function*() {
        const files = yield* localFs.listMarkdownFiles(docsPath)
        const map = new Map<string, string>()

        for (const filePath of files) {
          const localFile = yield* localFs.readMarkdownFile(filePath)
          const relativePath = pathService.relative(docsPath, filePath)
          const key = relativePath.replace(/\.md$/, "")

          if (localFile.frontMatter?.pageId) {
            map.set(key, localFile.frontMatter.pageId)
          }
        }

        return map
      })

    /**
     * Resolve parent page ID from directory structure.
     * Rule: foo/ contains children of foo.md
     */
    const resolveParent = (
      filePath: string,
      pageIdMap: Map<string, string>
    ): Effect.Effect<string, StructureError | FileSystemError> =>
      Effect.gen(function*() {
        const relativePath = pathService.relative(docsPath, filePath)
        const dirPath = pathService.dirname(relativePath)

        // Root level files -> parent is rootPageId
        if (dirPath === ".") {
          return config.rootPageId
        }

        // Files in subdir -> parent is the directory's parent page
        // e.g., "foo/bar.md" -> parent is "foo.md"
        const parentKey = dirPath
        const parentPageId = pageIdMap.get(parentKey)

        if (!parentPageId) {
          // Check if the parent .md file exists
          const parentMdPath = pathService.join(docsPath, `${parentKey}.md`)
          const parentExists = yield* localFs.exists(parentMdPath)

          if (!parentExists) {
            return yield* Effect.fail(
              new StructureError({
                path: filePath,
                message: `Directory '${dirPath}/' has no parent page`,
                advice: `Create '${parentKey}.md' first`
              })
            )
          }

          // Parent file exists but has no pageId (not pushed yet)
          return yield* Effect.fail(
            new StructureError({
              path: filePath,
              message: `Parent page '${parentKey}.md' not yet pushed`,
              advice: `Push parent before creating children`
            })
          )
        }

        return parentPageId
      })

    /**
     * Validate directory structure consistency.
     * - Every directory foo/ must have a corresponding foo.md with pageId
     */
    const validateStructure = (): Effect.Effect<void, SyncError> =>
      Effect.gen(function*() {
        const files = yield* localFs.listMarkdownFiles(docsPath)
        const pageIdMap = yield* buildPageIdMap()

        // Build set of directories that contain files
        const dirsWithFiles = new Set<string>()
        for (const filePath of files) {
          const relativePath = pathService.relative(docsPath, filePath)
          const dirPath = pathService.dirname(relativePath)
          if (dirPath !== ".") {
            dirsWithFiles.add(dirPath)
          }
        }

        // Check each directory has a parent .md with pageId
        // Rule: foo/ directory must have foo.md as parent
        for (const dir of dirsWithFiles) {
          const parentPageId = pageIdMap.get(dir)
          if (!parentPageId) {
            const parentMdPath = pathService.join(docsPath, `${dir}.md`)
            const parentExists = yield* localFs.exists(parentMdPath)

            if (!parentExists) {
              return yield* Effect.fail(
                new StructureError({
                  path: dir,
                  message: `Directory '${dir}/' has no parent page`,
                  advice: `Create '${dir}.md' first`
                })
              )
            }

            // Parent exists but not pushed - this is OK during push,
            // as long as we push in order (parent before child)
          }
        }

        // Check parentId in front-matter matches directory structure
        // Only validate new pages or pages where we can determine expected parent
        for (const filePath of files) {
          const localFile = yield* localFs.readMarkdownFile(filePath)
          if (localFile.frontMatter?.parentId) {
            const relativePath = pathService.relative(docsPath, filePath)
            const dirPath = pathService.dirname(relativePath)

            // Determine expected parent based on directory
            // foo/bar.md -> parent should be foo.md (pageIdMap key: "foo")
            let expectedParentId: string | null = null
            if (dirPath === ".") {
              // Root level - parent should be rootPageId
              // But if the parentId points elsewhere, it might be correct Confluence hierarchy
              // Only validate if it's a new page (no pageId yet)
              if (!localFile.frontMatter.pageId) {
                expectedParentId = config.rootPageId
              }
            } else {
              const parentPageId = pageIdMap.get(dirPath)
              if (parentPageId) {
                expectedParentId = parentPageId
              }
              // If parent not in map, skip validation (parent might be outside our tree)
            }

            if (expectedParentId !== null && localFile.frontMatter.parentId !== expectedParentId) {
              return yield* Effect.fail(
                new StructureError({
                  path: filePath,
                  message: `Page parentId '${localFile.frontMatter.parentId}' does not match directory location`,
                  advice: `Move file to correct directory or update parentId to '${expectedParentId}'`
                })
              )
            }
          }
        }
      })

    /**
     * Get user info with caching.
     */
    const getUser = (accountId: string): Effect.Effect<AtlassianUser | undefined, ApiError | RateLimitError> =>
      userCache.getOrFetch(accountId, client.getUser).pipe(
        Effect.catchAll(() => Effect.succeed(undefined))
      )

    /**
     * Convert version content to markdown and front-matter.
     */
    const versionToMarkdown = (
      pageId: PageId,
      version: PageVersionContent,
      title: string,
      parentId?: string,
      position?: number
    ): Effect.Effect<{ markdown: string; frontMatter: PageFrontMatter }, SyncError> =>
      Effect.gen(function*() {
        const htmlContent = version.body?.storage?.value ?? ""
        const markdown = yield* converter.htmlToMarkdown(htmlContent, {
          includeRawSource: config.saveSource
        })
        const contentHash = yield* computeHash(markdown).pipe(Effect.provide(HashServiceLive))

        // Get author info
        const author = version.authorId ? yield* getUser(version.authorId) : undefined

        const frontMatter: PageFrontMatter = {
          pageId,
          version: version.number,
          title,
          updated: new Date(version.createdAt),
          ...(parentId ? { parentId: parentId as PageId } : {}),
          ...(position !== undefined ? { position } : {}),
          contentHash,
          ...(version.message ? { versionMessage: version.message } : {}),
          ...(author?.displayName ? { authorName: author.displayName } : {}),
          ...(author?.email ? { authorEmail: author.email } : {})
        }

        return { markdown, frontMatter }
      })

    /**
     * Pull a single page and its children recursively.
     * Returns { pulled, commits } count.
     */
    const pullPage = (
      page: PageListItem | PageResponse,
      parentPath: string,
      options: PullOptions,
      gitInitialized: boolean,
      knownParentId?: string
    ): Effect.Effect<{ pulled: number; commits: number }, SyncError> =>
      Effect.gen(function*() {
        const pageId = page.id as PageId
        // Get children to determine if this is a folder
        const children = yield* client.getAllChildren(pageId)
        const hasChildren = children.length > 0

        const filePath = yield* localFs.getPagePath(page.title, hasChildren, parentPath)
        const dirPath = hasChildren ? yield* localFs.getPageDir(page.title, parentPath) : parentPath

        // Get page content
        const fullPage = yield* client.getPage(pageId)

        // Determine parentId: use API response, fall back to known parent
        const effectiveParentId = page.parentId ?? knownParentId

        // Check existing local version
        let localVersion = 0
        if (!options.force) {
          const exists = yield* localFs.exists(filePath)
          if (exists) {
            const localFile = yield* localFs.readMarkdownFile(filePath)
            if (localFile.frontMatter) {
              localVersion = localFile.frontMatter.version
              // If local is already at remote version, skip
              if (localVersion >= fullPage.version.number) {
                let childPulled = 0
                let childCommits = 0
                for (const child of children) {
                  // Pass current page's ID as parent for children
                  const result = yield* pullPage(child, dirPath, options, gitInitialized, pageId)
                  childPulled += result.pulled
                  childCommits += result.commits
                }
                return { pulled: childPulled, commits: childCommits }
              }
            }
          }
        }

        // Ensure directory exists
        if (hasChildren) {
          yield* localFs.ensureDir(dirPath)
        }

        let totalCommits = 0

        // If history replay is enabled and git is initialized, replay versions
        let historyReplayFailed = false
        if (options.replayHistory && gitInitialized && localVersion < fullPage.version.number) {
          // Fetch versions with body content since localVersion
          const versions = yield* client.getPageVersions(pageId, { since: localVersion, includeBody: true })
          // Sort by version number (oldest first)
          const sortedVersions = [...versions].sort((a, b) => a.number - b.number)
          const totalVersions = sortedVersions.length

          let versionIdx = 0
          for (const versionInfo of sortedVersions) {
            versionIdx++
            // Report progress
            if (options.onProgress) {
              options.onProgress(versionIdx, totalVersions, `${fullPage.title} v${versionInfo.number}`)
            }

            // Check if body content is available from the versions list
            const bodyContent = versionInfo.page?.body?.storage?.value
            if (!bodyContent) {
              // No body content available - history replay not supported
              historyReplayFailed = true
              break
            }

            // Build version content from the list response
            const versionContent = {
              number: versionInfo.number,
              authorId: versionInfo.authorId,
              createdAt: versionInfo.createdAt,
              message: versionInfo.message,
              body: {
                storage: {
                  value: bodyContent,
                  representation: "storage" as const
                }
              }
            }
            const { frontMatter, markdown } = yield* versionToMarkdown(
              pageId,
              versionContent,
              versionInfo.page?.title ?? fullPage.title,
              effectiveParentId,
              page.position
            )

            // Write file
            yield* localFs.writeMarkdownFile(filePath, frontMatter, markdown)

            // Save source HTML if configured
            if (config.saveSource && versionContent.body?.storage?.value) {
              const sourceFilePath = filePath.replace(/\.md$/, ".html")
              yield* localFs.writeFile(sourceFilePath, versionContent.body.storage.value)
            }

            // Commit this version
            const author = versionInfo.authorId ? yield* getUser(versionInfo.authorId) : undefined
            const commitMessage = versionInfo.message || `Update ${fullPage.title} (v${versionInfo.number})`

            yield* git.addAll()
            const commitOptions = author
              ? {
                message: commitMessage,
                author: { name: author.displayName, email: author.email ?? "unknown@atlassian.com" },
                date: new Date(versionInfo.createdAt)
              }
              : { message: commitMessage, date: new Date(versionInfo.createdAt) }
            yield* git.commit(commitOptions).pipe(Effect.catchTag("GitNoChangesError", () => Effect.void))

            totalCommits++
          }
        }

        // Simple pull - either history replay is disabled, not initialized, or body not available
        const needsSimplePull = historyReplayFailed || !options.replayHistory || !gitInitialized ||
          localVersion >= fullPage.version.number

        if (needsSimplePull) {
          if (historyReplayFailed) {
            yield* Effect.logWarning(
              "History replay not available. Confluence Cloud API does not return body content for historical versions. Falling back to simple pull."
            )
          }

          // Simple pull without history replay
          const htmlContent = fullPage.body?.storage?.value ?? ""
          let markdown = yield* converter.htmlToMarkdown(htmlContent, {
            includeRawSource: config.saveSource
          })

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

          const contentHash = yield* computeHash(markdown).pipe(Effect.provide(HashServiceLive))

          // Get author info
          const author = fullPage.version.authorId ? yield* getUser(fullPage.version.authorId) : undefined

          // Write file
          const frontMatter: PageFrontMatter = {
            pageId,
            version: fullPage.version.number,
            title: fullPage.title,
            updated: fullPage.version.createdAt ? new Date(fullPage.version.createdAt) : new Date(),
            ...(effectiveParentId ? { parentId: effectiveParentId as PageId } : {}),
            ...(page.position !== undefined ? { position: page.position } : {}),
            contentHash,
            ...(fullPage.version.message ? { versionMessage: fullPage.version.message } : {}),
            ...(author?.displayName ? { authorName: author.displayName } : {}),
            ...(author?.email ? { authorEmail: author.email } : {})
          }

          yield* localFs.writeMarkdownFile(filePath, frontMatter, markdown)

          // Save source HTML if configured
          if (config.saveSource && htmlContent) {
            const sourceFilePath = filePath.replace(/\.md$/, ".html")
            yield* localFs.writeFile(sourceFilePath, htmlContent)
          }
        }

        // Pull children
        let childPulled = 0
        let childCommits = 0
        for (const child of children) {
          // Pass current page's ID as parent for children
          const result = yield* pullPage(child, dirPath, options, gitInitialized, pageId)
          childPulled += result.pulled
          childCommits += result.commits
        }

        return { pulled: 1 + childPulled, commits: totalCommits + childCommits }
      })

    const pull = (options: PullOptions): Effect.Effect<PullResult, SyncError> =>
      Effect.gen(function*() {
        yield* localFs.ensureDir(docsPath)

        // Check if git is initialized
        const gitInitialized = yield* git.isInitialized()

        // Two-branch model: if origin/confluence exists, work on that branch first
        const hasRemoteBranch = gitInitialized
          ? yield* git.branchExists("origin/confluence")
          : false
        const originalBranch = gitInitialized ? yield* git.getCurrentBranch() : ""

        if (hasRemoteBranch) {
          // Switch to origin/confluence to pull updates there
          yield* git.checkout("origin/confluence")
        }

        const rootPage = yield* client.getPage(config.rootPageId)
        const result = yield* pullPage(rootPage, docsPath, options, gitInitialized)

        // If git is initialized and we have changes but didn't replay history, auto-commit
        if (gitInitialized && !options.replayHistory && result.pulled > 0) {
          yield* git.addAll()
          yield* git.commit({
            message: `Pull from Confluence (${result.pulled} page${result.pulled !== 1 ? "s" : ""})`
          }).pipe(Effect.catchTag("GitNoChangesError", () => Effect.void))
        }

        // Two-branch model: merge origin/confluence into current branch
        if (hasRemoteBranch && originalBranch && originalBranch !== "origin/confluence") {
          yield* git.checkout(originalBranch)
          yield* git.merge("origin/confluence", {
            message: `Merge remote changes from Confluence`
          }).pipe(Effect.catchAll(() => Effect.void)) // May fail if no changes
        }

        return {
          pulled: result.pulled,
          skipped: 0,
          commits: result.commits,
          errors: [] as ReadonlyArray<string>
        }
      })

    /**
     * Push a single file's content to Confluence.
     * Returns the canonical content after push.
     */
    const pushFile = (
      filePath: string,
      revisionMessage: string,
      spaceId: string,
      pageIdMap: Map<string, string>
    ): Effect.Effect<
      { pushed: boolean; created: boolean; newPageId?: string; error?: string },
      SyncError
    > =>
      Effect.gen(function*() {
        const localFile = yield* localFs.readMarkdownFile(filePath)

        // Handle new page creation
        if (localFile.isNew || !localFile.frontMatter) {
          // Get title from front-matter or filename
          const relativePath = pathService.relative(docsPath, filePath)
          const baseName = pathService.basename(filePath, ".md")

          // For new pages, re-parse front-matter to get title
          // The localFile only has the content (body), not the original front-matter
          const title = yield* Effect.tryPromise({
            try: async () => {
              const fs = await import("node:fs/promises")
              const matter = await import("gray-matter")
              const rawFile = await fs.readFile(filePath, "utf-8")
              const parsed = matter.default(rawFile)
              return (parsed.data as { title?: string }).title ?? baseName
            },
            catch: (cause) => new FileSystemError({ operation: "read", path: filePath, cause })
          })

          // Resolve parent from directory structure
          const parentId = yield* resolveParent(filePath, pageIdMap)

          // Convert markdown to HTML
          const html = yield* converter.markdownToHtml(localFile.content)

          // Create the page
          const createdPage = yield* client.createPage({
            spaceId,
            parentId,
            title,
            body: {
              representation: "storage",
              value: html
            }
          })

          // Set editor version to v2 (new editor)
          yield* client.setEditorVersion(createdPage.id as PageId, "v2").pipe(
            Effect.catchAll((error) => {
              // Log warning but don't fail the push
              return Effect.logWarning(`Failed to set editor v2 for page ${createdPage.id}: ${error.message}`)
            })
          )

          // Fetch canonical content back from Confluence
          const canonicalPage = yield* client.getPage(createdPage.id as PageId)
          const canonicalHtml = canonicalPage.body?.storage?.value ?? ""
          const canonicalMarkdown = yield* converter.htmlToMarkdown(canonicalHtml, {
            includeRawSource: config.saveSource
          })
          const canonicalHash = yield* computeHash(canonicalMarkdown).pipe(Effect.provide(HashServiceLive))

          // Write canonical content with full front-matter
          const newFrontMatter: PageFrontMatter = {
            pageId: createdPage.id as PageId,
            version: createdPage.version.number,
            title,
            updated: new Date(canonicalPage.version.createdAt ?? new Date().toISOString()),
            parentId: parentId as PageId,
            contentHash: canonicalHash
          }
          yield* localFs.writeMarkdownFile(filePath, newFrontMatter, canonicalMarkdown)

          // Update pageIdMap with new page
          const key = relativePath.replace(/\.md$/, "")
          pageIdMap.set(key, createdPage.id)

          return { pushed: false, created: true, newPageId: createdPage.id }
        }

        const fm = localFile.frontMatter
        const currentHash = yield* computeHash(localFile.content).pipe(Effect.provide(HashServiceLive))

        if (currentHash === fm.contentHash) {
          return { pushed: false, created: false }
        }

        // Fetch current version to avoid conflicts
        const remotePage = yield* client.getPage(fm.pageId)
        const html = yield* converter.markdownToHtml(localFile.content)
        const updatedPage = yield* client.updatePage({
          id: fm.pageId,
          title: fm.title,
          status: "current",
          version: {
            number: remotePage.version.number + 1,
            message: revisionMessage
          },
          body: {
            representation: "storage",
            value: html
          }
        })

        // Fetch canonical content back from Confluence
        const canonicalPage = yield* client.getPage(fm.pageId)
        const canonicalHtml = canonicalPage.body?.storage?.value ?? ""
        const canonicalMarkdown = yield* converter.htmlToMarkdown(canonicalHtml, {
          includeRawSource: config.saveSource
        })
        const canonicalHash = yield* computeHash(canonicalMarkdown).pipe(Effect.provide(HashServiceLive))

        // Write canonical content with updated front-matter
        const newFrontMatter: PageFrontMatter = {
          ...fm,
          version: updatedPage.version.number,
          updated: new Date(canonicalPage.version.createdAt ?? new Date().toISOString()),
          contentHash: canonicalHash
        }
        yield* localFs.writeMarkdownFile(filePath, newFrontMatter, canonicalMarkdown)

        return { pushed: true, created: false }
      })

    /**
     * Find commits that have unpushed changes.
     * Uses two-branch model: finds commits in current branch not in origin/confluence.
     * Returns commits from oldest to newest.
     */
    const findUnpushedCommits = (): Effect.Effect<
      ReadonlyArray<{ hash: string; message: string }>,
      SyncError
    > =>
      Effect.gen(function*() {
        // Two-branch model: find commits in current branch not in origin/confluence
        const hasRemoteBranch = yield* git.branchExists("origin/confluence")

        if (hasRemoteBranch) {
          // Use logRange to find commits not in origin/confluence
          const commits = yield* git.logRange("origin/confluence", "HEAD")
          return commits.map((c) => ({ hash: c.hash, message: c.message }))
        }

        // Fallback: no origin/confluence branch yet, use content hash comparison
        const files = yield* localFs.listMarkdownFiles(docsPath)
        if (files.length === 0) return []

        const allCommits = yield* git.log({ n: 100 })
        if (allCommits.length === 0) return []

        const unpushed: Array<{ hash: string; message: string }> = []

        for (const commit of allCommits) {
          yield* git.checkout(commit.hash)

          let hasChanges = false
          for (const filePath of files) {
            const exists = yield* localFs.exists(filePath)
            if (!exists) continue

            const localFile = yield* localFs.readMarkdownFile(filePath)
            if (!localFile.frontMatter) {
              hasChanges = true
              break
            }

            const currentHash = yield* computeHash(localFile.content).pipe(Effect.provide(HashServiceLive))
            if (currentHash !== localFile.frontMatter.contentHash) {
              hasChanges = true
              break
            }
          }

          if (!hasChanges) break
          unpushed.push({ hash: commit.hash, message: commit.message })
        }

        return unpushed.reverse()
      })

    const push = (options: { dryRun: boolean; message?: string }): Effect.Effect<PushResult, SyncError> =>
      Effect.gen(function*() {
        // Validate structure before push
        yield* validateStructure()

        // Get spaceId from root page
        const spaceId = yield* client.getSpaceId(config.rootPageId)

        // Build pageId map for parent resolution
        const pageIdMap = yield* buildPageIdMap()

        const gitInitialized = yield* git.isInitialized()

        // Get files and sort by depth (parent before child)
        const files = yield* localFs.listMarkdownFiles(docsPath)
        const sortedFiles = [...files].sort((a, b) => {
          const depthA = pathService.relative(docsPath, a).split(pathService.sep).length
          const depthB = pathService.relative(docsPath, b).split(pathService.sep).length
          return depthA - depthB
        })

        if (!gitInitialized) {
          // Non-git mode: just push current content
          let pushed = 0
          let created = 0
          const errors: Array<string> = []

          for (const filePath of sortedFiles) {
            if (options.dryRun) {
              pushed++
              continue
            }
            const result = yield* pushFile(
              filePath,
              options.message ?? "Updated via confluence-to-markdown",
              spaceId,
              pageIdMap
            ).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({
                  pushed: false,
                  created: false,
                  error: `Failed: ${error._tag}`
                })
              )
            )
            if (result.error) errors.push(result.error)
            if (result.pushed) pushed++
            if (result.created) created++
          }

          return { pushed, created, deleted: 0, skipped: 0, errors: errors as ReadonlyArray<string> }
        }

        // Git mode: push current HEAD state to Confluence
        // For simplicity, we push the final state as a single Confluence version
        // with the most recent commit message
        const errors: Array<string> = []
        let pushed = 0
        let created = 0
        let deleted = 0

        // Get the most recent unpushed commit message for the revision
        const unpushedCommits = yield* findUnpushedCommits()
        if (unpushedCommits.length === 0) {
          return { pushed: 0, created: 0, skipped: 0, deleted: 0, errors: [] as ReadonlyArray<string> }
        }

        if (options.dryRun) {
          return {
            pushed: unpushedCommits.length,
            created: 0,
            skipped: 0,
            deleted: 0,
            errors: [] as ReadonlyArray<string>
          }
        }

        // Use the last commit's message as the revision message
        const lastCommit = unpushedCommits[unpushedCommits.length - 1]!
        const revisionMessage = options.message ?? lastCommit.message

        // Find deleted files by comparing origin/confluence with current HEAD
        // Note: Git repo is inside .confluence/, so paths are relative to that
        // (e.g., "docs/page.md" not ".confluence/docs/page.md")
        const hasRemoteBranch = yield* git.branchExists("origin/confluence")
        if (hasRemoteBranch) {
          const deletedFiles = yield* git.getDeletedFiles("origin/confluence", "HEAD", "docs")

          // Delete pages from Confluence
          for (const deletedPath of deletedFiles) {
            // Read the file from origin/confluence to get pageId
            // deletedPath is already relative to git root (e.g., "docs/page.md")
            const pageIdFromOrigin = yield* git.getFileContentAt(
              "origin/confluence",
              deletedPath
            ).pipe(
              Effect.map((content) => {
                const match = content.match(/pageId:\s*['"]?(\d+)['"]?/)
                return match ? match[1] : null
              }),
              Effect.catchAll(() => Effect.succeed(null))
            )

            if (pageIdFromOrigin) {
              yield* client.deletePage(PageId(pageIdFromOrigin)).pipe(
                Effect.tap(() => Effect.sync(() => deleted++)),
                Effect.catchAll((error) => {
                  errors.push(`Failed to delete page ${pageIdFromOrigin}: ${error.message}`)
                  return Effect.void
                })
              )
            }
          }
        }

        for (const filePath of sortedFiles) {
          const result = yield* pushFile(filePath, revisionMessage, spaceId, pageIdMap).pipe(
            Effect.catchAll((error) =>
              Effect.succeed({
                pushed: false,
                created: false,
                error: `Failed to push ${filePath}: ${error._tag}`
              })
            )
          )
          if (result.error) errors.push(result.error)
          if (result.pushed) pushed++
          if (result.created) created++
        }

        // Amend the last commit with canonical content
        yield* git.addAll()
        yield* git.amend({ noEdit: true }).pipe(
          Effect.catchAll(() => Effect.void)
        )

        // Two-branch model: update origin/confluence to match HEAD
        if (hasRemoteBranch) {
          yield* git.updateBranch("origin/confluence", "HEAD")
        }

        return { pushed, created, skipped: 0, deleted, errors: errors as ReadonlyArray<string> }
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
          const currentHash = yield* computeHash(localFile.content).pipe(Effect.provide(HashServiceLive))

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
      status
    })
  })
)
