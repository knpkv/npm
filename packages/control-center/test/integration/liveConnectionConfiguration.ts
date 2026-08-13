import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { AtlassianBasicAuthEmail } from "../../src/server/plugins/AtlassianBasicAuth.js"

const RequiredText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
)
const AwsRegion = RequiredText.check(
  Schema.isPattern(/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u, {
    expected: "an AWS region"
  })
)
const AtlassianSiteUrl = RequiredText.check(
  Schema.makeFilter((value) => {
    const decoded = Schema.decodeUnknownResult(Schema.URLFromString)(value)
    if (Result.isFailure(decoded)) return false
    const url = decoded.success
    return (
      url.protocol === "https:" &&
      url.port.length === 0 &&
      url.hostname.endsWith(".atlassian.net") &&
      url.hostname.length > ".atlassian.net".length &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    )
  }, { expected: "an HTTPS Atlassian Cloud site root" })
)
const LiveApiToken = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(16_384),
  Schema.makeFilter((value) => value.trim().length > 0, {
    expected: "a non-whitespace API token"
  })
)
const LiveAtlassianCredentials = Schema.Struct({
  confluenceApiKey: LiveApiToken,
  confluenceEmail: AtlassianBasicAuthEmail,
  jiraApiKey: LiveApiToken,
  jiraEmail: AtlassianBasicAuthEmail
})

const LiveConnectionPublicConfiguration = Schema.Struct({
  activation: Schema.Literal("1"),
  atlassianSiteId: RequiredText,
  atlassianSiteUrl: AtlassianSiteUrl,
  awsRegion: AwsRegion,
  codeCommitRepository: RequiredText,
  codePipelinePipeline: RequiredText,
  confluenceProbePageId: RequiredText,
  confluenceSpaceId: RequiredText,
  jiraProjectId: RequiredText
})

const REQUIRED_VARIABLES: ReadonlyArray<string> = [
  "CONTROL_CENTER_LIVE_INTEGRATION",
  "CONTROL_CENTER_TEST_AWS_REGION",
  "CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY",
  "CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE",
  "CONTROL_CENTER_TEST_ATLASSIAN_SITE_URL",
  "CONTROL_CENTER_TEST_ATLASSIAN_SITE_ID",
  "CONTROL_CENTER_TEST_JIRA_PROJECT_ID",
  "CONTROL_CENTER_TEST_CONFLUENCE_SPACE_ID",
  "CONTROL_CENTER_TEST_CONFLUENCE_PAGE_ID",
  "JIRA_EMAIL",
  "JIRA_API_KEY",
  "CONFLUENCE_EMAIL",
  "CONFLUENCE_API_KEY"
]

/** Secret-safe failure emitted before a live fixture allocates local resources. */
export class LiveConnectionConfigurationError extends Schema.TaggedError<
  LiveConnectionConfigurationError
>()("LiveConnectionConfigurationError", {
  diagnosticCode: Schema.Literal("live-integration-configuration-incomplete"),
  requiredVariables: Schema.Array(Schema.String)
}) {}

/** Complete live-fixture configuration; provider tokens stay redacted until the owner request. */
export interface LiveConnectionConfiguration {
  readonly atlassianSiteId: string
  readonly atlassianSiteUrl: string
  readonly awsRegion: string
  readonly codeCommitRepository: string
  readonly codePipelinePipeline: string
  readonly confluenceApiKey: Redacted.Redacted<string>
  readonly confluenceEmail: string
  readonly confluenceProbePageId: string
  readonly confluenceSpaceId: string
  readonly jiraApiKey: Redacted.Redacted<string>
  readonly jiraEmail: string
  readonly jiraProjectId: string
}

const rawConfiguration = Config.all({
  activation: Config.string("CONTROL_CENTER_LIVE_INTEGRATION"),
  atlassianSiteId: Config.string("CONTROL_CENTER_TEST_ATLASSIAN_SITE_ID"),
  atlassianSiteUrl: Config.string("CONTROL_CENTER_TEST_ATLASSIAN_SITE_URL"),
  awsRegion: Config.string("CONTROL_CENTER_TEST_AWS_REGION"),
  codeCommitRepository: Config.string("CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY"),
  codePipelinePipeline: Config.string("CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE"),
  confluenceApiKey: Config.redacted("CONFLUENCE_API_KEY"),
  confluenceEmail: Config.string("CONFLUENCE_EMAIL"),
  confluenceProbePageId: Config.string("CONTROL_CENTER_TEST_CONFLUENCE_PAGE_ID"),
  confluenceSpaceId: Config.string("CONTROL_CENTER_TEST_CONFLUENCE_SPACE_ID"),
  jiraApiKey: Config.redacted("JIRA_API_KEY"),
  jiraEmail: Config.string("JIRA_EMAIL"),
  jiraProjectId: Config.string("CONTROL_CENTER_TEST_JIRA_PROJECT_ID")
})

const configurationError = () =>
  new LiveConnectionConfigurationError({
    diagnosticCode: "live-integration-configuration-incomplete",
    requiredVariables: [...REQUIRED_VARIABLES]
  })

/** Decode the complete opt-in configuration without retaining rejected values in the error. */
export const loadLiveConnectionConfiguration: Effect.Effect<
  LiveConnectionConfiguration,
  LiveConnectionConfigurationError
> = Effect.gen(function*() {
  const raw = yield* rawConfiguration.pipe(Effect.mapError(configurationError))
  const publicConfiguration = yield* Schema.decodeUnknownEffect(LiveConnectionPublicConfiguration)(
    raw
  ).pipe(Effect.mapError(configurationError))
  const credentials = yield* Schema.decodeUnknownEffect(LiveAtlassianCredentials)({
    confluenceApiKey: Redacted.value(raw.confluenceApiKey),
    confluenceEmail: raw.confluenceEmail,
    jiraApiKey: Redacted.value(raw.jiraApiKey),
    jiraEmail: raw.jiraEmail
  }).pipe(Effect.mapError(configurationError))
  return {
    ...publicConfiguration,
    confluenceApiKey: Redacted.make(credentials.confluenceApiKey),
    confluenceEmail: credentials.confluenceEmail,
    jiraApiKey: Redacted.make(credentials.jiraApiKey),
    jiraEmail: credentials.jiraEmail
  }
})
