/**
 * Read-only integration tests for Jira issue fetching and Markdown export.
 *
 * Requires:
 * - JIRA_INTEGRATION=1
 * - JIRA_EMAIL
 * - JIRA_API_KEY
 *
 * Optional overrides:
 * - JIRA_BASE_URL defaults to https://knpkv.atlassian.net
 * - JIRA_ISSUE_KEY defaults to KAN-1
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
import { Config, Effect, Layer, Option } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as yaml from "js-yaml"
import { IssueService, layer as IssueServiceLayer, SiteUrl } from "../src/IssueService.js"
import { layer as MarkdownWriterLayer, MarkdownWriter } from "../src/MarkdownWriter.js"

const DEFAULT_BASE_URL = "https://knpkv.atlassian.net"
const DEFAULT_ISSUE_KEY = "KAN-1"

interface IntegrationConfig {
  readonly baseUrl: string
  readonly issueKey: string
  readonly email: string
  readonly apiKey: Redacted.Redacted<string>
}

const envFlagEnabled = (value: string): boolean => ["1", "true", "yes"].includes(value.toLowerCase())

const nonEmptyOrDefault = (value: Option.Option<string>, fallback: string): string =>
  Option.match(value, {
    onNone: () => fallback,
    onSome: (some) => some.trim().length > 0 ? some : fallback
  })

const requireNonEmpty = (name: string, value: string): Effect.Effect<string, Error> =>
  value.trim().length > 0 ? Effect.succeed(value) : Effect.fail(new Error(`${name} must be set`))

const requireNonEmptyRedacted = (
  name: string,
  value: Redacted.Redacted<string>
): Effect.Effect<Redacted.Redacted<string>, Error> =>
  Redacted.value(value).trim().length > 0 ? Effect.succeed(value) : Effect.fail(new Error(`${name} must be set`))

const SHOULD_RUN_INTEGRATION = Effect.runSync(
  Config.option(Config.string("JIRA_INTEGRATION")).pipe(
    Effect.map((enabled) => Option.isSome(enabled) && envFlagEnabled(enabled.value))
  )
)

const readIntegrationConfig = Effect.gen(function*() {
  const baseUrl = yield* Config.option(Config.string("JIRA_BASE_URL"))
  const issueKey = yield* Config.option(Config.string("JIRA_ISSUE_KEY"))
  const email = yield* Config.string("JIRA_EMAIL")
  const apiKey = yield* Config.redacted("JIRA_API_KEY")

  return {
    baseUrl: nonEmptyOrDefault(baseUrl, DEFAULT_BASE_URL).replace(/\/+$/, ""),
    issueKey: nonEmptyOrDefault(issueKey, DEFAULT_ISSUE_KEY),
    email: yield* requireNonEmpty("JIRA_EMAIL", email),
    apiKey: yield* requireNonEmptyRedacted("JIRA_API_KEY", apiKey)
  } satisfies IntegrationConfig
})

const makeIntegrationLayer = (config: IntegrationConfig) => {
  const configLayer = Layer.succeed(JiraApiConfig, {
    baseUrl: config.baseUrl,
    auth: {
      type: "basic",
      email: config.email,
      apiToken: config.apiKey
    } satisfies { readonly type: "basic"; readonly email: string; readonly apiToken: typeof config.apiKey }
  })

  return MarkdownWriterLayer.pipe(
    Layer.provideMerge(IssueServiceLayer),
    Layer.provideMerge(Layer.succeed(SiteUrl, config.baseUrl)),
    Layer.provideMerge(JiraApiClient.layer),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(NodeServices.layer)
  )
}

const makeTempRoot = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped()
})

const joinPath = (...parts: ReadonlyArray<string>) =>
  Path.Path.pipe(
    Effect.map((path) => path.join(...parts))
  )

const readText = (filePath: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(filePath))
  )

const pathExists = (filePath: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(filePath))
  )

const parseFrontMatter = (markdown: string): Record<string, unknown> => {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown)
  const parsed = match?.[1] ? yaml.load(match[1]) : {}
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : {}
}

const getIssueAsMarkdown = (config: IntegrationConfig, testDir: string) =>
  Effect.gen(function*() {
    const issueService = yield* IssueService
    const writer = yield* MarkdownWriter
    const outputDir = yield* joinPath(testDir, "get-output")

    const issue = yield* issueService.getByKey(config.issueKey)
    yield* writer.writeMulti([issue], outputDir)

    expect(issue.key).toBe(config.issueKey)
    expect(issue.url).toBe(`${config.baseUrl}/browse/${config.issueKey}`)
    expect(issue.summary.length).toBeGreaterThan(0)

    const issueFile = yield* joinPath(outputDir, `${config.issueKey}.md`)
    expect(yield* pathExists(issueFile)).toBe(true)

    const markdown = yield* readText(issueFile)
    const frontMatter = parseFrontMatter(markdown)

    expect(frontMatter.key).toBe(config.issueKey)
    expect(frontMatter.url).toBe(`${config.baseUrl}/browse/${config.issueKey}`)
    expect(frontMatter.id).toBe(issue.id)
    expect(frontMatter.summary).toBe(issue.summary)
    expect(typeof frontMatter.status).toBe("string")
    expect(markdown).toContain(`# ${config.issueKey}:`)

    return { frontMatter, issue }
  })

const searchIssueAsSingleMarkdown = (config: IntegrationConfig, testDir: string) =>
  Effect.gen(function*() {
    const issueService = yield* IssueService
    const writer = yield* MarkdownWriter
    const outputDir = yield* joinPath(testDir, "search-output")
    const jql = `issuekey = ${config.issueKey}`

    const issues = yield* issueService.searchAll(jql, { maxResults: 1 })
    expect(issues.map((issue) => issue.key)).toContain(config.issueKey)

    yield* writer.writeSingle(issues, outputDir, jql)

    const exportFile = yield* joinPath(outputDir, "jira-export.md")
    expect(yield* pathExists(exportFile)).toBe(true)

    const markdown = yield* readText(exportFile)
    expect(markdown).toContain("# Jira Export")
    expect(markdown).toContain(`Query: \`${jql}\``)
    expect(markdown).toContain(`## ${config.issueKey}:`)
  })

describe("Jira integration", () => {
  it.effect.skipIf(!SHOULD_RUN_INTEGRATION)(
    "fetches KAN-1 with an API key and exports it as markdown",
    () =>
      Effect.gen(function*() {
        const config = yield* readIntegrationConfig
        return yield* Effect.gen(function*() {
          const testDir = yield* makeTempRoot

          const { frontMatter, issue } = yield* getIssueAsMarkdown(config, testDir)
          yield* searchIssueAsSingleMarkdown(config, testDir)
          expect(frontMatter.key).toBe(issue.key)
        }).pipe(
          Effect.provide(makeIntegrationLayer(config)),
          Effect.scoped
        )
      }),
    120000
  )
})
