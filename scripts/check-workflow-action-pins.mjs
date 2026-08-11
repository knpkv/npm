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

const normalizedActionInputs = (step) => {
  const inputs = new Map()
  const duplicates = new Set()
  if (step?.with === null || typeof step?.with !== "object" || Array.isArray(step.with)) {
    return { inputs, duplicates }
  }
  for (const [name, value] of Object.entries(step.with)) {
    const normalizedName = name.toLowerCase()
    if (inputs.has(normalizedName)) duplicates.add(normalizedName)
    else inputs.set(normalizedName, value)
  }
  return { inputs, duplicates }
}

export const validateWorkflowActionPins = (document, location, localActions = new Map()) => {
  const diagnostics = []
  const visit = (currentDocument, currentLocation, stack) => {
    const dockerImage = currentDocument?.runs?.using === "docker" ? currentDocument.runs.image : undefined
    if (typeof dockerImage === "string" && dockerImage.startsWith("docker://") && !dockerDigest.test(dockerImage)) {
      diagnostics.push(`${currentLocation}.runs.image: Docker actions must use an immutable sha256 digest`)
    }
    for (const entry of collectUses(currentDocument, currentLocation)) {
      if (entry.uses.startsWith("./")) {
        if (entry.uses.includes("${{")) {
          diagnostics.push(`${entry.location}: dynamic local action references require explicit review`)
          continue
        }
        const localPath = entry.uses.slice(2).replace(/\/+$/u, "")
        if (/\.ya?ml$/u.test(localPath)) continue
        if (stack.has(localPath)) {
          diagnostics.push(`${entry.location}: cyclic local action reference to ${entry.uses}`)
          continue
        }
        const localAction = localActions.get(localPath)
        if (localAction === undefined) {
          diagnostics.push(`${entry.location}: local action ${entry.uses} has no action.yml or action.yaml manifest`)
          continue
        }
        visit(localAction.document, localAction.location, new Set([...stack, localPath]))
        continue
      }
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
      if (action === "actions/checkout") {
        const { inputs, duplicates } = normalizedActionInputs(entry.step)
        for (const duplicate of duplicates) {
          diagnostics.push(`${entry.location}: duplicate action input ${duplicate} after case normalization`)
        }
        if (inputs.get("persist-credentials") !== false) {
          diagnostics.push(`${entry.location}: actions/checkout must set with.persist-credentials to false`)
        }
      }
    }
  }
  visit(document, location, new Set())
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
  const validMixedCaseCheckoutInput = parse(`
jobs:
  release:
    steps:
      - uses: Actions/Checkout@${"a".repeat(40)}
        with:
          Persist-Credentials: false
`)
  const invalidMixedCaseCheckoutInput = parse(`
jobs:
  release:
    steps:
      - uses: Actions/Checkout@${"a".repeat(40)}
        with:
          Persist-Credentials: true
`)
  const invalidDuplicateCheckoutInput = parse(`
jobs:
  release:
    steps:
      - uses: Actions/Checkout@${"a".repeat(40)}
        with:
          persist-credentials: false
          Persist-Credentials: false
`)
  const invalidLocalActionCaller = parse(`
jobs:
  build:
    steps:
      - uses: ./ci/build
`)
  const invalidLocalAction = parse(`
runs:
  using: composite
  steps:
    - uses: third-party/build@v1
`)
  const validLocalActionCaller = parse(`
jobs:
  build:
    steps:
      - uses: ./ci/trusted-build
`)
  const validLocalAction = parse(`
runs:
  using: composite
  steps:
    - uses: third-party/build@${"c".repeat(40)}
`)
  const cyclicLocalActionCaller = parse(`
jobs:
  build:
    steps:
      - uses: ./ci/cycle-a
`)
  const cyclicLocalActionA = parse(`
runs:
  using: composite
  steps:
    - uses: ./ci/cycle-b
`)
  const cyclicLocalActionB = parse(`
runs:
  using: composite
  steps:
    - uses: ./ci/cycle-a
`)
  const invalidDockerActionCaller = parse(`
jobs:
  build:
    steps:
      - uses: ./ci/docker-build
`)
  const invalidDockerAction = parse(`
runs:
  using: docker
  image: docker://owner/image:latest
`)
  const validDigestDockerActionCaller = parse(`
jobs:
  build:
    steps:
      - uses: ./ci/digest-build
`)
  const validDigestDockerAction = parse(`
runs:
  using: docker
  image: docker://owner/image@sha256:${"d".repeat(64)}
`)
  const validDockerfileActionCaller = parse(`
jobs:
  build:
    steps:
      - uses: ./ci/dockerfile-build
`)
  const validDockerfileAction = parse(`
runs:
  using: docker
  image: Dockerfile
`)
  assert.equal(validateWorkflowActionPins(invalid, "invalid fixture").length, 2)
  assert.equal(validateWorkflowActionPins(invalidMixedCaseCheckout, "mixed-case checkout fixture").length, 1)
  assert.equal(validateWorkflowActionPins(invalidMixedCaseCheckoutInput, "mixed-case checkout input fixture").length, 1)
  assert.equal(validateWorkflowActionPins(invalidDuplicateCheckoutInput, "duplicate checkout input fixture").length, 1)
  assert.deepEqual(validateWorkflowActionPins(valid, "valid fixture"), [])
  assert.deepEqual(validateWorkflowActionPins(validMixedCaseNonCheckout, "mixed-case action fixture"), [])
  assert.deepEqual(validateWorkflowActionPins(validMixedCaseCheckoutInput, "mixed-case checkout input fixture"), [])
  assert.equal(
    validateWorkflowActionPins(
      invalidLocalActionCaller,
      "invalid local action caller",
      new Map([["ci/build", { document: invalidLocalAction, location: "ci/build/action.yml" }]])
    ).length,
    1
  )
  assert.deepEqual(
    validateWorkflowActionPins(
      validLocalActionCaller,
      "valid local action caller",
      new Map([["ci/trusted-build", { document: validLocalAction, location: "ci/trusted-build/action.yml" }]])
    ),
    []
  )
  assert.equal(
    validateWorkflowActionPins(
      cyclicLocalActionCaller,
      "cyclic local action caller",
      new Map([
        ["ci/cycle-a", { document: cyclicLocalActionA, location: "ci/cycle-a/action.yml" }],
        ["ci/cycle-b", { document: cyclicLocalActionB, location: "ci/cycle-b/action.yml" }]
      ])
    ).length,
    1
  )
  assert.equal(
    validateWorkflowActionPins(
      invalidDockerActionCaller,
      "invalid Docker action caller",
      new Map([["ci/docker-build", { document: invalidDockerAction, location: "ci/docker-build/action.yml" }]])
    ).length,
    1
  )
  assert.deepEqual(
    validateWorkflowActionPins(
      validDigestDockerActionCaller,
      "digest Docker action caller",
      new Map([["ci/digest-build", { document: validDigestDockerAction, location: "ci/digest-build/action.yml" }]])
    ),
    []
  )
  assert.deepEqual(
    validateWorkflowActionPins(
      validDockerfileActionCaller,
      "Dockerfile action caller",
      new Map([
        ["ci/dockerfile-build", { document: validDockerfileAction, location: "ci/dockerfile-build/action.yml" }]
      ])
    ),
    []
  )
}

