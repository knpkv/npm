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

const patchGuidanceDiagnostics = (source: string): ReadonlyArray<string> => {
  const workflow: unknown = parse(source)
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return []

  return Object.values(workflow.jobs).flatMap((job) => {
    if (!isRecord(job) || !Array.isArray(job.steps)) return []
    return job.steps.flatMap((step) => {
      if (!isRecord(step) || !isRecord(step.with) || !Predicate.isString(step.with.body)) return []
      const sentences = step.with.body.replace(/\s+/gu, " ").split(/[.!?]/u)
      return sentences.flatMap((sentence) =>
        /\bpatch (?:is appropriate|(?:only )?when)\b/iu.test(sentence)
          && !/\bpublic contract is unchanged\b/iu.test(sentence)
          ? ["Patch release guidance must require an unchanged public contract"]
          : []
      )
    })
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

  it.effect("reserves API update patch guidance for unchanged public contracts", () =>
    Effect.gen(function*() {
      for (const name of ["clockify-api-update.yml", "jira-api-update.yml", "confluence-api-update.yml"]) {
        expect(patchGuidanceDiagnostics(yield* loadWorkflow(name))).toEqual([])
      }
    }))

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
