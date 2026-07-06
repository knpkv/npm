/**
 * Docker interaction via `docker` CLI.
 *
 * Shells out to the docker binary — avoids unix socket HTTP complexity.
 *
 * @module
 */
import { Context, Effect, Layer, Schema } from "effect"
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

const ContainerInfoSchema = Schema.Struct({
  Id: Schema.String,
  State: Schema.Struct({
    Status: Schema.String,
    Running: Schema.Boolean
  }),
  NetworkSettings: Schema.Struct({
    Ports: Schema.Record(
      Schema.String,
      Schema.NullOr(Schema.Array(Schema.Struct({ HostPort: Schema.String })))
    )
  })
})

const DockerPsRow = Schema.Struct({
  ID: Schema.String,
  State: Schema.String,
  Labels: Schema.String
})

interface DockerPsContainer {
  readonly Id: string
  readonly State: string
  readonly Labels: Record<string, string>
}

const decodeContainerInfoArray = Schema.decodeUnknownSync(Schema.Array(ContainerInfoSchema))
const decodeDockerPsRow = Schema.decodeUnknownSync(DockerPsRow)
const emptyDockerPsContainers = (): Array<DockerPsContainer> => []

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

  const service = {
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
        dockerError("inspectContainer"),
        Effect.flatMap((output) =>
          Effect.try({
            try: () => {
              const arr = decodeContainerInfoArray(JSON.parse(output))
              if (arr.length === 0) return undefined
              return arr[0]
            },
            catch: (cause) => new DockerError({ operation: "inspectContainer", cause })
          })
        ),
        Effect.flatMap((containerInfo) =>
          containerInfo === undefined
            ? Effect.fail(new DockerError({ operation: "inspectContainer", cause: "Empty inspect result" }))
            : Effect.succeed(containerInfo)
        )
      ),

    exec: (containerId: string, cmd: ReadonlyArray<string>) =>
      docker("exec", containerId, ...cmd).pipe(dockerError("exec")),

    listContainersByLabel: (label: string, value: string) =>
      docker("ps", "-a", "--filter", `label=${label}=${value}`, "--format", "{{json .}}").pipe(
        dockerError("listContainersByLabel"),
        Effect.flatMap((output) =>
          Effect.try({
            try: () => {
              if (!output) return emptyDockerPsContainers()
              return output.split("\n").map((line) => {
                const obj = decodeDockerPsRow(JSON.parse(line))
                return {
                  Id: obj.ID,
                  State: obj.State,
                  Labels: Object.fromEntries(obj.Labels.split(",").map((l) => l.split("=")))
                }
              })
            },
            catch: (cause) => new DockerError({ operation: "listContainersByLabel", cause })
          })
        )
      )
  }
  return service
})

export interface DockerServiceShape extends Success<typeof makeDockerService> {}

export class DockerService extends Context.Service<
  DockerService,
  DockerServiceShape
>()("DockerService") {
  static readonly Default = Layer.effect(DockerService, makeDockerService)
}
