/**
 * Local file system operations for markdown files.
 *
 * @module
 */
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { ContentHash } from "./Brand.js"
import type { FrontMatterError } from "./ConfluenceError.js"
import { FileSystemError } from "./ConfluenceError.js"
import type { ParsedMarkdown } from "./internal/frontmatter.js"
import { parseMarkdown, serializeMarkdown } from "./internal/frontmatter.js"
import { computeHash } from "./internal/hashUtils.js"
import { pageToDir, pageToPath } from "./internal/pathUtils.js"
import type { PageFrontMatter } from "./Schemas.js"

/**
 * Local markdown file representation.
 */
export interface LocalFile {
  readonly path: string
  readonly frontMatter: PageFrontMatter | null
  readonly content: string
  readonly contentHash: ContentHash
  readonly isNew: boolean
}

/**
 * Local file system service for markdown operations.
 *
 * @example
 * ```typescript
 * import { LocalFileSystem } from "@knpkv/confluence-to-markdown/LocalFileSystem"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const fs = yield* LocalFileSystem
 *   const files = yield* fs.listMarkdownFiles(".docs/confluence")
 *   console.log(files)
 * })
 * ```
 *
 * @category FileSystem
 */
export class LocalFileSystem extends Context.Tag(
  "@knpkv/confluence-to-markdown/LocalFileSystem"
)<
  LocalFileSystem,
  {
    /**
     * Read a markdown file with front-matter.
     */
    readonly readMarkdownFile: (filePath: string) => Effect.Effect<LocalFile, FileSystemError | FrontMatterError>

    /**
     * Write a markdown file with front-matter.
     */
    readonly writeMarkdownFile: (
      filePath: string,
      frontMatter: PageFrontMatter,
      content: string
    ) => Effect.Effect<void, FileSystemError>

    /**
     * List all markdown files in a directory recursively.
     */
    readonly listMarkdownFiles: (dirPath: string) => Effect.Effect<ReadonlyArray<string>, FileSystemError>

    /**
     * Ensure a directory exists.
     */
    readonly ensureDir: (dirPath: string) => Effect.Effect<void, FileSystemError>

    /**
     * Delete a file.
     */
    readonly deleteFile: (filePath: string) => Effect.Effect<void, FileSystemError>

    /**
     * Check if a file exists.
     */
    readonly exists: (filePath: string) => Effect.Effect<boolean, FileSystemError>

    /**
     * Get the file path for a page.
     */
    readonly getPagePath: (
      title: string,
      hasChildren: boolean,
      parentPath: string
    ) => string

    /**
     * Get the directory path for a page's children.
     */
    readonly getPageDir: (title: string, parentPath: string) => string

    /**
     * Write a raw file (e.g., source HTML).
     */
    readonly writeFile: (filePath: string, content: string) => Effect.Effect<void, FileSystemError>
  }
>() {}

/**
 * Layer that provides LocalFileSystem.
 *
 * @category Layers
 */
export const layer: Layer.Layer<LocalFileSystem, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  LocalFileSystem,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const readMarkdownFile = (
      filePath: string
    ): Effect.Effect<LocalFile, FileSystemError | FrontMatterError> =>
      Effect.gen(function*() {
        const content = yield* fs.readFileString(filePath).pipe(
          Effect.mapError((cause) => new FileSystemError({ operation: "read", path: filePath, cause }))
        )

        const parsed: ParsedMarkdown = yield* parseMarkdown(filePath, content)
        const contentHash = computeHash(parsed.content)

        return {
          path: filePath,
          frontMatter: parsed.frontMatter && "pageId" in parsed.frontMatter
            ? parsed.frontMatter as PageFrontMatter
            : null,
          content: parsed.content,
          contentHash,
          isNew: parsed.isNew
        }
      })

    const writeMarkdownFile = (
      filePath: string,
      frontMatter: PageFrontMatter,
      content: string
    ): Effect.Effect<void, FileSystemError> =>
      Effect.gen(function*() {
        const dir = pathService.dirname(filePath)
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.catchAll(() => Effect.void)
        )

        const serialized = serializeMarkdown(frontMatter, content)

        // Atomic write: write to temp file, then rename
        const tempPath = `${filePath}.tmp.${Date.now()}`
        yield* fs.writeFileString(tempPath, serialized).pipe(
          Effect.mapError((cause) => new FileSystemError({ operation: "write", path: filePath, cause }))
        )
        yield* fs.rename(tempPath, filePath).pipe(
          Effect.mapError((cause) => new FileSystemError({ operation: "rename", path: filePath, cause }))
        )
      })

    const listMarkdownFiles = (
      dirPath: string
    ): Effect.Effect<ReadonlyArray<string>, FileSystemError> =>
      Effect.gen(function*() {
        const exists = yield* fs.exists(dirPath).pipe(
          Effect.mapError((cause) => new FileSystemError({ operation: "read", path: dirPath, cause }))
        )

        if (!exists) {
          return []
        }

        const files: Array<string> = []

        const walkDir = (dir: string): Effect.Effect<void, FileSystemError> =>
          Effect.gen(function*() {
            const entries = yield* fs.readDirectory(dir).pipe(
              Effect.mapError((cause) => new FileSystemError({ operation: "read", path: dir, cause }))
            )

            for (const entryName of entries) {
              const fullPath = pathService.join(dir, entryName)

              const stat = yield* fs.stat(fullPath).pipe(
                Effect.mapError((cause) => new FileSystemError({ operation: "read", path: fullPath, cause }))
              )

              if (stat.type === "Directory") {
                yield* walkDir(fullPath)
              } else if (stat.type === "File" && entryName.endsWith(".md")) {
                files.push(fullPath)
              }
            }
          })

        yield* walkDir(dirPath)
        return files
      })

    const ensureDir = (dirPath: string): Effect.Effect<void, FileSystemError> =>
      fs.makeDirectory(dirPath, { recursive: true }).pipe(
        Effect.mapError((cause) => new FileSystemError({ operation: "mkdir", path: dirPath, cause })),
        Effect.asVoid
      )

    const deleteFile = (filePath: string): Effect.Effect<void, FileSystemError> =>
      fs.remove(filePath).pipe(
        Effect.mapError((cause) => new FileSystemError({ operation: "delete", path: filePath, cause }))
      )

    const exists = (filePath: string): Effect.Effect<boolean, FileSystemError> =>
      fs.exists(filePath).pipe(
        Effect.mapError((cause) => new FileSystemError({ operation: "read", path: filePath, cause }))
      )

    const writeFile = (
      filePath: string,
      content: string
    ): Effect.Effect<void, FileSystemError> =>
      Effect.gen(function*() {
        const dir = pathService.dirname(filePath)
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.catchAll(() => Effect.void)
        )

        // Atomic write: write to temp file, then rename
        const tempPath = `${filePath}.tmp.${Date.now()}`
        yield* fs.writeFileString(tempPath, content).pipe(
          Effect.mapError((cause) => new FileSystemError({ operation: "write", path: filePath, cause }))
        )
        yield* fs.rename(tempPath, filePath).pipe(
          Effect.mapError((cause) => new FileSystemError({ operation: "rename", path: filePath, cause }))
        )
      })

    return LocalFileSystem.of({
      readMarkdownFile,
      writeMarkdownFile,
      listMarkdownFiles,
      ensureDir,
      deleteFile,
      exists,
      getPagePath: pageToPath,
      getPageDir: pageToDir,
      writeFile
    })
  })
)
