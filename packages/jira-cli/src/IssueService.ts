/**
 * Jira issue fetching with field extraction and cursor-based pagination.
 *
 * **Mental model**
 *
 * - **API → domain mapping**: {@link IssueService} wraps the generated V3 client, extracting
 *   typed {@link Issue} objects from the loosely-typed API response via helper functions
 *   like `extractDisplayName` and `extractNameArray`.
 * - **Rendered fields**: Requests include `expand: "renderedFields"` to get HTML-rendered
 *   descriptions and comments, falling back to plain text.
 * - **Pagination guard**: {@link IssueServiceShape.searchAll} iterates pages using
 *   `nextPageToken` with a MAX_PAGES (1000) safety limit.
 *
 * **Common tasks**
 *
 * - Fetch single issue: `service.getByKey("PROJ-123")`
 * - Search with pagination: `service.searchAll(jql)`
 *
 * @module
 */
import { normalizeAttachmentMediaType } from "@knpkv/atlassian-common/attachments"
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import { JiraApiError } from "./JiraCliError.js"

/**
 * Site URL configuration for issue links.
 *
 * @category Config
 */
export class SiteUrl extends Context.Service<SiteUrl, string>()("@knpkv/jira-cli/SiteUrl") {}

/**
 * Attachment metadata.
 *
 * @category Types
 */
export interface Attachment {
  readonly id: string
  readonly filename: string
  readonly url: string
  readonly mediaType: string | null
  /** Backwards-compatible alias for consumers that still read Jira's MIME field name. */
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
}

/**
 * Search result with pagination info.
 *
 * @category Types
 */
export interface SearchResult {
  readonly issues: ReadonlyArray<Issue>
  /** True if this is the last page (API uses cursor pagination, no total count) */
  readonly isLast: boolean
  readonly nextPageToken: string | null
  readonly maxResults: number
}

interface SearchJqlResponse {
  readonly issues?: ReadonlyArray<unknown>
  readonly isLast?: boolean
  readonly nextPageToken?: string
}

const recordOrEmpty = (value: unknown): Readonly<Record<PropertyKey, unknown>> =>
  Predicate.isReadonlyObject(value) ? value : {}

const recordArray = (value: unknown): ReadonlyArray<Readonly<Record<PropertyKey, unknown>>> =>
  Array.isArray(value) ? value.filter(Predicate.isReadonlyObject) : []

const parseSearchJqlResponse = (value: unknown): SearchJqlResponse => {
  const record = recordOrEmpty(value)
  const nextPageToken = typeof record.nextPageToken === "string" ? record.nextPageToken : undefined
  return {
    issues: Array.isArray(record.issues) ? record.issues : [],
    isLast: typeof record.isLast === "boolean" ? record.isLast : nextPageToken === undefined,
    ...(nextPageToken !== undefined ? { nextPageToken } : {})
  }
}

/**
 * Edits to apply to an issue's list-valued fields.
 *
 * `add`/`remove` are incremental and `set` replaces. Prefer the incremental pair:
 * `fixVersions` and `labels` are **sets**, so a `set` that forgets an existing
 * value silently drops it — the failure mode when scripting a release scope.
 *
 * An empty array reads as "not supplied", not as "clear the field". The CLI's
 * repeatable flags use `Options.atLeast(0)`, which reports an absent flag as
 * `[]`, so treating `[]` as a replacement would turn every unpassed flag into a
 * destructive clear. The consequence is that clearing a field outright is not
 * currently expressible; it needs an explicit `--clear-*` flag (or a
 * presence-aware option type) rather than a reinterpretation of `[]`.
 *
 * @category Types
 */
export interface EditIssueInput {
  readonly addFixVersions?: ReadonlyArray<string>
  readonly removeFixVersions?: ReadonlyArray<string>
  readonly setFixVersions?: ReadonlyArray<string>
  readonly addLabels?: ReadonlyArray<string>
  readonly removeLabels?: ReadonlyArray<string>
  readonly setLabels?: ReadonlyArray<string>
}

/** Any JSON value, matching what the generated client accepts for field values. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

/** One entry in Jira's `update` map. */
interface FieldOperation {
  readonly add?: JsonValue
  readonly remove?: JsonValue
}

/** A `PUT /issue/{key}` body: `fields` replaces, `update` applies operations. */
interface EditIssuePayload {
  readonly fields?: { readonly [field: string]: JsonValue }
  readonly update?: { readonly [field: string]: ReadonlyArray<FieldOperation> }
}

