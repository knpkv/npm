import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import { parse } from "yaml"

const isRecord = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & Record<string, Schema.Json> =>
  Predicate.isObjectOrArray(value) && value !== null && !Array.isArray(value)

const buildCommands = (source: string): ReadonlyArray<string> => {
  const workflow: unknown = parse(source)
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return []

  return Object.values(workflow.jobs).flatMap((job) => {
    if (!isRecord(job) || !Array.isArray(job.steps)) return []
    return job.steps.flatMap((step) => {
      if (!isRecord(step) || !Predicate.isString(step.name) || !step.name.startsWith("Build ")) return []
      return Predicate.isString(step.run) ? [step.run] : []
    })
  })
}

const dependencyClosureDiagnostics = (
  source: string,
  expectedConsumers: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const commands = buildCommands(source)
  return expectedConsumers.flatMap((consumer) => {
    const dependencyClosedFilter = `--filter ${consumer}...`
    return commands.some((command) => command.includes(dependencyClosedFilter) && /\bbuild\b/u.test(command))
      ? []
      : [`API update workflow must build ${consumer} with its workspace dependency closure`]
  })
}

const generatedClientNames = new Set([
  "@knpkv/clockify-api-client",
  "@knpkv/confluence-api-client",
  "@knpkv/jira-api-client"
])

const patchGuidanceDiagnostics = (source: string): ReadonlyArray<string> => {
  const workflow: unknown = parse(source)
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return []

  return Object.values(workflow.jobs).flatMap((job) => {
    if (!isRecord(job) || !Array.isArray(job.steps)) return []
    const steps = job.steps.filter(isRecord)
    const bodies = steps.flatMap((step) =>
      isRecord(step.with) && Predicate.isString(step.with.body) ? [step.with.body.replace(/\s+/gu, " ")] : []
    )
    const hasUnchangedContractGuidance = bodies.some((body) => /\bpublic contract is unchanged\b/iu.test(body))
    const guidanceDiagnostics = bodies.flatMap((body) =>
      body.split(/[.!?]/u).flatMap((sentence) =>
        /\bpatch (?:is appropriate|(?:only )?when)\b/iu.test(sentence)
          && !/\bpublic contract is unchanged\b/iu.test(sentence)
          ? ["Patch release guidance must require an unchanged public contract"]
          : []
      )
    )
    const defaultDiagnostics = steps.flatMap((step) => {
      if (!Predicate.isString(step.run) || !/cat\s+>\s+\.changeset\//u.test(step.run)) return []
      const heredocs = [...step.run.matchAll(
        /cat\s+>\s+\.changeset\/[^\s]+\.md\s+<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1(?:\n|$)/gu
      )]
      if (heredocs.length === 0) return ["Generated changeset heredoc could not be inspected"]
      return heredocs.flatMap((heredoc) => {
        const frontmatter = heredoc[2]?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1]
        if (frontmatter === undefined) return ["Generated changeset must contain release frontmatter"]
        const releases: unknown = parse(frontmatter)
        if (!isRecord(releases)) return ["Generated changeset must contain release frontmatter"]
        return Object.entries(releases).flatMap(([name, release]) =>
          generatedClientNames.has(name) && release === "patch" && !hasUnchangedContractGuidance
            ? [`Generated client ${name} defaults to patch without unchanged-contract guidance`]
            : []
        )
      })
    })
    return [...guidanceDiagnostics, ...defaultDiagnostics]
  })
}

const loadWorkflow = Effect.fn("ApiUpdateWorkflows.loadWorkflow")(function*(name: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workflowPath = yield* path.fromFileUrl(new URL(`../../../.github/workflows/${name}`, import.meta.url))
  return yield* fileSystem.readFileString(workflowPath)
})

layer(NodeServices.layer)("API update workflow build closure", (it) => {
  it("rejects compatible-only patch guidance and accepts unchanged-contract guidance", () => {
    const workflow = (guidance: string) => `
jobs:
  update:
    steps:
      - name: Create pull request
        with:
          body: ${guidance}
`
    expect(patchGuidanceDiagnostics(workflow(
      "Patch is appropriate only after confirming every public contract remains compatible."
    ))).toEqual(["Patch release guidance must require an unchanged public contract"])
    expect(patchGuidanceDiagnostics(workflow(
      "Patch is appropriate only when the generated public contract is unchanged."
    ))).toEqual([])
  })

  it("rejects an unqualified generated-client patch default", () => {
    const workflow = (name: string, release: string, guidance: string) => `
jobs:
  update:
    steps:
      - name: Create changeset
        run: |
          cat > .changeset/api-update.md <<'CHANGESET'
          ---
          "${name}": ${release}
          ---
          Update generated API schemas. Apply the JSON patch before generation.
          CHANGESET
      - name: Create pull request
        with:
          body: ${guidance}
`
    expect(patchGuidanceDiagnostics(workflow("@knpkv/jira-api-client", "patch", "Review the generated API.")))
      .toEqual(["Generated client @knpkv/jira-api-client defaults to patch without unchanged-contract guidance"])
    expect(patchGuidanceDiagnostics(workflow("@knpkv/jira-api-client", "minor", "Review the generated API.")))
      .toEqual([])
    expect(patchGuidanceDiagnostics(workflow(
      "@knpkv/jira-api-client",
      "patch",
      "Patch is appropriate only when the generated public contract is unchanged."
    ))).toEqual([])
    expect(patchGuidanceDiagnostics(workflow("@fixture/private-client", "patch", "Apply the JSON patch.")))
      .toEqual([])
    expect(patchGuidanceDiagnostics(workflow("@knpkv/jira-clockify", "patch", "Consumer dependency update.")))
      .toEqual([])
  })

  it.effect.each(["clockify-api-update.yml", "jira-api-update.yml", "confluence-api-update.yml"])(
    "reserves patch guidance for unchanged public contracts in %s",
    (name) =>
      Effect.gen(function*() {
        expect(patchGuidanceDiagnostics(yield* loadWorkflow(name))).toEqual([])
      })
  )

  it("rejects a bare consumer build and accepts a dependency-closed build", () => {
    const invalid = `
jobs:
  update:
    steps:
      - name: Build generated client and consumer
        run: pnpm --filter @knpkv/confluence-to-markdown build
`
    const valid = `
jobs:
  update:
    steps:
      - name: Build generated client and consumer
        run: pnpm --filter @knpkv/confluence-to-markdown... build
`

    expect(dependencyClosureDiagnostics(invalid, ["@knpkv/confluence-to-markdown"])).toEqual([
      "API update workflow must build @knpkv/confluence-to-markdown with its workspace dependency closure"
    ])
    expect(dependencyClosureDiagnostics(valid, ["@knpkv/confluence-to-markdown"])).toEqual([])
  })

  it.effect("builds every API consumer with its workspace dependencies", () =>
    Effect.gen(function*() {
      const confluence = yield* loadWorkflow("confluence-api-update.yml")
      const jira = yield* loadWorkflow("jira-api-update.yml")
      const clockify = yield* loadWorkflow("clockify-api-update.yml")

      expect(dependencyClosureDiagnostics(confluence, ["@knpkv/confluence-to-markdown"])).toEqual([])
      expect(dependencyClosureDiagnostics(jira, ["@knpkv/jira-cli", "@knpkv/jira-clockify"])).toEqual([])
      expect(dependencyClosureDiagnostics(clockify, ["@knpkv/jira-clockify"])).toEqual([])
    }))
})
