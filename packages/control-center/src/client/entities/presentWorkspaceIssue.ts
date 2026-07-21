import type { RlyPerson } from "@knpkv/rly/patterns"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"

import type { DeliveryEntityDetails } from "../../domain/deliveryGraph.js"
import type { SourceRevision } from "../../domain/sourceRevision.js"

type IssueDetails = Extract<DeliveryEntityDetails, { readonly _tag: "issue" }>

export interface WorkspaceIssueMetadata {
  readonly label: string
  readonly value: string
}

export interface WorkspaceIssueCommentPresentation {
  readonly author: RlyPerson
  readonly body: string | null
  readonly id: string
  readonly time: string | null
}

export interface WorkspaceIssueHistoryPresentation {
  readonly actor: RlyPerson
  readonly changes: ReadonlyArray<{ readonly field: string; readonly transition: string }>
  readonly id: string
  readonly time: string | null
}

export interface WorkspaceIssueRelatedPresentation {
  readonly href: string | null
  readonly key: string
  readonly status: string
  readonly summary: string
}

export interface WorkspaceIssuePresentation {
  readonly acceptanceCriteria: string | null
  readonly collaborators: ReadonlyArray<RlyPerson>
  readonly commentCount: number
  readonly comments: ReadonlyArray<WorkspaceIssueCommentPresentation>
  readonly commentBodiesTruncated: boolean
  readonly commentsTruncated: boolean
  readonly description: string | null
  readonly environment: string | null
  readonly history: ReadonlyArray<WorkspaceIssueHistoryPresentation>
  readonly historyCount: number
  readonly historyTruncated: boolean
  readonly metadata: ReadonlyArray<WorkspaceIssueMetadata>
  readonly parent: WorkspaceIssueRelatedPresentation | null
  readonly subtasks: ReadonlyArray<WorkspaceIssueRelatedPresentation>
  readonly truncationMessage: string | null
}

const timestampFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
})

