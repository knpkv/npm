/** Schema-backed Jira issue normalization for the vendor-neutral plugin event. @internal */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { MaximumPluginPayloadBytes } from "../../../domain/plugins/bounds.js"
import { NormalizedPluginEventV1 } from "../../../domain/plugins/index.js"
import { SourceUrl } from "../../../domain/sourceRevision.js"
import type { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { PluginMalformedResponseFailure } from "../failures.js"

const JiraText = Schema.String.check(Schema.isMaxLength(32_768))
const JiraIdentifier = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const JiraAccountId = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128))
const JiraVersionId = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128))
const JiraVersionName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(255))
const JiraTimestamp = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))

const JiraAvatarUrls = Schema.Struct({
  "16x16": Schema.optionalKey(Schema.String),
  "24x24": Schema.optionalKey(Schema.String),
  "32x32": Schema.optionalKey(Schema.String),
  "48x48": Schema.optionalKey(Schema.String)
})

const JiraUser = Schema.Struct({
  accountId: Schema.optionalKey(JiraAccountId),
  active: Schema.optionalKey(Schema.Boolean),
  avatarUrls: Schema.optionalKey(JiraAvatarUrls),
  displayName: Schema.optionalKey(JiraText)
})

const JiraNamedValue = Schema.Struct({
  id: Schema.optionalKey(JiraIdentifier),
  name: Schema.optionalKey(JiraText)
})

const JiraProject = Schema.Struct({
  id: Schema.optionalKey(JiraIdentifier),
  key: Schema.optionalKey(JiraIdentifier),
  name: Schema.optionalKey(JiraText)
})

const JiraVersion = Schema.Struct({
  id: Schema.optionalKey(JiraVersionId),
  name: Schema.optionalKey(JiraVersionName),
  released: Schema.optionalKey(Schema.Boolean),
  releaseDate: Schema.optionalKey(Schema.String)
})

const JiraRelatedIssue = Schema.Struct({
  id: Schema.optionalKey(JiraIdentifier),
  key: Schema.optionalKey(JiraIdentifier),
  fields: Schema.optionalKey(Schema.Struct({
    summary: Schema.optionalKey(JiraText),
    status: Schema.optionalKey(JiraNamedValue)
  }))
})

const JiraIssueFields = Schema.Struct({
  summary: JiraText,
  updated: JiraTimestamp,
  description: Schema.optionalKey(Schema.NullOr(Schema.Json)),
  environment: Schema.optionalKey(Schema.NullOr(Schema.Json)),
  status: Schema.optionalKey(Schema.NullOr(JiraNamedValue)),
  priority: Schema.optionalKey(Schema.NullOr(JiraNamedValue)),
  issuetype: Schema.optionalKey(Schema.NullOr(JiraNamedValue)),
  project: Schema.optionalKey(Schema.NullOr(JiraProject)),
  assignee: Schema.optionalKey(Schema.NullOr(JiraUser)),
  reporter: Schema.optionalKey(Schema.NullOr(JiraUser)),
  creator: Schema.optionalKey(Schema.NullOr(JiraUser)),
  labels: Schema.optionalKey(Schema.Array(JiraText)),
  components: Schema.optionalKey(Schema.Array(JiraNamedValue)),
  fixVersions: Schema.optionalKey(Schema.Array(JiraVersion)),
  resolution: Schema.optionalKey(Schema.NullOr(JiraNamedValue)),
  created: Schema.optionalKey(JiraTimestamp),
  duedate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resolutiondate: Schema.optionalKey(Schema.NullOr(JiraTimestamp)),
  parent: Schema.optionalKey(Schema.NullOr(JiraRelatedIssue)),
  subtasks: Schema.optionalKey(Schema.Array(JiraRelatedIssue))
})

const JiraIssueResponse = Schema.Struct({
  id: JiraIdentifier,
  key: JiraIdentifier,
  fields: JiraIssueFields
})

const JiraCommentResponse = Schema.Struct({
  id: JiraIdentifier,
  author: Schema.optionalKey(JiraUser),
  updateAuthor: Schema.optionalKey(JiraUser),
  body: Schema.optionalKey(Schema.Json),
  created: Schema.optionalKey(JiraTimestamp),
  updated: Schema.optionalKey(JiraTimestamp)
})

