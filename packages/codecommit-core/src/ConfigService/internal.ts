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

export const AccountConfig = Schema.Struct({
  profile: AwsProfileName,
  regions: Schema.Array(AwsRegion).pipe(Schema.optionalWith({ default: () => ["us-east-1" as AwsRegion] })),
  enabled: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true }))
})

export type AccountConfig = typeof AccountConfig.Type

export const TuiConfig = Schema.Struct({
  accounts: Schema.Array(AccountConfig),
  autoDetect: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true }))
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
