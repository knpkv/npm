/**
 * Jira project version (release) fetching with people-field resolution.
 *
 * **Mental model**
 *
 * - **API → domain mapping**: {@link VersionService} wraps the generated V3 client,
 *   normalising a project version into a {@link Version} object with resolved Driver,
 *   Contributors, and Approvers (each rendered as a {@link Person}).
 * - **Expand options**: `approvers,driver,operations,issuesstatus` plus a passthrough
 *   for any extra fields the API returns (`contributors` is sent by Jira Premium even
 *   though it is not in the public OpenAPI spec).
 * - **Account-id resolution**: account IDs are looked up against
 *   `/rest/api/3/user?accountId={id}` and cached per service instance.
 * - **Mutations**: {@link VersionServiceShape.updateVersion} edits version fields
 *   (e.g. description) and {@link VersionServiceShape.addRelatedWork} /
 *   {@link VersionServiceShape.listRelatedWork} manage the "Related work" links that
 *   surface as Confluence pages on a release report. Mutations require the
 *   `manage:jira-project` OAuth scope (see `JiraAuth`).
 *
 * **Common tasks**
 *
 * - List versions for a project: `service.listProjectVersions("RPS", { released: true })`
 * - Get a single version: `service.getVersion("12345")`
 * - Set the description: `service.updateVersion("12345", { description: "..." })`
 * - Attach a Confluence page: `service.addRelatedWork("12345", { title, category, url })`
 *
 * @module
 */
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { buildByVersionJql } from "./internal/jqlBuilder.js"
import { JiraApiError } from "./JiraCliError.js"

/**
 * A resolved Jira user (account ID + display name).
 *
 * @category Types
 */
export interface Person {
  readonly accountId: string
  readonly displayName: string
  /** Resolved email address (PII). Stripped from `version --json` unless `--emails` is passed. */
  readonly emailAddress: string | null
}

/**
 * One approval line on a version.
 *
 * @category Types
 */
export interface Approver {
  readonly person: Person
  /** APPROVED | DECLINED | PENDING (Jira returns it uppercase). */
  readonly status: string
  readonly declineReason: string | null
  readonly description: string | null
}

/**
 * A ticket with the version set as its fixVersion. Carries the minimum metadata
 * needed by SOC2-style audits: assignee (for contributor derivation), labels
 * (for impact-tagging checks), and summary (for human-readable evidence).
 *
 * @category Types
 */
export interface VersionTicket {
  readonly key: string
  readonly summary: string | null
  readonly assignee: Person | null
  readonly labels: ReadonlyArray<string>
  /**
   * Values of any custom fields the caller asked to include (see
   * {@link ListVersionsOptions.customFieldNames}). Keyed by the field's display
   * name (the same string the caller passed in).
   */
  readonly customFields: Readonly<Record<string, string | null>>
}

/**
 * A project version (release) with people fields resolved.
 *
 * @category Types
 */
export interface Version {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly released: boolean
  readonly archived: boolean
  readonly startDate: string | null
  readonly releaseDate: string | null
  readonly driver: Person | null
  readonly contributors: ReadonlyArray<Person>
  readonly approvers: ReadonlyArray<Approver>
  readonly tickets: ReadonlyArray<VersionTicket>
  readonly url: string
}

/**
 * A "Related work" link on a version (e.g. a Confluence page surfaced on the
 * release report). `category` is a free-form string Jira groups by — common
 * values are `Communication`, `Testing`, `Design`.
 *
 * @category Types
 */
export interface RelatedWork {
  readonly relatedWorkId: string | null
  readonly title: string | null
  readonly category: string
  readonly url: string | null
}

/**
 * Input for attaching a new "Related work" link to a version.
 *
 * @category Types
 */
export interface AddRelatedWorkInput {
  readonly title: string
  readonly category: string
  readonly url: string
}

/**
 * Editable version fields. Only the provided keys are sent to Jira.
 *
 * @category Types
 */
export interface UpdateVersionInput {
  readonly description?: string
}

/**
 * Filters for listing versions.
 *
 * @category Types
 */
export interface ListVersionsOptions {
  /** Restrict to released versions. */
  readonly released?: boolean
  /** Restrict to unreleased versions. */
  readonly unreleased?: boolean
  /** Hard cap on the number of versions fetched (default: all). */
  readonly maxResults?: number
  /**
   * Custom field **display names** (e.g. `"Security & Compliance Impact"`)
   * whose values should be populated on each {@link VersionTicket.customFields}
   * map. Names are resolved to per-instance field IDs via `/rest/api/3/field`,
   * cached per service instance.
   */
  readonly customFieldNames?: ReadonlyArray<string>
}