const JiraChangeItem = Schema.Struct({
  field: Schema.optionalKey(JiraText),
  fieldId: Schema.optionalKey(JiraText),
  from: Schema.optionalKey(Schema.String),
  fromString: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  toString: Schema.optionalKey(Schema.String)
})

const JiraChangelogResponse = Schema.Struct({
  id: JiraIdentifier,
  author: Schema.optionalKey(JiraUser),
  created: Schema.optionalKey(JiraTimestamp),
  items: Schema.optionalKey(Schema.Array(JiraChangeItem))
})

type JiraIssueEvent = Extract<NormalizedPluginEventV1, { readonly _tag: "UpsertEntity" }>

const NormalizedJiraIssueAttributes = Schema.Struct({
  project: Schema.NullOr(Schema.Struct({
    id: Schema.NullOr(JiraIdentifier),
    key: Schema.NullOr(JiraIdentifier),
    name: Schema.NullOr(JiraText)
  })),
  collaborators: Schema.Array(Schema.Struct({
    providerPersonId: JiraAccountId,
    displayName: JiraText,
    avatarUrl: Schema.NullOr(Schema.String),
    active: Schema.Boolean,
    roles: Schema.Array(Schema.String)
  })),
  fixVersions: Schema.Array(Schema.Struct({
    id: Schema.NullOr(JiraVersionId),
    name: Schema.NullOr(JiraVersionName),
    released: Schema.Boolean,
    releaseDate: Schema.NullOr(Schema.String)
  })),
  commentTotal: Schema.Number,
  commentsTruncated: Schema.Boolean,
  historyTotal: Schema.Number,
  historyTruncated: Schema.Boolean
})

const MAXIMUM_MATERIALIZED_COLLABORATORS = 200
const MAXIMUM_MATERIALIZED_FIX_VERSIONS = 100

/** One bounded collection fetched from Jira. @internal */
export interface JiraFetchedCollection<Value> {
  readonly values: ReadonlyArray<Value>
  readonly total: number
  readonly truncated: boolean
}

interface NormalizeJiraIssueInput {
  readonly issue: unknown
  readonly comments: JiraFetchedCollection<unknown>
  readonly changelogs: JiraFetchedCollection<unknown>
  readonly observedAt: UtcTimestamp
  readonly webBaseUrl: URL
}

interface MutablePerson {
  readonly providerPersonId: string
  readonly displayName: string
  readonly avatarUrl: string | null
  readonly active: boolean
  readonly roles: Set<string>
}

const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const MAX_RICH_TEXT_CHARACTERS = 4_000
const MAX_CHANGE_VALUE_CHARACTERS = 1_000
const jsonEncoder = new TextEncoder()

const jsonByteLength = (value: unknown): number => jsonEncoder.encode(JSON.stringify(value)).byteLength

const richTextFragments = (value: Schema.Json): ReadonlyArray<string> => {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(richTextFragments)
  const decoded = Schema.decodeUnknownResult(JsonRecord)(value)
  if (Result.isFailure(decoded)) return []
  const text = decoded.success.text
  const content = decoded.success.content
  return [
    ...(typeof text === "string" ? [text] : []),
    ...(Array.isArray(content) ? content.flatMap(richTextFragments) : [])
  ]
}

const normalizeRichText = (value: Schema.Json | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const text = richTextFragments(value).join(" ").replace(/\s+/gu, " ").trim()
  return text.length === 0 ? null : text.slice(0, MAX_RICH_TEXT_CHARACTERS)
}

const compact = (value: string | undefined): string | null =>
  value === undefined ? null : value.slice(0, MAX_CHANGE_VALUE_CHARACTERS)

const namedValue = (value: typeof JiraNamedValue.Type | null | undefined) =>
  value === null || value === undefined
    ? null
    : { id: value.id ?? null, name: value.name ?? null }

const relatedIssue = (value: typeof JiraRelatedIssue.Type | null | undefined) =>
  value === null || value === undefined
    ? null
    : {
      id: value.id ?? null,
      key: value.key ?? null,
      summary: value.fields?.summary ?? null,
      status: namedValue(value.fields?.status)
    }

