import type { RlyPerson } from "@knpkv/rly/patterns"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"

import type { WorkspaceEntityInspection } from "../../api/deliveryGraph.js"
import type { DeliveryEntityDetails } from "../../domain/deliveryGraph.js"
import type { SourceRevision } from "../../domain/sourceRevision.js"

type PullRequestDetails = Extract<DeliveryEntityDetails, { readonly _tag: "pull-request" }>

export interface WorkspacePullRequestTimestamp {
  readonly dateTime: string
  readonly label: string
}

export interface WorkspacePullRequestPresentation {
  readonly agentReviewLabel: string
  readonly author: RlyPerson | null
  readonly baseRevision: string | null
  readonly createdAt: WorkspacePullRequestTimestamp | null
  readonly description: string | null
  readonly filesHref: string | null
  readonly headRevision: string
  readonly issueCount: number
  readonly mergeBaseRevision: string | null
  readonly pipelineCount: number
  readonly releaseCount: number
  readonly reviewLabel: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly updatedAt: WorkspacePullRequestTimestamp | null
}

const timestampFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
})

const titleCase = (value: string): string =>
  value
    .split(/[._\-\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`)
    .join(" ")

const authorName = (reference: string): string => {
  const leaf = reference.split("/").filter((part) => part.length > 0).at(-1) ?? reference
  return titleCase(leaf) || "AWS identity"
}

const authorFor = (reference: string | null | undefined): RlyPerson | null =>
  reference === null || reference === undefined
    ? null
    : {
      id: reference,
      name: authorName(reference),
      role: "Pull request author"
    }

const timestampFor = (value: PullRequestDetails["createdAt"]): WorkspacePullRequestTimestamp | null => {
  if (value === null || value === undefined) return null
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: (timestamp) => ({
      dateTime: DateTime.formatIso(timestamp),
      label: timestampFormatter.format(DateTime.toDateUtc(timestamp))
    })
  })
}

const reviewLabel = (reviewState: PullRequestDetails["reviewState"]): string => {
  switch (reviewState) {
    case "approved":
      return "Approved by people"
    case "changes-requested":
      return "Changes requested"
    case "merged":
      return "Merged"
    case "requested":
      return "Human review requested"
    case "not-requested":
      return "No human approval synchronized"
  }
}

/** Present one immutable pull-request revision without conflating agent and human review. */
export const presentWorkspacePullRequest = (
  details: PullRequestDetails,
  sourceUrl: SourceRevision["sourceUrl"],
  inspection: WorkspaceEntityInspection
): WorkspacePullRequestPresentation => ({
  agentReviewLabel: "Agent review not run",
  author: authorFor(details.authorReference),
  baseRevision: details.baseRevision ?? null,
  createdAt: timestampFor(details.createdAt),
  description: details.description?.trim() || null,
  filesHref: sourceUrl?.href ?? null,
  headRevision: details.headRevision,
  issueCount: inspection.graph.relatedEntityProjections.filter(
    ({ projection }) => projection.entityType === "issue"
  ).length,
  mergeBaseRevision: details.mergeBaseRevision ?? null,
  pipelineCount: inspection.graph.relatedEntityProjections.filter(
    ({ projection }) => projection.entityType === "pipeline-execution"
  ).length,
  releaseCount: inspection.entity.releaseIds.length,
  reviewLabel: reviewLabel(details.reviewState),
  sourceBranch: details.sourceBranch,
  targetBranch: details.targetBranch,
  updatedAt: timestampFor(details.updatedAt)
})