/**
 * VersionService interface.
 *
 * @category Services
 */
export interface VersionServiceShape {
  readonly listProjectVersions: (
    projectKey: string,
    options?: ListVersionsOptions
  ) => Effect.Effect<ReadonlyArray<Version>, JiraApiError>
  readonly getVersion: (id: string) => Effect.Effect<Version, JiraApiError>
  /** Update editable fields (currently description) on a version. Needs `manage:jira-project`. */
  readonly updateVersion: (id: string, input: UpdateVersionInput) => Effect.Effect<Version, JiraApiError>
  /** List the "Related work" links attached to a version. */
  readonly listRelatedWork: (id: string) => Effect.Effect<ReadonlyArray<RelatedWork>, JiraApiError>
  /** Attach a "Related work" link (e.g. a Confluence page) to a version. Needs `manage:jira-project`. */
  readonly addRelatedWork: (id: string, input: AddRelatedWorkInput) => Effect.Effect<RelatedWork, JiraApiError>
}

/**
 * VersionService tag.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { VersionService } from "@knpkv/jira-cli/VersionService"
 *
 * Effect.gen(function* () {
 *   const versions = yield* VersionService
 *   const list = yield* versions.listProjectVersions("RPS", { released: true })
 *   console.log(`Found ${list.length} released versions`)
 * })
 * ```
 *
 * @category Services
 */
export class VersionService extends Context.Service<
  VersionService,
  VersionServiceShape
>()("@knpkv/jira-cli/VersionService") {}

const EXPAND = "approvers,driver,operations,issuesstatus,contributors"

/** Loosely-typed record helper for navigating untyped API JSON. */
type Raw = Record<string, unknown>
const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value)
const asRaw = (value: unknown): Raw => isRaw(value) ? value : {}
const rawArray = (value: unknown): ReadonlyArray<Raw> => Array.isArray(value) ? value.filter(isRaw) : []

/**
 * Render a Jira custom-field value as a flat string.
 *
 * Handles the common shapes returned by `/rest/api/3/search/jql`:
 * - cascading select: `{ value, child: { value } }` → `"Parent > Child"`
 * - single select / option: `{ value }` → `"Parent"`
 * - user object: `{ displayName }` → display name
 * - plain string/number → coerced to string
 * - array of any of the above → values joined with `, `
 * - null / unset / unknown shape → `null`
 */
export const renderCustomFieldValue = (raw: unknown): string | null => {
  if (raw === null || raw === undefined) return null
  if (typeof raw === "string") return raw.length > 0 ? raw : null
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw)
  if (Array.isArray(raw)) {
    const parts = raw.map(renderCustomFieldValue).filter((v): v is string => !!v)
    return parts.length > 0 ? parts.join(", ") : null
  }
  if (isRaw(raw)) {
    const obj = raw
    const parent = stringOrNull(obj["value"])
    if (parent) {
      const child = obj["child"]
      if (isRaw(child)) {
        const childValue = stringOrNull(child["value"])
        if (childValue) return `${parent} > ${childValue}`
      }
      return parent
    }
    const displayName = stringOrNull(obj["displayName"])
    if (displayName) return displayName
    const name = stringOrNull(obj["name"])
    if (name) return name
  }
  return null
}

const stringOrNull = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null

export const personFromObject = (raw: unknown, fallbackId?: string): Person | null => {
  if (isRaw(raw)) {
    const obj = raw
    const accountId = stringOrNull(obj["accountId"]) ?? fallbackId ?? null
    if (!accountId) return null
    return {
      accountId,
      displayName: stringOrNull(obj["displayName"]) ?? accountId,
      emailAddress: stringOrNull(obj["emailAddress"])
    }
  }
  if (typeof raw === "string" && raw.length > 0) {
    return { accountId: raw, displayName: raw, emailAddress: null }
  }
  return null
}

export const extractContributorIds = (raw: Raw): ReadonlyArray<string> => {
  // Jira Premium *may* return `contributors` on the version (undocumented in the
  // public OpenAPI spec) — read defensively. In practice we've observed it
  // empty, hence the assignee-based fallback below.
  const field = raw["contributors"]
  if (!Array.isArray(field)) return []
  const ids: Array<string> = []
  for (const c of field) {
    if (typeof c === "string" && c.length > 0) ids.push(c)
    else if (isRaw(c)) {
      const id = c["accountId"]
      if (typeof id === "string" && id.length > 0) ids.push(id)
    }
  }
  return ids
}