const addPerson = (
  people: Map<string, MutablePerson>,
  user: typeof JiraUser.Type | null | undefined,
  role: string
): string | null => {
  if (user === null || user === undefined || user.accountId === undefined) return null
  const existing = people.get(user.accountId)
  if (existing !== undefined) {
    existing.roles.add(role)
    return user.accountId
  }
  people.set(user.accountId, {
    providerPersonId: user.accountId,
    displayName: user.displayName ?? user.accountId,
    avatarUrl: user.avatarUrls?.["48x48"] ?? user.avatarUrls?.["32x32"] ?? null,
    active: user.active ?? true,
    roles: new Set([role])
  })
  return user.accountId
}

const malformed = (diagnosticCode: string) =>
  new PluginMalformedResponseFailure({
    operation: "jira-normalize-issue",
    diagnosticCode
  })

const decodeMany = <SchemaType extends Schema.Codec<unknown, unknown, never, never>>(
  schema: SchemaType,
  values: ReadonlyArray<unknown>,
  diagnosticCode: string
): Effect.Effect<ReadonlyArray<SchemaType["Type"]>, PluginMalformedResponseFailure> =>
  Effect.forEach(
    values,
    (value) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => malformed(diagnosticCode)))
  )

/** Normalize a provider issue plus its bounded activity pages into one issue event. @internal */
export const normalizeJiraIssue = Effect.fn("JiraIssueNormalization.normalize")(function*(
  input: NormalizeJiraIssueInput
): Effect.fn.Return<JiraIssueEvent, PluginMalformedResponseFailure> {
  const issue = yield* Schema.decodeUnknownEffect(JiraIssueResponse)(input.issue).pipe(
    Effect.mapError(() => malformed("jira-issue-shape-invalid"))
  )
  const comments = yield* decodeMany(
    JiraCommentResponse,
    input.comments.values,
    "jira-comment-shape-invalid"
  )
  const changelogs = yield* decodeMany(
    JiraChangelogResponse,
    input.changelogs.values,
    "jira-changelog-shape-invalid"
  )

  const baseUrl = input.webBaseUrl.href.endsWith("/")
    ? input.webBaseUrl.href.slice(0, -1)
    : input.webBaseUrl.href
  const sourceUrl = new URL(`${baseUrl}/browse/${encodeURIComponent(issue.key)}`)

  const retainedComments = [...comments]
  const retainedChangelogs = [...changelogs]
  const retainedLabels = [...(issue.fields.labels ?? [])]
  const retainedComponents = (issue.fields.components ?? []).map(namedValue)
  const retainedFixVersions = (issue.fields.fixVersions ?? []).map((version) => ({
    id: version.id ?? null,
    name: version.name ?? null,
    released: version.released ?? false,
    releaseDate: version.releaseDate ?? null
  }))
  const retainedSubtasks = (issue.fields.subtasks ?? []).map(relatedIssue)
  const truncatedFields = new Set<string>()
  let compactCollaborators = false
  let retainedDescription = normalizeRichText(issue.fields.description)
  let retainedEnvironment = normalizeRichText(issue.fields.environment)
  let retainedStatus = namedValue(issue.fields.status)
  let retainedPriority = namedValue(issue.fields.priority)
  let retainedIssueType = namedValue(issue.fields.issuetype)
  let retainedProject = issue.fields.project === null || issue.fields.project === undefined
    ? null
    : {
      id: issue.fields.project.id ?? null,
      key: issue.fields.project.key ?? null,
      name: issue.fields.project.name ?? null
    }
  let retainedResolution = namedValue(issue.fields.resolution)
  let retainedCreatedAt: string | null = issue.fields.created ?? null
  let retainedDueDate: string | null = issue.fields.duedate ?? null
  let retainedResolvedAt: string | null = issue.fields.resolutiondate ?? null
  let retainedParent = relatedIssue(issue.fields.parent)
  const makeAttributes = () => {
    const people = new Map<string, MutablePerson>()
    const assigneeId = addPerson(people, issue.fields.assignee, "assignee")
    const reporterId = addPerson(people, issue.fields.reporter, "reporter")
    const creatorId = addPerson(people, issue.fields.creator, "creator")
    const normalizedComments = retainedComments.map((comment) => ({
      id: comment.id,
      authorId: addPerson(people, comment.author, "commenter"),
      updateAuthorId: addPerson(people, comment.updateAuthor, "comment-editor"),
      body: normalizeRichText(comment.body),
      createdAt: comment.created ?? null,
      updatedAt: comment.updated ?? null
    }))
    const normalizedHistory = retainedChangelogs.map((history) => ({
      id: history.id,
      authorId: addPerson(people, history.author, "change-author"),
      createdAt: history.created ?? null,
      changes: (history.items ?? []).map((item) => ({
        field: item.field ?? item.fieldId ?? "unknown",
        from: compact(item.fromString ?? item.from),
        to: compact(item.toString ?? item.to)
      }))
    }))
    const collaborators = Array.from(people.values()).map((person) => ({
      providerPersonId: person.providerPersonId,
      displayName: compactCollaborators ? person.providerPersonId : person.displayName,
      avatarUrl: compactCollaborators ? null : person.avatarUrl,
      active: person.active,
      roles: Array.from(person.roles).sort()
    }))
    return {
      schemaVersion: 1,
      key: issue.key,
      summary: issue.fields.summary,
      description: retainedDescription,
      environment: retainedEnvironment,
      status: retainedStatus,
      priority: retainedPriority,
      issueType: retainedIssueType,
      project: retainedProject,
      resolution: retainedResolution,
      labels: retainedLabels,
      components: retainedComponents,
      fixVersions: retainedFixVersions,
      createdAt: retainedCreatedAt,
      updatedAt: issue.fields.updated,
      dueDate: retainedDueDate,
      resolvedAt: retainedResolvedAt,
      parent: retainedParent,
      subtasks: retainedSubtasks,
      assigneeId,
      reporterId,
      creatorId,
      collaborators,
      truncatedFields: Array.from(truncatedFields).sort(),
      comments: normalizedComments,
      commentTotal: input.comments.total,
      commentsTruncated: input.comments.truncated || retainedComments.length < comments.length,
      history: normalizedHistory,
      historyTotal: input.changelogs.total,
      historyTruncated: input.changelogs.truncated || retainedChangelogs.length < changelogs.length
    }
  }
  let attributes = makeAttributes()
  while (
    jsonByteLength(attributes) > MaximumPluginPayloadBytes &&
    (retainedComments.length > 0 || retainedChangelogs.length > 0)
  ) {
    const currentBytes = jsonByteLength(attributes)
    const activityCount = retainedComments.length + retainedChangelogs.length
    const removeCount = Math.max(
      1,
      Math.ceil(activityCount * (1 - MaximumPluginPayloadBytes / currentBytes))
    )
    for (let removed = 0; removed < removeCount; removed += 1) {
      if (retainedComments.length >= retainedChangelogs.length && retainedComments.length > 0) {
        retainedComments.shift()
      } else {
        retainedChangelogs.shift()
      }
    }
    attributes = makeAttributes()
  }

  const clearValue = (field: string, clear: () => void, present: boolean): boolean => {
    if (!present) return false
    clear()
    truncatedFields.add(field)
    return true
  }
  const repeatedFieldTruncations: ReadonlyArray<{
    readonly field: string
    readonly removableBytes: () => number
    readonly truncate: () => void
  }> = [
    {
      field: "labels",
      removableBytes: () => jsonByteLength(retainedLabels),
      truncate: () => {
        retainedLabels.length = 0
      }
    },
    {
      field: "components",
      removableBytes: () => jsonByteLength(retainedComponents),
      truncate: () => {
        retainedComponents.length = 0
      }
    },
    {
      field: "fixVersions",
      removableBytes: () => jsonByteLength(retainedFixVersions),
      truncate: () => {
        retainedFixVersions.length = 0
      }
    },
    {
      field: "subtasks",
      removableBytes: () => jsonByteLength(retainedSubtasks),
      truncate: () => {
        retainedSubtasks.length = 0
      }
    },
    {
      field: "collaborators",
      removableBytes: () => {
        if (compactCollaborators) return 0
        const compacted = attributes.collaborators.map(({ active, providerPersonId, roles }) => ({
          providerPersonId,
          displayName: providerPersonId,
          avatarUrl: null,
          active,
          roles
        }))
        return Math.max(0, jsonByteLength(attributes.collaborators) - jsonByteLength(compacted))
      },
      truncate: () => {
        compactCollaborators = true
      }
    }
  ]
  while (jsonByteLength(attributes) > MaximumPluginPayloadBytes) {
    let selected: typeof repeatedFieldTruncations[number] | undefined
    let selectedBytes = 0
    for (const candidate of repeatedFieldTruncations) {
      const removableBytes = candidate.removableBytes()
      if (removableBytes > selectedBytes) {
        selected = candidate
        selectedBytes = removableBytes
      }
    }
    if (selected === undefined || selectedBytes === 0) break
    selected.truncate()
    truncatedFields.add(selected.field)
    attributes = makeAttributes()
  }

  const optionalFieldTruncations: ReadonlyArray<() => boolean> = [
    () =>
      clearValue("environment", () => {
        retainedEnvironment = null
      }, retainedEnvironment !== null),
    () =>
      clearValue("description", () => {
        retainedDescription = null
      }, retainedDescription !== null),
    () =>
      clearValue("parent", () => {
        retainedParent = null
      }, retainedParent !== null),
    () =>
      clearValue("project", () => {
        retainedProject = null
      }, retainedProject !== null),
    () =>
      clearValue("resolution", () => {
        retainedResolution = null
      }, retainedResolution !== null),
    () =>
      clearValue("priority", () => {
        retainedPriority = null
      }, retainedPriority !== null),
    () =>
      clearValue("issueType", () => {
        retainedIssueType = null
      }, retainedIssueType !== null),
    () =>
      clearValue("status", () => {
        retainedStatus = null
      }, retainedStatus !== null),
    () =>
      clearValue("dueDate", () => {
        retainedDueDate = null
      }, retainedDueDate !== null),
    () =>
      clearValue("createdAt", () => {
        retainedCreatedAt = null
      }, retainedCreatedAt !== null),
    () =>
      clearValue("resolvedAt", () => {
        retainedResolvedAt = null
      }, retainedResolvedAt !== null)
  ]
  for (
    let step = 0;
    jsonByteLength(attributes) > MaximumPluginPayloadBytes && step < optionalFieldTruncations.length;
    step += 1
  ) {
    if (optionalFieldTruncations[step]?.()) attributes = makeAttributes()
  }

  const event = yield* Schema.decodeUnknownEffect(Schema.toType(NormalizedPluginEventV1))({
    _tag: "UpsertEntity",
    eventId: `jira:issue:${issue.id}:${issue.fields.updated}`,
    observedAt: input.observedAt,
    revision: issue.fields.updated,
    entityType: "jira.issue",
    vendorImmutableId: issue.id,
    sourceUrl,
    title: `${issue.key} · ${issue.fields.summary}`.slice(0, 500),
    attributes
  }).pipe(Effect.mapError(() => malformed("jira-normalized-issue-invalid")))
  if (event._tag !== "UpsertEntity") return yield* malformed("jira-normalized-event-kind-invalid")
  return event
})

