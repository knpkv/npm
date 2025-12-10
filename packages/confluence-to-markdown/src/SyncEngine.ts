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
import type { ApiError, ConversionError, FileSystemError, FrontMatterError, RateLimitError } from "./ConfluenceError.js"
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

type SyncError = ApiError | RateLimitError | ConversionError | FileSystemError | FrontMatterError | GitServiceError

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
      gitInitialized: boolean
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
                  const result = yield* pullPage(child, dirPath, options, gitInitialized)
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
              page.parentId,
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
            ...(page.parentId ? { parentId: page.parentId as PageId } : {}),
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
          const result = yield* pullPage(child, dirPath, options, gitInitialized)
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
      revisionMessage: string
    ): Effect.Effect<
      { pushed: boolean; created: boolean; error?: string },
      SyncError
    > =>
      Effect.gen(function*() {
        const localFile = yield* localFs.readMarkdownFile(filePath)

        if (localFile.isNew || !localFile.frontMatter) {
          return { pushed: false, created: true, error: `Page creation not yet supported: ${filePath}` }
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
        const gitInitialized = yield* git.isInitialized()

        if (!gitInitialized) {
          // Non-git mode: just push current content
          const files = yield* localFs.listMarkdownFiles(docsPath)
          let pushed = 0
          let created = 0
          const errors: Array<string> = []

          for (const filePath of files) {
            if (options.dryRun) {
              pushed++
              continue
            }
            const result = yield* pushFile(filePath, options.message ?? "Updated via confluence-to-markdown").pipe(
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

          return { pushed, created, skipped: 0, errors: errors as ReadonlyArray<string> }
        }

        // Git mode: push current HEAD state to Confluence
        // For simplicity, we push the final state as a single Confluence version
        // with the most recent commit message
        const files = yield* localFs.listMarkdownFiles(docsPath)
        const errors: Array<string> = []
        let pushed = 0

        // Get the most recent unpushed commit message for the revision
        const unpushedCommits = yield* findUnpushedCommits()
        if (unpushedCommits.length === 0) {
          return { pushed: 0, created: 0, skipped: 0, errors: [] as ReadonlyArray<string> }
        }

        if (options.dryRun) {
          return {
            pushed: unpushedCommits.length,
            created: 0,
            skipped: 0,
            errors: [] as ReadonlyArray<string>
          }
        }

        // Use the last commit's message as the revision message
        const lastCommit = unpushedCommits[unpushedCommits.length - 1]!
        const revisionMessage = options.message ?? lastCommit.message

        for (const filePath of files) {
          const result = yield* pushFile(filePath, revisionMessage).pipe(
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
        }

        // Amend the last commit with canonical content
        yield* git.addAll()
        yield* git.amend({ noEdit: true }).pipe(
          Effect.catchAll(() => Effect.void)
        )

        // Two-branch model: update origin/confluence to match HEAD
        const hasRemoteBranch = yield* git.branchExists("origin/confluence")
        if (hasRemoteBranch) {
          yield* git.updateBranch("origin/confluence", "HEAD")
        }

        return { pushed, created: 0, skipped: 0, errors: errors as ReadonlyArray<string> }
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