/**
 * One list-valued field's edits, plus how to render a value for it — Jira wants
 * `{ name }` objects for fixVersions but bare strings for labels.
 */
interface FieldEditSpec {
  readonly field: string
  /** Flag stem, so an error can quote the flag the caller actually typed. */
  readonly flag: string
  readonly set: ReadonlyArray<string> | undefined
  readonly add: ReadonlyArray<string> | undefined
  readonly remove: ReadonlyArray<string> | undefined
  readonly wrap: (value: string) => JsonValue
}

/**
 * Outcome of {@link buildEditIssuePayload}: either a body to send, or the
 * reason the requested edit is not expressible as one.
 *
 * Tagged rather than discriminated by property presence, so a caller matches on
 * `_tag` and a future third outcome cannot narrow silently.
 *
 * @category Types
 */
export type EditIssuePayloadResult =
  | { readonly _tag: "Payload"; readonly payload: EditIssuePayload }
  | { readonly _tag: "Invalid"; readonly reason: string }

/**
 * Build the `PUT /issue/{key}` body for an {@link EditIssueInput}.
 *
 * Incremental edits go through Jira's `update` verb rather than a
 * read-modify-write on `fields`: the server applies them atomically, so a
 * concurrent edit cannot be clobbered and no extra GET is needed.
 *
 * Jira rejects a field that appears in both `fields` and `update`, and the error
 * it returns does not name the field — so that combination is caught here with a
 * message that does.
 *
 * Pure so the payload shape can be tested without the API.
 *
 * @category Utilities
 */
