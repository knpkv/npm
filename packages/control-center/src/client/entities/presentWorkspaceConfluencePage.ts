import type { RlyPerson } from "@knpkv/rly/patterns"
import * as DateTime from "effect/DateTime"

import type { WorkspaceEntityInspection } from "../../api/deliveryGraph.js"
import type { DeliveryEntityDetails } from "../../domain/deliveryGraph.js"

type PageDetails = Extract<DeliveryEntityDetails, { readonly _tag: "page" }>

export interface WorkspacePageTimestamp {
  readonly dateTime: string
  readonly label: string
}

export interface WorkspaceConfluencePagePresentation {
  readonly attachmentInventoryLabel: string
  readonly attachments: ReadonlyArray<{
    readonly createdAt: WorkspacePageTimestamp
    readonly fileSize: string
    readonly id: string
    readonly mediaType: string
    readonly title: string
    readonly version: string
  }>
  readonly content: string | null
  readonly contentState: "empty" | "lazy" | "loaded"
  readonly contributors: ReadonlyArray<RlyPerson>
  readonly createdAt: WorkspacePageTimestamp | null
  readonly historyInventoryLabel: string
  readonly revision: string
  readonly runbookEvidenceCount: number
  readonly sourceSpaceId: string
  readonly status: "Current" | "Draft" | "Superseded"
  readonly updatedAt: WorkspacePageTimestamp | null
  readonly versions: ReadonlyArray<{
    readonly author: string
    readonly createdAt: WorkspacePageTimestamp
    readonly message: string
    readonly minorEdit: boolean
    readonly number: number
  }>
  readonly watcherInventoryLabel: string
}

const timestampFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
})

const timestampFor = (value: DateTime.DateTime | undefined): WorkspacePageTimestamp | null =>
  value === undefined
    ? null
    : {
      dateTime: DateTime.formatIso(value),
      label: timestampFormatter.format(DateTime.toDateUtc(value))
    }

const inventoryLabel = (
  inventory: { readonly complete: boolean; readonly pagesFetched: number } | undefined,
  noun: string
): string =>
  inventory === undefined
    ? `${noun} not synchronized`
    : `${inventory.complete ? "Complete" : "Partial"} · ${String(inventory.pagesFetched)} bounded page${
      inventory.pagesFetched === 1 ? "" : "s"
    } read`

const fileSizeLabel = (bytes: number | null): string => {
  if (bytes === null) return "Size unavailable"
  if (bytes < 1_024) return `${String(bytes)} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

const roleLabel = (roles: ReadonlyArray<"author" | "contributor" | "owner" | "watcher">): string =>
  roles.map((role) => `${role.charAt(0).toLocaleUpperCase("en-US")}${role.slice(1)}`).join(" · ")

const uniqueContributors = (
  contributors: NonNullable<PageDetails["contributors"]>
): NonNullable<PageDetails["contributors"]> => {
  const byId = new Map<string, NonNullable<PageDetails["contributors"]>[number]>()
  for (const contributor of contributors) {
    const previous = byId.get(contributor.sourcePersonId)
    const roles = previous === undefined
      ? contributor.roles
      : [...new Set([...previous.roles, ...contributor.roles])]
    const identity = previous?.resolved === true && !contributor.resolved ? previous : contributor
    byId.set(contributor.sourcePersonId, { ...identity, roles })
  }
  return [...byId.values()]
}

/** Present one normalized page as a quiet read-only document with explicit provider boundaries. */
export const presentWorkspaceConfluencePage = (
  details: PageDetails,
  inspection: WorkspaceEntityInspection
): WorkspaceConfluencePagePresentation => {
  const contributors = uniqueContributors(details.contributors ?? [])
  const contributorNameById = new Map(contributors.map(({ displayName, sourcePersonId }) => [
    sourcePersonId,
    displayName
  ]))
  const contentState = details.contentState === "lazy"
    ? "lazy"
    : details.content === null || details.content === undefined
    ? "empty"
    : "loaded"
  return {
    attachmentInventoryLabel: inventoryLabel(details.attachmentInventory, "Attachment inventory"),
    attachments: (details.attachments ?? []).map((attachment) => ({
      createdAt: timestampFor(attachment.createdAt)!,
      fileSize: fileSizeLabel(attachment.fileSize),
      id: attachment.id,
      mediaType: attachment.mediaType ?? "Type unavailable",
      title: attachment.title,
      version: attachment.version === null ? "Version unavailable" : `v${String(attachment.version)}`
    })),
    content: contentState === "loaded" ? (details.content?.markdown ?? null) : null,
    contentState,
    contributors: contributors.map((contributor) => ({
      id: contributor.sourcePersonId,
      name: contributor.displayName,
      role: `${roleLabel(contributor.roles)}${contributor.external ? " · External" : ""}${
        contributor.resolved ? "" : " · Identity unresolved"
      }`
    })),
    createdAt: timestampFor(details.createdAt),
    historyInventoryLabel: inventoryLabel(details.versionHistory, "Revision history"),
    revision: details.revision,
    runbookEvidenceCount: inspection.graph.evidenceItems.length,
    sourceSpaceId: details.sourceSpaceId ?? details.spaceKey,
    status: details.status === "superseded" ? "Superseded" : details.status === "draft" ? "Draft" : "Current",
    updatedAt: timestampFor(details.updatedAt),
    versions: (details.versions ?? []).map((version) => ({
      author: version.authorSourcePersonId === null
        ? "Author unavailable"
        : contributorNameById.get(version.authorSourcePersonId) ?? "Identity not resolved",
      createdAt: timestampFor(version.createdAt)!,
      message: version.message ?? "No revision note",
      minorEdit: version.minorEdit,
      number: version.number
    })),
    watcherInventoryLabel: inventoryLabel(details.watcherInventory, "Watcher inventory")
  }
}
