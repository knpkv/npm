/**
 * Sandbox orchestration service.
 *
 * Ties together DockerService, PluginService, SandboxRepo
 * to manage sandbox lifecycle: create → run → stop → cleanup.
 *
 * @module
 */
import {
  Clock,
  Config,
  Context,
  Crypto,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Random,
  Ref,
  Result,
  Schedule,
  Stream
} from "effect"
import type { Success } from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcess } from "effect/unstable/process"
import { SandboxRepo, type SandboxRow } from "../CacheService/repos/SandboxRepo.js"
import * as ChildEnv from "../ChildEnv.js"
import {
  ConfigService,
  defaultSandboxConfig,
  type SandboxConfig,
  validateSandboxConfig
} from "../ConfigService/index.js"
import { PullRequestId, RepositoryName, SandboxId, type SandboxStatus } from "../Domain.js"
import { SandboxError } from "../Errors.js"
import { type ContainerConfig, DockerService, isMissingContainerError } from "./DockerService.js"
import { PluginService, type SandboxContext } from "./PluginService.js"
import { SandboxWorkerScope } from "./SandboxWorkerScope.js"

export interface CreateSandboxParams {
  readonly pullRequestId: string
  readonly awsAccountId: string
  readonly repositoryName: string
  readonly sourceBranch: string
  readonly profile: string
  readonly region: string
}

export interface SandboxContainerIdentity {
  readonly repairRootOwnedWorkspace: boolean
  readonly user: string
}

/** Keep the container non-root while matching the bind-mounted workspace owner when available. */
export const sandboxContainerIdentityForWorkspaceOwner = (
  uid: number | undefined,
  gid: number | undefined
): SandboxContainerIdentity =>
  uid === 0
    ? { user: "1000:1000", repairRootOwnedWorkspace: true }
    : uid !== undefined
    ? { user: `${uid}:${gid ?? uid}`, repairRootOwnedWorkspace: false }
    : { user: "1000:1000", repairRootOwnedWorkspace: false }

const SANDBOX_BASE_PORT = 18080
export const sandboxRuntimeHome = "/tmp"
export const sandboxRuntimeXdgDataHome = `${sandboxRuntimeHome}/.local/share`

const isRegionlessSandbox = (row: Pick<SandboxRow, "region">): boolean =>
  row.region === undefined || row.region === null || row.region === ""

const isPreContainerSandboxStatus = (status: string): boolean =>
  status === "creating" || status === "cloning" || status === "starting"

const homeDir = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE"))
)

const sandboxesDir = homeDir.pipe(
  Config.map((h) => `${h}/.codecommit/sandboxes`)
)

const expandHome = (p: string, home: string) => p.startsWith("~/") ? `${home}${p.slice(1)}` : p

export const makeContainerConfig = (
  workspacePath: string,
  port: number,
  sandboxId: string,
  pullRequestId: string,
  sandboxConfig: SandboxConfig,
  homePath: string,
  containerUser: string,
  accessPassword: string
): ContainerConfig => ({
  Image: sandboxConfig.image,
  User: containerUser,
  Cmd: ["--bind-addr", "0.0.0.0:8080", "--auth", "password", "/workspace"],
  ExposedPorts: { "8080/tcp": {} },
  HostConfig: {
    Binds: [
      `${workspacePath}:/workspace`,
      ...sandboxConfig.volumeMounts.map((m) =>
        `${expandHome(m.hostPath, homePath)}:${m.containerPath}${m.readonly ? ":ro" : ""}`
      )
    ],
    PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] },
    CapDrop: ["ALL"]
  },
  Env: [
    ...Object.entries(sandboxConfig.env).map(([k, v]) => `${k}=${v}`),
    `HOME=${sandboxRuntimeHome}`,
    `XDG_CACHE_HOME=${sandboxRuntimeHome}/.cache`,
    `XDG_CONFIG_HOME=${sandboxRuntimeHome}/.config`,
    `XDG_DATA_HOME=${sandboxRuntimeXdgDataHome}`,
    `PASSWORD=${accessPassword}`
  ],
  Labels: {
    "codecommit.sandbox.id": sandboxId,
    "codecommit.sandbox.pr": pullRequestId
  }
})

