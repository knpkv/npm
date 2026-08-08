/** Lossless, bounded changed-file loading for the exact-revision workspace. */
import type { Domain, ReadClient } from "@knpkv/codecommit-core"
import { Effect, Stream } from "effect"
import {
  blobPreviewDisposition,
  buildUnifiedDiff,
  changedFilePath,
  type FileDiffIdentity,
  fileDiffIdentity,
  filetypeForPath,
  type PullRequestWorkspaceIdentity
} from "./details-model.js"

export interface RenderedFileDiff {
  readonly binary: boolean
  readonly diff: string
  readonly filetype: string | undefined
  readonly identity: FileDiffIdentity
  readonly metadata: string | null
  readonly path: string
  readonly truncated: boolean
}

export interface FileDiffRequest {
  readonly account: Domain.Account
  readonly file: ReadClient.CodeCommitChangedFile
  readonly identity: PullRequestWorkspaceIdentity
  readonly repositoryName: Domain.RepositoryName
  readonly revision: ReadClient.CodeCommitPullRequestRevision
}

type PreviewBlob =
  | { readonly _tag: "bytes"; readonly bytes: Uint8Array }
  | { readonly _tag: "too-large" }

interface FileDiffReadClient {
  readonly getBlob: ReadClient.CodeCommitReadClientService["getBlob"]
}

const decodeBlob = (bytes: Uint8Array) => Stream.make(bytes).pipe(Stream.decodeText(), Stream.mkString)

/** Loads both immutable blobs while preserving binary, oversize, and provider failures distinctly. */
export const loadFileDiff = Effect.fn("loadFileDiff")(function*(
  client: FileDiffReadClient,
  request: FileDiffRequest
) {
  const loadBlob = (blob: ReadClient.CodeCommitBlobMetadata | null) =>
    blob === null
      ? Effect.succeed<PreviewBlob>({ _tag: "bytes", bytes: new Uint8Array() })
      : client.getBlob({
        account: request.account,
        repositoryName: request.repositoryName,
        blobId: blob.blobId
      }).pipe(
        Effect.map(({ bytes }): PreviewBlob => ({ _tag: "bytes", bytes })),
        Effect.catchTag("CodeCommitBlobTooLargeError", (): Effect.Effect<PreviewBlob> =>
          Effect.succeed({ _tag: "too-large" }))
      )
  const [beforeBlob, afterBlob] = yield* Effect.all(
    [loadBlob(request.file.before), loadBlob(request.file.after)],
    { concurrency: 2 }
  )
  const path = changedFilePath(request.file)
  const identity = fileDiffIdentity(request.identity, request.revision, request.file)
  if (beforeBlob._tag === "too-large" || afterBlob._tag === "too-large") {
    return {
      binary: false,
      diff: "",
      filetype: filetypeForPath(path),
      identity,
      metadata: null,
      path,
      truncated: true
    } satisfies RenderedFileDiff
  }
  const beforeBytes = beforeBlob.bytes
  const afterBytes = afterBlob.bytes
  const disposition = blobPreviewDisposition(beforeBytes, afterBytes)
  if (disposition === "binary") {
    return {
      binary: true,
      diff: "",
      filetype: undefined,
      identity,
      metadata: null,
      path,
      truncated: false
    } satisfies RenderedFileDiff
  }
  if (disposition === "too-large") {
    return {
      binary: false,
      diff: "",
      filetype: filetypeForPath(path),
      identity,
      metadata: null,
      path,
      truncated: true
    } satisfies RenderedFileDiff
  }
  const [beforeText, afterText] = yield* Effect.all(
    [decodeBlob(beforeBytes), decodeBlob(afterBytes)],
    { concurrency: 2 }
  )
  const rendered = buildUnifiedDiff(request.file, beforeText, afterText)
  return {
    binary: false,
    diff: rendered.diff,
    filetype: filetypeForPath(path),
    identity,
    metadata: rendered.metadata,
    path,
    truncated: rendered.truncated
  } satisfies RenderedFileDiff
})
