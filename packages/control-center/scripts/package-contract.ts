import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const ExportTargetSchema = Schema.Struct({
  import: Schema.String,
  types: Schema.String
})

const PackageManifestSchema = Schema.Struct({
  bin: Schema.Struct({ "control-center": Schema.String }),
  dependencies: Schema.Record(Schema.String, Schema.String),
  engines: Schema.Struct({ node: Schema.String }),
  exports: Schema.Record(Schema.String, Schema.Json),
  main: Schema.String,
  name: Schema.String,
  scripts: Schema.Struct({ start: Schema.String }),
  types: Schema.String,
  version: Schema.String.check(Schema.isPattern(semverPattern))
})

const expectedExports = {
  ".": { import: "./dist/server/index.js", types: "./dist/server/index.d.ts" },
  "./api": { import: "./dist/server/api/index.js", types: "./dist/server/api/index.d.ts" },
  "./domain": { import: "./dist/server/domain/index.js", types: "./dist/server/domain/index.d.ts" },
  "./server": { import: "./dist/server/server/index.js", types: "./dist/server/server/index.d.ts" }
} satisfies Readonly<Record<string, { readonly import: string; readonly types: string }>>

const sameKeys = (record: Readonly<Record<string, Schema.Json>>, expected: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(record).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** Return manifest violations that would weaken the package contract. */
export const inspectPackageContract = <UnparsedInput>(value: UnparsedInput): ReadonlyArray<string> => {
  const decoded = Schema.decodeUnknownResult(PackageManifestSchema)(value)
  if (Result.isFailure(decoded)) return ["package manifest does not match its required structure"]

  const manifest = decoded.success
  const violations: Array<string> = []
  if (manifest.bin["control-center"] !== "./dist/server/server/cli.js") {
    violations.push("control-center bin must reference the built server CLI")
  }
  if (manifest.name !== "@knpkv/control-center") violations.push("package name must be @knpkv/control-center")
  if (manifest.scripts.start !== "node ./dist/server/server/cli.js") {
    violations.push("start must forward arguments to the built server CLI")
  }
  if (manifest.main !== "./dist/server/index.js") violations.push("main must reference the browser-safe root entry")
  if (manifest.types !== "./dist/server/index.d.ts") violations.push("types must reference the root declaration")
  if (manifest.engines.node !== ">=26") violations.push("Node 26 or newer must be required")

  const runtimeKeys = [
    "@aws-sdk/client-codepipeline",
    "@aws-sdk/credential-providers",
    "@effect/ai-openai-compat",
    "@effect/platform-browser",
    "@effect/platform-node",
    "@effect/sql-libsql",
    "@knpkv/ai-claude",
    "@knpkv/ai-codex",
    "@knpkv/ai-runtime",
    "@knpkv/atlassian-common",
    "@knpkv/codecommit-core",
    "@knpkv/clockify-api-client",
    "@knpkv/confluence-api-client",
    "@knpkv/confluence-to-markdown",
    "@knpkv/control-center-sql",
    "@knpkv/jira-api-client",
    "@knpkv/rly",
    "@distilled.cloud/aws",
    "effect",
    "react",
    "react-dom",
    "react-markdown",
    "react-router",
    "remark-gfm"
  ]
  if (!sameKeys(manifest.dependencies, [...runtimeKeys].sort())) {
    violations.push("runtime dependencies must remain the reviewed set")
  }
  if (manifest.dependencies["@knpkv/rly"] !== "workspace:^") {
    violations.push("@knpkv/rly must use workspace:^")
  }
  if (manifest.dependencies["@distilled.cloud/aws"] !== "1.0.0-rc.4") {
    violations.push("@distilled.cloud/aws must remain on the reviewed CodePipeline client version")
  }
  if (manifest.dependencies["@aws-sdk/client-codepipeline"] !== "^3.1108.0") {
    violations.push("AWS CodePipeline client must remain on the reviewed runtime version")
  }
  if (manifest.dependencies["@aws-sdk/credential-providers"] !== "^3.1108.0") {
    violations.push("AWS credential providers must remain on the reviewed runtime version")
  }
  const workspaceDependencies: ReadonlyArray<
    | "@knpkv/ai-claude"
    | "@knpkv/ai-codex"
    | "@knpkv/ai-runtime"
    | "@knpkv/atlassian-common"
    | "@knpkv/codecommit-core"
    | "@knpkv/clockify-api-client"
    | "@knpkv/confluence-api-client"
    | "@knpkv/confluence-to-markdown"
    | "@knpkv/jira-api-client"
  > = [
    "@knpkv/ai-claude",
    "@knpkv/ai-codex",
    "@knpkv/ai-runtime",
    "@knpkv/atlassian-common",
    "@knpkv/codecommit-core",
    "@knpkv/clockify-api-client",
    "@knpkv/confluence-api-client",
    "@knpkv/confluence-to-markdown",
    "@knpkv/jira-api-client"
  ]
  for (const dependency of workspaceDependencies) {
    if (manifest.dependencies[dependency] !== "workspace:^") {
      violations.push(`${dependency} must use workspace:^`)
    }
  }
  if (manifest.dependencies["@knpkv/control-center-sql"] !== "workspace:^") {
    violations.push("@knpkv/control-center-sql must use workspace:^")
  }
  if (manifest.dependencies["@effect/sql-libsql"] !== "4.0.0-rc.109") {
    violations.push("@effect/sql-libsql must align with the pinned Effect RC")
  }
  if (manifest.dependencies["@effect/ai-openai-compat"] !== "4.0.0-rc.109") {
    violations.push("@effect/ai-openai-compat must align with the pinned Effect RC")
  }
  if (manifest.dependencies["@effect/platform-node"] !== "4.0.0-rc.109") {
    violations.push("@effect/platform-node must align with the pinned Effect RC")
  }
  if (manifest.dependencies["@effect/platform-browser"] !== "4.0.0-rc.109") {
    violations.push("@effect/platform-browser must align with the pinned Effect RC")
  }
  if (manifest.dependencies.effect !== "4.0.0-rc.109") {
    violations.push("effect must align with the pinned Effect RC")
  }

  const expectedKeys = Object.keys(expectedExports).sort()
  if (!sameKeys(manifest.exports, expectedKeys)) {
    violations.push("package exports must contain only ., ./api, ./domain, ./server")
  }
  for (const [entry, expected] of Object.entries(expectedExports)) {
    const actual = Schema.decodeUnknownResult(ExportTargetSchema)(manifest.exports[entry])
    if (
      Result.isFailure(actual) ||
      actual.success.import !== expected.import ||
      actual.success.types !== expected.types
    ) {
      violations.push(`invalid ${entry} export target`)
    }
  }
  return violations
}
