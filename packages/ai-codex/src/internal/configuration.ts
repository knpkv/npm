import { Config, Effect, Option } from "effect"
import type * as AiError from "effect/unstable/ai/AiError"
import type { CodexModelOptions } from "../model.js"
import { configurationFailure, invalidRequest } from "./errors.js"

const DEFAULT_EXECUTABLE = "codex"
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_MAX_STDERR_BYTES = 65_536
const DEFAULT_TIMEOUT = "2 minutes"

const optionalEnvironmentValue = (name: string) => Config.option(Config.string(name))

const reviewedChildEnvironment = Config.all({
  codexAccessToken: optionalEnvironmentValue("CODEX_ACCESS_TOKEN"),
  codexApiKey: optionalEnvironmentValue("CODEX_API_KEY"),
  codexCaCertificate: optionalEnvironmentValue("CODEX_CA_CERTIFICATE"),
  codexHome: optionalEnvironmentValue("CODEX_HOME"),
  codexSqliteHome: optionalEnvironmentValue("CODEX_SQLITE_HOME"),
  home: optionalEnvironmentValue("HOME"),
  path: optionalEnvironmentValue("PATH"),
  rustLog: optionalEnvironmentValue("RUST_LOG"),
  sslCertFile: optionalEnvironmentValue("SSL_CERT_FILE"),
  temp: optionalEnvironmentValue("TEMP"),
  tmp: optionalEnvironmentValue("TMP"),
  tmpdir: optionalEnvironmentValue("TMPDIR"),
  userProfile: optionalEnvironmentValue("USERPROFILE"),
  xdgConfigHome: optionalEnvironmentValue("XDG_CONFIG_HOME")
}).pipe(
  Config.map((configured) => ({
    ...(Option.isSome(configured.codexAccessToken) ? { CODEX_ACCESS_TOKEN: configured.codexAccessToken.value } : {}),
    ...(Option.isSome(configured.codexApiKey) ? { CODEX_API_KEY: configured.codexApiKey.value } : {}),
    ...(Option.isSome(configured.codexCaCertificate)
      ? { CODEX_CA_CERTIFICATE: configured.codexCaCertificate.value }
      : {}),
    ...(Option.isSome(configured.codexHome) ? { CODEX_HOME: configured.codexHome.value } : {}),
    ...(Option.isSome(configured.codexSqliteHome)
      ? { CODEX_SQLITE_HOME: configured.codexSqliteHome.value }
      : {}),
    ...(Option.isSome(configured.home) ? { HOME: configured.home.value } : {}),
    ...(Option.isSome(configured.path) ? { PATH: configured.path.value } : {}),
    ...(Option.isSome(configured.rustLog) ? { RUST_LOG: configured.rustLog.value } : {}),
    ...(Option.isSome(configured.sslCertFile) ? { SSL_CERT_FILE: configured.sslCertFile.value } : {}),
    ...(Option.isSome(configured.temp) ? { TEMP: configured.temp.value } : {}),
    ...(Option.isSome(configured.tmp) ? { TMP: configured.tmp.value } : {}),
    ...(Option.isSome(configured.tmpdir) ? { TMPDIR: configured.tmpdir.value } : {}),
    ...(Option.isSome(configured.userProfile) ? { USERPROFILE: configured.userProfile.value } : {}),
    ...(Option.isSome(configured.xdgConfigHome) ? { XDG_CONFIG_HOME: configured.xdgConfigHome.value } : {})
  }))
)

export interface NormalizedOptions {
  readonly access: "read-only" | "workspace-write"
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly executable: string
  readonly maxOutputBytes: number
  readonly maxStderrBytes: number
  readonly model: string | undefined
  readonly timeout: NonNullable<CodexModelOptions["timeout"]>
}

export const normalizeOptions = (
  options: CodexModelOptions,
  method: string
): Effect.Effect<NormalizedOptions, AiError.AiError> =>
  Effect.gen(function*() {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      return yield* invalidRequest(method, "maxOutputBytes", "must be a positive safe integer")
    }
    if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes <= 0) {
      return yield* invalidRequest(method, "maxStderrBytes", "must be a positive safe integer")
    }
    if (options.cwd.trim().length === 0) {
      return yield* invalidRequest(method, "cwd", "must not be empty")
    }
    return {
      access: options.access ?? "read-only",
      cwd: options.cwd,
      environment: {
        ...yield* reviewedChildEnvironment.pipe(
          Effect.mapError((cause) => configurationFailure(method, cause))
        ),
        ...options.environment
      },
      executable: options.executable ?? DEFAULT_EXECUTABLE,
      maxOutputBytes,
      maxStderrBytes,
      model: options.model,
      timeout: options.timeout ?? DEFAULT_TIMEOUT
    }
  })

export const makeArguments = (
  options: NormalizedOptions,
  schemaFile: string | undefined
): ReadonlyArray<string> => {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    options.access,
    "--skip-git-repo-check"
  ]
  if (options.model !== undefined) args.push("--model", options.model)
  if (schemaFile !== undefined) args.push("--output-schema", schemaFile)
  args.push("-")
  return args
}