const makeSandboxService = Effect.gen(function*() {
  const ownerScope = yield* SandboxWorkerScope
  const repo = yield* SandboxRepo
  const docker = yield* DockerService
  const plugins = yield* PluginService
  const configService = yield* ConfigService
  const cryptoService = yield* Crypto.Crypto
  const homePath = yield* homeDir.pipe(Effect.orDie)
  const basePath = yield* sandboxesDir.pipe(Effect.orDie)
  const activeWorkerIds = yield* Ref.make<ReadonlySet<string>>(new Set())

  const loadSandboxConfig: Effect.Effect<SandboxConfig> = configService.load.pipe(
    Effect.map((config) => config.sandbox),
    Effect.catch(() => Effect.succeed(defaultSandboxConfig))
  )

  const updateStatus = (
    id: SandboxId,
    status: SandboxStatus,
    extra?: { containerId?: string; port?: number; error?: string }
  ) => repo.updateStatus(id, status, extra)

  const recordCreationFailure = <UnparsedInput>(id: SandboxId, error: UnparsedInput) =>
    Effect.gen(function*() {
      yield* Effect.logError(`Sandbox ${id} creation failed`, error)
      const errorDetail = Result.try(() => String(Predicate.isError(error) ? error.message : error)).pipe(
        Result.getOrElse(() => "Unknown error")
      )
      yield* updateStatus(id, "error", { error: errorDetail.slice(0, 500) }).pipe(
        Effect.catch((statusError) => Effect.logError("Failed to update sandbox error status", statusError)),
        Effect.catchDefect((statusDefect) =>
          Effect.logError("Defect while updating sandbox error status", statusDefect)
        )
      )
    })

  const progress = (id: SandboxId, detail: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((ms) => {
        const ts = new Date(ms).toISOString()
        return repo.updateDetail(id, detail).pipe(
          Effect.tap(() => repo.appendLog(id, `[${ts}] ${detail}`)),
          Effect.tap(() => Effect.logInfo(`Sandbox ${id}: ${detail}`))
        )
      })
    )

  const allocatePort = () => Random.nextIntBetween(SANDBOX_BASE_PORT, SANDBOX_BASE_PORT + 1000)

  const makeSandboxContext = (row: SandboxRow): SandboxContext => ({
    sandboxId: SandboxId.make(row.id),
    containerId: row.containerId ?? "",
    workspacePath: row.workspacePath,
    port: row.port ?? 0,
    pr: {
      id: PullRequestId.make(row.pullRequestId),
      repositoryName: RepositoryName.make(row.repositoryName),
      sourceBranch: row.sourceBranch
    }
  })

  const retireLegacySandbox = (legacy: SandboxRow) =>
    Effect.gen(function*() {
      const activeWorker = yield* Ref.get(activeWorkerIds).pipe(
        Effect.map((ids) => ids.has(legacy.id))
      )
      if (activeWorker) {
        return yield* new SandboxError({
          sandboxId: SandboxId.make(legacy.id),
          message: "Legacy sandbox is still active; retry after its worker exits"
        })
      }

      const discovered = yield* docker.listContainersByLabel("codecommit.sandbox.id", legacy.id)
      const containerIds = new Set([
        ...(legacy.containerId === null || legacy.containerId.length === 0 ? [] : [legacy.containerId]),
        ...discovered.map((container) => container.Id)
      ])
      if (legacy.accessPassword === null) {
        yield* Effect.forEach(
          containerIds,
          (containerId) =>
            docker.stopContainer(containerId).pipe(
              Effect.catchIf(isMissingContainerError, () => Effect.void)
            ),
          { discard: true }
        )
        yield* updateStatus(SandboxId.make(legacy.id), "error", {
          error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
        })
        return
      }

      yield* Effect.forEach(
        containerIds,
        (containerId) =>
          docker.inspectContainer(containerId).pipe(
            Effect.flatMap((info) => info.State.Running ? docker.stopContainer(containerId) : Effect.void),
            Effect.catchIf(isMissingContainerError, () => Effect.void)
          ),
        { discard: true }
      )
      yield* updateStatus(SandboxId.make(legacy.id), "stopped")
    })

  const service = {
    create: (params: CreateSandboxParams) =>
      Effect.gen(function*() {
        // Singleton check — one active sandbox per PR
        const existing = yield* repo.findByPr(
          params.awsAccountId,
          params.pullRequestId,
          params.repositoryName,
          params.region
        )
        const exactExisting = Option.isSome(existing) && existing.value.region === params.region
          ? existing.value
          : undefined
        const emptyAccountExisting = params.awsAccountId.length === 0
          ? Option.none<SandboxRow>()
          : yield* repo.findByPr("", params.pullRequestId, params.repositoryName, params.region)
        const effectiveExisting = yield* Option.match(emptyAccountExisting, {
          onNone: () => Effect.succeed(exactExisting),
          onSome: (legacy) => {
            if (legacy.accessPassword === null) {
              return retireLegacySandbox(legacy).pipe(Effect.as(exactExisting))
            }
            if (exactExisting !== undefined) {
              return retireLegacySandbox(legacy).pipe(Effect.as(exactExisting))
            }
            return retireLegacySandbox(legacy).pipe(Effect.as(exactExisting))
          }
        })
        const regionless = yield* repo.findRegionlessByPrAll(
          params.awsAccountId,
          params.pullRequestId,
          params.repositoryName
        )
        const legacyResults = yield* Effect.forEach(regionless, (legacy) =>
          Effect.gen(function*() {
            const discovered = yield* docker.listContainersByLabel("codecommit.sandbox.id", legacy.id)
            const containerIds = new Set([
              ...(legacy.containerId === null || legacy.containerId.length === 0 ? [] : [legacy.containerId]),
              ...discovered.map((container) => container.Id)
            ])
            if (
              legacy.accessPassword !== null && containerIds.size === 0 && isPreContainerSandboxStatus(legacy.status)
            ) {
              return yield* new SandboxError({
                sandboxId: SandboxId.make(legacy.id),
                message: "Regionless legacy sandbox is still starting; retry after its worker reports a container"
              })
            }
            if (legacy.accessPassword === null) {
              yield* Effect.forEach(
                containerIds,
                (containerId) =>
                  docker.stopContainer(containerId).pipe(
                    Effect.catchIf(isMissingContainerError, () => Effect.void)
                  ),
                { discard: true }
              )
              yield* updateStatus(SandboxId.make(legacy.id), "error", {
                error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
              })
              return Option.some(legacy)
            }
            yield* Effect.forEach(containerIds, (containerId) =>
              docker.inspectContainer(containerId).pipe(
                Effect.flatMap((info) => info.State.Running ? docker.stopContainer(containerId) : Effect.void),
                Effect.catchIf(isMissingContainerError, () => Effect.void)
              ), { discard: true })
            yield* updateStatus(SandboxId.make(legacy.id), "stopped")
            return Option.none<SandboxRow>()
          }), { concurrency: 1 })
        const unauthenticated = legacyResults.find(Option.isSome)
        if (unauthenticated !== undefined && Option.isSome(unauthenticated)) {
          return yield* new SandboxError({
            sandboxId: SandboxId.make(unauthenticated.value.id),
            message: "Regionless legacy sandbox requires explicit cleanup before recreation"
          })
        }
        if (effectiveExisting !== undefined) {
          if (effectiveExisting.containerId === null && isPreContainerSandboxStatus(effectiveExisting.status)) {
            const activeWorker = yield* Ref.get(activeWorkerIds).pipe(
              Effect.map((ids) => ids.has(effectiveExisting.id))
            )
            if (activeWorker) return effectiveExisting
            yield* updateStatus(SandboxId.make(effectiveExisting.id), "error", {
              error: "Orphaned (no container)"
            })
          } else {
            return effectiveExisting
          }
        }

        const sandboxCfg = yield* loadSandboxConfig
        yield* validateSandboxConfig(sandboxCfg, homePath)

        const nowMs = yield* Clock.currentTimeMillis
        const rand = yield* Random.nextIntBetween(0, 2176782336)
        const id = SandboxId.make(`sbx-${nowMs}-${rand.toString(36).padStart(6, "0")}`)
        const port = yield* allocatePort()
        const accessPassword = yield* cryptoService.randomUUIDv4
        const workspacePath = `${basePath}/${id}`
        const now = new Date(nowMs).toISOString()

        const workerTransferred = yield* Ref.make(false)
        const releaseWorkerReservation = () =>
          Ref.update(activeWorkerIds, (ids) => {
            const next = new Set(ids)
            next.delete(String(id))
            return next
          })
        yield* Ref.update(activeWorkerIds, (ids) => new Set(ids).add(String(id)))
        const worker = Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const host = yield* ChildEnv.HostEnvironment
          const log = (detail: string) => progress(id, detail)

          yield* log("Sandbox config validated")

          // Clone via HTTPS + AWS credential helper
          yield* updateStatus(id, "cloning")
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          const cloneUrl = `https://git-codecommit.${params.region}.amazonaws.com/v1/repos/${params.repositoryName}`
          const branch = params.sourceBranch.replace(/^refs\/heads\//, "")
          const depthLabel = sandboxCfg.cloneDepth > 0 ? ` (depth ${sandboxCfg.cloneDepth})` : ""
          yield* log(`Cloning ${params.repositoryName}/${branch}${depthLabel}`)
          const depthArgs: Array<string> = sandboxCfg.cloneDepth > 0
            ? ["--depth", String(sandboxCfg.cloneDepth)]
            : []
          const cloneResult = yield* Effect.gen(function*() {
            const cloneProc = yield* ChildProcess.make(
              "git",
              [
                "-c",
                "credential.helper=!aws codecommit credential-helper $@",
                "-c",
                "credential.UseHttpPath=true",
                "clone",
                ...depthArgs,
                "-b",
                branch,
                cloneUrl,
                workspacePath
              ],
              {
                // `git` and the `aws` credential helper both resolve from PATH, so the
                // profile overrides must extend the inherited environment. Ambient AWS
                // credentials would outrank them, so profileScopedEnv drops those.
                env: ChildEnv.profileScopedEnv(host.variables, {
                  AWS_PROFILE: params.profile,
                  AWS_DEFAULT_REGION: params.region,
                  AWS_REGION: params.region
                }),
                extendEnv: true,
                stderr: "pipe"
              }
            )
            const exitCode = yield* cloneProc.exitCode
            const stderrChunks = yield* Stream.runCollect(cloneProc.stderr)
            const stderrText = Array.from(stderrChunks).map((c) => new TextDecoder().decode(c)).join("").trim()
            return { exitCode, stderrText }
          }).pipe(Effect.scoped)
          if (cloneResult.exitCode !== 0) {
            const stderrText = cloneResult.stderrText
            yield* log(`Clone failed: ${stderrText}`)
            yield* updateStatus(id, "error", {
              error: stderrText || `git clone failed (exit ${cloneResult.exitCode})`
            })
            return
          }
          yield* log("Clone complete")

          const workspaceInfo = yield* fs.stat(workspacePath)
          const containerIdentity = sandboxContainerIdentityForWorkspaceOwner(
            Option.getOrUndefined(workspaceInfo.uid),
            Option.getOrUndefined(workspaceInfo.gid)
          )
          if (containerIdentity.repairRootOwnedWorkspace) {
            yield* log("Preparing root-owned workspace for the non-root sandbox user")
            const chownExitCode = yield* Effect.scoped(
              ChildProcess.make("chown", ["-R", "1000:1000", "--", workspacePath]).pipe(
                Effect.flatMap((handle) => handle.exitCode)
              )
            )
            if (chownExitCode !== 0) {
              return yield* new SandboxError({
                sandboxId: id,
                message: "Failed to prepare root-owned workspace for the non-root sandbox user"
              })
            }
          }

          // Pull image
          yield* updateStatus(id, "starting")
          yield* log(`Pulling image ${sandboxCfg.image}`)
          yield* docker.pullImage(sandboxCfg.image).pipe(
            Effect.tap(() => log("Image ready")),
            Effect.catchIf(() => true, () => log("Image pull skipped (using cached)"))
          )

          // Create + start container
          yield* log("Creating container")
          yield* validateSandboxConfig(sandboxCfg, homePath)
          const containerConfig = makeContainerConfig(
            workspacePath,
            port,
            id,
            params.pullRequestId,
            sandboxCfg,
            homePath,
            containerIdentity.user,
            accessPassword
          )
          const containerId = yield* docker.createContainer(containerConfig)
          const cid = containerId.trim()
          yield* log(`Container ${cid.slice(0, 12)} created, starting`)
          yield* docker.startContainer(cid)
          yield* updateStatus(id, "starting", { containerId: cid, port })
          yield* log(`Container started on port ${port}`)

          // Wait for code-server to be ready (poll health)
          yield* log("Waiting for code-server health check")
          yield* docker.exec(cid, ["curl", "-sf", "http://localhost:8080/healthz"]).pipe(
            Effect.retry(Schedule.max([Schedule.recurs(30), Schedule.spaced(Duration.seconds(1))])),
            Effect.tap(() => log("code-server ready")),
            Effect.tapError((e) => log(`Health check failed: ${String(e)}`)),
            Effect.catchIf(() => true, () => Effect.void)
          )

          // Run plugin hooks
          const row = yield* repo.findById(id)
          const ctx = makeSandboxContext(row)
          yield* log("Running plugin hooks")
          yield* plugins.executeHook("onSandboxCreate", ctx)
          yield* plugins.executeHook("onSandboxReady", ctx)

          // Install configured extensions
          if (sandboxCfg.extensions.length > 0) {
            yield* log(`Installing ${sandboxCfg.extensions.length} extension(s)`)
            yield* Effect.forEach(sandboxCfg.extensions, (ext) =>
              log(`Installing extension: ${ext}`).pipe(
                Effect.andThen(docker.exec(cid, ["code-server", "--install-extension", ext])),
                Effect.tap((output) =>
                  log(`Extension installed: ${ext}${output.length > 0 ? `\n${output.trim()}` : ""}`)
                ),
                Effect.tapError((e) => log(`Extension failed: ${ext} — ${String(e)}`)),
                Effect.catchIf(() => true, () => Effect.void)
              ), { discard: true })
          }

          // Run configured setup commands
          if (sandboxCfg.setupCommands.length > 0) {
            yield* log(`Running ${sandboxCfg.setupCommands.length} setup command(s)`)
            yield* Effect.forEach(sandboxCfg.setupCommands, (cmd, i) =>
              log(`[${i + 1}/${sandboxCfg.setupCommands.length}] ${cmd}`).pipe(
                Effect.andThen(docker.exec(cid, ["sh", "-c", cmd])),
                Effect.tap((output) =>
                  log(`Command done: ${cmd.slice(0, 60)}${output.length > 0 ? `\n${output.trim()}` : ""}`)
                ),
                Effect.tapError((e) =>
                  log(`Command failed: ${cmd.slice(0, 60)} — ${String(e)}`)
                ),
                Effect.catchIf(() => true, () => Effect.void)
              ), { discard: true })
          }

          yield* updateStatus(id, "running")
          yield* log("Sandbox ready")
        }).pipe(
          Effect.catch((error) =>
            recordCreationFailure(id, error)
          ),
          // Observe and persist unexpected defects without recovering them.
          // `tapDefect` leaves the original Cause / Exit unchanged.
          Effect.tapDefect((defect) => recordCreationFailure(id, defect)),
          Effect.ensuring(releaseWorkerReservation())
        )
        yield* repo.insert({
          id,
          pullRequestId: params.pullRequestId,
          awsAccountId: params.awsAccountId,
          repositoryName: params.repositoryName,
          region: params.region,
          sourceBranch: params.sourceBranch,
          accessPassword,
          workspacePath,
          status: "creating",
          createdAt: now,
          lastActivityAt: now
        }).pipe(
          Effect.andThen(
            Effect.uninterruptible(
              ownerScope.fork(worker).pipe(
                Effect.andThen(Ref.set(workerTransferred, true))
              )
            )
          ),
          Effect.ensuring(
            Ref.get(workerTransferred).pipe(
              Effect.flatMap((transferred) => transferred ? Effect.void : releaseWorkerReservation())
            )
          )
        )

        return yield* repo.findById(id)
      }).pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, "SandboxError")
            ? cause
            : new SandboxError({ message: "Failed to create sandbox", cause })
        )
      ),

    get: (id: SandboxId) =>
      repo.findById(id).pipe(
        Effect.mapError((cause) => new SandboxError({ sandboxId: id, message: "Sandbox not found", cause }))
      ),

    list: () => repo.findActive(),

    listAll: () => repo.findAll(),

    stop: (id: SandboxId) =>
      Effect.gen(function*() {
        const row = yield* repo.findById(id)
        yield* updateStatus(id, "stopping")

        if (row.containerId !== null) {
          const ctx = makeSandboxContext(row)
          yield* plugins.executeHook("onSandboxDestroy", ctx)
          yield* docker.stopContainer(row.containerId).pipe(Effect.catchIf(() => true, () => Effect.void))
        }

        yield* updateStatus(id, "stopped")
        yield* Effect.logInfo(`Sandbox ${id} stopped`)
      }).pipe(
        Effect.mapError((cause) => new SandboxError({ sandboxId: id, message: "Failed to stop sandbox", cause }))
      ),

    restart: (id: SandboxId) =>
      Effect.gen(function*() {
        const row = yield* repo.findById(id)
        if (row.accessPassword === null) {
          return yield* new SandboxError({
            sandboxId: id,
            message: "Legacy sandbox has no authenticated access credential; delete and recreate it"
          })
        }
        if (row.containerId === null) {
          return yield* new SandboxError({ sandboxId: id, message: "No container to restart" })
        }

        yield* updateStatus(id, "starting")
        yield* progress(id, "Restarting container")
        yield* docker.startContainer(row.containerId)
        yield* updateStatus(id, "starting", row.port !== null ? { port: row.port } : {})
        yield* progress(id, "Waiting for code-server health check")

        yield* docker.exec(row.containerId, ["curl", "-sf", "http://localhost:8080/healthz"]).pipe(
          Effect.retry(Schedule.max([Schedule.recurs(30), Schedule.spaced(Duration.seconds(1))])),
          Effect.tap(() => progress(id, "code-server ready")),
          Effect.catchIf(() => true, () => Effect.void)
        )

        const ctx = makeSandboxContext(yield* repo.findById(id))
        yield* plugins.executeHook("onSandboxReady", ctx)

        yield* updateStatus(id, "running")
        yield* progress(id, "Sandbox restarted")
        yield* Effect.logInfo(`Sandbox ${id} restarted`)
      }).pipe(
        Effect.mapError((cause) => new SandboxError({ sandboxId: id, message: "Failed to restart sandbox", cause }))
      ),

    cleanup: (id: SandboxId) =>
      Effect.gen(function*() {
        const row = yield* repo.findById(id)
        const fs = yield* FileSystem.FileSystem

        if (row.containerId !== null) {
          yield* docker.removeContainer(row.containerId).pipe(Effect.catchIf(() => true, () => Effect.void))
        }

        yield* fs.remove(row.workspacePath, { recursive: true }).pipe(Effect.catchIf(() => true, () => Effect.void))
        yield* repo.delete(id)
        yield* Effect.logInfo(`Sandbox ${id} cleaned up`)
      }).pipe(
        Effect.mapError((cause) => new SandboxError({ sandboxId: id, message: "Failed to cleanup sandbox", cause }))
      ),

    reconcile: () =>
      Effect.gen(function*() {
        const active = yield* repo.findActive()
        const all = yield* repo.findAll()
        const activeIds = new Set(active.map((row) => row.id))
        const rows = all.filter((row) =>
          row.accessPassword === null || activeIds.has(row.id) || isRegionlessSandbox(row)
        )
        yield* Effect.forEach(rows, (row) =>
          Effect.gen(function*() {
            if (isRegionlessSandbox(row)) {
              const discovered = yield* docker.listContainersByLabel("codecommit.sandbox.id", row.id)
              const containerIds = new Set([
                ...(row.containerId === null || row.containerId.length === 0 ? [] : [row.containerId]),
                ...discovered.map((container) => container.Id)
              ])
              if (
                row.accessPassword !== null &&
                containerIds.size === 0 &&
                isPreContainerSandboxStatus(row.status)
              ) {
                const activeWorker = yield* Ref.get(activeWorkerIds).pipe(
                  Effect.map((ids) => ids.has(row.id))
                )
                if (activeWorker) return
                yield* updateStatus(SandboxId.make(row.id), "error", { error: "Orphaned (no container)" })
                return
              }
              if (row.accessPassword === null) {
                yield* Effect.forEach(
                  containerIds,
                  (containerId) =>
                    docker.stopContainer(containerId).pipe(
                      Effect.catchIf(isMissingContainerError, () => Effect.void)
                    ),
                  { discard: true }
                )
                yield* updateStatus(SandboxId.make(row.id), "error", {
                  error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
                })
                return
              }
              yield* Effect.forEach(containerIds, (containerId) =>
                docker.inspectContainer(containerId).pipe(
                  Effect.flatMap((info) => info.State.Running ? docker.stopContainer(containerId) : Effect.void),
                  Effect.catchIf(isMissingContainerError, () => Effect.void)
                ), { discard: true })
              yield* updateStatus(SandboxId.make(row.id), "stopped")
              yield* Effect.logInfo(`Reconciled regionless sandbox ${row.id}`)
              return
            }
            if (row.accessPassword === null) {
              const discovered = yield* docker.listContainersByLabel("codecommit.sandbox.id", row.id)
              const containerIds = new Set([
                ...(row.containerId === null || row.containerId.length === 0 ? [] : [row.containerId]),
                ...discovered.map((container) => container.Id)
              ])
              // Do not consider any legacy row reconciled until every persisted
              // or labeled passwordless container has confirmed shutdown.
              yield* Effect.forEach(
                containerIds,
                (containerId) =>
                  docker.stopContainer(containerId).pipe(
                    Effect.catchIf(isMissingContainerError, () => Effect.void)
                  ),
                { discard: true }
              )
              yield* updateStatus(SandboxId.make(row.id), "error", {
                error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
              })
              return
            }
            if (row.containerId === null) {
              if (isPreContainerSandboxStatus(row.status)) {
                const activeWorker = yield* Ref.get(activeWorkerIds).pipe(
                  Effect.map((ids) => ids.has(row.id))
                )
                if (activeWorker) return
              }
              yield* updateStatus(SandboxId.make(row.id), "error", { error: "Orphaned (no container)" })
              return
            }
            const info = yield* docker.inspectContainer(row.containerId).pipe(
              Effect.map(Option.some),
              Effect.catchIf(isMissingContainerError, () => Effect.succeed(Option.none()))
            )
            if (Option.isNone(info) || info.value.State.Running === false) {
              yield* updateStatus(SandboxId.make(row.id), "stopped")
              yield* Effect.logInfo(`Reconciled orphaned sandbox ${row.id}`)
            }
          }), { discard: true })
      }).pipe(
        Effect.as(true),
        Effect.catch((cause) => Effect.logWarning("Sandbox reconcile failed", cause).pipe(Effect.as(false)))
      ),

    hasLegacyUnauthenticated: () =>
      repo.findAll().pipe(
        Effect.map((rows) => rows.some((row) => row.accessPassword === null || isRegionlessSandbox(row)))
      ),

    gcIdle: (idleTimeout = Duration.minutes(30), cleanupDelay = Duration.hours(24)) =>
      Effect.gen(function*() {
        const all = yield* repo.findAll()
        const now = yield* Clock.currentTimeMillis

        // Stop idle running sandboxes
        yield* Effect.forEach(
          all.filter((r) => r.status === "running"),
          (row) => {
            const lastActivity = new Date(row.lastActivityAt).getTime()
            if (now - lastActivity > Duration.toMillis(idleTimeout)) {
              return Effect.gen(function*() {
                yield* Effect.logInfo(`GC: stopping idle sandbox ${row.id}`)
                if (row.containerId !== null) {
                  yield* docker.stopContainer(row.containerId).pipe(Effect.catchIf(() => true, () => Effect.void))
                }
                yield* updateStatus(SandboxId.make(row.id), "stopped")
              })
            }
            return Effect.void
          },
          { discard: true }
        )

        // Cleanup stopped sandboxes past delay
        const fs = yield* FileSystem.FileSystem
        yield* Effect.forEach(
          all.filter((r) => r.status === "stopped" || r.status === "error"),
          (row) => {
            const lastActivity = new Date(row.lastActivityAt).getTime()
            if (now - lastActivity > Duration.toMillis(cleanupDelay)) {
              return Effect.gen(function*() {
                yield* Effect.logInfo(`GC: cleaning up sandbox ${row.id}`)
                if (row.containerId !== null) {
                  yield* docker.removeContainer(row.containerId).pipe(Effect.catchIf(() => true, () => Effect.void))
                }
                yield* fs.remove(row.workspacePath, { recursive: true }).pipe(
                  Effect.catchIf(() => true, () => Effect.void)
                )
                yield* repo.delete(SandboxId.make(row.id))
              })
            }
            return Effect.void
          },
          { discard: true }
        )
      }).pipe(Effect.catch((cause) => Effect.logWarning("Sandbox GC failed", cause)))
  }
  return service
})

export interface SandboxServiceContract extends Success<typeof makeSandboxService> {}

export class SandboxService extends Context.Service<
  SandboxService,
  SandboxServiceContract
>()("SandboxService") {
  /** Dependency-requiring layer used by composition tests and custom runtimes. @internal */
  static readonly layer = Layer.effect(SandboxService, makeSandboxService)

  static readonly Default = SandboxService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(SandboxRepo.Default, DockerService.Default, PluginService.Default, SandboxWorkerScope.Default)
    )
  )
}
