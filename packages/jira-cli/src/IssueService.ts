/**
 * Issue fetching service for Jira CLI.
 *
 * @module
 */
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { JiraApiError } from "./JiraCliError.js"

/**
 * Site URL configuration for issue links.
 *
 * @category Config
 */
export class SiteUrl extends Context.Tag("@knpkv/jira-cli/SiteUrl")<SiteUrl, string>() {}

/**
 * Attachment metadata.
 *
 * @category Types
 */
export interface Attachment {
  readonly id: string
  readonly filename: string
  readonly url: string
  readonly mimeType: string
  readonly size: number
}

/**
 * Comment on an issue.
 *
 * @category Types
 */
export interface Comment {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly created: Date
  readonly updated: Date
}

/**
 * Jira issue with relevant fields.
 *
 * @category Types
 */
export interface Issue {
  readonly key: string
  readonly id: string
  readonly summary: string
  readonly status: string
  readonly type: string
  readonly priority: string | null
  readonly assignee: string | null
  readonly reporter: string | null
  readonly created: Date
  readonly updated: Date
  readonly fixVersions: ReadonlyArray<string>
  readonly labels: ReadonlyArray<string>
  readonly components: ReadonlyArray<string>
  readonly description: string
  readonly attachments: ReadonlyArray<Attachment>
  readonly comments: ReadonlyArray<Comment>
  readonly url: string
}

/**
 * Search options for issue queries.
 *
 * @category Types
 */
export interface SearchOptions {
  readonly maxResults?: number
  readonly startAt?: number
}

/**
 * Search result with pagination info.
 *
 * @category Types
 */
export interface SearchResult {
  readonly issues: ReadonlyArray<Issue>
  readonly total: number
  readonly startAt: number
  readonly maxResults: number
}

/**
 * IssueService interface.
 *
 * @category Services
 */
export interface IssueServiceShape {
  /** Get a single issue by key */
  readonly getByKey: (key: string) => Effect.Effect<Issue, JiraApiError>
  /** Search issues by JQL query */
  readonly search: (jql: string, options?: SearchOptions) => Effect.Effect<SearchResult, JiraApiError>
  /** Search all issues by JQL query (handles pagination) */
  readonly searchAll: (
    jql: string,
    options?: { readonly maxResults?: number }
  ) => Effect.Effect<ReadonlyArray<Issue>, JiraApiError>
}

/**
 * IssueService tag.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { IssueService } from "@knpkv/jira-cli/IssueService"
 *
 * Effect.gen(function* () {
 *   const service = yield* IssueService
 *   const issues = yield* service.searchAll('fixVersion = "1.0.0"')
 *   console.log(`Found ${issues.length} issues`)
 * })
 * ```
 *
 * @category Services
 */
export class IssueService extends Context.Tag("@knpkv/jira-cli/IssueService")<
  IssueService,
  IssueServiceShape
>() {}

const FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "created",
  "updated",
  "fixVersions",
  "labels",
  "components",
  "attachment",
  "comment"
]

/**
 * Extract string from a field that may be an object with displayName/name.
 */
const extractDisplayName = (field: unknown): string | null => {
  if (field === null || field === undefined) return null
  if (typeof field === "string") return field
  if (typeof field === "object") {
    const obj = field as Record<string, unknown>
    if (typeof obj["displayName"] === "string") return obj["displayName"]
    if (typeof obj["name"] === "string") return obj["name"]
  }
  return null
}

/**
 * Extract array of strings from a field that may be array of objects with name.
 */
const extractNameArray = (field: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(field)) return []
  return field
    .map((item) => {
      if (typeof item === "string") return item
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>
        if (typeof obj["name"] === "string") return obj["name"]
      }
      return null
    })
    .filter((x): x is string => x !== null)
}

/**
 * Parse date from unknown value, returning epoch date if invalid.
 */
const parseDate = (val: unknown): Date => {
  const str = String(val ?? "")
  if (!str) return new Date(0)
  const date = new Date(str)
  return isNaN(date.getTime()) ? new Date(0) : date
}

/**
 * Map IssueBean from API to our Issue type.
 */