export const buildEditIssuePayload = (
  input: EditIssueInput
): EditIssuePayloadResult => {
  const fields: Record<string, JsonValue> = {}
  const update: Record<string, ReadonlyArray<FieldOperation>> = {}

  const specs: ReadonlyArray<FieldEditSpec> = [
    {
      field: "fixVersions",
      flag: "fix-version",
      set: input.setFixVersions,
      add: input.addFixVersions,
      remove: input.removeFixVersions,
      // fixVersions entries are objects keyed by name.
      wrap: (name) => ({ name })
    },
    {
      field: "labels",
      flag: "label",
      set: input.setLabels,
      add: input.addLabels,
      remove: input.removeLabels,
      // Labels are bare strings.
      wrap: (label) => label
    }
  ]

  for (const spec of specs) {
    // An empty repeatable flag arrives as `[]`, which means "not passed" rather
    // than "replace with nothing" — treating it as a set would clear the field.
    const set = spec.set !== undefined && spec.set.length > 0 ? spec.set : undefined
    const increments = [
      ...(spec.add ?? []).map((value) => ({ add: spec.wrap(value) })),
      ...(spec.remove ?? []).map((value) => ({ remove: spec.wrap(value) }))
    ]
    if (set !== undefined && increments.length > 0) {
      return {
        _tag: "Invalid",
        reason: `--${spec.flag} cannot be combined with --add-${spec.flag}/--remove-${spec.flag}; ` +
          `--${spec.flag} replaces the whole list.`
      }
    }
    if (set !== undefined) fields[spec.field] = set.map(spec.wrap)
    else if (increments.length > 0) update[spec.field] = increments
  }

  const hasFields = Object.keys(fields).length > 0
  const hasUpdate = Object.keys(update).length > 0
  if (!hasFields && !hasUpdate) {
    return {
      _tag: "Invalid",
      reason:
        "Nothing to edit. Pass at least one of --add-fix-version, --remove-fix-version, --fix-version, --add-label, --remove-label or --label."
    }
  }
  return {
    _tag: "Payload",
    payload: {
      ...(hasFields ? { fields } : {}),
      ...(hasUpdate ? { update } : {})
    }
  }
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
  /**
   * Edit an issue's list-valued fields (fixVersions, labels) and return the
   * issue as it stands afterwards. Needs `write:jira-work`.
   */
  readonly edit: (key: string, input: EditIssueInput) => Effect.Effect<Issue, JiraApiError>
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
export class IssueService extends Context.Service<
  IssueService,
  IssueServiceShape
>()("@knpkv/jira-cli/IssueService") {}

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
  if (Predicate.isReadonlyObject(field)) {
    if (typeof field.displayName === "string") return field.displayName
    if (typeof field.name === "string") return field.name
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
      if (Predicate.isReadonlyObject(item)) {
        if (typeof item.name === "string") return item.name
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
const mapIssue = (bean: Readonly<Record<PropertyKey, unknown>>, baseUrl: string): Issue => {
  const fields = recordOrEmpty(bean.fields)
  const renderedFields = recordOrEmpty(bean.renderedFields)
  const key = String(bean["key"] ?? "")
  const id = String(bean["id"] ?? "")

  // Extract attachments
  const attachmentField = fields["attachment"]
  const attachments: Array<Attachment> = Array.isArray(attachmentField)
    ? recordArray(attachmentField).map((att) => {
      const mediaType = normalizeAttachmentMediaType(
        undefined,
        typeof att["mimeType"] === "string" ? att["mimeType"] : null
      )
      return {
        id: String(att["id"] ?? ""),
        filename: String(att["filename"] ?? ""),
        url: String(att["content"] ?? ""),
        mediaType,
        mimeType: mediaType ?? "",
        size: Number(att["size"] ?? 0)
      }
    })
    : []

  // Extract comments
  const commentField = recordOrEmpty(fields["comment"])
  const commentList = recordArray(commentField.comments)
  const renderedComments = recordArray(recordOrEmpty(renderedFields.comment).comments)

  // Build map of rendered comments by ID for accurate matching
  const renderedMap = new Map<string, Record<string, unknown>>()
  for (const r of renderedComments) {
    const rId = String(r["id"] ?? "")
    if (rId) renderedMap.set(rId, r)
  }

  const comments: Array<Comment> = commentList.map((c) => {
    const author = recordOrEmpty(c.author)
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

const mapIssueUnknown = (bean: unknown, baseUrl: string): Issue => mapIssue(recordOrEmpty(bean), baseUrl)

const make = Effect.gen(function*() {
  const client = yield* JiraApiClient
  const siteUrl = yield* SiteUrl

  const getByKey = (key: string): Effect.Effect<Issue, JiraApiError> =>
    client.getIssue(key, {
      params: {
        fields: FIELDS,
        expand: "renderedFields"
      }
    }).pipe(
      Effect.map((result) => mapIssueUnknown(result, siteUrl)),
      Effect.mapError((cause) => new JiraApiError({ message: `Failed to get issue ${key}`, cause }))
    )

  const searchJql = (
    jql: string,
    maxResults: number,
    nextPageToken?: string
  ): Effect.Effect<SearchJqlResponse, JiraApiError> =>
    client.searchIssuesUsingJql({
      params: {
        jql,
        maxResults,
        ...(nextPageToken ? { nextPageToken } : {}),
        fields: FIELDS,
        expand: "renderedFields"
      }
    }).pipe(
      Effect.map(parseSearchJqlResponse),
      Effect.mapError((cause) => new JiraApiError({ message: "Failed to search issues", cause }))
    )

  const search = (jql: string, options?: SearchOptions): Effect.Effect<SearchResult, JiraApiError> =>
    searchJql(jql, options?.maxResults ?? 50).pipe(
      Effect.map((result) => {
        const issues = result.issues ?? []
        const mappedIssues: Array<Issue> = []
        for (const bean of issues) {
          mappedIssues.push(mapIssueUnknown(bean, siteUrl))
        }
        return {
          issues: mappedIssues,
          isLast: result.isLast ?? true,
          nextPageToken: result.nextPageToken ?? null,
          maxResults: options?.maxResults ?? 50
        }
      })
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
      let result = yield* searchJql(jql, maxResults, nextPageToken)
      let issues = result.issues ?? []
      pageCount++

      for (const bean of issues) {
        allIssues.push(mapIssueUnknown(bean, siteUrl))
      }

      // Fetch remaining pages with iteration guard
      while (!result.isLast && result.nextPageToken && pageCount < MAX_PAGES) {
        nextPageToken = result.nextPageToken
        result = yield* searchJql(jql, maxResults, nextPageToken)
        issues = result.issues ?? []
        pageCount++

        for (const bean of issues) {
          allIssues.push(mapIssueUnknown(bean, siteUrl))
        }
      }

      return allIssues
    })

  const edit = (key: string, input: EditIssueInput): Effect.Effect<Issue, JiraApiError> =>
    Effect.gen(function*() {
      const built = buildEditIssuePayload(input)
      if (built._tag === "Invalid") return yield* Effect.fail(new JiraApiError({ message: built.reason }))
      yield* client.editIssue(key, { payload: built.payload }).pipe(
        Effect.mapError((cause) => new JiraApiError({ message: `Failed to edit issue ${key}`, cause }))
      )
      // The 204 carries no body, so re-read to report the resulting state.
      return yield* getByKey(key)
    })

  return IssueService.of({ getByKey, search, searchAll, edit })
})

/**
 * Layer for IssueService.
 *
 * @category Layers
 */
export const layer = Layer.effect(IssueService, make)
