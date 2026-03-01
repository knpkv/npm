/**
 * @internal
 */
import type { Effect } from "effect"
import { Array as Arr, Context, Either, pipe, Schema } from "effect"
import { AwsProfileName, AwsRegion } from "../Domain.js"
import type { ConfigError, ProfileDetectionError } from "../Errors.js"

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export class DetectedProfile extends Schema.Class<DetectedProfile>("DetectedProfile")({
  name: AwsProfileName.pipe(Schema.nonEmptyString()),
  region: Schema.optionalWith(AwsRegion, { exact: true })
}) {}

export const SandboxConfig = Schema.Struct({
  image: Schema.String.pipe(Schema.optionalWith({ default: () => "codercom/code-server:latest" })),
  extensions: Schema.Array(Schema.String).pipe(Schema.optionalWith({ default: () => [] as Array<string> })),
  setupCommands: Schema.Array(Schema.String).pipe(Schema.optionalWith({ default: () => [] as Array<string> })),
  env: Schema.Record({ key: Schema.String, value: Schema.String }).pipe(
    Schema.optionalWith({ default: () => ({}) as Record<string, string> })
  ),
  enableClaudeCode: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true })),
  volumeMounts: Schema.Array(
    Schema.Struct({
      hostPath: Schema.String,
      containerPath: Schema.String,
      readonly: Schema.Boolean.pipe(Schema.optionalWith({ default: () => false }))
    })
  ).pipe(
    Schema.optionalWith({ default: () => [] as Array<{ hostPath: string; containerPath: string; readonly: boolean }> })
  ),
  cloneDepth: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(0),
    Schema.optionalWith({ default: () => 0 })
  )
})

export type SandboxConfig = typeof SandboxConfig.Type

export const defaultSandboxConfig = Schema.decodeSync(SandboxConfig)({})

export const AccountConfig = Schema.Struct({
  profile: AwsProfileName,
  regions: Schema.Array(AwsRegion).pipe(Schema.optionalWith({ default: () => ["us-east-1" as AwsRegion] })),
  enabled: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true }))
})

export type AccountConfig = typeof AccountConfig.Type

export const TuiConfig = Schema.Struct({
  accounts: Schema.Array(AccountConfig),
  autoDetect: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true })),
  autoRefresh: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true })),
  refreshIntervalSeconds: Schema.Number.pipe(Schema.optionalWith({ default: () => 300 })),
  sandbox: SandboxConfig.pipe(Schema.optionalWith({ default: () => Schema.decodeSync(SandboxConfig)({}) }))
})

export type TuiConfig = typeof TuiConfig.Type

// ---------------------------------------------------------------------------
// INI Parsing (Schema-validated)
// ---------------------------------------------------------------------------

const decodeDetectedProfile = Schema.decodeUnknownEither(DetectedProfile)

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
    Arr.filterMap((section) => Either.getRight(decodeDetectedProfile(section))),
    Arr.dedupeWith((a, b) => a.name === b.name)
  )

// ---------------------------------------------------------------------------
// Internal service: resolved config paths
// ---------------------------------------------------------------------------

export class ConfigPaths extends Context.Tag("@knpkv/codecommit-core/ConfigPaths")<
  ConfigPaths,
  {
    readonly configPath: Effect.Effect<string, ConfigError>
    readonly homePath: Effect.Effect<string, ProfileDetectionError>
  }
>() {}
