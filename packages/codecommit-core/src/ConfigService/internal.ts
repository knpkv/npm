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

interface SandboxVolumeMountDefault {
  readonly hostPath: string
  readonly containerPath: string
  readonly readonly: boolean
}

const decodeAwsRegion = Schema.decodeSync(AwsRegion)
const emptyStrings: Array<string> = []
const emptyEnv: Record<string, string> = {}
const emptyVolumeMounts: Array<SandboxVolumeMountDefault> = []
const defaultAccountRegions: Array<AwsRegion> = [decodeAwsRegion("us-east-1")]
export const defaultSandboxImage =
  "codercom/code-server@sha256:b88ed46a6ace76a0294a17a24f39aa88032ed0a3692c3d8ab5433b47ab57ccbf"
const legacyDefaultSandboxImage = "codercom/code-server:latest"

export class DetectedProfile extends Schema.Class<DetectedProfile>("DetectedProfile")({
  name: Schema.NonEmptyString.pipe(Schema.brand("AwsProfileName")),
  region: Schema.optionalKey(AwsRegion)
}) {}

export const SandboxConfig = Schema.Struct({
  image: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(defaultSandboxImage))),
  extensions: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(emptyStrings))),
  setupCommands: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault(emptyStrings))
  ),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault(emptyEnv))
  ),
  volumeMounts: Schema.Array(
    Schema.Struct({
      hostPath: Schema.String,
      containerPath: Schema.String,
      readonly: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(true)))
    })
  ).pipe(
    Schema.withDecodingDefaultTypeKey(
      decodingDefault(emptyVolumeMounts)
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
    Schema.withDecodingDefaultTypeKey(decodingDefault(defaultAccountRegions))
  ),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(true)))
})

export type AccountConfig = typeof AccountConfig.Type

export const ReviewKind = Schema.Literals(["review", "security", "tests", "explain"])
export type ReviewKind = typeof ReviewKind.Type

export const ReviewProfileConfig = Schema.Struct({
  id: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z][a-z0-9-]*$/u)
  ),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(80)),
  kind: ReviewKind,
  skillIds: Schema.Array(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256))
  ).check(Schema.isMaxLength(24), Schema.isUnique())
})

export type ReviewProfileConfig = typeof ReviewProfileConfig.Type

export const defaultReviewProfiles: ReadonlyArray<ReviewProfileConfig> = [
  {
    id: "thorough",
    name: "Thorough review",
    kind: "review",
    skillIds: ["builtin:pr-review", "builtin:pr-review-diff"]
  },
  {
    id: "security",
    name: "Security review",
    kind: "security",
    skillIds: ["builtin:pr-review-diff"]
  },
  {
    id: "tests",
    name: "Test review",
    kind: "tests",
    skillIds: ["builtin:pr-review-diff"]
  },
  {
    id: "explain",
    name: "Explain change",
    kind: "explain",
    skillIds: []
  }
]

export const ReviewConfig = Schema.Struct({
  defaultProfileId: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z][a-z0-9-]*$/u)
  ).pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault("thorough"))
  ),
  profiles: Schema.Array(ReviewProfileConfig).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(12)
  ).pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault(defaultReviewProfiles))
  )
}).check(
  Schema.makeFilter(
    ({ defaultProfileId, profiles }) =>
      new Set(profiles.map(({ id }) => id)).size === profiles.length &&
      profiles.some(({ id }) => id === defaultProfileId),
    { expected: "unique review profile ids containing the default profile" }
  )
)

export type ReviewConfig = typeof ReviewConfig.Type

export const defaultReviewConfig: ReviewConfig = {
  defaultProfileId: "thorough",
  profiles: defaultReviewProfiles
}

export const TuiConfig = Schema.Struct({
  accounts: Schema.Array(AccountConfig),
  autoDetect: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(true))),
  autoRefresh: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(true))),
  refreshIntervalSeconds: Schema.Number.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(300))),
  review: ReviewConfig.pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault(defaultReviewConfig))
  ),
  sandbox: SandboxConfig.pipe(
    Schema.withDecodingDefaultTypeKey(decodingDefault(defaultSandboxConfig))
  )
})

export type TuiConfig = typeof TuiConfig.Type

/** Migrate only the mutable image tag previously emitted by the settings UI. */
export const migrateLegacySandboxImage = (config: TuiConfig): TuiConfig =>
  config.sandbox.image === legacyDefaultSandboxImage
    ? { ...config, sandbox: { ...config.sandbox, image: defaultSandboxImage } }
    : config

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
  review: defaultReviewConfig,
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
