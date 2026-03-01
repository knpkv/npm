/**
 * Sandbox orchestration service.
 *
 * Ties together DockerService, PluginService, SandboxRepo
 * to manage sandbox lifecycle: create → run → stop → cleanup.
 *
 * @module
 */
import { Command, FileSystem } from "@effect/platform"
import { Cause, Clock, Config, Duration, Effect, Option, Random, Schedule, Stream } from "effect"
import { SandboxRepo, type SandboxRow } from "../CacheService/repos/SandboxRepo.js"
import { ConfigService, defaultSandboxConfig, type SandboxConfig } from "../ConfigService/index.js"
import { PullRequestId, RepositoryName, SandboxId, type SandboxStatus } from "../Domain.js"
import { SandboxError } from "../Errors.js"
import { type ContainerConfig, DockerService } from "./DockerService.js"
import { makeClaudeCodePlugin } from "./plugins/ClaudeCodePlugin.js"
import { PluginService, type SandboxContext } from "./PluginService.js"

export interface CreateSandboxParams {
  readonly pullRequestId: string
  readonly awsAccountId: string
  readonly repositoryName: string
  readonly sourceBranch: string
  readonly profile: string
  readonly region: string
}

const SANDBOX_BASE_PORT = 18080

const homeDir = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE"))
)

const sandboxesDir = homeDir.pipe(
  Config.map((h) => `${h}/.codecommit/sandboxes`)
)

const anthropicApiKey = Config.string("ANTHROPIC_API_KEY").pipe(
  Config.option
)

const expandHome = (p: string, home: string) => p.startsWith("~/") ? `${home}${p.slice(1)}` : p

const makeContainerConfig = (
  workspacePath: string,
  port: number,
  sandboxId: string,
  pullRequestId: string,
  apiKey: Option.Option<string>,
  sandboxConfig: SandboxConfig,
  homePath: string
): ContainerConfig => ({
  Image: sandboxConfig.image,
  Cmd: ["--bind-addr", "0.0.0.0:8080", "--auth", "none", "/workspace"],
  ExposedPorts: { "8080/tcp": {} },
  HostConfig: {
    Binds: [
      `${workspacePath}:/workspace`,
      ...sandboxConfig.volumeMounts.map((m) =>
        `${expandHome(m.hostPath, homePath)}:${m.containerPath}${m.readonly ? ":ro" : ""}`
      )
    ],
    PortBindings: { "8080/tcp": [{ HostPort: String(port) }] }
  },
  Env: [
    ...(Option.isSome(apiKey) ? [`ANTHROPIC_API_KEY=${apiKey.value}`] : []),
    ...Object.entries(sandboxConfig.env).map(([k, v]) => `${k}=${v}`)
  ],
  Labels: {
    "codecommit.sandbox.id": sandboxId,
    "codecommit.sandbox.pr": pullRequestId
  }
})

