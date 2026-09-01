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

/** Docker reports an absent inspect/stop target with one of these exact stderr shapes. */
export const isMissingContainerError = (error: DockerError): boolean => {
  if (
    !Predicate.isString(error.operation) ||
    (error.operation !== "inspectContainer" && error.operation !== "stopContainer")
  ) return false
  const cause = error.cause
  const message = Predicate.isString(cause)
    ? cause
    : Predicate.isError(cause)
    ? cause.message
    : undefined
  return message !== undefined &&
    /^(?:Error:\s+|Error response from daemon:\s+)No such (?:object|container):\s+\S+/u.test(
      message.trim()
    )
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
  const dockerWithResult = (...args: Array<string>) =>
    Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(
          ChildProcess.make("sh", ["-c", `docker ${args.map(shellEscape).join(" ")} 2>&1`])
        )
        const output = yield* Stream.mkString(Stream.decodeText(handle.stdout))
        const exitCode = yield* handle.exitCode
        return { output, exitCode }
      })
    )
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
      Effect.gen(function*() {
        const result = yield* dockerWithResult("inspect", containerId).pipe(
          Effect.mapError((cause) => new DockerError({ operation: "inspectContainer", cause }))
        )
        if (Number(result.exitCode) !== 0) {
          return yield* new DockerError({
            operation: "inspectContainer",
            cause: result.output.trim() || `docker inspect exited with code ${String(result.exitCode)}`
          })
        }
        const arr = yield* Effect.try({
          try: () => decodeContainerInfoArray(JSON.parse(result.output)),
          catch: (cause) => new DockerError({ operation: "inspectContainer", cause })
        })
        const containerInfo = arr[0]
        return containerInfo === undefined
          ? yield* new DockerError({ operation: "inspectContainer", cause: "Empty inspect result" })
          : containerInfo
      }),

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