const program = Effect.gen(function* () {
  yield* Effect.sync(runSelfTest)
  const fileSystem = yield* FileSystem.FileSystem
  const workflowFiles = yield* Effect.tryPromise({
    try: () =>
      Glob.glob([".github/workflows/**/*.{yml,yaml}"], {
        ignore: ["**/generated/**", "**/vendor/**", "**/node_modules/**"],
        nodir: true
      }),
    catch: (cause) => new Error("Failed to enumerate GitHub workflow files", { cause })
  })
  const localActionFiles = yield* Effect.tryPromise({
    try: () =>
      Glob.glob(["**/action.{yml,yaml}"], {
        dot: true,
        ignore: ["**/generated/**", "**/vendor/**", "**/node_modules/**"],
        nodir: true
      }),
    catch: (cause) => new Error("Failed to enumerate local action manifests", { cause })
  })
  const localActions = new Map()
  for (const file of localActionFiles.toSorted()) {
    const content = yield* fileSystem.readFileString(file)
    const document = yield* Effect.try({
      try: () => parse(content),
      catch: (cause) => new Error(`${file}: invalid YAML`, { cause })
    })
    localActions.set(file.replace(/\/action\.ya?ml$/u, ""), { document, location: file })
  }
  const diagnostics = []
  for (const file of workflowFiles.toSorted()) {
    const content = yield* fileSystem.readFileString(file)
    const document = yield* Effect.try({
      try: () => parse(content),
      catch: (cause) => new Error(`${file}: invalid YAML`, { cause })
    })
    diagnostics.push(...validateWorkflowActionPins(document, file, localActions))
  }
  if (diagnostics.length > 0) {
    return yield* Effect.fail(new Error(`Unsafe GitHub action references:\n${diagnostics.join("\n")}`))
  }
  yield* Console.log(
    `GitHub action pins checked across ${workflowFiles.length} workflows and ${localActionFiles.length} local actions`
  )
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
