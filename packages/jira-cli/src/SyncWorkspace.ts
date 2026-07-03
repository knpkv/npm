/**
 * Local workspace I/O for Jira Markdown Sync.
 *
 * @module
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { parseSyncBaseline, serializeSyncBaseline } from "./internal/sync/baseline.js"
import { makeDefaultWorkspaceConfig, parseWorkspaceConfig, serializeWorkspaceConfig } from "./internal/sync/config.js"
import { makeEmptyManifest, parseSyncManifest, serializeSyncManifest } from "./internal/sync/manifest.js"
import {
  baselineFilePath,
  conventionDocumentPath,
  resolveWorkspacePaths,
  type SyncWorkspacePaths
} from "./internal/sync/paths.js"
import type { SyncBaseline, SyncManifest, WorkspaceConfig } from "./internal/sync/types.js"
import { SyncWorkspaceError } from "./JiraCliError.js"

export interface InitWorkspaceInput {
  readonly root: string
  readonly siteUrl: string
}

export interface SyncWorkspaceShape {
  readonly init: (input: InitWorkspaceInput) => Effect.Effect<SyncWorkspacePaths, SyncWorkspaceError>
  readonly paths: (root: string, config?: Pick<WorkspaceConfig, "documentsDir">) => Effect.Effect<SyncWorkspacePaths>
  readonly readConfig: (root: string) => Effect.Effect<WorkspaceConfig, SyncWorkspaceError>
  readonly writeConfig: (root: string, config: WorkspaceConfig) => Effect.Effect<void, SyncWorkspaceError>
  readonly readManifest: (root: string) => Effect.Effect<SyncManifest, SyncWorkspaceError>
  readonly writeManifest: (root: string, manifest: SyncManifest) => Effect.Effect<void, SyncWorkspaceError>
  readonly readBaseline: (root: string, issueId: string) => Effect.Effect<SyncBaseline, SyncWorkspaceError>
  readonly writeBaseline: (
    root: string,
    baseline: SyncBaseline
  ) => Effect.Effect<void, SyncWorkspaceError>
  readonly conventionDocumentPath: (root: string, issueKey: string) => Effect.Effect<string, SyncWorkspaceError>
}

export class SyncWorkspace extends Context.Service<
  SyncWorkspace,
  SyncWorkspaceShape
>()("@knpkv/jira-cli/SyncWorkspace") {}

const mapWorkspaceError = (message: string, path?: string | undefined) => (cause: unknown) =>
  new SyncWorkspaceError({ message, path, cause })

const make = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const paths: SyncWorkspaceShape["paths"] = (root, config) => Effect.succeed(resolveWorkspacePaths(path, root, config))

  const ensureDir = (dir: string): Effect.Effect<void, SyncWorkspaceError> =>
    fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError(mapWorkspaceError("Failed to create sync workspace directory", dir)),
      Effect.asVoid
    )

  const writeFile = (filePath: string, content: string): Effect.Effect<void, SyncWorkspaceError> =>
    Effect.gen(function*() {
      const dir = path.dirname(filePath)
      yield* ensureDir(dir)
      const nowMs = yield* Clock.currentTimeMillis
      const tempPath = `${filePath}.tmp.${nowMs}`
      yield* fs.writeFileString(tempPath, content).pipe(
        Effect.mapError(mapWorkspaceError("Failed to write sync workspace file", filePath))
      )
      yield* fs.rename(tempPath, filePath).pipe(
        Effect.mapError(mapWorkspaceError("Failed to replace sync workspace file", filePath))
      )
    })

  const readFile = (filePath: string): Effect.Effect<string, SyncWorkspaceError> =>
    fs.readFileString(filePath).pipe(
      Effect.mapError(mapWorkspaceError("Failed to read sync workspace file", filePath))
    )

  const init: SyncWorkspaceShape["init"] = ({ root, siteUrl }) =>
    Effect.gen(function*() {
      const config = makeDefaultWorkspaceConfig(siteUrl)
      const workspacePaths = resolveWorkspacePaths(path, root, config)
      yield* ensureDir(workspacePaths.documentsDir)
      yield* ensureDir(workspacePaths.metadataDir)
      yield* ensureDir(workspacePaths.baselinesDir)
      yield* ensureDir(workspacePaths.historyDir)
      yield* writeFile(workspacePaths.configFile, serializeWorkspaceConfig(config))
      yield* writeFile(workspacePaths.manifestFile, serializeSyncManifest(makeEmptyManifest(siteUrl)))
      return workspacePaths
    })

  const readConfig: SyncWorkspaceShape["readConfig"] = (root) =>
    Effect.gen(function*() {
      const workspacePaths = resolveWorkspacePaths(path, root)
      const content = yield* readFile(workspacePaths.configFile)
      return yield* parseWorkspaceConfig(workspacePaths.configFile, content).pipe(
        Effect.mapError((cause) =>
          new SyncWorkspaceError({
            message: cause.message,
            path: "path" in cause ? cause.path : workspacePaths.configFile,
            cause
          })
        )
      )
    })

  const writeConfig: SyncWorkspaceShape["writeConfig"] = (root, config) =>
    Effect.gen(function*() {
      const workspacePaths = resolveWorkspacePaths(path, root, config)
      yield* ensureDir(workspacePaths.metadataDir)
      yield* writeFile(workspacePaths.configFile, serializeWorkspaceConfig(config))
    })

  const readManifest: SyncWorkspaceShape["readManifest"] = (root) =>
    Effect.gen(function*() {
      const workspacePaths = resolveWorkspacePaths(path, root)
      const content = yield* readFile(workspacePaths.manifestFile)
      return yield* parseSyncManifest(workspacePaths.manifestFile, content).pipe(
        Effect.mapError((cause) =>
          new SyncWorkspaceError({
            message: cause.message,
            path: "path" in cause ? cause.path : workspacePaths.manifestFile,
            cause
          })
        )
      )
    })

  const writeManifest: SyncWorkspaceShape["writeManifest"] = (root, manifest) =>
    Effect.gen(function*() {
      const workspacePaths = resolveWorkspacePaths(path, root)
      yield* ensureDir(workspacePaths.metadataDir)
      yield* writeFile(workspacePaths.manifestFile, serializeSyncManifest(manifest))
    })

  const readBaseline: SyncWorkspaceShape["readBaseline"] = (root, issueId) =>
    Effect.gen(function*() {
      const workspacePaths = resolveWorkspacePaths(path, root)
      const filePath = baselineFilePath(path, workspacePaths, issueId)
      const content = yield* readFile(filePath)
      return yield* parseSyncBaseline(filePath, content).pipe(
        Effect.mapError((cause) =>
          new SyncWorkspaceError({
            message: cause.message,
            path: "path" in cause ? cause.path : filePath,
            cause
          })
        )
      )
    })

  const writeBaseline: SyncWorkspaceShape["writeBaseline"] = (root, baseline) =>
    Effect.gen(function*() {
      const workspacePaths = resolveWorkspacePaths(path, root)
      const filePath = baselineFilePath(path, workspacePaths, baseline.issueId)
      yield* ensureDir(workspacePaths.baselinesDir)
      yield* writeFile(filePath, serializeSyncBaseline(baseline))
    })

  const getConventionDocumentPath: SyncWorkspaceShape["conventionDocumentPath"] = (root, issueKey) =>
    Effect.gen(function*() {
      const config = yield* readConfig(root)
      const workspacePaths = resolveWorkspacePaths(path, root, config)
      return conventionDocumentPath(path, workspacePaths, issueKey)
    })

  return SyncWorkspace.of({
    init,
    paths,
    readConfig,
    writeConfig,
    readManifest,
    writeManifest,
    readBaseline,
    writeBaseline,
    conventionDocumentPath: getConventionDocumentPath
  })
})

export const layer: Layer.Layer<SyncWorkspace, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  SyncWorkspace,
  make
)
