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
 * - **Mutations**: {@link VersionServiceContract.createVersion} opens a new release,
 *   {@link VersionServiceContract.updateVersion} edits version fields (e.g. description)
 *   and {@link VersionServiceContract.addRelatedWork} /
 *   {@link VersionServiceContract.listRelatedWork} manage the "Related work" links that
 *   surface as Confluence pages on a release report. Mutations require the
 *   `manage:jira-project` OAuth scope (see `JiraAuth`).
 * - **Project id resolution**: the create endpoint takes a numeric `projectId`
 *   (`project` is deprecated), so {@link VersionServiceContract.createVersion} accepts the
 *   project *key* callers already use elsewhere and resolves it via `/project/{key}`.
 *
 * **Common tasks**
 *
 * - List versions for a project: `service.listProjectVersions("RPS", { released: true })`
 * - Get a single version: `service.getVersion("12345")`
 * - Open a new release: `service.createVersion({ projectKey: "RPS", name: "OOB 100" })`
 * - Set the description: `service.updateVersion("12345", { description: "..." })`
 * - Attach a Confluence page: `service.addRelatedWork("12345", { title, category, url })`
 *
 * @module
 */
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
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
 * Fields for a new version. `projectKey` is the key (e.g. `RPS`) — it is resolved
 * to the numeric `projectId` the create endpoint requires. Dates are ISO 8601
 * `yyyy-mm-dd`.
 *
 * @category Types
 */