const mapIssue = (bean: Record<string, unknown>, baseUrl: string): Issue => {
  const fields = (bean["fields"] ?? {}) as Record<string, unknown>
  const renderedFields = (bean["renderedFields"] ?? {}) as Record<string, unknown>
  const key = String(bean["key"] ?? "")
  const id = String(bean["id"] ?? "")

  // Extract attachments
  const attachmentField = fields["attachment"]
  const attachments: Array<Attachment> = Array.isArray(attachmentField)
    ? attachmentField.map((a) => {
      const att = a as Record<string, unknown>
      return {
        id: String(att["id"] ?? ""),
        filename: String(att["filename"] ?? ""),
        url: String(att["content"] ?? ""),
        mimeType: String(att["mimeType"] ?? ""),
        size: Number(att["size"] ?? 0)
      }
    })
    : []

  // Extract comments
  const commentField = fields["comment"] as Record<string, unknown> | undefined
  const commentList = (commentField?.["comments"] ?? []) as Array<Record<string, unknown>>
  const renderedComments =
    ((renderedFields["comment"] as Record<string, unknown> | undefined)?.["comments"] ?? []) as Array<
      Record<string, unknown>
    >

  // Build map of rendered comments by ID for accurate matching
  const renderedMap = new Map<string, Record<string, unknown>>()
  for (const r of renderedComments) {
    const rId = String(r["id"] ?? "")
    if (rId) renderedMap.set(rId, r)
  }

  const comments: Array<Comment> = commentList.map((c) => {
    const author = c["author"] as Record<string, unknown> | undefined
    const commentId = String(c["id"] ?? "")
    const rendered = renderedMap.get(commentId)
    const renderedBody = rendered?.["body"]
    return {
      id: commentId,
      author: extractDisplayName(author) ?? "Unknown",
      body: typeof renderedBody === "string" ? renderedBody : String(c["body"] ?? ""),
      created: parseDate(c["created"]),
      updated: parseDate(c["updated"])
    }
  })

  // Use rendered description (HTML) if available
  const description = typeof renderedFields["description"] === "string"
    ? renderedFields["description"]
    : String(fields["description"] ?? "")

  return {
    key,
    id,
    summary: String(fields["summary"] ?? ""),
    status: extractDisplayName(fields["status"]) ?? "Unknown",
    type: extractDisplayName(fields["issuetype"]) ?? "Unknown",
    priority: extractDisplayName(fields["priority"]),
    assignee: extractDisplayName(fields["assignee"]),
    reporter: extractDisplayName(fields["reporter"]),
    created: parseDate(fields["created"]),
    updated: parseDate(fields["updated"]),
    fixVersions: extractNameArray(fields["fixVersions"]),
    labels: extractNameArray(fields["labels"]),
    components: extractNameArray(fields["components"]),
    description,
    attachments,
    comments,
    url: `${baseUrl}/browse/${key}`
  }
}

const make = Effect.gen(function*() {
  const client = yield* JiraApiClient
  const siteUrl = yield* SiteUrl

  const getByKey = (key: string): Effect.Effect<Issue, JiraApiError> =>
    Effect.gen(function*() {
      const result = yield* client.v3.getIssue(key, {
        fields: FIELDS,
        expand: "renderedFields"
      }).pipe(
        Effect.mapError((cause) => new JiraApiError({ message: `Failed to get issue ${key}`, cause }))
      )
      return mapIssue(result as unknown as Record<string, unknown>, siteUrl)
    })

  const search = (jql: string, options?: SearchOptions): Effect.Effect<SearchResult, JiraApiError> =>
    Effect.gen(function*() {
      const result = yield* client.v3.searchAndReconsileIssuesUsingJql({
        jql,
        maxResults: options?.maxResults ?? 50,
        fields: FIELDS,
        expand: "renderedFields"
      }).pipe(
        Effect.mapError((cause) => new JiraApiError({ message: "Failed to search issues", cause }))
      )

      const issues = result.issues ?? []
      const mappedIssues: Array<Issue> = []
      for (const bean of issues) {
        mappedIssues.push(mapIssue(bean as unknown as Record<string, unknown>, siteUrl))
      }

      return {
        issues: mappedIssues,
        total: issues.length,
        startAt: options?.startAt ?? 0,
        maxResults: options?.maxResults ?? 50
      }
    })

  const fetchPage = (
    jql: string,
    maxResults: number,
    nextPageToken?: string
  ) =>
    client.v3.searchAndReconsileIssuesUsingJql({
      jql,
      maxResults,
      nextPageToken,
      fields: FIELDS,
      expand: "renderedFields"
    }).pipe(
      Effect.mapError((cause) => new JiraApiError({ message: "Failed to search issues", cause }))
    )

  const MAX_PAGES = 1000

  const searchAll = (
    jql: string,
    options?: { readonly maxResults?: number }
  ): Effect.Effect<ReadonlyArray<Issue>, JiraApiError> =>
    Effect.gen(function*() {
      const allIssues: Array<Issue> = []
      const maxResults = options?.maxResults ?? 100
      let nextPageToken: string | undefined = undefined
      let pageCount = 0

      // Fetch first page
      let result = yield* fetchPage(jql, maxResults, nextPageToken)
      let issues = result.issues ?? []
      pageCount++

      for (const bean of issues) {
        allIssues.push(mapIssue(bean as unknown as Record<string, unknown>, siteUrl))
      }

      // Fetch remaining pages with iteration guard
      while (!result.isLast && result.nextPageToken && pageCount < MAX_PAGES) {
        nextPageToken = result.nextPageToken
        result = yield* fetchPage(jql, maxResults, nextPageToken)
        issues = result.issues ?? []
        pageCount++

        for (const bean of issues) {
          allIssues.push(mapIssue(bean as unknown as Record<string, unknown>, siteUrl))
        }
      }

      return allIssues
    })

  return IssueService.of({ getByKey, search, searchAll })
})

/**
 * Layer for IssueService.
 *
 * @category Layers
 */
export const layer = Layer.effect(IssueService, make)
