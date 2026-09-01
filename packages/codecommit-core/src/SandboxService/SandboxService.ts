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
  Fiber,
  Layer,
  Option,
  Predicate,
  Random,
  Ref,
  Result,
  Schedule,
  Semaphore,
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
import {
  type ContainerConfig,
  DockerService,
  isAlreadyStoppedContainerError,
  isMissingContainerError
} from "./DockerService.js"
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

const isTerminalSandboxStatus = (status: string): boolean => status === "stopped" || status === "error"
const isConfirmedStoppedContainer = (state: string): boolean => state === "exited" || state === "dead"

const isCompletedLegacyRetirement = (
  row: Pick<SandboxRow, "accessPassword" | "legacyRetiredAt" | "status">
): boolean => row.accessPassword !== null && row.status === "stopped" && row.legacyRetiredAt !== null

const isPendingLegacyRetirement = (
  row: Pick<SandboxRow, "accessPassword" | "legacyRetiredAt" | "status">
): boolean => row.accessPassword !== null && row.status !== "stopped" && row.legacyRetiredAt !== null

const isOrdinaryStoppingSandbox = (
  row: Pick<SandboxRow, "legacyRetiredAt" | "status">
): boolean => row.status === "stopping" && row.legacyRetiredAt === null

const isDiscoveredAwsAccountId = (value: string): boolean => /^\d{12}$/u.test(value)

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
  const activeWorkerIds = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
  const lifecycleAdmission = yield* Semaphore.make(1)
  const containerAdmission = yield* Semaphore.make(1)
  const createAdmission = yield* Semaphore.make(1)
  const stopRequestedIds = yield* Ref.make<ReadonlySet<string>>(new Set())
  const retiredLegacyIds = yield* Ref.make<ReadonlySet<string>>(new Set())
  const markWorkerActive = (id: string) =>
    Ref.update(activeWorkerIds, (workers) => {
      const next = new Map(workers)
      next.set(id, (next.get(id) ?? 0) + 1)
      return next
    })
  const releaseWorker = (id: string) =>
    Ref.modify(activeWorkerIds, (workers): readonly [boolean, ReadonlyMap<string, number>] => {
      const next = new Map(workers)
      const count = next.get(id) ?? 0
      if (count <= 1) next.delete(id)
      else next.set(id, count - 1)
      return [count <= 1, next]
    })
  const hasActiveWorker = (id: string) =>
    Ref.get(activeWorkerIds).pipe(Effect.map((workers) => (workers.get(id) ?? 0) > 0))
  const isStopRequested = (id: string) => Ref.get(stopRequestedIds).pipe(Effect.map((ids) => ids.has(id)))
  const requestWorkerStop = (id: string) => Ref.update(stopRequestedIds, (ids) => new Set(ids).add(id))
  const clearWorkerStopRequest = (id: string) =>
    Ref.update(stopRequestedIds, (ids) => {
      if (!ids.has(id)) return ids
      const next = new Set(ids)
      next.delete(id)
      return next
    })

  const findFallbackCandidate = (params: CreateSandboxParams) =>
    !isDiscoveredAwsAccountId(params.awsAccountId)
      ? Effect.gen(function*() {
        const candidates = (yield* repo.findAll()).filter((row) =>
          isDiscoveredAwsAccountId(row.awsAccountId) &&
          row.awsAccountId !== params.profile &&
          row.pullRequestId === params.pullRequestId &&
          row.repositoryName === params.repositoryName &&
          (row.region === params.region || row.region === null || row.region === undefined || row.region === "")
        )
        let terminalCandidate: SandboxRow | undefined
        for (const candidate of candidates) {
          if (!isTerminalSandboxStatus(candidate.status)) {
            return { row: candidate, blocksCreation: true }
          }
          const containers = yield* docker.listContainersByLabel("codecommit.sandbox.id", candidate.id)
          if (containers.some((container) => !isConfirmedStoppedContainer(container.State))) {
            return { row: candidate, blocksCreation: true }
          }
          terminalCandidate ??= candidate
        }
        return terminalCandidate === undefined
          ? undefined
          : { row: terminalCandidate, blocksCreation: false }
      })
      : Effect.void

  const loadSandboxConfig: Effect.Effect<SandboxConfig> = configService.load.pipe(
    Effect.map((config) => config.sandbox),
    Effect.catch(() => Effect.succeed(defaultSandboxConfig))
  )

  const updateStatus = (
    id: SandboxId,
    status: SandboxStatus,
    extra?: { containerId?: string; port?: number; error?: string; legacyRetiredAt?: string }
  ) => repo.updateStatus(id, status, extra)

  const updateWorkerStatus = (
    id: SandboxId,
    status: SandboxStatus,
    extra?: { containerId?: string; port?: number; error?: string; legacyRetiredAt?: string }
  ) =>
    lifecycleAdmission.withPermits(1)(Effect.gen(function*() {
      if (yield* isStopRequested(String(id))) return
      yield* updateStatus(id, status, extra)
    }))

  const releaseWorkerReservation = (id: string) =>
    releaseWorker(id).pipe(
      Effect.flatMap((lastWorker) => lastWorker ? clearWorkerStopRequest(id) : Effect.void)
    )

  const recordCreationFailure = <UnparsedInput>(id: SandboxId, error: UnparsedInput) =>
    lifecycleAdmission.withPermits(1)(Effect.gen(function*() {
      if (yield* isStopRequested(String(id))) return
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
    }))

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
    lifecycleAdmission.withPermits(1)(Effect.gen(function*() {
      const activeWorker = yield* hasActiveWorker(legacy.id)
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
              Effect.catchIf(
                (error) => isMissingContainerError(error) || isAlreadyStoppedContainerError(error),
                () => Effect.void
              )
            ),
          { discard: true }
        )
        yield* updateStatus(SandboxId.make(legacy.id), "error", {
          error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
        })
        return
      }

      yield* markLegacyRetirementStarted(SandboxId.make(legacy.id))
      yield* Effect.forEach(
        containerIds,
        (containerId) =>
          docker.inspectContainer(containerId).pipe(
            Effect.flatMap((info) => info.State.Running ? docker.stopContainer(containerId) : Effect.void),
            Effect.catchIf(
              (error) => isMissingContainerError(error) || isAlreadyStoppedContainerError(error),
              () => Effect.void
            )
          ),
        { discard: true }
      )
      yield* Clock.currentTimeMillis.pipe(
        Effect.flatMap((ms) =>
          updateStatus(SandboxId.make(legacy.id), "stopped", { legacyRetiredAt: new Date(ms).toISOString() })
        )
      )
      yield* Ref.update(retiredLegacyIds, (ids) => new Set(ids).add(legacy.id))
    }))

  const markLegacyRetired = (id: SandboxId) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((ms) => updateStatus(id, "stopped", { legacyRetiredAt: new Date(ms).toISOString() }))
    )

  const markLegacyRetirementStarted = (id: SandboxId) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((ms) => updateStatus(id, "stopping", { legacyRetiredAt: new Date(ms).toISOString() }))
    )

  const service = {
    create: (params: CreateSandboxParams) =>
      Effect.gen(function*() {
        yield* Effect.uninterruptible(createAdmission.take(1))

        // Singleton check — one active sandbox per PR
        const existing = yield* repo.findByPr(
          params.awsAccountId,
          params.pullRequestId,
          params.repositoryName,
          params.region
        )
        const exactCandidate = Option.isSome(existing) && existing.value.region === params.region
          ? existing.value
          : undefined
        const exactExisting = exactCandidate !== undefined &&
            !isCompletedLegacyRetirement(exactCandidate) &&
            !isPendingLegacyRetirement(exactCandidate)
          ? exactCandidate
          : undefined
        const pendingExact = exactCandidate !== undefined && isPendingLegacyRetirement(exactCandidate)
          ? [exactCandidate]
          : []
        const emptyAccountRows = params.awsAccountId.length === 0
          ? []
          : (yield* repo.findAll()).filter((row) =>
            row.awsAccountId === "" &&
            row.pullRequestId === params.pullRequestId &&
            row.repositoryName === params.repositoryName &&
            row.region === params.region
          )
        const profileRows = isDiscoveredAwsAccountId(params.awsAccountId) &&
            !isDiscoveredAwsAccountId(params.profile) &&
            params.profile !== params.awsAccountId
          ? (yield* repo.findAll()).filter((row) =>
            row.awsAccountId === params.profile &&
            row.pullRequestId === params.pullRequestId &&
            row.repositoryName === params.repositoryName &&
            row.region === params.region
          )
          : []
        const effectiveExisting = yield* Effect.forEach(
          [...emptyAccountRows, ...profileRows, ...pendingExact]
            .filter((row) => !isCompletedLegacyRetirement(row)),
          retireLegacySandbox,
          { discard: true }
        ).pipe(
          Effect.as(exactExisting)
        )
        const regionlessKeys = Array.from(
          new Set([
            params.awsAccountId,
            isDiscoveredAwsAccountId(params.awsAccountId) && !isDiscoveredAwsAccountId(params.profile)
              ? params.profile
              : undefined
          ])
        ).filter((key): key is string => key !== undefined && key.length > 0)
        const regionlessCandidates = (yield* Effect.forEach(regionlessKeys, (key) =>
          repo.findRegionlessByPrAll(key, params.pullRequestId, params.repositoryName), { concurrency: 1 })).flat()
          .filter(
            (row) =>
              regionlessKeys.includes(row.awsAccountId) && !isCompletedLegacyRetirement(row)
          )
        const regionless = regionlessCandidates.filter(
          (row, index, candidates) =>
            candidates.findIndex((candidate) =>
              candidate.id === row.id
            ) === index
        )
        const legacyResults = yield* Effect.forEach(regionless, (legacy) =>
          lifecycleAdmission.withPermits(1)(Effect.gen(function*() {
            if (legacy.accessPassword !== null && (yield* hasActiveWorker(legacy.id))) {
              return yield* new SandboxError({
                sandboxId: SandboxId.make(legacy.id),
                message: "Regionless legacy sandbox is still active; retry after its worker exits"
              })
            }
            const discovered = yield* docker.listContainersByLabel("codecommit.sandbox.id", legacy.id)
            const containerIds = new Set([
              ...(legacy.containerId === null || legacy.containerId.length === 0 ? [] : [legacy.containerId]),
              ...discovered.map((container) =>
                container.Id
              )
            ])
            if (
              legacy.accessPassword !== null && containerIds.size === 0 && isPreContainerSandboxStatus(legacy.status)
            ) {
              return yield* new SandboxError({
                sandboxId: SandboxId.make(legacy.id),
                message: "Regionless legacy sandbox is still starting; retry after its worker reports a container"
              })
            }
            if (legacy.accessPassword !== null) {
              yield* markLegacyRetirementStarted(SandboxId.make(legacy.id))
            }
            if (legacy.accessPassword === null) {
              yield* Effect.forEach(
                containerIds,
                (containerId) =>
                  docker.stopContainer(containerId).pipe(
                    Effect.catchIf(
                      (error) => isMissingContainerError(error) || isAlreadyStoppedContainerError(error),
                      () => Effect.void
                    )
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
                Effect.catchIf(
                  (error) => isMissingContainerError(error) || isAlreadyStoppedContainerError(error),
                  () => Effect.void
                )
              ), { discard: true })
            yield* markLegacyRetired(SandboxId.make(legacy.id))
            return Option.none<SandboxRow>()
          })), { concurrency: 1 })
        const unauthenticated = legacyResults.find(Option.isSome)
        if (unauthenticated !== undefined && Option.isSome(unauthenticated)) {
          return yield* new SandboxError({
            sandboxId: SandboxId.make(unauthenticated.value.id),
            message: "Regionless legacy sandbox requires explicit cleanup before recreation"
          })
        }
        if (exactCandidate !== undefined && isOrdinaryStoppingSandbox(exactCandidate)) {
          return yield* new SandboxError({
            sandboxId: SandboxId.make(exactCandidate.id),
            message: "Sandbox is still stopping; retry after it has stopped"
          })
        }
        if (effectiveExisting !== undefined) {
          if (effectiveExisting.containerId === null && isPreContainerSandboxStatus(effectiveExisting.status)) {
            const activeWorker = yield* hasActiveWorker(effectiveExisting.id)
            if (activeWorker) {
              return effectiveExisting
            }
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
        const releaseWorkerReservationForCreate = () =>
          releaseWorkerReservation(String(id))
        const worker = Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const host = yield* ChildEnv.HostEnvironment
          const log = (detail: string) => progress(id, detail)

          if (yield* isStopRequested(String(id))) return
          yield* log("Sandbox config validated")

          // Clone via HTTPS + AWS credential helper
          yield* updateWorkerStatus(id, "cloning")
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
            yield* updateWorkerStatus(id, "error", {
              error: stderrText || `git clone failed (exit ${cloneResult.exitCode})`
            })
            return
          }
          yield* log("Clone complete")

          if (yield* isStopRequested(String(id))) return

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
          yield* updateWorkerStatus(id, "starting")
          yield* log(`Pulling image ${sandboxCfg.image}`)
          yield* docker.pullImage(sandboxCfg.image).pipe(
            Effect.tap(() => log("Image ready")),
            Effect.catchIf(() => true, () => log("Image pull skipped (using cached)"))
          )

          // Create + start container. Stop and provisioning share this gate so a
          // stop request cannot pass while a worker is between create and start.
          const cid = yield* lifecycleAdmission.withPermits(1)(Effect.gen(function*() {
            if (yield* isStopRequested(String(id))) return undefined
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
            const nextCid = containerId.trim()
            if (yield* isStopRequested(String(id))) {
              yield* updateStatus(id, "stopping", { containerId: nextCid, port })
              return undefined
            }
            yield* log(`Container ${nextCid.slice(0, 12)} created, starting`)
            yield* docker.startContainer(nextCid)
            yield* updateStatus(id, "starting", { containerId: nextCid, port })
            yield* log(`Container started on port ${port}`)
            if (yield* isStopRequested(String(id))) return undefined
            return nextCid
          }))
          if (cid === undefined) return
          if (yield* isStopRequested(String(id))) return

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

          yield* updateWorkerStatus(id, "running")
          yield* log("Sandbox ready")
        }).pipe(
          Effect.catch((error) =>
            recordCreationFailure(id, error)
          ),
          // Observe and persist unexpected defects without recovering them.
          // `tapDefect` leaves the original Cause / Exit unchanged.
          Effect.tapDefect((defect) => recordCreationFailure(id, defect))
        )
        const fallbackStopGuard = yield* lifecycleAdmission.withPermits(1)(
          Effect.gen(function*() {
            const fallbackCandidate = yield* findFallbackCandidate(params)
            if (fallbackCandidate === undefined) return undefined
            if (fallbackCandidate.blocksCreation) {
              return yield* new SandboxError({
                sandboxId: SandboxId.make(fallbackCandidate.row.id),
                message: "AWS account identity is unavailable; retry after account discovery"
              })
            }
            yield* requestWorkerStop(String(fallbackCandidate.row.id))
            return fallbackCandidate.row.id
          })
        )
        yield* markWorkerActive(String(id))
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
              ownerScope.fork(worker, releaseWorkerReservationForCreate()).pipe(
                Effect.flatMap(({ fiber, started }) =>
                  Effect.race(
                    started.pipe(Effect.as(true)),
                    Fiber.await(fiber).pipe(Effect.as(false))
                  )
                ),
                Effect.flatMap((started) => started ? Ref.set(workerTransferred, true) : Effect.void)
              )
            )
          ),
          Effect.ensuring(
            Ref.get(workerTransferred).pipe(
              Effect.flatMap((transferred) => transferred ? Effect.void : releaseWorkerReservationForCreate())
            )
          ),
          Effect.ensuring(
            fallbackStopGuard === undefined
              ? Effect.void
              : clearWorkerStopRequest(String(fallbackStopGuard))
          )
        )

        return yield* repo.findById(id)
      }).pipe(
        Effect.ensuring(createAdmission.release(1)),
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
      Effect.uninterruptibleMask((restore) => {
        const stopSandbox = lifecycleAdmission.withPermits(1)(Effect.gen(function*() {
          const row = yield* repo.findById(id)
          yield* updateStatus(id, "stopping")

          if (row.containerId !== null) {
            const containerId = row.containerId
            const ctx = makeSandboxContext(row)
            yield* plugins.executeHook("onSandboxDestroy", ctx)
            yield* containerAdmission.withPermits(1)(Effect.gen(function*() {
              const stop = row.legacyRetiredAt === null
                ? docker.stopContainer(containerId).pipe(Effect.catchIf(() => true, () => Effect.void))
                : docker.stopContainer(containerId).pipe(
                  Effect.catchIf(
                    (error) => isMissingContainerError(error) || isAlreadyStoppedContainerError(error),
                    () => Effect.void
                  )
                )
              yield* stop
            }))
          }

          yield* updateStatus(id, "stopped")
          yield* Effect.logInfo(`Sandbox ${id} stopped`)
        }))
        return restore(
          createAdmission.withPermits(1)(
            Effect.uninterruptible(
              Effect.ensuring(
                Effect.gen(function*() {
                  // Publish the stop intent before waiting for lifecycle admission.
                  // Restart checks this marker before it can publish ownership.
                  yield* requestWorkerStop(String(id))
                  yield* stopSandbox
                }),
                hasActiveWorker(String(id)).pipe(
                  Effect.flatMap((activeWorker) => activeWorker ? Effect.void : clearWorkerStopRequest(String(id)))
                )
              )
            )
          )
        )
      }).pipe(
        Effect.mapError((cause) => new SandboxError({ sandboxId: id, message: "Failed to stop sandbox", cause }))
      ),

    restart: (id: SandboxId) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.acquireUseRelease(
          Effect.gen(function*() {
            yield* lifecycleAdmission.take(1)
            return {
              permitReleased: yield* Ref.make(false),
              workerMarked: yield* Ref.make(false)
            }
          }),
          ({ permitReleased, workerMarked }) =>
            Effect.gen(function*() {
              const row = yield* repo.findById(id)
              if (yield* isStopRequested(String(id))) return
              const wasRetired = yield* Ref.get(retiredLegacyIds).pipe(Effect.map((ids) => ids.has(String(id))))
              if (wasRetired || row.legacyRetiredAt !== null) {
                return yield* new SandboxError({
                  sandboxId: id,
                  message: "Legacy sandbox was retired; create a replacement"
                })
              }
              if (row.accessPassword === null) {
                return yield* new SandboxError({
                  sandboxId: id,
                  message: "Legacy sandbox has no authenticated access credential; delete and recreate it"
                })
              }
              if (row.containerId === null) {
                return yield* new SandboxError({ sandboxId: id, message: "No container to restart" })
              }
              const containerId = row.containerId
              yield* markWorkerActive(String(id))
              yield* Ref.set(workerMarked, true)
              yield* lifecycleAdmission.release(1)
              yield* Ref.set(permitReleased, true)
              yield* restore(Effect.gen(function*() {
                if (yield* isStopRequested(String(id))) return
                yield* updateWorkerStatus(id, "starting")
                if (yield* isStopRequested(String(id))) return
                yield* progress(id, "Restarting container")
                const started = yield* containerAdmission.withPermits(1)(Effect.gen(function*() {
                  if (yield* isStopRequested(String(id))) return false
                  yield* docker.startContainer(containerId)
                  yield* updateStatus(id, "starting", row.port !== null ? { port: row.port } : {})
                  return true
                }))
                if (!started || (yield* isStopRequested(String(id)))) return
                yield* progress(id, "Waiting for code-server health check")

                yield* docker.exec(containerId, ["curl", "-sf", "http://localhost:8080/healthz"]).pipe(
                  Effect.retry(Schedule.max([Schedule.recurs(30), Schedule.spaced(Duration.seconds(1))])),
                  Effect.tap(() => progress(id, "code-server ready")),
                  Effect.catchIf(() => true, () => Effect.void)
                )
                if (yield* isStopRequested(String(id))) return

                const ctx = makeSandboxContext(yield* repo.findById(id))
                yield* plugins.executeHook("onSandboxReady", ctx)
                if (yield* isStopRequested(String(id))) return

                yield* updateWorkerStatus(id, "running")
                if (yield* isStopRequested(String(id))) return
                yield* progress(id, "Sandbox restarted")
                yield* Effect.logInfo(`Sandbox ${id} restarted`)
              }))
            }),
          ({ permitReleased, workerMarked }) =>
            Effect.gen(function*() {
              if (!(yield* Ref.getAndSet(permitReleased, true))) yield* lifecycleAdmission.release(1)
              if (yield* Ref.getAndSet(workerMarked, false)) yield* releaseWorkerReservation(String(id))
            })
        )
      ).pipe(
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
        yield* Effect.uninterruptible(lifecycleAdmission.take(1))

        const active = yield* repo.findActive()
        const all = yield* repo.findAll()
        const activeIds = new Set(active.map((row) => row.id))
        const rows = all.filter((row) =>
          !isCompletedLegacyRetirement(row) &&
          (row.accessPassword === null || activeIds.has(row.id) || isRegionlessSandbox(row) ||
            (row.legacyRetiredAt !== null && row.status !== "stopped"))
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
                const activeWorker = yield* hasActiveWorker(row.id)
                if (activeWorker) return
                yield* updateStatus(SandboxId.make(row.id), "error", { error: "Orphaned (no container)" })
                return
              }
              if (row.accessPassword === null) {
                yield* Effect.forEach(
                  containerIds,
                  (containerId) =>
                    docker.stopContainer(containerId).pipe(
                      Effect.catchIf(
                        (error) => isMissingContainerError(error) || isAlreadyStoppedContainerError(error),
                        () => Effect.void
                      )
                    ),
                  { discard: true }
                )
                yield* updateStatus(SandboxId.make(row.id), "error", {
                  error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
                })
                return
              }
              if (yield* hasActiveWorker(row.id)) {
                return
              }
              yield* markLegacyRetirementStarted(SandboxId.make(row.id))
              yield* Effect.forEach(containerIds, (containerId) =>
                docker.inspectContainer(containerId).pipe(
                  Effect.flatMap((info) => info.State.Running ? docker.stopContainer(containerId) : Effect.void),
                  Effect.catchIf(
                    (error) => isMissingContainerError(error) || isAlreadyStoppedContainerError(error),
                    () => Effect.void
                  )
                ), { discard: true })
              yield* markLegacyRetired(SandboxId.make(row.id))
              yield* Effect.logInfo(`Reconciled regionless sandbox ${row.id}`)
              return
            }
            if (row.accessPassword !== null && row.legacyRetiredAt !== null) {
              const discovered = yield* docker.listContainersByLabel("codecommit.sandbox.id", row.id)
              const containerIds = new Set([
                ...(row.containerId === null || row.containerId.length === 0 ? [] : [row.containerId]),
                ...discovered.map((container) => container.Id)
              ])
              yield* Effect.forEach(containerIds, (containerId) =>
                docker.inspectContainer(containerId).pipe(
                  Effect.flatMap((info) => info.State.Running ? docker.stopContainer(containerId) : Effect.void),
                  Effect.catchIf(
                    (error) => isMissingContainerError(error) || isAlreadyStoppedContainerError(error),
                    () => Effect.void
                  )
                ), { discard: true })
              yield* updateStatus(SandboxId.make(row.id), "stopped", { legacyRetiredAt: row.legacyRetiredAt })
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
                    Effect.catchIf(
                      (error) => isMissingContainerError(error) || isAlreadyStoppedContainerError(error),
                      () => Effect.void
                    )
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
                const activeWorker = yield* hasActiveWorker(row.id)
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
        Effect.catch((cause) => Effect.logWarning("Sandbox reconcile failed", cause).pipe(Effect.as(false))),
        Effect.ensuring(lifecycleAdmission.release(1))
      ),

    hasLegacyUnauthenticated: () =>
      repo.findAll().pipe(
        Effect.map((rows) =>
          rows.some((row) =>
            row.accessPassword === null || (isRegionlessSandbox(row) && !isCompletedLegacyRetirement(row))
          )
        )
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