/** Normalise a Jira "Related work" entry into a {@link RelatedWork}. */
export const toRelatedWork = (raw: unknown): RelatedWork => {
  const o = asRaw(raw)
  return {
    relatedWorkId: stringOrNull(o["relatedWorkId"]),
    title: stringOrNull(o["title"]),
    category: stringOrNull(o["category"]) ?? "",
    url: stringOrNull(o["url"])
  }
}

const make = Effect.gen(function*() {
  const client = yield* JiraApiClient
  const userCache = new Map<string, Person>()
  // In-flight lookups keyed by accountId so concurrent callers (bounded by the
  // `concurrency: 4` fan-outs) share a single request instead of duplicating it.
  const userInFlight = new Map<string, Effect.Effect<Person, never>>()

  // Cached lookup of all custom field IDs sharing a given display name.
  const fieldIdsByName = new Map<string, ReadonlyArray<string>>()

  const resolveFieldIds = (
    name: string
  ): Effect.Effect<ReadonlyArray<string>, JiraApiError> =>
    Effect.gen(function*() {
      const cached = fieldIdsByName.get(name)
      if (cached !== undefined) return cached
      const result = yield* client.getFields(undefined).pipe(
        Effect.mapError((cause) => new JiraApiError({ message: `Failed to list Jira fields`, cause }))
      )
      const matches: Array<string> = []
      for (const field of rawArray(result)) {
        const id = field["id"]
        if (field["name"] === name && typeof id === "string") {
          matches.push(id)
        }
      }
      fieldIdsByName.set(name, matches)
      return matches
    })

  const fetchUser = (accountId: string): Effect.Effect<Person, never> =>
    client.getUser({ params: { accountId } }).pipe(
      Effect.map((u) => {
        const obj = asRaw(u)
        const person: Person = {
          accountId,
          displayName: stringOrNull(obj["displayName"]) ?? accountId,
          emailAddress: stringOrNull(obj["emailAddress"])
        }
        userCache.set(accountId, person)
        return person
      }),
      Effect.catch(() => {
        // User may be deleted / inaccessible — fall back to bare account id.
        const fallback: Person = { accountId, displayName: accountId, emailAddress: null }
        userCache.set(accountId, fallback)
        return Effect.succeed(fallback)
      }),
      // Drop the in-flight memo once resolved so a later miss can refetch.
      Effect.ensuring(Effect.sync(() => userInFlight.delete(accountId)))
    )

  const resolveUser = (accountId: string): Effect.Effect<Person, never> =>
    Effect.gen(function*() {
      const cached = userCache.get(accountId)
      if (cached) return cached
      const existing = userInFlight.get(accountId)
      if (existing) return yield* existing
      // `Effect.cached` shares one execution across all awaiters of the returned
      // effect. Building it and storing it in `userInFlight` happens in
      // synchronous effect steps (no async boundary), so concurrent uncached
      // callers — bounded by the `concurrency: 4` fan-outs — dedupe to one
      // request rather than each issuing their own.
      const shared = yield* Effect.cached(fetchUser(accountId))
      userInFlight.set(accountId, shared)
      return yield* shared
    })

  interface RawTicket {
    readonly key: string
    readonly summary: string | null
    readonly assigneeId: string | null
    readonly labels: ReadonlyArray<string>
    readonly customFields: Record<string, string | null>
  }

  /**
   * Fetch every ticket whose `fixVersion` matches `versionName`, returning the
   * minimum metadata downstream audits need (key, summary, assignee, labels).
   *
   * `projectKey` scopes the query to a single project so version names that
   * collide across projects (e.g. `"1.0.0"`) don't pull in unrelated issues.
   * When omitted (e.g. {@link getVersion}, which has no project context), the
   * query is instance-wide and may match same-named versions in other projects.
   */
  const ticketsForVersion = (
    versionName: string,
    customFieldNames: ReadonlyArray<string>,
    projectKey?: string
  ): Effect.Effect<ReadonlyArray<VersionTicket>, JiraApiError> =>
    Effect.gen(function*() {
      const nameToIds = new Map<string, ReadonlyArray<string>>()
      for (const name of customFieldNames) {
        const ids = yield* resolveFieldIds(name)
        nameToIds.set(name, ids)
      }
      const allFieldIds = new Set<string>()
      for (const ids of nameToIds.values()) for (const id of ids) allFieldIds.add(id)
      const requestedFields = ["assignee", "labels", "summary", ...allFieldIds]

      const raws: Array<RawTicket> = []
      const PAGE = 100
      const MAX_PAGES = 100
      let nextPageToken: string | undefined = undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = yield* client.searchIssuesUsingJql({
          params: {
            jql: buildByVersionJql(versionName, projectKey),
            fields: requestedFields,
            maxResults: PAGE,
            ...(nextPageToken ? { nextPageToken } : {})
          }
        }).pipe(
          Effect.mapError((cause) =>
            new JiraApiError({ message: `Failed to fetch tickets for fixVersion "${versionName}"`, cause })
          )
        )

        const resObj = asRaw(result)
        const issues = rawArray(resObj["issues"])
        for (const issue of issues) {
          const key = stringOrNull(issue["key"]) ?? ""
          const fields = asRaw(issue["fields"])
          const assignee = fields["assignee"]
          let assigneeId: string | null = null
          if (isRaw(assignee)) {
            const accountId = assignee["accountId"]
            if (typeof accountId === "string" && accountId.length > 0) assigneeId = accountId
          }
          const labelsRaw = fields["labels"]
          const labels: Array<string> = []
          if (Array.isArray(labelsRaw)) {
            for (const l of labelsRaw) if (typeof l === "string" && l.length > 0) labels.push(l)
          }
          const customFields: Record<string, string | null> = {}
          for (const name of customFieldNames) {
            const ids = nameToIds.get(name) ?? []
            let resolved: string | null = null
            for (const id of ids) {
              const v = renderCustomFieldValue(fields[id])
              if (v !== null) {
                resolved = v
                break
              }
            }
            customFields[name] = resolved
          }
          raws.push({
            key,
            summary: stringOrNull(fields["summary"]),
            assigneeId,
            labels,
            customFields
          })
        }

        const isLast = resObj["isLast"]
        const next = resObj["nextPageToken"]
        if (isLast === true || typeof next !== "string" || next.length === 0) break
        nextPageToken = next
      }

      const uniqueAssignees = Array.from(
        new Set(raws.map((t) => t.assigneeId).filter((id): id is string => !!id))
      )
      yield* Effect.forEach(uniqueAssignees, (id) => resolveUser(id), { concurrency: 4 })

      return raws.map((t) => ({
        key: t.key,
        summary: t.summary,
        assignee: t.assigneeId ? userCache.get(t.assigneeId) ?? null : null,
        labels: t.labels,
        customFields: t.customFields
      }))
    })

  const mapVersion = (
    raw: Raw,
    customFieldNames: ReadonlyArray<string>,
    projectKey?: string
  ): Effect.Effect<Version, JiraApiError> =>
    Effect.gen(function*() {
      const id = String(raw["id"] ?? "")
      const name = String(raw["name"] ?? "")
      const driverId = stringOrNull(raw["driver"])
      const declared = extractContributorIds(raw)
      const approversRaw = rawArray(raw["approvers"])

      const tickets = yield* ticketsForVersion(name, customFieldNames, projectKey)

      const contributorIds = declared.length > 0
        ? declared
        : Array.from(new Set(tickets.map((t) => t.assignee?.accountId).filter((v): v is string => !!v)))

      const driver = driverId ? yield* resolveUser(driverId) : null
      const contributors = yield* Effect.forEach(contributorIds, (id) => resolveUser(id), { concurrency: 4 })

      const approvers = yield* Effect.forEach(approversRaw, (a) =>
        Effect.gen(function*() {
          const accountId = stringOrNull(a["accountId"])
          const person = accountId
            ? yield* resolveUser(accountId)
            : (personFromObject(a) ?? { accountId: "<unknown>", displayName: "<unknown>", emailAddress: null })
          return {
            person,
            status: String(a["status"] ?? "UNKNOWN").toUpperCase(),
            declineReason: stringOrNull(a["declineReason"]),
            description: stringOrNull(a["description"])
          }
        }), { concurrency: 4 })

      return {
        id,
        name,
        description: stringOrNull(raw["description"]),
        released: raw["released"] === true,
        archived: raw["archived"] === true,
        startDate: stringOrNull(raw["startDate"]),
        releaseDate: stringOrNull(raw["releaseDate"]),
        driver,
        contributors,
        approvers,
        tickets,
        url: stringOrNull(raw["self"]) ?? ""
      }
    })

  /**
   * Map a version's scalar fields only — no ticket scan, no people resolution.
   * Used for mutation responses ({@link updateVersion}) whose PUT payload carries
   * no `expand`, so the heavy {@link ticketsForVersion} fan-out would only ever
   * feed an empty `contributors` fallback. `driver`/`contributors`/`approvers`/
   * `tickets` are returned empty.
   */
  const mapVersionScalar = (raw: Raw): Version => ({
    id: String(raw["id"] ?? ""),
    name: String(raw["name"] ?? ""),
    description: stringOrNull(raw["description"]),
    released: raw["released"] === true,
    archived: raw["archived"] === true,
    startDate: stringOrNull(raw["startDate"]),
    releaseDate: stringOrNull(raw["releaseDate"]),
    driver: null,
    contributors: [],
    approvers: [],
    tickets: [],
    url: stringOrNull(raw["self"]) ?? ""
  })

  const PAGE_SIZE = 50
  const MAX_PAGES = 200

  const listProjectVersions = (
    projectKey: string,
    options?: ListVersionsOptions
  ): Effect.Effect<ReadonlyArray<Version>, JiraApiError> =>
    Effect.gen(function*() {
      const all: Array<Raw> = []
      let startAt = 0
      const cap = options?.maxResults
      const customFieldNames = options?.customFieldNames ?? []
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = yield* client.getProjectVersionsPaginated(projectKey, {
          params: {
            startAt,
            maxResults: PAGE_SIZE,
            expand: EXPAND,
            orderBy: "-releaseDate"
          }
        }).pipe(
          Effect.mapError((cause) => new JiraApiError({ message: `Failed to list versions for ${projectKey}`, cause }))
        )

        const resObj = asRaw(result)
        const values = rawArray(resObj["values"])
        for (const v of values) {
          if (options?.released === true && v["released"] !== true) continue
          if (options?.unreleased === true && v["released"] === true) continue
          all.push(v)
          if (cap !== undefined && all.length >= cap) break
        }
        if (cap !== undefined && all.length >= cap) break
        const isLast = resObj["isLast"]
        if (isLast === true || values.length < PAGE_SIZE) break
        startAt += values.length
      }
      return yield* Effect.forEach(all, (r) => mapVersion(r, customFieldNames, projectKey), { concurrency: 4 })
    })

  const getVersion = (id: string): Effect.Effect<Version, JiraApiError> =>
    client.getVersion(id, { params: { expand: EXPAND } }).pipe(
      Effect.mapError((cause) => new JiraApiError({ message: `Failed to get version ${id}`, cause })),
      Effect.flatMap((raw) => mapVersion(asRaw(raw), []))
    )

  const updateVersion = (id: string, input: UpdateVersionInput): Effect.Effect<Version, JiraApiError> =>
    client.updateVersion(id, {
      payload: { ...(input.description !== undefined ? { description: input.description } : {}) }
    }).pipe(
      Effect.mapError((cause) => new JiraApiError({ message: `Failed to update version ${id}`, cause })),
      Effect.map((raw) => mapVersionScalar(asRaw(raw)))
    )

  const listRelatedWork = (id: string): Effect.Effect<ReadonlyArray<RelatedWork>, JiraApiError> =>
    client.getRelatedWork(id, undefined).pipe(
      Effect.mapError((cause) => new JiraApiError({ message: `Failed to list related work for version ${id}`, cause })),
      Effect.map((raw) => (Array.isArray(raw) ? raw : []).map(toRelatedWork))
    )

  const addRelatedWork = (id: string, input: AddRelatedWorkInput): Effect.Effect<RelatedWork, JiraApiError> =>
    client.createRelatedWork(id, {
      payload: { title: input.title, category: input.category, url: input.url }
    }).pipe(
      Effect.mapError((cause) => new JiraApiError({ message: `Failed to add related work to version ${id}`, cause })),
      Effect.map((raw) => {
        const w = toRelatedWork(raw)
        // POST echoes the created entity; fall back to the input we sent.
        return {
          relatedWorkId: w.relatedWorkId,
          title: w.title ?? input.title,
          category: w.category || input.category,
          url: w.url ?? input.url
        }
      })
    )

  return VersionService.of({
    listProjectVersions,
    getVersion,
    updateVersion,
    listRelatedWork,
    addRelatedWork
  })
})

/**
 * Layer for VersionService.
 *
 * @category Layers
 */
export const layer = Layer.effect(VersionService, make)
