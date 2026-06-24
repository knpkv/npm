/**
 * @internal
 */
import { Array as Arr, Context, Effect, Option, pipe, Schema } from "effect"
import { AwsProfileName, AwsRegion } from "../Domain.js"
import type { ConfigError, ProfileDetectionError } from "../Errors.js"

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const decodingDefault = <A>(value: A): Effect.Effect<A, Schema.SchemaError, never> => Effect.succeed(value)

export class DetectedProfile extends Schema.Class<DetectedProfile>("DetectedProfile")({
  name: Schema.NonEmptyString.pipe(Schema.brand("AwsProfileName")),
  region: Schema.optionalKey(AwsRegion)
}) {}

export const SandboxConfig = Schema.Struct({
  image: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault("codercom/code-server:latest"))),
  extensions: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(decodingDefault([] as Array<string>))),
  setupCommands: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault([] as Array<string>))
  ),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault({} as Record<string, string>))
  ),
  volumeMounts: Schema.Array(
    Schema.Struct({
      hostPath: Schema.String,
      containerPath: Schema.String,
      readonly: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(false)))
    })
  ).pipe(
    Schema.withDecodingDefaultTypeKey(
      decodingDefault([] as Array<{ hostPath: string; containerPath: string; readonly: boolean }>)
    )
  ),
  cloneDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault(0))
  )
})

export type SandboxConfig = typeof SandboxConfig.Type

export const defaultSandboxConfig: SandboxConfig = Schema.decodeSync(SandboxConfig)({})

export const AccountConfig = Schema.Struct({
  profile: AwsProfileName,
  regions: Schema.Array(AwsRegion).pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault(["us-east-1" as AwsRegion]))
  ),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(true)))
})

export type AccountConfig = typeof AccountConfig.Type

export const TuiConfig = Schema.Struct({
  accounts: Schema.Array(AccountConfig),
  autoDetect: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(true))),
  autoRefresh: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(true))),
  refreshIntervalSeconds: Schema.Number.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(300))),
  sandbox: SandboxConfig.pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault(defaultSandboxConfig))
  )
})

export type TuiConfig = typeof TuiConfig.Type

export const accountsFromDetected = (detected: ReadonlyArray<DetectedProfile>): TuiConfig["accounts"] =>
  detected.map((profile) => ({
    profile: profile.name,
    regions: profile.region ? [profile.region] : [],
    enabled: false
  }))

export const makeDefaultConfig = (detected: ReadonlyArray<DetectedProfile> = []): TuiConfig => ({
  accounts: accountsFromDetected(detected),
  autoDetect: true,
  autoRefresh: true,
  refreshIntervalSeconds: 300,
  sandbox: defaultSandboxConfig
})

// ---------------------------------------------------------------------------
// INI Parsing (Schema-validated)
// ---------------------------------------------------------------------------

const decodeDetectedProfile = Schema.decodeUnknownOption(DetectedProfile)

interface RawSection {
  readonly name: string
  readonly region?: string
}

const parseIniSections = (content: string): Array<RawSection> => {
  const lines = content.split("\n")
  const sections: Array<RawSection> = []
  let current: { name: string; region?: string } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue

    const profileMatch = trimmed.match(/^\[(?:profile\s+)?(.+)\]$/)
    if (profileMatch?.[1]) {
      if (current) sections.push(current)
      current = { name: profileMatch[1].trim() }
    } else if (current && trimmed.includes("=")) {
      const [key, ...valueParts] = trimmed.split("=")
      if (key?.trim().toLowerCase() === "region") {
        current.region = valueParts.join("=").trim()
      }
    }
  }
  if (current) sections.push(current)
  return sections
}

export const parseAwsConfig = (content: string): ReadonlyArray<DetectedProfile> =>
  pipe(
    parseIniSections(content),
    Arr.map((section) => decodeDetectedProfile(section)),
    Arr.filter(Option.isSome),
    Arr.map((profile) => profile.value),
    Arr.dedupeWith((a, b) => a.name === b.name)
  )

// ---------------------------------------------------------------------------
// Internal service: resolved config paths
// ---------------------------------------------------------------------------

export class ConfigPaths extends Context.Service<
  ConfigPaths,
  {
    readonly configPath: Effect.Effect<string, ConfigError>
    readonly homePath: Effect.Effect<string, ProfileDetectionError>
  }
>()("@knpkv/codecommit-core/ConfigPaths") {}
