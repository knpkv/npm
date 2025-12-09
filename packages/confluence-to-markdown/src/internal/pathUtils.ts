/**
 * Path utilities for converting page titles to file paths.
 *
 * @module
 * @internal
 */
import * as Path from "@effect/platform/Path"
import * as Effect from "effect/Effect"

/**
 * Convert a page title to a URL-safe slug.
 * Prevents path traversal by only allowing alphanumeric characters and hyphens.
 *
 * @param title - The page title
 * @returns A slugified version of the title
 *
 * @internal
 */
export const slugify = (title: string): string => {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with hyphens (prevents ../ path traversal)
    .replace(/^-+|-+$/g, "") // Trim leading/trailing hyphens
    .substring(0, 100) // Limit length

  // Ensure we have a valid slug (not empty after sanitization)
  return slug || "untitled"
}

/**
 * Convert a page to a local file path.
 *
 * @param title - The page title
 * @param hasChildren - Whether the page has child pages
 * @param parentPath - The parent directory path
 * @returns The local file path for the page
 *
 * @internal
 */
export const pageToPath = (
  title: string,
  hasChildren: boolean,
  parentPath: string
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const slug = slugify(title)
    return hasChildren
      ? path.join(parentPath, slug, "index.md")
      : path.join(parentPath, `${slug}.md`)
  })

/**
 * Get the directory path for a page (used when creating children).
 *
 * @param title - The page title
 * @param parentPath - The parent directory path
 * @returns The directory path for the page's children
 *
 * @internal
 */
export const pageToDir = (
  title: string,
  parentPath: string
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const slug = slugify(title)
    return path.join(parentPath, slug)
  })

/**
 * Extract page slug from a file path.
 *
 * @param filePath - The file path
 * @returns The page slug
 *
 * @internal
 */
export const pathToSlug = (filePath: string): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const basename = path.basename(filePath, ".md")
    return basename === "index" ? path.basename(path.dirname(filePath)) : basename
  })
