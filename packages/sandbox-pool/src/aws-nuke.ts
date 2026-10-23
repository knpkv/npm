import { Effect, FileSystem, Path, Redacted, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Nuke, nukeArgs, type PoolSession, ResetBlocked } from "./reset.js"

export interface AwsNukeOptions {
  /** The aws-nuke binary, by absolute path. */
  readonly binary: string
  /** Where configs are written, one per account. Created owner-only. */
  readonly configDirectory: string
  /** Variables aws-nuke gets besides the session; nothing else from the host's environment reaches it. */
  readonly environment?: Readonly<Record<string, string>>
}

const accountIdPattern = /^\d{12}$/

/**
 * `environment` named AWS variables. Any of them (a profile, a config file, a role, a container endpoint) can
 * outrank the pool session in aws-nuke's credential chain and point the run at another account.
 */
export class AwsNukeEnvironmentRefused extends Schema.TaggedError<AwsNukeEnvironmentRefused>()(
  "AwsNukeEnvironmentRefused",
  { names: Schema.Array(Schema.String) }
) {}

/**
 * A `Nuke` that runs the aws-nuke binary. Configs are written owner-only (directory 0700, file 0600), named by
 * account id, each written fresh and renamed into place. `environment` may carry no AWS variable. A run sees
 * only `environment` and the pool account's session, never the host's own credentials,
 * and is a dry run unless `live`. Output is returned whole: the reset's guard reads every removal line.
 */
export const makeAwsNuke = Effect.fn("AwsNuke.make")(function*(options: AwsNukeOptions) {
  // Environment names are case-insensitive on Windows, so `aws_profile` counts too.
  const awsNames = Object.keys(options.environment ?? {}).filter((name) => name.toUpperCase().startsWith("AWS_"))
  if (awsNames.length > 0) return yield* new AwsNukeEnvironmentRefused({ names: awsNames })
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner
  const blocked = (step: string) => (error: { readonly message: string }) =>
    new ResetBlocked({ step, detail: error.message })
  return Nuke.of({
    writeConfig: (accountId, config) => {
      if (!accountIdPattern.test(accountId)) {
        return Effect.fail(new ResetBlocked({ step: "write nuke config", detail: "not an account id" }))
      }
      const file = path.join(options.configDirectory, `${accountId}.json`)
      return Effect.gen(function*() {
        yield* fs.makeDirectory(options.configDirectory, { recursive: true, mode: 0o700 })
        // An existing directory keeps its mode through makeDirectory; narrow it.
        yield* fs.chmod(options.configDirectory, 0o700)
        // A fresh file gets its mode on create, and rename replaces whatever sits at `file`, a link included.
        const fresh = `${file}.tmp`
        yield* fs.remove(fresh, { force: true })
        yield* fs.writeFileString(fresh, config, { mode: 0o600, flag: "wx" })
        yield* fs.rename(fresh, file)
        return file
      }).pipe(Effect.mapError(blocked("write nuke config")), Effect.withSpan("AwsNuke.writeConfig"))
    },
    run: (input: { readonly configPath: string; readonly session: PoolSession; readonly live: boolean }) =>
      Effect.scoped(
        Effect.gen(function*() {
          const handle = yield* spawner.spawn(
            ChildProcess.make(options.binary, nukeArgs(input.configPath, input.live), {
              extendEnv: false,
              env: {
                ...options.environment,
                AWS_ACCESS_KEY_ID: input.session.accessKeyId,
                AWS_SECRET_ACCESS_KEY: Redacted.value(input.session.secretAccessKey),
                AWS_SESSION_TOKEN: Redacted.value(input.session.sessionToken)
              }
            })
          )
          const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString)
          const exitCode = yield* handle.exitCode
          return { exitCode: Number(exitCode), output }
        })
      ).pipe(
        Effect.mapError(blocked("spawn aws-nuke")),
        Effect.withSpan("AwsNuke.run", { attributes: { live: input.live } })
      )
  })
})
