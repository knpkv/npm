import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Redacted, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Spawner from "effect/process/ChildProcessSpawner"
import { makeAwsNuke } from "../src/aws.js"
import type { PoolSession } from "../src/index.js"

const session: PoolSession = {
  accessKeyId: "ASIAPOOLSESSION",
  secretAccessKey: Redacted.make("pool-secret"),
  sessionToken: Redacted.make("pool-token")
}

interface Spawned {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Record<string, string | undefined> | undefined
  readonly extendEnv: boolean | undefined
}

/** A spawner whose child prints `output` and exits with `exitCode`, recording each command. */
const spawner = (output: string, exitCode: number, spawned: Array<Spawned>) =>
  Effect.provideService(
    ChildProcessSpawner,
    Spawner.make((command) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("unexpected pipeline")
        spawned.push({
          command: command.command,
          args: command.args,
          env: command.options.env,
          extendEnv: command.options.extendEnv
        })
        const bytes = Stream.make(new TextEncoder().encode(output))
        return Spawner.makeHandle({
          pid: Spawner.ProcessId(1),
          exitCode: Effect.succeed(Spawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          unref: Effect.succeed(Effect.void),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: bytes,
          stderr: Stream.empty,
          all: bytes,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty
        })
      })
    )
  )

interface Written {
  readonly op: string
  readonly path: string
  readonly mode: number | undefined
  readonly data?: string
}

const files = (written: Array<Written>) =>
  Effect.provideService(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      makeDirectory: (path, options) =>
        Effect.sync(() => void written.push({ op: "mkdir", path, mode: options?.mode })),
      writeFileString: (path, data, options) =>
        Effect.sync(() => void written.push({ op: `write ${options?.flag}`, path, mode: options?.mode, data })),
      remove: (path) => Effect.sync(() => void written.push({ op: "remove", path, mode: undefined })),
      rename: (from, to) =>
        Effect.sync(() => void written.push({ op: `rename to ${to}`, path: from, mode: undefined })),
      chmod: (path, mode) => Effect.sync(() => void written.push({ op: "chmod", path, mode }))
    })
  )

const nuke = makeAwsNuke({
  binary: "/opt/aws-nuke",
  configDirectory: "/state/nuke",
  environment: { PATH: "/bin", HOME: "/home/pool" }
}).pipe(Effect.orDie)

layer(Path.layer)("aws-nuke runner", (it) => {
  it.effect("writes each account's config owner-only through a fresh file renamed into place", () => {
    const written: Array<Written> = []
    return nuke.pipe(
      Effect.flatMap((runner) => runner.writeConfig("222222222222", "{\"regions\":[]}")),
      Effect.map((path) => {
        expect(path).toBe("/state/nuke/222222222222.json")
        expect(written).toEqual([
          { op: "mkdir", path: "/state/nuke", mode: 0o700 },
          { op: "chmod", path: "/state/nuke", mode: 0o700 },
          { op: "remove", path: "/state/nuke/222222222222.json.tmp", mode: undefined },
          { op: "write wx", path: "/state/nuke/222222222222.json.tmp", mode: 0o600, data: "{\"regions\":[]}" },
          { op: "rename to /state/nuke/222222222222.json", path: "/state/nuke/222222222222.json.tmp", mode: undefined }
        ])
      }),
      files(written),
      spawner("", 0, [])
    )
  })

  it.effect("refuses a config name that is not an account id, writing nothing", () => {
    const written: Array<Written> = []
    return nuke.pipe(
      Effect.flatMap((runner) => runner.writeConfig("../escape", "{}")),
      Effect.flip,
      Effect.map((failure) => {
        expect([failure.step, failure.detail]).toEqual(["write nuke config", "not an account id"])
        expect(written).toEqual([])
      }),
      files(written),
      spawner("", 0, [])
    )
  })

  it.effect("runs the binary with the session and the given environment only, dry unless live", () => {
    const spawned: Array<Spawned> = []
    return Effect.gen(function*() {
      const runner = yield* nuke
      const dry = yield* runner.run({ configPath: "/state/nuke/2.json", session, live: false })
      yield* runner.run({ configPath: "/state/nuke/2.json", session, live: true })
      expect(dry).toEqual({ exitCode: 3, output: "Scan complete: 1 total, 0 nukeable, 1 filtered" })
      expect(spawned.map(({ args, command }) => [command, args.at(2), args.includes("--no-dry-run")])).toEqual([
        ["/opt/aws-nuke", "/state/nuke/2.json", false],
        ["/opt/aws-nuke", "/state/nuke/2.json", true]
      ])
      expect(spawned[0]?.extendEnv).toBe(false)
      expect(spawned[0]?.env).toEqual({
        PATH: "/bin",
        HOME: "/home/pool",
        AWS_ACCESS_KEY_ID: "ASIAPOOLSESSION",
        AWS_SECRET_ACCESS_KEY: "pool-secret",
        AWS_SESSION_TOKEN: "pool-token"
      })
    }).pipe(
      files([]),
      spawner("Scan complete: 1 total, 0 nukeable, 1 filtered", 3, spawned)
    )
  })

  it.effect("refuses an environment carrying any AWS variable, in any case, at make", () =>
    makeAwsNuke({
      binary: "/opt/aws-nuke",
      configDirectory: "/state/nuke",
      environment: { PATH: "/bin", AWS_PROFILE: "management", aws_config_file: "/x", AWS_ROLE_ARN: "arn" }
    }).pipe(
      Effect.flip,
      Effect.map((refused) => {
        expect(refused._tag).toBe("AwsNukeEnvironmentRefused")
        expect(refused.names).toEqual(["AWS_PROFILE", "aws_config_file", "AWS_ROLE_ARN"])
      }),
      files([]),
      spawner("", 0, [])
    ))
})
