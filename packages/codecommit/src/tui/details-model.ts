import type { Domain, ReadClient } from "@knpkv/codecommit-core"
import { structuredPatch } from "diff"

const MAX_RENDERED_LINES = 500
const MAX_RENDERED_LINE_LENGTH = 2_000
const DIFF_CONTEXT_LINES = 3

export interface PullRequestWorkspaceIdentity {
  readonly profile: string
  readonly pullRequestId: string
  readonly region: string
  readonly repositoryName: string
}

export interface FileDiffIdentity extends PullRequestWorkspaceIdentity {
  readonly afterBlobId: string | null
  readonly beforeBlobId: string | null
  readonly destinationCommit: string
  readonly sourceCommit: string
}

export type DetailsKeyIntent =
  | "back"
  | "cancel-action"
  | "checkout-worktree"
  | "confirm-action"
  | "explain-risk"
  | "next-file"
  | "open-browser"
  | "previous-file"
  | "review-pr"
  | "review-security"
  | "review-tests"
  | "show-comments"
  | "show-diff"
  | "yield"

/** Decides whether the exact-head workspace consumes a key or yields it to dialogs/focused controls. */
export const detailsKeyIntent = (input: {
  readonly actionCancelable: boolean
  readonly actionReady: boolean
  readonly dialogOpen: boolean
  readonly keyName: string
  readonly tab: "comments" | "diff"
}): DetailsKeyIntent => {
  if (input.dialogOpen) return "yield"
  if (input.keyName === "escape") return input.actionCancelable ? "cancel-action" : "back"
  if (input.keyName === "1") return "show-diff"
  if (input.keyName === "2" || input.keyName === "c") return "show-comments"
  if (input.keyName === "o") return "open-browser"
  if (input.tab === "diff" && (input.keyName === "up" || input.keyName === "k")) return "previous-file"
  if (input.tab === "diff" && (input.keyName === "down" || input.keyName === "j")) return "next-file"
  if (input.keyName === "w") return "checkout-worktree"
  if (input.keyName === "r") return "review-pr"
  if (input.keyName === "s") return "review-security"
  if (input.keyName === "t") return "review-tests"
  if (input.keyName === "e") return "explain-risk"
  if (input.keyName === "x" && input.actionCancelable) return "cancel-action"
  if (input.keyName === "return" && input.actionReady) return "confirm-action"
  return "yield"
}

export const pullRequestWorkspaceIdentity = (pr: Domain.PullRequest): PullRequestWorkspaceIdentity => ({
  profile: pr.account.profile,
  pullRequestId: pr.id,
  region: pr.account.region,
  repositoryName: pr.repositoryName
})

export const workspaceIdentityMatches = (
  actual: PullRequestWorkspaceIdentity,
  expected: PullRequestWorkspaceIdentity
): boolean =>
  actual.profile === expected.profile &&
  actual.pullRequestId === expected.pullRequestId &&
  actual.region === expected.region &&
  actual.repositoryName === expected.repositoryName

export const fileDiffIdentity = (
  identity: PullRequestWorkspaceIdentity,
  revision: ReadClient.CodeCommitPullRequestRevision,
  file: ReadClient.CodeCommitChangedFile
): FileDiffIdentity => ({
  ...identity,
  afterBlobId: file.after?.blobId ?? null,
  beforeBlobId: file.before?.blobId ?? null,
  destinationCommit: revision.destinationCommit,
  sourceCommit: revision.sourceCommit
})

export const fileDiffIdentityMatches = (actual: FileDiffIdentity, expected: FileDiffIdentity): boolean =>
  workspaceIdentityMatches(actual, expected) &&
  actual.afterBlobId === expected.afterBlobId &&
  actual.beforeBlobId === expected.beforeBlobId &&
  actual.destinationCommit === expected.destinationCommit &&
  actual.sourceCommit === expected.sourceCommit

export const humanReviewState = (pr: Pick<Domain.PullRequest, "isApproved" | "isMergeable">) => ({
  approval: pr.isApproved ? "APPROVED" : "NEEDS REVIEW",
  mergeability: pr.isMergeable ? "MERGEABLE" : "CONFLICTS"
})

/** Cached list decisions have no revision identifier, so they cannot label an exact-head workspace. */
export const exactRevisionReviewState = (): {
  readonly approval: "UNVERIFIED"
  readonly mergeability: "UNVERIFIED"
} => ({
  approval: "UNVERIFIED",
  mergeability: "UNVERIFIED"
})

export const changedFilePath = (file: ReadClient.CodeCommitChangedFile): string =>
  file.after?.path ?? file.before?.path ?? "unknown"

export const filetypeForPath = (path: string): string | undefined => {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : ""
  const aliases: Record<string, string> = {
    cjs: "javascript",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    yaml: "yaml",
    yml: "yaml"
  }
  return aliases[extension] ?? (extension.length > 0 ? extension : undefined)
}

const patchPath = (value: string): string => value.replace(/[\r\n\t]/g, "_")

const formatHunk = (hunk: {
  readonly lines: ReadonlyArray<string>
  readonly newLines: number
  readonly newStart: number
  readonly oldLines: number
  readonly oldStart: number
}): ReadonlyArray<string> => [
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  ...hunk.lines
]

/** Builds a bounded valid unified patch for OpenTUI's native diff renderable. */
export const buildUnifiedDiff = (
  file: ReadClient.CodeCommitChangedFile,
  beforeText: string,
  afterText: string
): { readonly diff: string; readonly metadata: string | null; readonly truncated: boolean } => {
  const beforePath = patchPath(file.before?.path ?? "/dev/null")
  const afterPath = patchPath(file.after?.path ?? "/dev/null")
  const oldFileName = file.before === null ? "/dev/null" : `a/${beforePath}`
  const newFileName = file.after === null ? "/dev/null" : `b/${afterPath}`
  const patch = structuredPatch(oldFileName, newFileName, beforeText, afterText, "", "", {
    context: DIFF_CONTEXT_LINES,
    maxEditLength: 20_000,
    timeout: 1_000
  })
  if (patch === undefined) return { diff: "", metadata: null, truncated: true }

  if (patch.hunks.length === 0) {
    const metadata: Array<string> = []
    if (file.before === null && file.after !== null) metadata.push("empty file added")
    if (file.before !== null && file.after === null) metadata.push("empty file deleted")
    if (file.before?.path !== undefined && file.after?.path !== undefined && file.before.path !== file.after.path) {
      metadata.push(`rename ${file.before.path} → ${file.after.path}`)
    }
    if (file.before?.mode !== undefined && file.after?.mode !== undefined && file.before.mode !== file.after.mode) {
      metadata.push(`mode ${file.before.mode} → ${file.after.mode}`)
    }
    if (metadata.length === 0) metadata.push("No textual changes")
    return { diff: "", metadata: metadata.join("\n"), truncated: false }
  }

  const lines = [`--- ${oldFileName}`, `+++ ${newFileName}`]
  let retainedHunks = 0
  for (const hunk of patch.hunks) {
    const formatted = formatHunk(hunk)
    const fitsBudget = lines.length + formatted.length <= MAX_RENDERED_LINES
    const hasBoundedLines = hunk.lines.every((line) => line.length <= MAX_RENDERED_LINE_LENGTH)
    if (!fitsBudget || !hasBoundedLines) break
    for (const line of formatted) lines.push(line)
    retainedHunks += 1
  }

  const truncated = retainedHunks < patch.hunks.length
  return { diff: retainedHunks === 0 && truncated ? "" : lines.join("\n"), metadata: null, truncated }
}
