/**
 * Shared page input parsing for commands that accept Confluence page IDs.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { ConfigError } from "../ConfluenceError.js"

export interface PageInput {
  readonly url?: string | undefined
  readonly pageId?: string | undefined
  readonly baseUrl?: string | undefined
}

export interface ResolvedPageInput {
  readonly pageId: string
  readonly baseUrl: string
}

const isSupportedHost = (host: string): boolean => /^[a-z0-9-]+\.atlassian\.(?:net|com)$/.test(host)

const isNumericPageId = (segment: string): boolean => /^[0-9]+$/.test(segment)

export const validatePageId = (input: string): Effect.Effect<string, ConfigError> => {
  const pageId = input.trim()
  return pageId.length > 0 && isNumericPageId(pageId)
    ? Effect.succeed(pageId)
    : Effect.fail(new ConfigError({ message: `Invalid Confluence page ID: ${input}` }))
}

// Users copy the base URL out of the browser, where every Confluence path sits
// under /wiki. Treat that (and a bare trailing slash) as the site root rather
// than rejecting it — the API client builds its own paths from the origin.
const siteRootPathname = (pathname: string): string => pathname.replace(/\/wiki\/?$/, "").replace(/\/+$/, "")

export const validateBaseUrl = (input: string): Effect.Effect<string, ConfigError> =>
  Effect.gen(function*() {
    const url = yield* Effect.try({
      try: () => new URL(input.trim()),
      catch: () => new ConfigError({ message: `Invalid Confluence URL: ${input}` })
    })
    if (url.protocol !== "https:" || siteRootPathname(url.pathname) !== "" || !isSupportedHost(url.host)) {
      return yield* Effect.fail(
        new ConfigError({
          message: `Invalid Confluence URL: ${input}. Expected format: https://yoursite.atlassian.net`
        })
      )
    }
    return `${url.protocol}//${url.host}`
  })

export const parseConfluencePageUrl = (input: string): Effect.Effect<ResolvedPageInput, ConfigError> =>
  Effect.gen(function*() {
    const url = yield* Effect.try({
      try: () => new URL(input.trim()),
      catch: () => new ConfigError({ message: `Invalid Confluence page URL: ${input}` })
    })

    if (url.protocol !== "https:" || !isSupportedHost(url.host)) {
      return yield* Effect.fail(
        new ConfigError({
          message: `Unsupported Confluence page URL: ${input}. Expected an https Atlassian Cloud URL.`
        })
      )
    }

    const segments = url.pathname.split("/").filter((segment) => segment.length > 0)
    const pagesIndex = segments.indexOf("pages")
    const pageIdFromPages = pagesIndex >= 0 ? segments[pagesIndex + 1] : undefined
    const pageId = pagesIndex >= 0
      ? pageIdFromPages && isNumericPageId(pageIdFromPages) ? pageIdFromPages : undefined
      : segments.find(isNumericPageId)

    if (!pageId) {
      return yield* Effect.fail(new ConfigError({ message: `Could not find a page ID in URL: ${input}` }))
    }

    return {
      pageId,
      baseUrl: `${url.protocol}//${url.host}`
    }
  })

/**
 * Look for a cloned workspace at or above `startDir` and read its base URL.
 *
 * Lets `page get/put/patch` be run from anywhere inside a workspace without
 * repeating `--base-url` on every invocation. Silent on every failure: this is
 * a convenience, and an unreadable or malformed config simply means the flag
 * is still required.
 */
export const baseUrlFromWorkspace = (
  startDir: string
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    let dir = pathService.resolve(startDir)
    for (;;) {
      const configPath = pathService.join(dir, ".confluence", "config.json")
      const exists = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false))
      if (exists) {
        const raw = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""))
        const parsed = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(raw),
          catch: () => null
        }).pipe(Effect.orElseSucceed(() => null))
        const candidate = Predicate.isObject(parsed) && "baseUrl" in parsed ? parsed["baseUrl"] : undefined
        if (Predicate.isString(candidate) && candidate.trim().length > 0) {
          return yield* validateBaseUrl(candidate).pipe(Effect.orElseSucceed(() => undefined))
        }
        return undefined
      }
      const parent = pathService.dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  })

export const resolvePageInput = (input: PageInput): Effect.Effect<ResolvedPageInput, ConfigError> =>
  Effect.gen(function*() {
    const url = input.url?.trim()
    const pageId = input.pageId?.trim()
    const baseUrl = input.baseUrl?.trim()

    if (url && (pageId || baseUrl)) {
      return yield* Effect.fail(
        new ConfigError({ message: "Use either --url or --page-id/--base-url, not both." })
      )
    }

    if (url) {
      return yield* parseConfluencePageUrl(url)
    }

    if (!pageId || !baseUrl) {
      return yield* Effect.fail(
        new ConfigError({
          message: "Both --page-id and --base-url are required when --url is not provided " +
            "(--base-url is inferred automatically when run inside a cloned workspace)."
        })
      )
    }

    return {
      pageId: yield* validatePageId(pageId),
      baseUrl: yield* validateBaseUrl(baseUrl)
    }
  })

/**
 * `resolvePageInput`, falling back to a surrounding workspace's configured
 * base URL when `--base-url` is omitted.
 */
export const resolvePageInputWithWorkspace = (
  input: PageInput
): Effect.Effect<ResolvedPageInput, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    if (input.url !== undefined || input.baseUrl !== undefined) {
      return yield* resolvePageInput(input)
    }
    const pathService = yield* Path.Path
    const discovered = yield* baseUrlFromWorkspace(pathService.resolve("."))
    return yield* resolvePageInput(discovered === undefined ? input : { ...input, baseUrl: discovered })
  })
