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
  exports: Schema.Record(Schema.String, Schema.Unknown),
  main: Schema.String,
  name: Schema.String,
  scripts: Schema.Struct({ start: Schema.String }),
  types: Schema.String,
  version: Schema.String.check(Schema.isPattern(semverPattern))
})

const expectedExports: Readonly<Record<string, { readonly import: string; readonly types: string }>> = {
  ".": { import: "./dist/server/index.js", types: "./dist/server/index.d.ts" },
  "./api": { import: "./dist/server/api/index.js", types: "./dist/server/api/index.d.ts" },
  "./domain": { import: "./dist/server/domain/index.js", types: "./dist/server/domain/index.d.ts" },
  "./server": { import: "./dist/server/server/index.js", types: "./dist/server/server/index.d.ts" }
}

const sameKeys = (record: Readonly<Record<string, unknown>>, expected: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(record).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** Return manifest violations that would weaken the package contract. */
export const inspectPackageContract = (value: unknown): ReadonlyArray<string> => {
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
  if (manifest.engines.node !== ">=24") violations.push("Node 24 or newer must be required")

  const runtimeKeys = [
    "@aws-sdk/credential-providers",
    "@effect/platform-browser",
    "@effect/platform-node",
    "@effect/sql-libsql",
    "@knpkv/ai-claude",
    "@knpkv/ai-codex",
    "@knpkv/codecommit-core",
    "@knpkv/clockify-api-client",
    "@knpkv/confluence-api-client",
    "@knpkv/confluence-to-markdown",
    "@knpkv/control-center-sql",
    "@knpkv/jira-api-client",
    "@knpkv/rly",
    "distilled-aws",
    "effect",
    "react",
    "react-dom",
    "react-router"
  ]
  if (!sameKeys(manifest.dependencies, [...runtimeKeys].sort())) {
    violations.push("runtime dependencies must remain the reviewed set")
  }
  if (manifest.dependencies["@knpkv/rly"] !== "workspace:^") {
    violations.push("@knpkv/rly must use workspace:^")
  }
  if (manifest.dependencies["distilled-aws"] !== "0.1.1") {
    violations.push("distilled-aws must remain on the reviewed CodePipeline client version")
  }
  if (manifest.dependencies["@aws-sdk/credential-providers"] !== "^3.1085.0") {
    violations.push("AWS credential providers must remain on the reviewed runtime version")
  }
  const workspaceDependencies: ReadonlyArray<
    | "@knpkv/ai-claude"
    | "@knpkv/ai-codex"
    | "@knpkv/codecommit-core"
    | "@knpkv/clockify-api-client"
    | "@knpkv/confluence-api-client"
    | "@knpkv/confluence-to-markdown"
    | "@knpkv/jira-api-client"
  > = [
    "@knpkv/ai-claude",
    "@knpkv/ai-codex",
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
  if (manifest.dependencies["@effect/sql-libsql"] !== "4.0.0-beta.98") {
    violations.push("@effect/sql-libsql must align with the pinned Effect beta")
  }
  if (manifest.dependencies["@effect/platform-node"] !== "4.0.0-beta.98") {
    violations.push("@effect/platform-node must align with the pinned Effect beta")
  }
  if (manifest.dependencies["@effect/platform-browser"] !== "4.0.0-beta.98") {
    violations.push("@effect/platform-browser must align with the pinned Effect beta")
  }
  if (manifest.dependencies.effect !== "4.0.0-beta.98") {
    violations.push("effect must align with the pinned Effect beta")
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
