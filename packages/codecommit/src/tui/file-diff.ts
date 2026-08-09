/** Lossless, bounded changed-file loading for the exact-revision workspace. */
import { type Domain, ReadClient } from "@knpkv/codecommit-core"
import { Effect, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as GitEnvironment from "../GitEnvironment.js"
import { WorktreeError } from "../WorktreeService.js"
import {
  blobPreviewDisposition,
  buildUnifiedDiff,
  changedFilePath,
  type FileDiffIdentity,
  fileDiffIdentity,
  fileDiffIdentityKey,
  filetypeForPath,
  isChangedDiffLine,
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
  readonly localWorktreePath?: string
  readonly repositoryName: Domain.RepositoryName
  readonly revision: ReadClient.CodeCommitPullRequestRevision
}

export type FileDiffOutcome =
  | { readonly _tag: "failure"; readonly identity: FileDiffIdentity }
  | { readonly _tag: "success"; readonly identity: FileDiffIdentity; readonly value: RenderedFileDiff }

export interface LocalFileDiffWorkspaceRequest extends Omit<FileDiffRequest, "file" | "localWorktreePath"> {
  readonly files: ReadonlyArray<ReadClient.CodeCommitChangedFile>
  readonly localWorktreePath: string
}

type FileDiffCacheEntry = readonly [key: string, outcome: FileDiffOutcome]

/** Maximum warm previews retained before the workspace becomes interactive. */
export const MAXIMUM_PRELOADED_FILE_DIFFS = 25

type PreviewBlob =
  | { readonly _tag: "bytes"; readonly bytes: Uint8Array }
  | { readonly _tag: "too-large" }

export interface LocalBlobRequest {
  readonly blobId: ReadClient.CodeCommitBlobId
  readonly worktreePath: string
}

export interface FileDiffReadClient {
  readonly getBlob: ReadClient.CodeCommitReadClientService["getBlob"]
  readonly getLocalBlob?: (
    request: LocalBlobRequest
  ) => Effect.Effect<
    ReadClient.CodeCommitBlobContent,
    ReadClient.CodeCommitBlobTooLargeError | WorktreeError
  >
}

const decodeBlob = (bytes: Uint8Array) => Stream.make(bytes).pipe(Stream.decodeText(), Stream.mkString)

const LocalGitBlobId = Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{40}$/u))

interface LocalBlobAccumulator {
  readonly bytes: number
  readonly chunks: ReadonlyArray<Uint8Array>
}

/** Reads one immutable raw blob from a prepared local Git object database without materializing repository paths. */
export const loadLocalGitBlob = Effect.fn("loadLocalGitBlob")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: LocalBlobRequest
) {
  const blobId = yield* Schema.decodeUnknownEffect(LocalGitBlobId)(request.blobId).pipe(
    Effect.mapError((cause) =>
      new WorktreeError({ operation: "validate-local-blob", message: "Invalid local Git blob identity", cause })
    )
  )
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make("git", ["cat-file", "blob", blobId], {
      cwd: request.worktreePath,
      env: GitEnvironment.isolated(),
      extendEnv: true,
      stderr: "ignore",
      stdout: "pipe"
    })).pipe(
      Effect.mapError((cause) =>
        new WorktreeError({ operation: "read-local-blob", message: "Unable to start local Git blob read", cause })
      )
    )
    const accumulator = yield* Stream.runFoldEffect(
      handle.stdout,
      (): LocalBlobAccumulator => ({ bytes: 0, chunks: [] }),
      (current, chunk) => {
        const bytes = current.bytes + chunk.byteLength
        return bytes > ReadClient.CODECOMMIT_BLOB_MAXIMUM_BYTES
          ? new ReadClient.CodeCommitBlobTooLargeError({
            actualBytes: bytes,
            maximumBytes: ReadClient.CODECOMMIT_BLOB_MAXIMUM_BYTES,
            operation: "read-local-blob",
            source: "read-client"
          })
          : Effect.succeed({ bytes, chunks: [...current.chunks, chunk] })
      }
    ).pipe(
      Effect.mapError((cause) =>
        Schema.is(ReadClient.CodeCommitBlobTooLargeError)(cause)
          ? cause
          : new WorktreeError({ operation: "read-local-blob", message: "Unable to read local Git blob", cause })
      )
    )
    const exitCode = yield* handle.exitCode.pipe(
      Effect.mapError((cause) =>
        new WorktreeError({ operation: "read-local-blob", message: "Unable to finish local Git blob read", cause })
      )
    )
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* new WorktreeError({
        operation: "read-local-blob",
        message: `git cat-file exited with code ${exitCode}`
      })
    }
    const bytes = new Uint8Array(accumulator.bytes)
    let offset = 0
    for (const chunk of accumulator.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new ReadClient.CodeCommitBlobContent({
      blobId: ReadClient.CodeCommitBlobId.make(blobId),
      bytes
    })
  }))
})

