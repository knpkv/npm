/** Schema-backed Jira issue normalization for the vendor-neutral plugin event. @internal */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type { NormalizedIssueFixVersion } from "../../../domain/normalizedIssue.js"
import {
  MAXIMUM_NORMALIZED_ISSUE_COLLABORATORS,
  MAXIMUM_NORMALIZED_ISSUE_COMMENTS,
  MAXIMUM_NORMALIZED_ISSUE_COMPONENTS,
  MAXIMUM_NORMALIZED_ISSUE_FIX_VERSIONS,
  MAXIMUM_NORMALIZED_ISSUE_HISTORY,
  MAXIMUM_NORMALIZED_ISSUE_HISTORY_CHANGES,
  MAXIMUM_NORMALIZED_ISSUE_LABELS,
  MAXIMUM_NORMALIZED_ISSUE_SUBTASKS,
  NormalizedIssueAttributes
} from "../../../domain/normalizedIssue.js"
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
  subtasks: Schema.optionalKey(Schema.Array(JiraRelatedIssue)),
  estimatePoints: Schema.optionalKey(Schema.NullOr(Schema.Number))
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
  readonly sourcePersonId: string
  readonly displayName: string
  readonly avatarUrl: string | null
  readonly active: boolean
  readonly roles: Set<string>
}

const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const MAX_RICH_TEXT_CHARACTERS = 16_000
const MAX_CHANGE_VALUE_CHARACTERS = 1_000
const jsonEncoder = new TextEncoder()

const jsonByteLength = (value: unknown): number => jsonEncoder.encode(JSON.stringify(value)).byteLength

