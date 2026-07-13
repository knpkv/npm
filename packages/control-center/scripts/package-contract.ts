const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

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

/** Return manifest violations that would weaken the initial package contract. */
export const inspectPackageContract = (value: unknown): ReadonlyArray<string> => {
  if (!isRecord(value)) return ["package manifest must be an object"]
  const violations: Array<string> = []
  if (value.name !== "@knpkv/control-center") violations.push("package name must be @knpkv/control-center")
  if (value.version !== "0.0.0") violations.push("new package version must remain 0.0.0 until changesets version it")
  if (value.main !== "./dist/server/index.js") violations.push("main must reference the browser-safe root entry")
  if (value.types !== "./dist/server/index.d.ts") violations.push("types must reference the root declaration")

  if (!isRecord(value.engines) || value.engines.node !== ">=24") violations.push("Node 24 or newer must be required")

  if (!isRecord(value.dependencies)) {
    violations.push("runtime dependencies must be explicit")
  } else {
    const runtimeKeys = ["@knpkv/rly", "react", "react-dom"]
    if (!sameKeys(value.dependencies, [...runtimeKeys].sort())) {
      violations.push("T01 runtime dependencies must remain the reviewed minimal set")
    }
    if (value.dependencies["@knpkv/rly"] !== "workspace:^") {
      violations.push("@knpkv/rly must use workspace:^")
    }
  }

  if (!isRecord(value.exports)) {
    violations.push("package exports must be explicit")
  } else {
    const expectedKeys = Object.keys(expectedExports).sort()
    if (!sameKeys(value.exports, expectedKeys)) {
      violations.push("package exports must contain only ., ./api, ./domain, ./server")
    }
    for (const [entry, expected] of Object.entries(expectedExports)) {
      const actual = value.exports[entry]
      if (!isRecord(actual) || actual.import !== expected.import || actual.types !== expected.types) {
        violations.push(`invalid ${entry} export target`)
      }
    }
  }
  return violations
}