export interface CreateVersionInput {
  readonly projectKey: string
  readonly name: string
  readonly description?: string
  readonly startDate?: string
  readonly releaseDate?: string
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
export interface VersionServiceContract {
  readonly listProjectVersions: (
    projectKey: string,
    options?: ListVersionsOptions
  ) => Effect.Effect<ReadonlyArray<Version>, JiraApiError>
  readonly getVersion: (id: string) => Effect.Effect<Version, JiraApiError>
  /**
   * Create a new (unreleased) version on a project. Needs `manage:jira-project`.
   * Resolves `projectKey` to the numeric project id the API requires.
   */
  readonly createVersion: (input: CreateVersionInput) => Effect.Effect<Version, JiraApiError>
  /** Update editable fields (currently description) on a version. Needs `manage:jira-project`. */
  readonly updateVersion: (id: string, input: UpdateVersionInput) => Effect.Effect<Version, JiraApiError>
  /** List the "Related work" links attached to a version. */
  readonly listRelatedWork: (id: string) => Effect.Effect<ReadonlyArray<RelatedWork>, JiraApiError>
  /** Attach a "Related work" link (e.g. a Confluence page) to a version. Needs `manage:jira-project`. */
  readonly addRelatedWork: (id: string, input: AddRelatedWorkInput) => Effect.Effect<RelatedWork, JiraApiError>
  /** Remove a "Related work" link from a version. Needs `manage:jira-project`. */
  readonly deleteRelatedWork: (id: string, relatedWorkId: string) => Effect.Effect<void, JiraApiError>
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
  VersionServiceContract
>()("@knpkv/jira-cli/VersionService") {}

const EXPAND = "approvers,driver,operations,issuesstatus,contributors"

/** Loosely-typed record helper for navigating untyped API JSON. */
type Raw = Record<string, Schema.Json>
const isRaw = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & Raw =>
  Predicate.isObjectOrArray(value) && value !== null && !Array.isArray(value)
const asRaw = <UnparsedInput>(value: UnparsedInput): Raw => isRaw(value) ? value : {}
const rawArray = <UnparsedInput>(value: UnparsedInput): ReadonlyArray<Raw> =>
  Array.isArray(value) ? value.filter(isRaw) : []

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
export const renderCustomFieldValue = <UnparsedInput>(raw: UnparsedInput): string | null => {
  if (raw === null || raw === undefined) return null
  if (Predicate.isString(raw)) return raw.length > 0 ? raw : null
  if (Predicate.isNumber(raw) || Predicate.isBoolean(raw)) return String(raw)
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

const stringOrNull = <UnparsedInput>(v: UnparsedInput): string | null =>
  Predicate.isString(v) && v.length > 0 ? v : null

export const personFromObject = <UnparsedInput>(raw: UnparsedInput, fallbackId?: string): Person | null => {
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
  if (Predicate.isString(raw) && raw.length > 0) {
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
    if (Predicate.isString(c) && c.length > 0) ids.push(c)
    else if (isRaw(c)) {
      const id = c["accountId"]
      if (Predicate.isString(id) && id.length > 0) ids.push(id)
    }
  }
  return ids
}

/** Normalise a Jira "Related work" entry into a {@link RelatedWork}. */
export const toRelatedWork = <UnparsedInput>(raw: UnparsedInput): RelatedWork => {
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
        if (field["name"] === name && Predicate.isString(id)) {
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
        const result: unknown = yield* client.searchIssuesUsingJql({
          params: {
            jql: buildByVersionJql(versionName, projectKey),
            fields: requestedFields,
            maxResults: PAGE,
            ...(nextPageToken && { nextPageToken })
          }
        }).pipe(
          Effect.mapError((cause) =>
            new JiraApiError({ message: `Failed to fetch tickets for fixVersion "${versionName}"`, cause })
          )
        )

        const resObj: Raw = asRaw(result)
        const issues = rawArray(resObj["issues"])
        for (const issue of issues) {
          const key = stringOrNull(issue["key"]) ?? ""
          const fields = asRaw(issue["fields"])
          const assignee = fields["assignee"]
          let assigneeId: string | null = null
          if (isRaw(assignee)) {
            const accountId = assignee["accountId"]
            if (Predicate.isString(accountId) && accountId.length > 0) assigneeId = accountId
          }
          const labelsRaw = fields["labels"]
          const labels: Array<string> = []
          if (Array.isArray(labelsRaw)) {
            for (const l of labelsRaw) if (Predicate.isString(l) && l.length > 0) labels.push(l)
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
        if (isLast === true || !Predicate.isString(next) || next.length === 0) break
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

  /**
   * Resolve a project key to its numeric id.
   *
   * `POST /version` requires `projectId`; its `project` (key) field is deprecated
   * and ignored by newer instances, so sending the key straight through creates
   * nothing and reports a confusing 400. Callers pass the key because that is
   * what every other command takes.
   */
  const resolveProjectId = (projectKey: string): Effect.Effect<number, JiraApiError> =>
    client.getProject(projectKey, undefined).pipe(
      Effect.mapError((cause) => new JiraApiError({ message: `Failed to look up project ${projectKey}`, cause })),
      Effect.flatMap((raw) => {
        const id = asRaw(raw)["id"]
        // Jira serialises project ids as strings here even though the version
        // payload wants a number.
        const numeric = Predicate.isNumber(id) ? id : Predicate.isString(id) ? Number(id) : Number.NaN
        return Number.isInteger(numeric)
          ? Effect.succeed(numeric)
          : Effect.fail(
            new JiraApiError({
              message: `Project ${projectKey} returned no usable numeric id; cannot create a version against it.`
            })
          )
      })
    )

  const createVersion = (input: CreateVersionInput): Effect.Effect<Version, JiraApiError> =>
    Effect.gen(function*() {
      const projectId = yield* resolveProjectId(input.projectKey)
      const raw = yield* client.createVersion({
        payload: {
          name: input.name,
          projectId,
          ...((input.description !== undefined) && { description: input.description }),
          ...((input.startDate !== undefined) && { startDate: input.startDate }),
          ...((input.releaseDate !== undefined) && { releaseDate: input.releaseDate })
        }
      }).pipe(
        Effect.mapError((cause) =>
          new JiraApiError({ message: `Failed to create version "${input.name}" on ${input.projectKey}`, cause })
        )
      )
      // The 201 body carries no `expand`, so map scalars only — same reasoning as
      // updateVersion.
      return mapVersionScalar(asRaw(raw))
    })

  const updateVersion = (id: string, input: UpdateVersionInput): Effect.Effect<Version, JiraApiError> =>
    client.updateVersion(id, {
      payload: { ...((input.description !== undefined) && { description: input.description }) }
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

  const deleteRelatedWork = (id: string, relatedWorkId: string): Effect.Effect<void, JiraApiError> =>
    client.deleteRelatedWork(id, relatedWorkId, undefined).pipe(
      Effect.mapError((cause) =>
        new JiraApiError({ message: `Failed to remove related work ${relatedWorkId} from version ${id}`, cause })
      ),
      Effect.asVoid
    )

  return VersionService.of({
    listProjectVersions,
    getVersion,
    createVersion,
    updateVersion,
    listRelatedWork,
    addRelatedWork,
    deleteRelatedWork
  })
})

/**
 * Desired related-work link for {@link planRelatedWorkSync}.
 *
 * @category Types
 */
export interface DesiredRelatedWork {
  readonly title: string
  readonly url: string
}

/**
 * Plan for reconciling a version's related-work links.
 *
 * @category Types
 */
export interface RelatedWorkSyncPlan {
  readonly toAdd: ReadonlyArray<DesiredRelatedWork>
  readonly kept: ReadonlyArray<string>
  // `url` is nullable because Jira can return a related-work entry without one;
  // pruning still has to be able to remove it.
  readonly toRemove: ReadonlyArray<{ readonly relatedWorkId: string; readonly url: string | null }>
}

/**
 * Work out which related-work links to add, keep and remove.
 *
 * Matching is by URL: Jira assigns the id, and the title is editable, so the
 * URL is the only stable identity a link has. Scoped to one category so a
 * `Communication` reconcile cannot disturb `Testing` links. Removal is opt-in
 * (`prune`) because links added by hand in the Jira UI are legitimate.
 *
 * URL identity is applied on both sides, which is what makes "exactly the given
 * set" true: repeated desired entries collapse to one, and `prune` removes
 * surplus copies of a desired URL as well as links to undesired ones — a pile-up
 * of identical `Release notes` links is the case this exists to clean up, so
 * keeping every copy merely because its URL is wanted would defeat it.
 *
 * Pure so that repeated scaffolding runs can be tested without the API — the
 * property that matters is that running it twice adds nothing the second time.
 *
 * @category Utilities
 */
export const planRelatedWorkSync = (
  existing: ReadonlyArray<RelatedWork>,
  desired: ReadonlyArray<DesiredRelatedWork>,
  options: { readonly category: string; readonly prune: boolean }
): RelatedWorkSyncPlan => {
  const inCategory = existing.filter((w) => w.category === options.category)
  const existingUrls = new Set(inCategory.flatMap((w) => (w.url === null ? [] : [w.url])))

  const desiredByUrl = new Map<string, DesiredRelatedWork>()
  for (const entry of desired) {
    if (!desiredByUrl.has(entry.url)) desiredByUrl.set(entry.url, entry)
  }
  const unique = [...desiredByUrl.values()]

  const toAdd = unique.filter((d) => !existingUrls.has(d.url))
  const kept = unique.filter((d) => existingUrls.has(d.url)).map((d) => d.url)

  const keptUrls = new Set<string>()
  const toRemove = options.prune
    ? inCategory.flatMap((w) => {
      // Designate the keeper before asking whether this copy is deletable. An
      // undeletable first copy that skipped straight out never claimed the
      // URL, so the next duplicate claimed it instead and *both* survived a
      // reconcile that reported success.
      if (w.url !== null && desiredByUrl.has(w.url) && !keptUrls.has(w.url)) {
        keptUrls.add(w.url)
        return []
      }
      // Nothing to delete with; leave it alone whatever its url.
      if (w.relatedWorkId === null) return []
      // A url-less entry can never match a desired link — every desired link
      // has one — so pruning must remove it rather than skip it, or the
      // category is not reconciled to the requested set and the command
      // reports success while the stale entry stays.
      return [{ relatedWorkId: w.relatedWorkId, url: w.url }]
    })
    : []

  return { toAdd, kept, toRemove }
}

/**
 * Layer for VersionService.
 *
 * @category Layers
 */
export const layer = Layer.effect(VersionService, make)
