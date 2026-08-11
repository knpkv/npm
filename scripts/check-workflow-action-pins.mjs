import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Glob from "glob"
import { parse } from "yaml"

const fullCommitSha = /^[0-9a-f]{40}$/u
const dockerDigest = /@sha256:[0-9a-f]{64}$/u

const collectUses = (value, location, results = []) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectUses(entry, `${location}[${index}]`, results))
    return results
  }
  if (value === null || typeof value !== "object") return results
  for (const [key, entry] of Object.entries(value)) {
    const entryLocation = `${location}.${key}`
    if (key === "uses" && typeof entry === "string") {
      results.push({ location: entryLocation, uses: entry, step: value })
    }
    collectUses(entry, entryLocation, results)
  }
  return results
}

export const validateWorkflowActionPins = (document, location) => {
  const diagnostics = []
  for (const entry of collectUses(document, location)) {
    if (entry.uses.startsWith("./")) continue
    if (entry.uses.startsWith("docker://")) {
      if (!dockerDigest.test(entry.uses)) {
        diagnostics.push(`${entry.location}: docker actions must use an immutable sha256 digest`)
      }
      continue
    }
    const separator = entry.uses.lastIndexOf("@")
    const reference = separator === -1 ? "" : entry.uses.slice(separator + 1)
    const action = separator === -1 ? entry.uses : entry.uses.slice(0, separator).toLowerCase()
    if (!fullCommitSha.test(reference)) {
      diagnostics.push(`${entry.location}: external action ${entry.uses} must use a full 40-character commit SHA`)
      continue
    }
    if (action === "actions/checkout" && entry.step.with?.["persist-credentials"] !== false) {
      diagnostics.push(`${entry.location}: actions/checkout must set with.persist-credentials to false`)
    }
  }
  return diagnostics
}

const runSelfTest = () => {
  const invalid = parse(`
jobs:
  release:
    steps:
      - uses: changesets/action@v1
      - uses: actions/checkout@${"a".repeat(40)}
`)
  const valid = parse(`
jobs:
  release:
    steps:
      - uses: changesets/action@${"b".repeat(40)}
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          persist-credentials: false
      - uses: ./.github/actions/setup
`)
  const invalidMixedCaseCheckout = parse(`
jobs:
  release:
    steps:
      - uses: Actions/Checkout@${"a".repeat(40)}
`)
  const validMixedCaseNonCheckout = parse(`
jobs:
  release:
    steps:
      - uses: Actions/Setup-Node@${"a".repeat(40)}
`)
  assert.equal(validateWorkflowActionPins(invalid, "invalid fixture").length, 2)
  assert.equal(validateWorkflowActionPins(invalidMixedCaseCheckout, "mixed-case checkout fixture").length, 1)
  assert.deepEqual(validateWorkflowActionPins(valid, "valid fixture"), [])
  assert.deepEqual(validateWorkflowActionPins(validMixedCaseNonCheckout, "mixed-case action fixture"), [])
}

const program = Effect.gen(function* () {
  yield* Effect.sync(runSelfTest)
  const fileSystem = yield* FileSystem.FileSystem
  const workflowFiles = yield* Effect.tryPromise({
    try: () =>
      Glob.glob([".github/workflows/**/*.{yml,yaml}", ".github/actions/**/*.{yml,yaml}"], {
        ignore: ["**/generated/**", "**/vendor/**", "**/node_modules/**"],
        nodir: true
      }),
    catch: (cause) => new Error("Failed to enumerate GitHub workflow files", { cause })
  })
  const diagnostics = []
  for (const file of workflowFiles.toSorted()) {
    const content = yield* fileSystem.readFileString(file)
    const document = yield* Effect.try({
      try: () => parse(content),
      catch: (cause) => new Error(`${file}: invalid YAML`, { cause })
    })
    diagnostics.push(...validateWorkflowActionPins(document, file))
  }
  if (diagnostics.length > 0) {
    return yield* Effect.fail(new Error(`Unsafe GitHub action references:\n${diagnostics.join("\n")}`))
  }
  yield* Console.log(`GitHub action pins checked across ${workflowFiles.length} workflow files`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