const decodedJsonRecord = (value: Schema.Json): typeof JsonRecord.Type | null => {
  const decoded = Schema.decodeUnknownResult(JsonRecord)(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

const normalizedRenderedText = (value: string, maximum: number | null = MAX_RICH_TEXT_CHARACTERS): string | null => {
  const text = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
  return text.length === 0 ? null : maximum === null ? text : text.slice(0, maximum)
}

const adfContent = (record: typeof JsonRecord.Type): ReadonlyArray<Schema.Json> =>
  Array.isArray(record.content) ? record.content : []

const MarkdownAsciiPunctuation: ReadonlySet<string> = new Set(
  Array.from("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
)

const escapedMarkdownText = (value: string): string =>
  Array.from(value, (character) => MarkdownAsciiPunctuation.has(character) ? `\\${character}` : character).join("")

const markdownInlineCode = (value: string): string => {
  let longestBacktickRun = 0
  for (const match of value.matchAll(/`+/gu)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length)
  }
  const delimiter = "`".repeat(longestBacktickRun + 1)
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : ""
  return `${delimiter}${padding}${value}${padding}${delimiter}`
}

const adfTextWithMarks = (record: typeof JsonRecord.Type, value: string): string => {
  if (!Array.isArray(record.marks)) return escapedMarkdownText(value)
  let rendered = escapedMarkdownText(value)
  let linkTarget: string | null = null
  let strong = false
  let emphasis = false
  let strike = false
  let code = false
  for (const markValue of record.marks) {
    const mark = decodedJsonRecord(markValue)
    if (mark === null) continue
    if (mark.type === "strong") strong = true
    if (mark.type === "em") emphasis = true
    if (mark.type === "strike") strike = true
    if (mark.type === "code") code = true
    if (mark.type !== "link") continue
    const attrs = mark.attrs === undefined ? null : decodedJsonRecord(mark.attrs)
    if (typeof attrs?.href !== "string") continue
    const decoded = Schema.decodeUnknownResult(SourceUrl)(attrs.href)
    if (Result.isFailure(decoded)) continue
    linkTarget = Schema.encodeSync(SourceUrl)(decoded.success)
  }
  if (code) rendered = markdownInlineCode(value)
  if (strong) rendered = `**${rendered}**`
  if (emphasis) rendered = `*${rendered}*`
  if (strike) rendered = `~~${rendered}~~`
  return linkTarget === null ? rendered : `[${rendered}](<${linkTarget}>)`
}

const adfText = (value: Schema.Json): string => {
  if (typeof value === "string") return escapedMarkdownText(value)
  if (Array.isArray(value)) return value.map(adfText).join("")
  const record = decodedJsonRecord(value)
  if (record === null) return ""
  if (record.type === "hardBreak") return "\\\n"
  if (record.type === "mention") {
    const attrs = record.attrs === undefined ? null : decodedJsonRecord(record.attrs)
    return typeof attrs?.text === "string" ? escapedMarkdownText(attrs.text) : ""
  }
  return typeof record.text === "string"
    ? adfTextWithMarks(record, record.text)
    : adfContent(record).map(adfText).join("")
}

const rawAdfText = (value: Schema.Json): string => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(rawAdfText).join("")
  const record = decodedJsonRecord(value)
  if (record === null) return ""
  return typeof record.text === "string" ? record.text : adfContent(record).map(rawAdfText).join("")
}

const markdownCodeFence = (value: string): string => {
  let longestBacktickRun = 0
  for (const match of value.matchAll(/`+/gu)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length)
  }
  return "`".repeat(Math.max(3, longestBacktickRun + 1))
}

const indented = (value: string, prefix: string): string =>
  value
    .split("\n")
    .map((line, index) => (index === 0 ? `${prefix}${line}` : `  ${line}`))
    .join("\n")

const renderAdfBlock = (value: Schema.Json): string => {
  if (typeof value === "string") return escapedMarkdownText(value)
  if (Array.isArray(value)) {
    return value
      .map(renderAdfBlock)
      .filter((part) => part.length > 0)
      .join("\n\n")
  }
  const record = decodedJsonRecord(value)
  if (record === null) return ""
  const content = adfContent(record)
  switch (record.type) {
    case "doc":
      return content
        .map(renderAdfBlock)
        .filter((part) => part.length > 0)
        .join("\n\n")
    case "paragraph":
      return content.map(adfText).join("")
    case "heading": {
      const attrs = record.attrs === undefined ? null : decodedJsonRecord(record.attrs)
      const level = typeof attrs?.level === "number" && Number.isInteger(attrs.level)
        ? Math.min(6, Math.max(1, attrs.level))
        : 1
      return `${"#".repeat(level)} ${content.map(adfText).join("")}`
    }
    case "bulletList":
      return content.map((item) => indented(renderAdfBlock(item), "- ")).join("\n")
    case "orderedList": {
      const attrs = record.attrs === undefined ? null : decodedJsonRecord(record.attrs)
      const start = typeof attrs?.order === "number" && Number.isInteger(attrs.order) ? attrs.order : 1
      return content.map((item, index) => indented(renderAdfBlock(item), `${String(start + index)}. `)).join("\n")
    }
    case "listItem":
      return content
        .map(renderAdfBlock)
        .filter((part) => part.length > 0)
        .join("\n")
    case "codeBlock": {
      const attrs = record.attrs === undefined ? null : decodedJsonRecord(record.attrs)
      const language = typeof attrs?.language === "string" ? attrs.language.replace(/[^a-z0-9_+-]/giu, "") : ""
      const code = content.map(rawAdfText).join("")
      const fence = markdownCodeFence(code)
      return `${fence}${language}\n${code}\n${fence}`
    }
    case "blockquote":
      return content
        .map(renderAdfBlock)
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    case "rule":
      return "---"
    case "hardBreak":
      return "\n"
    default:
      return typeof record.text === "string"
        ? adfText(record)
        : content
          .map(renderAdfBlock)
          .filter((part) => part.length > 0)
          .join("\n")
  }
}

const normalizeRichText = (value: Schema.Json | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  return normalizedRenderedText(renderAdfBlock(value))
}

const unboundedRichText = (value: Schema.Json | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  return normalizedRenderedText(renderAdfBlock(value), null)
}

const acceptanceCriteriaFromAdf = (
  value: Schema.Json | null | undefined,
  maximum: number | null = MAX_RICH_TEXT_CHARACTERS
): string | null => {
  if (value === null || value === undefined || typeof value === "string" || Array.isArray(value)) return null
  const document = decodedJsonRecord(value)
  if (document === null) return null
  const blocks = adfContent(document)
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue
    const heading = decodedJsonRecord(block)
    if (heading?.type !== "heading") continue
    const headingText = normalizedRenderedText(adfContent(heading).map(rawAdfText).join(""), 255)
    if (headingText === null || !/^acceptance criteria:?$/iu.test(headingText)) continue
    const attrs = heading.attrs === undefined ? null : decodedJsonRecord(heading.attrs)
    const level = typeof attrs?.level === "number" && Number.isInteger(attrs.level) ? attrs.level : 1
    const criteria: Array<Schema.Json> = []
    for (const candidate of blocks.slice(index + 1)) {
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        const candidateRecord = decodedJsonRecord(candidate)
        if (candidateRecord?.type === "heading") {
          const candidateAttrs = candidateRecord.attrs === undefined ? null : decodedJsonRecord(candidateRecord.attrs)
          const candidateLevel = typeof candidateAttrs?.level === "number" && Number.isInteger(candidateAttrs.level)
            ? candidateAttrs.level
            : 1
          if (candidateLevel <= level) break
        }
      }
      criteria.push(candidate)
    }
    return normalizedRenderedText(criteria.map(renderAdfBlock).join("\n\n"), maximum)
  }
  return null
}

const compact = (value: string | undefined): string | null =>
  value === undefined ? null : value.slice(0, MAX_CHANGE_VALUE_CHARACTERS)

const namedValue = (value: typeof JiraNamedValue.Type | null | undefined) =>
  value === null || value === undefined ? null : { sourceId: value.id ?? null, name: value.name?.slice(0, 255) ?? null }

const relatedIssue = (value: typeof JiraRelatedIssue.Type | null | undefined) =>
  value === null || value === undefined
    ? null
    : {
      sourceId: value.id ?? null,
      key: value.key?.slice(0, 100) ?? null,
      summary: value.fields?.summary?.slice(0, 500) ?? null,
      status: namedValue(value.fields?.status)
    }

const normalizedAvatarUrl = (value: string | undefined): string | null => {
  if (value === undefined || value.length > 2_048) return null
  const decoded = Schema.decodeUnknownResult(SourceUrl)(value)
  return Result.isSuccess(decoded) ? Schema.encodeSync(SourceUrl)(decoded.success) : null
}

const collaboratorLosesDetail = (user: typeof JiraUser.Type | null | undefined): boolean => {
  if (user === null || user === undefined || user.accountId === undefined) return false
  const avatarUrl = user.avatarUrls?.["48x48"] ?? user.avatarUrls?.["32x32"]
  return (user.displayName?.length ?? 0) > 200 || (avatarUrl !== undefined && normalizedAvatarUrl(avatarUrl) === null)
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
    sourcePersonId: user.accountId,
    displayName: (user.displayName ?? user.accountId).slice(0, 200),
    avatarUrl: normalizedAvatarUrl(user.avatarUrls?.["48x48"] ?? user.avatarUrls?.["32x32"]),
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

  const truncatedFields = new Set<string>()
  const retainedComments = comments.slice(-MAXIMUM_NORMALIZED_ISSUE_COMMENTS)
  const retainedChangelogs = changelogs.slice(-MAXIMUM_NORMALIZED_ISSUE_HISTORY)
  const retainedLabels = (issue.fields.labels ?? [])
    .map((label) => label.trim().slice(0, 255))
    .filter((label) => label.length > 0)
    .slice(0, MAXIMUM_NORMALIZED_ISSUE_LABELS)
  const retainedComponents = (issue.fields.components ?? [])
    .slice(0, MAXIMUM_NORMALIZED_ISSUE_COMPONENTS)
    .map(namedValue)
  const retainedFixVersions = (issue.fields.fixVersions ?? [])
    .slice(0, MAXIMUM_NORMALIZED_ISSUE_FIX_VERSIONS)
    .map((version) => ({
      sourceId: version.id ?? null,
      name: version.name?.slice(0, 255) ?? null,
      released: version.released ?? false,
      releaseDate: version.releaseDate?.slice(0, 100) ?? null
    }))
  const retainedSubtasks = (issue.fields.subtasks ?? []).slice(0, MAXIMUM_NORMALIZED_ISSUE_SUBTASKS).map(relatedIssue)
  if (comments.length > retainedComments.length || input.comments.truncated) truncatedFields.add("comments")
  if (changelogs.length > retainedChangelogs.length || input.changelogs.truncated) truncatedFields.add("history")
  if ((issue.fields.labels?.length ?? 0) > retainedLabels.length) truncatedFields.add("labels")
  if ((issue.fields.components?.length ?? 0) > retainedComponents.length) truncatedFields.add("components")
  if ((issue.fields.fixVersions?.length ?? 0) > retainedFixVersions.length) truncatedFields.add("fixVersions")
  if ((issue.fields.subtasks?.length ?? 0) > retainedSubtasks.length) truncatedFields.add("subtasks")
  if (changelogs.some(({ items }) => (items?.length ?? 0) > MAXIMUM_NORMALIZED_ISSUE_HISTORY_CHANGES)) {
    truncatedFields.add("history")
  }
  if (issue.key.length > 100) truncatedFields.add("key")
  if (issue.fields.summary.length > 500) truncatedFields.add("summary")
  if (issue.fields.updated.length > 100) truncatedFields.add("updatedAt")
  if ((issue.fields.duedate?.length ?? 0) > 100) truncatedFields.add("dueDate")
  if ((issue.fields.status?.name?.trim().length ?? 0) > 100) truncatedFields.add("status")
  if ((issue.fields.priority?.name?.trim().length ?? 0) > 100) truncatedFields.add("priority")
  if ((issue.fields.issuetype?.name?.length ?? 0) > 255) truncatedFields.add("issueType")
  if ((issue.fields.resolution?.name?.length ?? 0) > 255) truncatedFields.add("resolution")
  if ((issue.fields.project?.key?.length ?? 0) > 100 || (issue.fields.project?.name?.length ?? 0) > 255) {
    truncatedFields.add("project")
  }
  if ((issue.fields.labels ?? []).some((label) => label.trim().length === 0 || label.trim().length > 255)) {
    truncatedFields.add("labels")
  }
  if ((issue.fields.components ?? []).some(({ name }) => (name?.length ?? 0) > 255)) {
    truncatedFields.add("components")
  }
  if ((issue.fields.fixVersions ?? []).some(({ releaseDate }) => (releaseDate?.length ?? 0) > 100)) {
    truncatedFields.add("fixVersions")
  }
  if (
    issue.fields.parent !== null &&
    issue.fields.parent !== undefined &&
    ((issue.fields.parent.key?.length ?? 0) > 100 ||
      (issue.fields.parent.fields?.summary?.length ?? 0) > 500 ||
      (issue.fields.parent.fields?.status?.name?.length ?? 0) > 255)
  ) {
    truncatedFields.add("parent")
  }
  if (
    (issue.fields.subtasks ?? []).some(
      (subtask) =>
        (subtask.key?.length ?? 0) > 100 ||
        (subtask.fields?.summary?.length ?? 0) > 500 ||
        (subtask.fields?.status?.name?.length ?? 0) > 255
    )
  ) {
    truncatedFields.add("subtasks")
  }
  const commentBodiesTruncated = comments.some(
    (comment) => (unboundedRichText(comment.body)?.length ?? 0) > MAX_RICH_TEXT_CHARACTERS
  )
  if (commentBodiesTruncated) {
    truncatedFields.add("comments")
  }
  if (
    changelogs.some(({ items }) =>
      (items ?? []).some(
        (item) =>
          (item.field ?? item.fieldId ?? "unknown").length > 255 ||
          ((item.fromString ?? item.from)?.length ?? 0) > MAX_CHANGE_VALUE_CHARACTERS ||
          ((item.toString ?? item.to)?.length ?? 0) > MAX_CHANGE_VALUE_CHARACTERS
      )
    )
  ) {
    truncatedFields.add("history")
  }
  if (
    [issue.fields.assignee, issue.fields.reporter, issue.fields.creator].some(collaboratorLosesDetail) ||
    comments.some(
      ({ author, updateAuthor }) => collaboratorLosesDetail(author) || collaboratorLosesDetail(updateAuthor)
    ) ||
    changelogs.some(({ author }) => collaboratorLosesDetail(author))
  ) {
    truncatedFields.add("collaborators")
  }
  let compactCollaborators = false
  const description = unboundedRichText(issue.fields.description)
  const acceptanceCriteria = acceptanceCriteriaFromAdf(issue.fields.description, null)
  const environment = unboundedRichText(issue.fields.environment)
  if ((description?.length ?? 0) > MAX_RICH_TEXT_CHARACTERS) truncatedFields.add("description")
  if ((acceptanceCriteria?.length ?? 0) > MAX_RICH_TEXT_CHARACTERS) {
    truncatedFields.add("acceptanceCriteria")
  }
  if ((environment?.length ?? 0) > MAX_RICH_TEXT_CHARACTERS) truncatedFields.add("environment")
  let retainedDescription = description?.slice(0, MAX_RICH_TEXT_CHARACTERS) ?? null
  let retainedAcceptanceCriteria = acceptanceCriteria?.slice(0, MAX_RICH_TEXT_CHARACTERS) ?? null
  let retainedEnvironment = environment?.slice(0, MAX_RICH_TEXT_CHARACTERS) ?? null
  let retainedStatus = issue.fields.status?.name?.trim().slice(0, 100) || "unknown"
  let retainedPriority = issue.fields.priority?.name?.trim().slice(0, 100) || null
  let retainedIssueType = namedValue(issue.fields.issuetype)
  let retainedProject = issue.fields.project === null || issue.fields.project === undefined
    ? null
    : {
      sourceId: issue.fields.project.id ?? null,
      key: issue.fields.project.key?.slice(0, 100) ?? null,
      name: issue.fields.project.name?.slice(0, 255) ?? null
    }
  let retainedResolution = namedValue(issue.fields.resolution)
  let retainedCreatedAt: string | null = issue.fields.created ?? null
  let retainedDueDate: string | null = issue.fields.duedate?.slice(0, 100) ?? null
  let retainedResolvedAt: string | null = issue.fields.resolutiondate ?? null
  let retainedParent = relatedIssue(issue.fields.parent)
  const makeAttributes = () => {
    const people = new Map<string, MutablePerson>()
    const assigneeSourcePersonId = addPerson(people, issue.fields.assignee, "assignee")
    const reporterSourcePersonId = addPerson(people, issue.fields.reporter, "reporter")
    const creatorSourcePersonId = addPerson(people, issue.fields.creator, "creator")
    const normalizedComments = retainedComments.map((comment) => ({
      sourceId: comment.id,
      authorSourcePersonId: addPerson(people, comment.author, "commenter"),
      updateAuthorSourcePersonId: addPerson(people, comment.updateAuthor, "comment-editor"),
      body: normalizeRichText(comment.body),
      createdAt: comment.created ?? null,
      updatedAt: comment.updated ?? null
    }))
    const normalizedHistory = retainedChangelogs.map((history) => ({
      sourceId: history.id,
      authorSourcePersonId: addPerson(people, history.author, "change-author"),
      createdAt: history.created ?? null,
      changes: (history.items ?? []).slice(0, MAXIMUM_NORMALIZED_ISSUE_HISTORY_CHANGES).map((item) => ({
        field: (item.field ?? item.fieldId ?? "unknown").slice(0, 255),
        from: compact(item.fromString ?? item.from),
        to: compact(item.toString ?? item.to)
      }))
    }))
    const collaboratorValues = Array.from(people.values())
    if (collaboratorValues.length > MAXIMUM_NORMALIZED_ISSUE_COLLABORATORS) {
      truncatedFields.add("collaborators")
    }
    const collaborators = collaboratorValues.slice(0, MAXIMUM_NORMALIZED_ISSUE_COLLABORATORS).map((person) => ({
      sourcePersonId: person.sourcePersonId,
      displayName: compactCollaborators ? person.sourcePersonId : person.displayName,
      avatarUrl: compactCollaborators ? null : person.avatarUrl,
      active: person.active,
      roles: Array.from(person.roles).sort()
    }))
    return {
      key: issue.key.slice(0, 100),
      summary: issue.fields.summary.slice(0, 500),
      description: retainedDescription,
      acceptanceCriteria: retainedAcceptanceCriteria,
      environment: retainedEnvironment,
      status: retainedStatus,
      priority: retainedPriority,
      estimatePoints: issue.fields.estimatePoints ?? null,
      issueType: retainedIssueType,
      project: retainedProject,
      resolution: retainedResolution,
      labels: retainedLabels,
      components: retainedComponents,
      fixVersions: retainedFixVersions,
      createdAt: retainedCreatedAt,
      updatedAt: issue.fields.updated.slice(0, 100),
      dueDate: retainedDueDate,
      resolvedAt: retainedResolvedAt,
      parent: retainedParent,
      subtasks: retainedSubtasks,
      assigneeSourcePersonId,
      reporterSourcePersonId,
      creatorSourcePersonId,
      collaborators,
      truncatedFields: Array.from(truncatedFields).sort(),
      comments: normalizedComments,
      commentTotal: input.comments.total,
      commentsTruncated: input.comments.truncated || retainedComments.length < comments.length,
      commentBodiesTruncated,
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
        truncatedFields.add("comments")
      } else {
        retainedChangelogs.shift()
        truncatedFields.add("history")
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
        const compacted = attributes.collaborators.map(({ active, roles, sourcePersonId }) => ({
          sourcePersonId,
          displayName: sourcePersonId,
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
      clearValue("acceptanceCriteria", () => {
        retainedAcceptanceCriteria = null
      }, retainedAcceptanceCriteria !== null),
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
        retainedStatus = "unknown"
      }, retainedStatus !== "unknown"),
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

  const normalizedAttributes = yield* Schema.decodeUnknownEffect(NormalizedIssueAttributes)(attributes).pipe(
    Effect.mapError(() => malformed("jira-normalized-issue-attributes-invalid"))
  )

  const event = yield* Schema.decodeUnknownEffect(Schema.toType(NormalizedPluginEventV1))({
    _tag: "UpsertEntity",
    eventId: `jira:issue:${issue.id}:${issue.fields.updated}`,
    observedAt: input.observedAt,
    revision: issue.fields.updated,
    entityType: "jira.issue",
    vendorImmutableId: issue.id,
    sourceUrl,
    title: `${issue.key} · ${issue.fields.summary}`.slice(0, 500),
    attributes: normalizedAttributes
  }).pipe(Effect.mapError(() => malformed("jira-normalized-issue-invalid")))
  if (event._tag !== "UpsertEntity") return yield* malformed("jira-normalized-event-kind-invalid")
  return event
})

const normalizedEvent = Effect.fn("JiraIssueNormalization.normalizedEvent")(function*(input: unknown) {
  return yield* Schema.decodeUnknownEffect(Schema.toType(NormalizedPluginEventV1))(input).pipe(
    Effect.mapError(() => malformed("jira-normalized-related-event-invalid"))
  )
})

const releaseRevision = (version: typeof NormalizedIssueFixVersion.Type): string =>
  `${version.released ? "released" : "candidate"}:${version.releaseDate ?? "none"}:${version.name ?? "unnamed"}`

/** Normalize one synchronized Jira issue into canonical issue, person, release, and evidence events. @internal */
export const normalizeJiraIssueEvents = Effect.fn("JiraIssueNormalization.normalizeEvents")(function*(
  input: NormalizeJiraIssueInput
): Effect.fn.Return<ReadonlyArray<NormalizedPluginEventV1>, PluginMalformedResponseFailure> {
  const issueEvent = yield* normalizeJiraIssue(input)
  const attributes = yield* Schema.decodeUnknownEffect(NormalizedIssueAttributes)(issueEvent.attributes).pipe(
    Effect.mapError(() => malformed("jira-normalized-issue-attributes-invalid"))
  )
  const events: Array<NormalizedPluginEventV1> = [issueEvent]

  for (const collaborator of attributes.collaborators ?? []) {
    const avatarUrl = collaborator.avatarUrl === null
      ? null
      : Schema.decodeUnknownResult(SourceUrl)(collaborator.avatarUrl)
    events.push(
      yield* normalizedEvent({
        _tag: "UpsertPerson",
        eventId: `jira:person:${collaborator.sourcePersonId}:${issueEvent.vendorImmutableId}:${issueEvent.revision}`,
        observedAt: issueEvent.observedAt,
        revision: issueEvent.revision,
        vendorPersonId: collaborator.sourcePersonId,
        displayName: collaborator.displayName.slice(0, 200),
        avatarUrl: avatarUrl === null || Result.isFailure(avatarUrl) ? null : avatarUrl.success,
        active: collaborator.active
      })
    )
  }

  const activitySummary = [
    `comments ${String(attributes.commentTotal ?? 0)}${attributes.commentsTruncated ? "+" : ""}`,
    `history ${String(attributes.historyTotal ?? 0)}${attributes.historyTruncated ? "+" : ""}`
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

  for (const version of attributes.fixVersions ?? []) {
    if (version.sourceId === null || version.name === null) continue
    const revision = releaseRevision(version)
    const releaseVendorId = `jira-version:${version.sourceId}`
    const projectKey = attributes.project?.key
    const fixVersionEvidenceId =
      `jira:issue:${issueEvent.vendorImmutableId}:fix-version:${version.sourceId}:${issueEvent.revision}`
    events.push(
      yield* normalizedEvent({
        _tag: "UpsertEntity",
        eventId: `jira:version:${version.sourceId}:issue:${issueEvent.vendorImmutableId}:${issueEvent.revision}`,
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
          projectId: attributes.project?.sourceId ?? null,
          projectKey: projectKey ?? null,
          serviceName: (attributes.project?.name ?? projectKey ?? "Jira").slice(0, 200),
          version: version.name.slice(0, 100),
          lifecycle: version.released ? "released" : "candidate",
          releaseDate: version.releaseDate,
          fixVersionId: version.sourceId
        }
      })
    )
    events.push(
      yield* normalizedEvent({
        _tag: "AppendEvidence",
        eventId: `jira:evidence:${issueEvent.vendorImmutableId}:fix-version:${version.sourceId}:${issueEvent.revision}`,
        observedAt: issueEvent.observedAt,
        revision: issueEvent.revision,
        evidenceId: fixVersionEvidenceId,
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
    events.push(
      yield* normalizedEvent({
        _tag: "ProposeRelationship",
        eventId: `jira:relationship:${releaseVendorId}:contains:${issueEvent.vendorImmutableId}:${issueEvent.revision}`,
        observedAt: issueEvent.observedAt,
        revision: issueEvent.revision,
        relationshipId: `${releaseVendorId}:contains:${issueEvent.vendorImmutableId}`,
        from: {
          entityType: "release",
          vendorImmutableId: releaseVendorId
        },
        to: {
          entityType: issueEvent.entityType,
          vendorImmutableId: issueEvent.vendorImmutableId
        },
        relationshipType: "contains",
        confidence: 1,
        evidenceIds: [fixVersionEvidenceId]
      })
    )
  }

  return events
})
