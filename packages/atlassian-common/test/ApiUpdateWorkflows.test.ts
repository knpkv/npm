import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
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

const PackageManifest = Schema.Struct({
  name: Schema.String,
  private: Schema.optional(Schema.Boolean),
  exports: Schema.optional(Schema.Json)
})

// Public generated subpaths or generated export targets declare the contract;
// package names and consumer dependencies do not.
const isJsonArray = Schema.is(Schema.Array(Schema.Json))

const exposesGeneratedContract = (exports: Schema.Json): boolean => {
  if (Predicate.isString(exports)) return /(?:^|\/)generated(?:\/|$)/u.test(exports)
  if (isJsonArray(exports)) return exports.some(exposesGeneratedContract)
  if (!isRecord(exports)) return false
  return Object.entries(exports).some(([name, target]) =>
    /^\.\/generated(?:\/|$)/u.test(name) || exposesGeneratedContract(target)
  )
}

const patchGuidanceDiagnostics = (
  source: string,
  generatedClientNames: ReadonlySet<string>
): ReadonlyArray<string> => {
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

// Generated changesets must not reuse a fixed path: the workflow regenerates the PR branch
// from the base, so a fixed name overwrites a still-pending changeset from an earlier update.
const changesetPathDiagnostics = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/cat\s+>\s+(\.changeset\/[^\s]+\.md)/gu)].flatMap(([, changesetPath]) =>
    changesetPath !== undefined && changesetPath.includes("${GITHUB_RUN_ID}")
      ? []
      : [`Generated changeset ${changesetPath ?? ""} must be unique per workflow run`]
  )

// A regenerated-client-only diff is generator churn, not an upstream change: the
// detection step must compare only the workflow's own client `specsDir`, and the
// pull request must be gated on it.
const specOnlyGuardDiagnostics = (source: string, specsDir: string): ReadonlyArray<string> => {
  const workflow: unknown = parse(source)
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return ["API update workflow could not be inspected"]

  return Object.values(workflow.jobs).flatMap((job) => {
    if (!isRecord(job) || !Array.isArray(job.steps)) return []
    const steps = job.steps.filter(isRecord)
    const detection = steps.find((step) => Predicate.isString(step.run) && step.run.includes("updated=true"))
    if (detection === undefined || !Predicate.isString(detection.id) || !Predicate.isString(detection.run)) {
      return ["API update workflow must detect upstream spec changes"]
    }
    const pathspecs = detection.run.replace(/\\\n\s*/gu, " ").match(/git diff --quiet -- ([^;\n]+)/u)?.[1]
      ?.trim().split(/\s+/u) ?? []
    const pathspecDiagnostics = pathspecs.length === 0
      ? ["API update workflow must compare spec paths with git diff --quiet"]
      : pathspecs.flatMap((pathspec) =>
        pathspec === specsDir || pathspec.startsWith(`${specsDir}/`)
          ? []
          : [`API update workflow must open a pull request only for spec changes, not ${pathspec}`]
      )
    const gate = `steps.${detection.id}.outputs.updated == 'true'`
    const pullRequestDiagnostics = steps.flatMap((step) =>
      Predicate.isString(step.uses) && step.uses.startsWith("peter-evans/create-pull-request@")
        && !(Predicate.isString(step.if) && step.if.includes(gate))
        ? ["API update pull request must be gated on the spec-change detection step"]
        : []
    )
    return [...pathspecDiagnostics, ...pullRequestDiagnostics]
  })
}

const releaseWorkflow = (name: string, release: string, guidance = "Review the generated API.") => `
jobs:
  update:
    steps:
      - name: Create changeset
        run: |
          cat > .changeset/api-update.md <<'CHANGESET'
          ---
          "${name}": ${release}
          ---
          Update generated API schemas.
          CHANGESET
      - name: Create pull request
        with:
          body: ${guidance}
`

const inspectApiUpdateWorkflows = Effect.fn("ApiUpdateWorkflows.inspectApiUpdateWorkflows")(function*(root: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packagesRoot = path.join(root, "packages")
  const generatedClientNames = new Set<string>()
  for (const directory of yield* fileSystem.readDirectory(packagesRoot)) {
    if (["vendor", "generated", "node_modules"].includes(directory)) continue
    const packageRoot = path.join(packagesRoot, directory)
    if ((yield* fileSystem.stat(packageRoot)).type !== "Directory") continue
    const manifestPath = path.join(packageRoot, "package.json")
    if (!(yield* fileSystem.exists(manifestPath))) continue
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(
      yield* fileSystem.readFileString(manifestPath)
    )
    if (manifest.private !== true && manifest.exports !== undefined && exposesGeneratedContract(manifest.exports)) {
      generatedClientNames.add(manifest.name)
    }
  }
  const workflowRoot = path.join(root, ".github/workflows")
  const diagnostics: Array<string> = []
  for (const name of [...(yield* fileSystem.readDirectory(workflowRoot))].sort()) {
    if (!/-api-update\.ya?ml$/u.test(name)) continue
    const source = yield* fileSystem.readFileString(path.join(workflowRoot, name))
    for (const diagnostic of patchGuidanceDiagnostics(source, generatedClientNames)) {
      diagnostics.push(`${name}: ${diagnostic}`)
    }
  }
  return diagnostics
})