const normalizedEvent = Effect.fn("JiraIssueNormalization.normalizedEvent")(function*(input: unknown) {
  return yield* Schema.decodeUnknownEffect(Schema.toType(NormalizedPluginEventV1))(input).pipe(
    Effect.mapError(() => malformed("jira-normalized-related-event-invalid"))
  )
})

const releaseRevision = (version: typeof NormalizedJiraIssueAttributes.Type["fixVersions"][number]): string =>
  `${version.released ? "released" : "candidate"}:${version.releaseDate ?? "none"}:${version.name ?? "unnamed"}`

/** Normalize one synchronized Jira issue into canonical issue, person, release, and evidence events. @internal */
export const normalizeJiraIssueEvents = Effect.fn("JiraIssueNormalization.normalizeEvents")(function*(
  input: NormalizeJiraIssueInput
): Effect.fn.Return<ReadonlyArray<NormalizedPluginEventV1>, PluginMalformedResponseFailure> {
  const issueEvent = yield* normalizeJiraIssue(input)
  const attributes = yield* Schema.decodeUnknownEffect(NormalizedJiraIssueAttributes)(issueEvent.attributes).pipe(
    Effect.mapError(() => malformed("jira-normalized-issue-attributes-invalid"))
  )
  const events: Array<NormalizedPluginEventV1> = [issueEvent]

  for (const collaborator of attributes.collaborators.slice(0, MAXIMUM_MATERIALIZED_COLLABORATORS)) {
    const avatarUrl = collaborator.avatarUrl === null
      ? null
      : Schema.decodeUnknownResult(SourceUrl)(collaborator.avatarUrl)
    events.push(
      yield* normalizedEvent({
        _tag: "UpsertPerson",
        eventId: `jira:person:${collaborator.providerPersonId}:${issueEvent.vendorImmutableId}:${issueEvent.revision}`,
        observedAt: issueEvent.observedAt,
        revision: issueEvent.revision,
        vendorPersonId: collaborator.providerPersonId,
        displayName: collaborator.displayName.slice(0, 200),
        avatarUrl: avatarUrl === null || Result.isFailure(avatarUrl) ? null : avatarUrl.success,
        active: collaborator.active
      })
    )
  }

  const activitySummary = [
    `comments ${String(attributes.commentTotal)}${attributes.commentsTruncated ? "+" : ""}`,
    `history ${String(attributes.historyTotal)}${attributes.historyTruncated ? "+" : ""}`
  ].join(", ")
  events.push(
    yield* normalizedEvent({
      _tag: "AppendEvidence",
      eventId: `jira:evidence:${issueEvent.vendorImmutableId}:activity:${issueEvent.revision}`,
      observedAt: issueEvent.observedAt,
      revision: issueEvent.revision,
      evidenceId: `jira:issue:${issueEvent.vendorImmutableId}:activity:${issueEvent.revision}`,
      subject: {
        entityType: issueEvent.entityType,
        vendorImmutableId: issueEvent.vendorImmutableId
      },
      evidenceType: "status-observed",
      summary: `Jira activity freshness: ${activitySummary}`,
      capturedAt: issueEvent.observedAt,
      data: {
        predicate: "status-observed",
        value: { _tag: "state", value: activitySummary }
      }
    })
  )

  for (const version of attributes.fixVersions.slice(0, MAXIMUM_MATERIALIZED_FIX_VERSIONS)) {
    if (version.id === null || version.name === null) continue
    const revision = releaseRevision(version)
    const releaseVendorId = `jira-version:${version.id}`
    const projectKey = attributes.project?.key
    events.push(
      yield* normalizedEvent({
        _tag: "UpsertEntity",
        eventId: `jira:version:${version.id}:${revision}`,
        observedAt: issueEvent.observedAt,
        revision,
        entityType: "release",
        vendorImmutableId: releaseVendorId,
        sourceUrl: projectKey === null || projectKey === undefined
          ? null
          : new URL(
            `plugins/servlet/project-config/${encodeURIComponent(projectKey)}/versions`,
            input.webBaseUrl
          ),
        title: `${attributes.project?.name ?? projectKey ?? "Jira"} · ${version.name}`.slice(0, 500),
        attributes: {
          schemaVersion: 1,
          source: "jira-fix-version",
          projectId: attributes.project?.id ?? null,
          projectKey: projectKey ?? null,
          serviceName: (attributes.project?.name ?? projectKey ?? "Jira").slice(0, 200),
          version: version.name.slice(0, 100),
          lifecycle: version.released ? "released" : "candidate",
          releaseDate: version.releaseDate,
          fixVersionId: version.id
        }
      })
    )
    events.push(
      yield* normalizedEvent({
        _tag: "AppendEvidence",
        eventId: `jira:evidence:${issueEvent.vendorImmutableId}:fix-version:${version.id}:${issueEvent.revision}`,
        observedAt: issueEvent.observedAt,
        revision: issueEvent.revision,
        evidenceId: `jira:issue:${issueEvent.vendorImmutableId}:fix-version:${version.id}`,
        subject: {
          entityType: issueEvent.entityType,
          vendorImmutableId: issueEvent.vendorImmutableId
        },
        evidenceType: "relationship-observed",
        summary: `Jira fix version ${version.name}`.slice(0, 500),
        capturedAt: issueEvent.observedAt,
        data: {
          predicate: "relationship-observed",
          value: { _tag: "state", value: version.name.slice(0, 500) }
        }
      })
    )
  }

  return events
})
