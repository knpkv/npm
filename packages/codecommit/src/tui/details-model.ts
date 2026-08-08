import { type Domain, ReadClient } from "@knpkv/codecommit-core"
import { structuredPatch } from "diff"
import { Effect, Schema } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { WorktreeError } from "../WorktreeService.js"

const MAX_RENDERED_LINES = 500
const MAX_RENDERED_LINE_LENGTH = 2_000
const DIFF_CONTEXT_LINES = 3
const BINARY_SAMPLE_BYTES = 8_000
const MAX_PREVIEW_BLOB_BYTES = ReadClient.CODECOMMIT_BLOB_MAXIMUM_BYTES
const MAX_ACTION_DIAGNOSTIC_CHARACTERS = 2_048
const FILETYPE_ALIASES: Record<string, string> = {
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

export interface PullRequestWorkspaceIdentity {
  readonly profile: string
  readonly pullRequestId: string
  readonly region: string
  readonly repositoryName: string
}

export type WorkspaceActionPhase =
  | "idle"
  | "preflight"
  | "ready"
  | "running-review"
  | "running-worktree"
  | "terminal"

export type WorkspaceLifecycleTransition =
  | { readonly _tag: "preserve" }
  | {
    readonly _tag: "reset"
    readonly interrupt: "checkout" | "none" | "preflight" | "review"
  }

export interface FileDiffIdentity extends PullRequestWorkspaceIdentity {
  readonly afterBlobId: string | null
  readonly beforeBlobId: string | null
  readonly destinationCommit: string
  readonly sourceCommit: string
}

export interface ActionDiagnostic {
  readonly message: string
  readonly operation: string
}

export type ActionOutcome<A> =
  | { readonly _tag: "failure"; readonly diagnostic: ActionDiagnostic; readonly requestId: string }
  | { readonly _tag: "success"; readonly requestId: string; readonly value: A }

const isWorktreeError = Schema.is(WorktreeError)

/** Retains only bounded, already-sanitized fields from typed action failures. */
export const actionDiagnostic = (error: unknown): ActionDiagnostic => {
  if (isWorktreeError(error)) {
    return {
      message: error.message.slice(0, MAX_ACTION_DIAGNOSTIC_CHARACTERS),
      operation: error.operation
    }
  }
  if (AiError.isAiError(error)) {
    return {
      message: error.reason.message.slice(0, MAX_ACTION_DIAGNOSTIC_CHARACTERS),
      operation: `codex-${error.method}`
    }
  }
  return { message: "Unexpected action failure", operation: "action" }
}

const actionFailure = (requestId: string, error: unknown): ActionOutcome<never> => ({
  _tag: "failure",
  diagnostic: actionDiagnostic(error),
  requestId
})

const actionSuccess = <A>(requestId: string, value: A): ActionOutcome<A> => ({ _tag: "success", requestId, value })

export const actionOutcome = <A, E, R>(requestId: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => actionFailure(requestId, error),
      onSuccess: (value) => actionSuccess(requestId, value)
    })
  )

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
  | "scroll-content-down"
  | "scroll-content-up"
  | "show-comments"
  | "show-diff"
  | "yield"

/** Decides whether the exact-head workspace consumes a key or yields it to dialogs/focused controls. */
export const detailsKeyIntent = (input: {
  readonly actionCancelable: boolean
  readonly actionReady: boolean
  readonly dialogOpen: boolean
  readonly keyName: string
  readonly modified: boolean
  readonly tab: "comments" | "diff"
}): DetailsKeyIntent => {
  if (input.dialogOpen || input.modified) return "yield"
  if (input.keyName === "escape") return input.actionCancelable ? "cancel-action" : "back"
  if (input.keyName === "1") return "show-diff"
  if (input.keyName === "2" || input.keyName === "c") return "show-comments"
  if (input.keyName === "o") return "open-browser"
  if (input.tab === "diff" && input.keyName === "k") return "previous-file"
  if (input.tab === "diff" && input.keyName === "j") return "next-file"
  if (input.tab === "diff" && input.keyName === "up") return "scroll-content-up"
  if (input.tab === "diff" && input.keyName === "down") return "scroll-content-down"
  if (input.keyName === "w") return "checkout-worktree"
  if (input.keyName === "r") return "review-pr"
  if (input.keyName === "s") return "review-security"
  if (input.keyName === "t") return "review-tests"
  if (input.keyName === "e") return "explain-risk"
  if (input.keyName === "x" && input.actionCancelable) return "cancel-action"
  if (input.keyName === "return" && input.actionReady) return "confirm-action"
  return "yield"
}

