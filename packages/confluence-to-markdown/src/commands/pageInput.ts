/**
 * Shared page input parsing for commands that accept Confluence page IDs.
 */
import * as Effect from "effect/Effect"
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

export const validateBaseUrl = (input: string): Effect.Effect<string, ConfigError> =>
  Effect.gen(function*() {
    const url = yield* Effect.try({
      try: () => new URL(input.trim()),
      catch: () => new ConfigError({ message: `Invalid Confluence URL: ${input}` })
    })
    if (url.protocol !== "https:" || url.pathname !== "/" || !isSupportedHost(url.host)) {
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
        new ConfigError({ message: "Both --page-id and --base-url are required when --url is not provided." })
      )
    }

    return {
      pageId: yield* validatePageId(pageId),
      baseUrl: yield* validateBaseUrl(baseUrl)
    }
  })
