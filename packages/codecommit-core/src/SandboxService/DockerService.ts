/**
 * Docker interaction via `docker` CLI.
 *
 * Shells out to the docker binary — avoids unix socket HTTP complexity.
 *
 * @module
 */
import { Context, Effect, Layer, Predicate, Schema, Stream } from "effect"
import type { Success } from "effect/Effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { DockerError } from "../Errors.js"

export interface ContainerConfig {
  readonly Image: string
  readonly Cmd: ReadonlyArray<string>
  readonly User?: string
  readonly ExposedPorts: Record<string, Record<string, never>>
  readonly HostConfig: {
    readonly Binds: ReadonlyArray<string>
    readonly PortBindings: Record<string, ReadonlyArray<{ HostIp: string; HostPort: string }>>
    readonly NetworkMode?: string
    readonly CapDrop?: ReadonlyArray<string>
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

/** Docker's inspect command reports a missing container with this exact stderr shape. */
export const isMissingContainerError = (error: DockerError): boolean => {
  if (!Predicate.isString(error.operation) || error.operation !== "inspectContainer") return false
  const cause = error.cause
  const message = Predicate.isString(cause)
    ? cause
    : Predicate.isError(cause)
    ? cause.message
    : undefined
  return message !== undefined && /^Error:\s+No such (?:object|container):\s+\S+/u.test(message.trim())
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

export const renderDockerPortBinding = (
  containerPort: string,
  binding: { readonly HostIp: string; readonly HostPort: string }
): string => `${binding.HostIp}:${binding.HostPort}:${containerPort.replace("/tcp", "")}`

const makeDockerService = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const docker = (...args: Array<string>) =>
    spawner.string(ChildProcess.make("sh", ["-c", `docker ${args.map(shellEscape).join(" ")} 2>&1`]))
  const dockerWithInput = (input: string, ...args: Array<string>) =>
    spawner.string(
      ChildProcess.make("sh", ["-c", `docker ${args.map(shellEscape).join(" ")} 2>&1`], {
        stdin: {
          stream: Stream.make(input).pipe(Stream.encodeText),
          endOnDone: true
        }
      })
    )

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
          args.push("-p", renderDockerPortBinding(containerPort, b))
        }
      }

      // Volume binds
      for (const bind of config.HostConfig.Binds) {
        args.push("-v", bind)
      }

      // Network mode
      if (config.HostConfig.NetworkMode !== undefined) {
        args.push("--network", config.HostConfig.NetworkMode)
      }

      for (const capability of config.HostConfig.CapDrop ?? []) {
        args.push("--cap-drop", capability)
      }

      if (config.User !== undefined) {
        args.push("--user", config.User)
      }

      // Keep environment values, including the generated access password, out
      // of process arguments. Docker reads the protected parent-child pipe.
      const environment = config.Env ?? []
      if (environment.length > 0) args.push("--env-file", "/dev/stdin")

      // Labels
      for (const [k, v] of Object.entries(config.Labels ?? {})) {
        args.push("-l", `${k}=${v}`)
      }

      // Image + command
      args.push(config.Image)
      for (const c of config.Cmd) args.push(c)

      return (environment.length > 0
        ? dockerWithInput(`${environment.join("\n")}\n`, ...args)
        : docker(...args)).pipe(dockerError("createContainer"))
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
              if (output.length === 0) return emptyDockerPsContainers()
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

export interface DockerServiceContract extends Success<typeof makeDockerService> {}

export class DockerService extends Context.Service<
  DockerService,
  DockerServiceContract
>()("DockerService") {
  static readonly Default = Layer.effect(DockerService, makeDockerService)
}
