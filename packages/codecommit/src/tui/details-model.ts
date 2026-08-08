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
): { readonly diff: string; readonly truncated: boolean } => {
  const beforePath = patchPath(file.before?.path ?? "/dev/null")
  const afterPath = patchPath(file.after?.path ?? "/dev/null")
  const oldFileName = file.before === null ? "/dev/null" : `a/${beforePath}`
  const newFileName = file.after === null ? "/dev/null" : `b/${afterPath}`
  const patch = structuredPatch(oldFileName, newFileName, beforeText, afterText, "", "", {
    context: DIFF_CONTEXT_LINES,
    maxEditLength: 20_000,
    timeout: 1_000
  })
  if (patch === undefined) return { diff: "", truncated: true }

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
  return { diff: retainedHunks === 0 && truncated ? "" : lines.join("\n"), truncated }
}