export class SandboxService extends Effect.Service<SandboxService>()("SandboxService", {
  dependencies: [SandboxRepo.Default, DockerService.Default, PluginService.Default],
  effect: Effect.gen(function*() {
    const repo = yield* SandboxRepo
    const docker = yield* DockerService
    const plugins = yield* PluginService
    const configService = yield* ConfigService
    const homePath = yield* homeDir.pipe(Effect.orDie)
    const basePath = yield* sandboxesDir.pipe(Effect.orDie)
    const apiKey = yield* anthropicApiKey.pipe(Effect.orDie)

    const loadSandboxConfig = configService.load.pipe(
      Effect.map((c) => c.sandbox),
      Effect.catchAll(() => Effect.succeed(defaultSandboxConfig))
    )

    // Register built-in plugins conditionally based on config
    yield* Effect.gen(function*() {
      const sandboxCfg = yield* loadSandboxConfig
      if (sandboxCfg.enableClaudeCode) {
        yield* plugins.register(
          makeClaudeCodePlugin((containerId, cmd) =>
            docker.exec(containerId, cmd).pipe(Effect.catchAll(() => Effect.void))
          )
        )
      }
    })

    const updateStatus = (
      id: SandboxId,
      status: SandboxStatus,
      extra?: { containerId?: string; port?: number; error?: string }
    ) => repo.updateStatus(id, status, extra)

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

    return {
      create: (params: CreateSandboxParams) =>
        Effect.gen(function*() {
          // Singleton check — one active sandbox per PR
          const existing = yield* repo.findByPr(params.awsAccountId, params.pullRequestId)
          if (Option.isSome(existing)) {
            return existing.value
          }

          const nowMs = yield* Clock.currentTimeMillis
          const rand = yield* Random.nextIntBetween(0, 2176782336)
          const id = SandboxId.make(`sbx-${nowMs}-${rand.toString(36).padStart(6, "0")}`)
          const port = yield* allocatePort()
          const workspacePath = `${basePath}/${id}`
          const now = new Date(nowMs).toISOString()

          yield* repo.insert({
            id,
            pullRequestId: params.pullRequestId,
            awsAccountId: params.awsAccountId,
            repositoryName: params.repositoryName,
            sourceBranch: params.sourceBranch,
            workspacePath,
            status: "creating",
            createdAt: now,
            lastActivityAt: now
          })

          // Fork daemon for async lifecycle
          yield* Effect.forkDaemon(
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              const log = (detail: string) => progress(id, detail)

              // Load config at creation time
              yield* log("Loading sandbox config")
              const sandboxCfg = yield* loadSandboxConfig

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
              const cloneProc = yield* Command.make(
                "git",
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
              ).pipe(
                Command.env({ AWS_PROFILE: params.profile, AWS_DEFAULT_REGION: params.region }),
                Command.stderr("pipe"),
                Command.start
              )
              const exitCode = yield* cloneProc.exitCode
              if (exitCode !== 0) {
                const stderrChunks = yield* Stream.runCollect(cloneProc.stderr)
                const stderrText = Array.from(stderrChunks).map((c) => new TextDecoder().decode(c)).join("").trim()
                yield* log(`Clone failed: ${stderrText}`)
                yield* updateStatus(id, "error", { error: stderrText || `git clone failed (exit ${exitCode})` })
                return
              }
              yield* log("Clone complete")

              // Pull image
              yield* updateStatus(id, "starting")
              yield* log(`Pulling image ${sandboxCfg.image}`)
              yield* docker.pullImage(sandboxCfg.image).pipe(
                Effect.tap(() => log("Image ready")),
                Effect.catchAll(() => log("Image pull skipped (using cached)"))
              )

              // Create + start container
              yield* log("Creating container")
              const containerConfig = makeContainerConfig(
                workspacePath,
                port,
                id,
                params.pullRequestId,
                apiKey,
                sandboxCfg,
                homePath
              )
              const containerId = yield* docker.createContainer(containerConfig)
              const cid = containerId.trim()
              yield* log(`Container ${cid.slice(0, 12)} created, starting`)
              yield* docker.startContainer(cid)
              yield* updateStatus(id, "starting", { containerId: cid, port })
              yield* log(`Container started on port ${port}`)

              // Fix ownership of dirs that Docker may have created as root (from volume mounts)
              yield* docker.exec(cid, [
                "sudo",
                "chown",
                "-R",
                "coder:coder",
                "/home/coder/.local"
              ]).pipe(Effect.catchAll(() => Effect.void))

              // Wait for code-server to be ready (poll health)
              yield* log("Waiting for code-server health check")
              yield* docker.exec(cid, ["curl", "-sf", "http://localhost:8080/healthz"]).pipe(
                Effect.retry(Schedule.recurs(30).pipe(Schedule.intersect(Schedule.spaced(Duration.seconds(1))))),
                Effect.tap(() => log("code-server ready")),
                Effect.tapError((e) => log(`Health check failed: ${String(e)}`)),
                Effect.catchAll(() => Effect.void)
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
                    Effect.zipRight(docker.exec(cid, ["code-server", "--install-extension", ext])),
                    Effect.tap((output) => log(`Extension installed: ${ext}${output ? `\n${output.trim()}` : ""}`)),
                    Effect.tapError((e) => log(`Extension failed: ${ext} — ${String(e)}`)),
                    Effect.catchAll(() => Effect.void)
                  ), { discard: true })
              }

              // Run configured setup commands
              if (sandboxCfg.setupCommands.length > 0) {
                yield* log(`Running ${sandboxCfg.setupCommands.length} setup command(s)`)
                yield* Effect.forEach(sandboxCfg.setupCommands, (cmd, i) =>
                  log(`[${i + 1}/${sandboxCfg.setupCommands.length}] ${cmd}`).pipe(
                    Effect.zipRight(docker.exec(cid, ["sh", "-c", cmd])),
                    Effect.tap((output) =>
                      log(`Command done: ${cmd.slice(0, 60)}${output ? `\n${output.trim()}` : ""}`)
                    ),
                    Effect.tapError((e) =>
                      log(`Command failed: ${cmd.slice(0, 60)} — ${String(e)}`)
                    ),
                    Effect.catchAll(() => Effect.void)
                  ), { discard: true })
              }

              yield* updateStatus(id, "running")
              yield* log("Sandbox ready")
            }).pipe(
              Effect.catchAllCause((cause) =>
                Effect.gen(function*() {
                  yield* Effect.logError(`Sandbox ${id} creation failed`, cause)
                  const squashed = Cause.squash(cause)
                  const errorDetail = squashed instanceof Error ? squashed.message : String(squashed)
                  yield* updateStatus(id, "error", { error: errorDetail.slice(0, 500) }).pipe(
                    Effect.catchAll((statusErr) =>
                      Effect.logError("Failed to update sandbox error status", statusErr)
                    )
                  )
                })
              )
            )
          )

          return yield* repo.findById(id)
        }).pipe(
          Effect.mapError((cause) => new SandboxError({ message: "Failed to create sandbox", cause }))
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

          if (row.containerId) {
            const ctx = makeSandboxContext(row)
            yield* plugins.executeHook("onSandboxDestroy", ctx)
            yield* docker.stopContainer(row.containerId).pipe(Effect.catchAll(() => Effect.void))
          }

          yield* updateStatus(id, "stopped")
          yield* Effect.logInfo(`Sandbox ${id} stopped`)
        }).pipe(
          Effect.mapError((cause) => new SandboxError({ sandboxId: id, message: "Failed to stop sandbox", cause }))
        ),

      restart: (id: SandboxId) =>
        Effect.gen(function*() {
          const row = yield* repo.findById(id)
          if (!row.containerId) {
            return yield* Effect.fail(
              new SandboxError({ sandboxId: id, message: "No container to restart" })
            )
          }

          yield* updateStatus(id, "starting")
          yield* progress(id, "Restarting container")
          yield* docker.startContainer(row.containerId)
          yield* updateStatus(id, "starting", row.port ? { port: row.port } : {})
          yield* progress(id, "Waiting for code-server health check")

          yield* docker.exec(row.containerId, ["curl", "-sf", "http://localhost:8080/healthz"]).pipe(
            Effect.retry(
              Schedule.recurs(30).pipe(Schedule.intersect(Schedule.spaced(Duration.seconds(1))))
            ),
            Effect.tap(() => progress(id, "code-server ready")),
            Effect.catchAll(() => Effect.void)
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

          if (row.containerId) {
            yield* docker.removeContainer(row.containerId).pipe(Effect.catchAll(() => Effect.void))
          }

          yield* fs.remove(row.workspacePath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void))
          yield* repo.delete(id)
          yield* Effect.logInfo(`Sandbox ${id} cleaned up`)
        }).pipe(
          Effect.mapError((cause) => new SandboxError({ sandboxId: id, message: "Failed to cleanup sandbox", cause }))
        ),

      reconcile: () =>
        Effect.gen(function*() {
          const active = yield* repo.findActive()
          yield* Effect.forEach(active, (row) =>
            Effect.gen(function*() {
              if (!row.containerId) {
                yield* updateStatus(SandboxId.make(row.id), "error", { error: "Orphaned (no container)" })
                return
              }
              const info = yield* docker.inspectContainer(row.containerId).pipe(
                Effect.catchAll(() => Effect.succeed(null))
              )
              if (!info || !info.State.Running) {
                yield* updateStatus(SandboxId.make(row.id), "stopped")
                yield* Effect.logInfo(`Reconciled orphaned sandbox ${row.id}`)
              }
            }), { discard: true })
        }).pipe(Effect.catchAllCause((cause) => Effect.logWarning("Sandbox reconcile failed", cause))),

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
                  if (row.containerId) {
                    yield* docker.stopContainer(row.containerId).pipe(Effect.catchAll(() => Effect.void))
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
                  if (row.containerId) {
                    yield* docker.removeContainer(row.containerId).pipe(Effect.catchAll(() => Effect.void))
                  }
                  yield* fs.remove(row.workspacePath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void))
                  yield* repo.delete(SandboxId.make(row.id))
                })
              }
              return Effect.void
            },
            { discard: true }
          )
        }).pipe(Effect.catchAllCause((cause) => Effect.logWarning("Sandbox GC failed", cause)))
    } as const
  })
}) {}