export type BlobPreviewDisposition = "binary" | "text" | "too-large"

/** Classifies fetched blobs before allocating decoded strings for the terminal preview. */
export const blobPreviewDisposition = (
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array
): BlobPreviewDisposition => {
  if (beforeBytes.byteLength > MAX_PREVIEW_BLOB_BYTES || afterBytes.byteLength > MAX_PREVIEW_BLOB_BYTES) {
    return "too-large"
  }
  const hasNullByte = (bytes: Uint8Array): boolean => bytes.subarray(0, BINARY_SAMPLE_BYTES).some((byte) => byte === 0)
  if (hasNullByte(beforeBytes) || hasNullByte(afterBytes)) return "binary"
  const isValidUtf8 = (bytes: Uint8Array): boolean => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return true
    } catch {
      return false
    }
  }
  if (!isValidUtf8(beforeBytes) || !isValidUtf8(afterBytes)) return "binary"
  return "text"
}

export const pullRequestWorkspaceIdentity = (pr: Domain.PullRequest): PullRequestWorkspaceIdentity => ({
  profile: pr.account.profile,
  pullRequestId: pr.id,
  region: pr.account.region,
  repositoryName: pr.repositoryName
})

/** Stable refresh key for every PR field that can change exact-head loading or local actions. */
export const pullRequestWorkspaceReloadKey = (pr: Domain.PullRequest): string =>
  [
    pr.account.profile,
    pr.account.region,
    pr.account.repoAccountId ?? "",
    pr.repositoryName,
    pr.id,
    pr.lastModifiedDate.getTime()
  ].join("\u0000")

/** Preserves semantic no-op refreshes and identifies the atom to interrupt before a real reset. */
export const workspaceLifecycleTransition = (
  previousKey: string | null,
  nextKey: string,
  phase: WorkspaceActionPhase
): WorkspaceLifecycleTransition => {
  if (previousKey === nextKey) return { _tag: "preserve" }
  const interrupt = phase === "preflight"
    ? "preflight"
    : phase === "running-worktree"
    ? "checkout"
    : phase === "running-review"
    ? "review"
    : "none"
  return { _tag: "reset", interrupt }
}

export const workspaceIdentityMatches = (
  actual: PullRequestWorkspaceIdentity,
  expected: PullRequestWorkspaceIdentity
): boolean =>
  actual.profile === expected.profile &&
  actual.pullRequestId === expected.pullRequestId &&
  actual.region === expected.region &&
  actual.repositoryName === expected.repositoryName

/** Keeps exact-pair threads plus explicitly commitless general PR comments. */
export const currentRevisionCommentLocations = (
  locations: ReadonlyArray<Domain.PRCommentLocation>,
  revision: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "sourceCommit">
): ReadonlyArray<Domain.PRCommentLocation> =>
  locations.filter((location) => {
    const commitless = location.beforeCommitId === undefined && location.afterCommitId === undefined
    if (commitless) return location.filePath === undefined
    return location.beforeCommitId === revision.destinationCommit && location.afterCommitId === revision.sourceCommit
  })

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

/** Keeps a retained async result only when it belongs to the file currently on screen. */
export const currentFileDiffOutcome = <A extends { readonly identity: FileDiffIdentity }>(
  outcome: A | null,
  expected: FileDiffIdentity | null
): A | null =>
  outcome !== null && expected !== null && fileDiffIdentityMatches(outcome.identity, expected) ? outcome : null

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