const loadWorkflow = Effect.fn("ApiUpdateWorkflows.loadWorkflow")(function*(name: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workflowPath = yield* path.fromFileUrl(new URL(`../../../.github/workflows/${name}`, import.meta.url))
  return yield* fileSystem.readFileString(workflowPath)
})

layer(NodeServices.layer)("API update workflow build closure", (it) => {
  const fixtureClients = new Set(["@knpkv/jira-api-client"])

  it.effect("discovers a fourth API workflow and its exported generated contract", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "api-update-discovery-" })
      const workflowRoot = path.join(root, ".github/workflows")
      yield* fileSystem.makeDirectory(workflowRoot, { recursive: true })
      for (const name of ["clockify", "jira", "confluence", "tempo"]) {
        const packageRoot = path.join(root, "packages", name)
        yield* fileSystem.makeDirectory(packageRoot, { recursive: true })
        yield* fileSystem.writeFileString(
          path.join(packageRoot, "package.json"),
          JSON.stringify({
            name: `@fixture/${name}`,
            exports: { "./api": { types: "./dist/generated/Api.d.ts", import: "./dist/generated/Api.js" } }
          })
        )
        yield* fileSystem.writeFileString(
          path.join(workflowRoot, `${name}-api-update.yml`),
          releaseWorkflow(`@fixture/${name}`, name === "tempo" ? "patch" : "minor")
        )
      }
      for (
        const [directory, manifest] of [
          ["private-client", {
            name: "@fixture/private-client",
            private: true,
            exports: { "./generated": "./dist/Api.js" }
          }],
          ["vendor", { name: "@fixture/vendor-client", exports: { "./generated": "./dist/Api.js" } }],
          ["generated", { name: "@fixture/generated-package", exports: { "./generated": "./dist/Api.js" } }],
          ["consumer", {
            name: "@fixture/consumer",
            exports: { ".": "./dist/index.js" },
            dependencies: { "@fixture/tempo": "workspace:*" }
          }]
        ] satisfies ReadonlyArray<readonly [string, Schema.Json]>
      ) {
        const packageRoot = path.join(root, "packages", directory)
        yield* fileSystem.makeDirectory(packageRoot, { recursive: true })
        yield* fileSystem.writeFileString(path.join(packageRoot, "package.json"), JSON.stringify(manifest))
        const decoded = yield* Schema.decodeUnknownEffect(PackageManifest)(manifest)
        yield* fileSystem.writeFileString(
          path.join(workflowRoot, `${directory}-api-update.yml`),
          releaseWorkflow(decoded.name, "patch")
        )
      }
      expect(yield* inspectApiUpdateWorkflows(root)).toEqual([
        "tempo-api-update.yml: Generated client @fixture/tempo defaults to patch without unchanged-contract guidance"
      ])
      yield* fileSystem.writeFileString(
        path.join(workflowRoot, "tempo-api-update.yml"),
        releaseWorkflow("@fixture/tempo", "minor")
      )
      expect(yield* inspectApiUpdateWorkflows(root)).toEqual([])
    }))

  it("recognizes generated export subpaths and conditional targets without guessing package names", () => {
    expect(exposesGeneratedContract({ "./generated/v1": "./dist/Api.js" })).toBe(true)
    expect(exposesGeneratedContract({ ".": { import: [null, "./dist/generated/Api.js"] } })).toBe(true)
    expect(exposesGeneratedContract({ ".": "./dist/generated-client.js" })).toBe(false)
    expect(exposesGeneratedContract({ ".": "./dist/index.js" })).toBe(false)
  })

  it("rejects compatible-only patch guidance and accepts unchanged-contract guidance", () => {
    const workflow = (guidance: string) => `
jobs:
  update:
    steps:
      - name: Create pull request
        with:
          body: ${guidance}
`
    expect(patchGuidanceDiagnostics(
      workflow(
        "Patch is appropriate only after confirming every public contract remains compatible."
      ),
      fixtureClients
    )).toEqual(["Patch release guidance must require an unchanged public contract"])
    expect(patchGuidanceDiagnostics(
      workflow(
        "Patch is appropriate only when the generated public contract is unchanged."
      ),
      fixtureClients
    )).toEqual([])
  })

  it("rejects an unqualified generated-client patch default", () => {
    expect(
      patchGuidanceDiagnostics(
        releaseWorkflow("@knpkv/jira-api-client", "patch", "Review the generated API."),
        fixtureClients
      )
    )
      .toEqual(["Generated client @knpkv/jira-api-client defaults to patch without unchanged-contract guidance"])
    expect(
      patchGuidanceDiagnostics(
        releaseWorkflow("@knpkv/jira-api-client", "minor", "Review the generated API."),
        fixtureClients
      )
    )
      .toEqual([])
    expect(patchGuidanceDiagnostics(
      releaseWorkflow(
        "@knpkv/jira-api-client",
        "patch",
        "Patch is appropriate only when the generated public contract is unchanged."
      ),
      fixtureClients
    )).toEqual([])
    expect(
      patchGuidanceDiagnostics(
        releaseWorkflow("@fixture/private-client", "patch", "Apply the JSON patch."),
        fixtureClients
      )
    )
      .toEqual([])
    expect(
      patchGuidanceDiagnostics(
        releaseWorkflow("@knpkv/jira-clockify", "patch", "Consumer dependency update."),
        fixtureClients
      )
    )
      .toEqual([])
  })

  it.effect("checks every discovered API-update workflow in the repository", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
      expect(yield* fileSystem.readDirectory(path.join(root, ".github/workflows"))).toEqual(expect.arrayContaining([
        "clockify-api-update.yml",
        "jira-api-update.yml",
        "confluence-api-update.yml"
      ]))
      expect(yield* inspectApiUpdateWorkflows(root)).toEqual([])
    }))

  it("rejects a fixed generated changeset path and accepts a per-run path", () => {
    expect(changesetPathDiagnostics("run: cat > .changeset/clockify-api-spec-update.md <<'CHANGESET'")).toEqual([
      "Generated changeset .changeset/clockify-api-spec-update.md must be unique per workflow run"
    ])
    expect(
      changesetPathDiagnostics("run: cat > .changeset/clockify-api-spec-update-${GITHUB_RUN_ID}.md <<'CHANGESET'")
    ).toEqual([])
  })

  it.effect("writes every generated changeset to a per-run path", () =>
    Effect.gen(function*() {
      for (const name of ["clockify-api-update.yml", "jira-api-update.yml", "confluence-api-update.yml"]) {
        const source = yield* loadWorkflow(name)
        expect(source).toMatch(/cat\s+>\s+\.changeset\//u)
        expect(changesetPathDiagnostics(source)).toEqual([])
      }
    }))

  it("rejects generated-code detection and accepts a spec-only gate", () => {
    const workflow = (pathspecs: string, gate: string) => `
jobs:
  update:
    steps:
      - name: Detect spec changes
        id: check
        run: |
          if git diff --quiet -- \\
            ${pathspecs}; then
            echo "updated=false" >> "$GITHUB_OUTPUT"
          else
            echo "updated=true" >> "$GITHUB_OUTPUT"
          fi
      - name: Create pull request
        if: ${gate}
        uses: peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1
`
    const gate = "steps.check.outputs.updated == 'true'"
    const specs = "packages/x/.specs"
    expect(specOnlyGuardDiagnostics(workflow("packages/x/.specs packages/x/src/generated", gate), specs)).toEqual([
      "API update workflow must open a pull request only for spec changes, not packages/x/src/generated"
    ])
    expect(specOnlyGuardDiagnostics(workflow("packages/y/.specs", gate), specs)).toEqual([
      "API update workflow must open a pull request only for spec changes, not packages/y/.specs"
    ])
    expect(specOnlyGuardDiagnostics(workflow("packages/x/.specs-old", gate), specs)).toEqual([
      "API update workflow must open a pull request only for spec changes, not packages/x/.specs-old"
    ])
    expect(specOnlyGuardDiagnostics(workflow("packages/x/.specs", "always()"), specs)).toEqual([
      "API update pull request must be gated on the spec-change detection step"
    ])
    expect(specOnlyGuardDiagnostics(workflow("packages/x/.specs/x-v1.json", gate), specs)).toEqual([])
    expect(specOnlyGuardDiagnostics(workflow("packages/x/.specs", gate), specs)).toEqual([])
  })

  it.effect("opens API update pull requests only for spec changes", () =>
    Effect.gen(function*() {
      for (const client of ["clockify", "jira", "confluence"]) {
        const source = yield* loadWorkflow(`${client}-api-update.yml`)
        expect(specOnlyGuardDiagnostics(source, `packages/${client}-api-client/.specs`)).toEqual([])
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
