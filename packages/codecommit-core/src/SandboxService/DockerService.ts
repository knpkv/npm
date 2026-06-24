/**
 * Docker interaction via `docker` CLI.
 *
 * Shells out to the docker binary — avoids unix socket HTTP complexity.
 *
 * @module
 */
import { Context, Effect, Layer } from "effect"
import type { Success } from "effect/Effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { DockerError } from "../Errors.js"

export interface ContainerConfig {
  readonly Image: string
  readonly Cmd: ReadonlyArray<string>
  readonly ExposedPorts: Record<string, Record<string, never>>
  readonly HostConfig: {
    readonly Binds: ReadonlyArray<string>
    readonly PortBindings: Record<string, ReadonlyArray<{ HostPort: string }>>
    readonly NetworkMode?: string
  }
  readonly Env?: ReadonlyArray<string>
  readonly Labels?: Record<string, string>
}

export interface ContainerInfo {
  readonly Id: string
  readonly State: {
    readonly Status: string
    readonly Running: boolean
  }
  readonly NetworkSettings: {
    readonly Ports: Record<string, ReadonlyArray<{ HostPort: string }> | null>
  }
}

const dockerError = (operation: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new DockerError({ operation, cause })),
    Effect.withSpan(`DockerService.${operation}`)
  )

const shellEscape = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

const makeDockerService = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const docker = (...args: Array<string>) =>
    spawner.string(ChildProcess.make("sh", ["-c", `docker ${args.map(shellEscape).join(" ")} 2>&1`]))

  return {
    isAvailable: () =>
      docker("info").pipe(
        Effect.map(() => true),
        Effect.catchIf(() => true, () => Effect.succeed(false))
      ),

    pullImage: (image: string) => docker("pull", image).pipe(Effect.asVoid, dockerError("pullImage")),

    createContainer: (config: ContainerConfig) => {
      const args: Array<string> = ["create"]

      // Port bindings
      for (const [containerPort, bindings] of Object.entries(config.HostConfig.PortBindings)) {
        for (const b of bindings) {
          args.push("-p", `${b.HostPort}:${containerPort.replace("/tcp", "")}`)
        }
      }

      // Volume binds
      for (const bind of config.HostConfig.Binds) {
        args.push("-v", bind)
      }

      // Network mode
      if (config.HostConfig.NetworkMode) {
        args.push("--network", config.HostConfig.NetworkMode)
      }

      // Env vars
      for (const env of config.Env ?? []) {
        args.push("-e", env)
      }

      // Labels
      for (const [k, v] of Object.entries(config.Labels ?? {})) {
        args.push("-l", `${k}=${v}`)
      }

      // Image + command
      args.push(config.Image)
      for (const c of config.Cmd) args.push(c)

      return docker(...args).pipe(dockerError("createContainer"))
    },

    startContainer: (containerId: string) =>
      docker("start", containerId).pipe(Effect.asVoid, dockerError("startContainer")),

    stopContainer: (containerId: string, timeout = 10) =>
      docker("stop", "-t", String(timeout), containerId).pipe(Effect.asVoid, dockerError("stopContainer")),

    removeContainer: (containerId: string) =>
      docker("rm", "-f", containerId).pipe(Effect.asVoid, dockerError("removeContainer")),

    inspectContainer: (containerId: string) =>
      docker("inspect", containerId).pipe(
        Effect.flatMap((output) =>
          Effect.try({
            try: () => {
              const arr = JSON.parse(output) as Array<ContainerInfo>
              if (arr.length === 0) throw new Error("Empty inspect result")
              return arr[0]!
            },
            catch: (e) => e
          })
        ),
        dockerError("inspectContainer")
      ),

    exec: (containerId: string, cmd: ReadonlyArray<string>) =>
      docker("exec", containerId, ...cmd).pipe(dockerError("exec")),

    listContainersByLabel: (label: string, value: string) =>
      docker("ps", "-a", "--filter", `label=${label}=${value}`, "--format", "{{json .}}").pipe(
        Effect.flatMap((output) =>
          Effect.try({
            try: () => {
              if (!output) return [] as Array<{ Id: string; State: string; Labels: Record<string, string> }>
              return output.split("\n").map((line) => {
                const obj = JSON.parse(line) as { ID: string; State: string; Labels: string }
                return {
                  Id: obj.ID,
                  State: obj.State,
                  Labels: Object.fromEntries(obj.Labels.split(",").map((l) => l.split("=")))
                }
              })
            },
            catch: (e) => e
          })
        ),
        dockerError("listContainersByLabel")
      )
  } as const
})

export interface DockerServiceShape extends Success<typeof makeDockerService> {}

export class DockerService extends Context.Service<
  DockerService,
  DockerServiceShape
>()("DockerService") {
  static readonly Default = Layer.effect(DockerService, makeDockerService)
}