const loadPreviewBlobs = Effect.fn("loadPreviewBlobs")(function*(
  client: FileDiffReadClient,
  request: FileDiffRequest
) {
  const loadProviderBlob = (blob: ReadClient.CodeCommitBlobMetadata) =>
    client.getBlob({
      account: request.account,
      repositoryName: request.repositoryName,
      blobId: blob.blobId
    }).pipe(
      Effect.map(({ bytes }): PreviewBlob => ({ _tag: "bytes", bytes })),
      Effect.catchTag("CodeCommitBlobTooLargeError", (): Effect.Effect<PreviewBlob> =>
        Effect.succeed({ _tag: "too-large" }))
    )
  const loadBlob = (blob: ReadClient.CodeCommitBlobMetadata | null) =>
    blob === null
      ? Effect.succeed<PreviewBlob>({ _tag: "bytes", bytes: new Uint8Array() })
      : request.localWorktreePath !== undefined && client.getLocalBlob !== undefined
      ? client.getLocalBlob({ blobId: blob.blobId, worktreePath: request.localWorktreePath }).pipe(
        Effect.map(({ bytes }): PreviewBlob => ({ _tag: "bytes", bytes })),
        Effect.catchTags({
          CodeCommitBlobTooLargeError: (): Effect.Effect<PreviewBlob> => Effect.succeed({ _tag: "too-large" }),
          WorktreeError: () => loadProviderBlob(blob)
        })
      )
      : loadProviderBlob(blob)
  return yield* Effect.all([loadBlob(request.file.before), loadBlob(request.file.after)], { concurrency: 2 })
})

/** Checks a provider line coordinate against both complete immutable blobs before any comment mutation. */
export const validateChangedFileLine = Effect.fn("validateChangedFileLine")(function*(
  client: FileDiffReadClient,
  request: FileDiffRequest,
  side: "before" | "after",
  line: number
) {
  const [beforeBlob, afterBlob] = yield* loadPreviewBlobs(client, request)
  if (beforeBlob._tag === "too-large" || afterBlob._tag === "too-large") return false
  if (blobPreviewDisposition(beforeBlob.bytes, afterBlob.bytes) !== "text") return false
  const [beforeText, afterText] = yield* Effect.all(
    [decodeBlob(beforeBlob.bytes), decodeBlob(afterBlob.bytes)],
    { concurrency: 2 }
  )
  return isChangedDiffLine(beforeText, afterText, side, line)
})

/** Loads both immutable blobs while preserving binary, oversize, and provider failures distinctly. */
export const loadFileDiff = Effect.fn("loadFileDiff")(function*(
  client: FileDiffReadClient,
  request: FileDiffRequest
) {
  const [beforeBlob, afterBlob] = yield* loadPreviewBlobs(client, request)
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

/** Warms a bounded local prefix before exposing an exact-head workspace for file navigation. */
export const preloadLocalFileDiffs = Effect.fn("preloadLocalFileDiffs")(function*(
  client: FileDiffReadClient,
  request: LocalFileDiffWorkspaceRequest
) {
  const entries = yield* Effect.forEach(request.files.slice(0, MAXIMUM_PRELOADED_FILE_DIFFS), (file) => {
    const fileRequest: FileDiffRequest = {
      account: request.account,
      file,
      identity: request.identity,
      localWorktreePath: request.localWorktreePath,
      repositoryName: request.repositoryName,
      revision: request.revision
    }
    const identity = fileDiffIdentity(request.identity, request.revision, file)
    return loadFileDiff(client, fileRequest).pipe(
      Effect.match({
        onFailure: (): FileDiffOutcome => ({ _tag: "failure", identity }),
        onSuccess: (value): FileDiffOutcome => ({ _tag: "success", identity, value })
      }),
      Effect.map((outcome): FileDiffCacheEntry => [fileDiffIdentityKey(identity), outcome])
    )
  }, { concurrency: 4 })
  return new Map(entries)
})