const titleCase = (value: string): string =>
  value.split("-").map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`).join(" ")

const readableTimestamp = (value: string | null): string | null => {
  if (value === null) return null
  return Option.match(DateTime.make(value), {
    onNone: () => value,
    onSome: (timestamp) => timestampFormatter.format(DateTime.toDateUtc(timestamp))
  })
}

const valueName = (value: { readonly name: string | null; readonly sourceId: string | null }): string =>
  value.name ?? value.sourceId ?? "Not set"

const listValue = (values: ReadonlyArray<string> | undefined): string =>
  values === undefined || values.length === 0 ? "Not set" : values.join(" · ")

const personFallback = (sourcePersonId: string): RlyPerson => ({
  id: sourcePersonId,
  name: "Unknown collaborator",
  role: "Jira collaborator"
})

const peopleFor = (details: IssueDetails): ReadonlyMap<string, RlyPerson> =>
  new Map(
    (details.collaborators ?? []).map((collaborator) => {
      const roles = collaborator.roles.map(titleCase)
      return [
        collaborator.sourcePersonId,
        {
          id: collaborator.sourcePersonId,
          name: collaborator.displayName,
          role: roles.length === 0 ? "Jira collaborator" : roles.join(" · "),
          ...(collaborator.avatarUrl === null ? {} : { avatarSrc: collaborator.avatarUrl })
        }
      ]
    })
  )

const relatedIssue = (
  value: NonNullable<IssueDetails["parent"]>,
  sourceUrl: SourceRevision["sourceUrl"]
): WorkspaceIssueRelatedPresentation => ({
  href: (() => {
    if (sourceUrl === null || value.key === null) return null
    const browsePath = /^(.*\/browse\/)[^/]+$/u.exec(sourceUrl.pathname)?.[1]
    return browsePath === undefined ? null : `${sourceUrl.origin}${browsePath}${encodeURIComponent(value.key)}`
  })(),
  key: value.key ?? value.sourceId ?? "Unknown issue",
  status: value.status === null ? "Status unknown" : valueName(value.status),
  summary: value.summary ?? "Summary unavailable"
})

const metadataFor = (details: IssueDetails): ReadonlyArray<WorkspaceIssueMetadata> => {
  const project = details.project
  const fixVersions = (details.fixVersions ?? []).map(valueName)
  const components = (details.components ?? []).map(valueName)
  return [
    {
      label: "Type",
      value: details.issueType === null || details.issueType === undefined ? "Not set" : valueName(details.issueType)
    },
    {
      label: "Project",
      value: project === null || project === undefined
        ? "Not set"
        : [project.key, project.name].filter((value): value is string => value !== null).join(" · ") || "Not set"
    },
    {
      label: "Resolution",
      value: details.resolution === null || details.resolution === undefined
        ? "Unresolved"
        : valueName(details.resolution)
    },
    { label: "Labels", value: listValue(details.labels) },
    { label: "Components", value: listValue(components) },
    { label: "Fix versions", value: listValue(fixVersions) },
    { label: "Created", value: readableTimestamp(details.createdAt ?? null) ?? "Not available" },
    { label: "Updated", value: readableTimestamp(details.updatedAt ?? null) ?? "Not available" },
    { label: "Due", value: readableTimestamp(details.dueDate ?? null) ?? "Not set" }
  ]
}

const transition = (from: string | null, to: string | null): string => `${from ?? "Empty"} → ${to ?? "Empty"}`

/** Present provider-neutral synchronized issue detail for the canonical entity document. */
export const presentWorkspaceIssue = (
  details: IssueDetails,
  sourceUrl: SourceRevision["sourceUrl"]
): WorkspaceIssuePresentation => {
  const people = peopleFor(details)
  const person = (sourcePersonId: string | null): RlyPerson =>
    sourcePersonId === null
      ? personFallback("unknown-person")
      : (people.get(sourcePersonId) ?? personFallback(sourcePersonId))
  const truncatedFields = new Set(details.truncatedFields ?? [])
  const comments = (details.comments ?? []).map((comment) => ({
    author: person(comment.authorSourcePersonId),
    body: comment.body,
    id: comment.sourceId,
    time: readableTimestamp(comment.updatedAt ?? comment.createdAt)
  }))
  const history = (details.history ?? []).map((entry) => ({
    actor: person(entry.authorSourcePersonId),
    changes: entry.changes.map((change) => ({ field: change.field, transition: transition(change.from, change.to) })),
    id: entry.sourceId,
    time: readableTimestamp(entry.createdAt)
  }))
  const commentCount = details.commentTotal ?? comments.length
  const historyCount = details.historyTotal ?? history.length
  const commentsTruncated = (details.commentsTruncated ?? false) || commentCount > comments.length
  const historyTruncated = (details.historyTruncated ?? false) || historyCount > history.length
  const reducedFields = [...truncatedFields].filter(
    (field) => field !== "comments" && (field !== "history" || !historyTruncated)
  )
  return {
    acceptanceCriteria: details.acceptanceCriteria ?? null,
    collaborators: [...people.values()],
    commentCount,
    comments,
    commentBodiesTruncated: details.commentBodiesTruncated ?? (truncatedFields.has("comments") && !commentsTruncated),
    commentsTruncated,
    description: details.description ?? null,
    environment: details.environment ?? null,
    history,
    historyCount,
    historyTruncated,
    metadata: metadataFor(details),
    parent: details.parent === null || details.parent === undefined ? null : relatedIssue(details.parent, sourceUrl),
    subtasks: (details.subtasks ?? []).map((subtask) => relatedIssue(subtask, sourceUrl)),
    truncationMessage: reducedFields.length === 0
      ? null
      : `Jira shortened ${reducedFields.map(titleCase).join(", ")} to keep this synchronized view bounded.`
  }
}