export const changedFileRowId = (index: number): string => `changed-file-${index}`

export const filetypeForPath = (path: string): string | undefined => {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : ""
  return FILETYPE_ALIASES[extension] ?? (extension.length > 0 ? extension : undefined)
}

const escapedCodePoint = (character: string): string =>
  `\\u{${character.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}}`

const isTerminalControl = (codePoint: number): boolean =>
  (codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)

const BIDI_CONTROL = /\p{Bidi_Control}/u

const isTerminalUnsafe = (character: string, codePoint: number): boolean =>
  isTerminalControl(codePoint) || BIDI_CONTROL.test(character)

/** Makes an untrusted single-line value visibly safe for terminal rendering. */
export const terminalSafeText = (value: string): string =>
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && isTerminalUnsafe(character, codePoint) ? escapedCodePoint(character) : character
  }).join("")

/** Normalizes CRLF and preserves tabs and line feeds while escaping terminal controls. */
export const terminalSafeMultilineText = (value: string): string =>
  Array.from(value.replaceAll("\r\n", "\n"), (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint !== 0x09 && codePoint !== 0x0a && isTerminalUnsafe(character, codePoint)
      ? escapedCodePoint(character)
      : character
  }).join("")

const terminalSafePatchLine = (value: string): string =>
  terminalSafeMultilineText(value.replace(/\r$/u, "").replaceAll("\\", "\\\\"))

const fileMetadata = (file: ReadClient.CodeCommitChangedFile): Array<string> => {
  const metadata: Array<string> = []
  if (file.before?.path !== undefined && file.after?.path !== undefined && file.before.path !== file.after.path) {
    metadata.push(`rename ${terminalSafeText(file.before.path)} → ${terminalSafeText(file.after.path)}`)
  }
  if (file.before?.mode !== undefined && file.after?.mode !== undefined && file.before.mode !== file.after.mode) {
    metadata.push(`mode ${terminalSafeText(file.before.mode)} → ${terminalSafeText(file.after.mode)}`)
  }
  return metadata
}

const formatHunk = (hunk: {
  readonly lines: ReadonlyArray<string>
  readonly newLines: number
  readonly newStart: number
  readonly oldLines: number
  readonly oldStart: number
}): ReadonlyArray<string> => [
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  ...hunk.lines.map(terminalSafePatchLine)
]

/** Builds a bounded valid unified patch for OpenTUI's native diff renderable. */
export const buildUnifiedDiff = (
  file: ReadClient.CodeCommitChangedFile,
  beforeText: string,
  afterText: string
): { readonly diff: string; readonly metadata: string | null; readonly truncated: boolean } => {
  const beforePath = terminalSafeText(file.before?.path ?? "/dev/null")
  const afterPath = terminalSafeText(file.after?.path ?? "/dev/null")
  const oldFileName = file.before === null ? "/dev/null" : `a/${beforePath}`
  const newFileName = file.after === null ? "/dev/null" : `b/${afterPath}`
  const patch = structuredPatch(
    oldFileName,
    newFileName,
    beforeText,
    afterText,
    "",
    "",
    {
      context: DIFF_CONTEXT_LINES,
      maxEditLength: 20_000,
      timeout: 1_000
    }
  )
  if (patch === undefined) return { diff: "", metadata: null, truncated: true }

  if (patch.hunks.length === 0) {
    const metadata = fileMetadata(file)
    if (file.before === null && file.after !== null) metadata.push("empty file added")
    if (file.before !== null && file.after === null) metadata.push("empty file deleted")
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
  const metadata = fileMetadata(file)
  return {
    diff: retainedHunks === 0 && truncated ? "" : lines.join("\n"),
    metadata: metadata.length === 0 ? null : metadata.join("\n"),
    truncated
  }
}
