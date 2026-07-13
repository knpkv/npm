import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { componentManifest } from "../component-manifest.js"
import { componentStyleSources } from "./contract.js"
import { findPackedDiffArtifacts, validatePackedDiffArtifactSources } from "./packed/diff-assets.js"
import {
  renderDiffConsumerAssertions,
  renderDiffConsumerFixture,
  renderDiffConsumerImports,
  renderDiffConsumerMarkup
} from "./packed/diff-consumer.js"
import {
  findLeakedDiffImplementation,
  renderNormalEntryConsumer,
  renderNormalEntryViteConfig
} from "./packed/normal-entry.js"

class PackedPackageError extends Data.TaggedError("PackedPackageError")<{
  readonly reason: string
}> {}

const PackageJson = Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String }))

const program = Effect.scoped(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "rly-packed-consumer-" })
  const hasComponentStyles = componentStyleSources(componentManifest).length > 0

  const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
    spawner.string(ChildProcess.make(command, args, { cwd })).pipe(
      Effect.mapError(() => new PackedPackageError({ reason: `${command} ${args.join(" ")} failed` }))
    )

  const packageSource = yield* fs.readFileString(path.join(packageRoot, "package.json"))
  const packageJson = yield* Schema.decodeUnknownEffect(PackageJson)(packageSource).pipe(
    Effect.mapError(() => new PackedPackageError({ reason: "Could not decode rly package identity" }))
  )
  yield* run("pnpm", ["pack", "--pack-destination", temporary], packageRoot)

  const archiveName = `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`
  const archive = path.join(temporary, archiveName)
  const listing = yield* run("tar", ["-tf", archive], temporary)
  for (
    const artifact of [
      "package/dist/styles.css",
      "package/dist/base.css",
      "package/dist/fonts.css",
      "package/dist/generated-tokens.css",
      ...(hasComponentStyles ? ["package/dist/components.css"] : []),
      "package/dist/fonts/geist-latin-wght-normal.woff2",
      "package/dist/fonts/geist-mono-latin-wght-normal.woff2"
    ]
  ) {
    if (!listing.split("\n").includes(artifact)) {
      return yield* Effect.fail(new PackedPackageError({ reason: `Packed asset is missing: ${artifact}` }))
    }
  }
  const diffArtifacts = findPackedDiffArtifacts(listing.split("\n"))
  if (diffArtifacts === undefined) {
    return yield* Effect.fail(new PackedPackageError({ reason: "Packed diff worker or its WASM runtime is missing" }))
  }
  const packedDiffEntry = yield* run("tar", ["-xOf", archive, "package/dist/diff/index.js"], temporary)
  const packedWorkerSource = yield* run("tar", ["-xOf", archive, diffArtifacts.worker], temporary)
  const diffArtifactFailure = validatePackedDiffArtifactSources({
    diffEntry: packedDiffEntry,
    wasmFileName: path.basename(diffArtifacts.wasm),
    workerFileName: path.basename(diffArtifacts.worker),
    workerSource: packedWorkerSource
  })
  if (diffArtifactFailure !== undefined) {
    return yield* Effect.fail(new PackedPackageError({ reason: diffArtifactFailure }))
  }
  const leaked = listing.split("\n").filter((entry) =>
    /^package\/(?:src|test|scripts|generated|component-manifest\.ts)(?:\/|$)/.test(entry)
    || /^package\/dist\/dts\/tokens\/(?:colors|model|motion|shape|space|typography)\.d\.ts(?:\.map)?$/.test(entry)
  )
  if (leaked.length > 0) {
    return yield* Effect.fail(new PackedPackageError({ reason: `Packed source leaked: ${leaked.join(", ")}` }))
  }
  const packedStyles = yield* run("tar", ["-xOf", archive, "package/dist/styles.css"], temporary)
  const componentImport = "@import \"./components.css\";"
  const componentImportCount = packedStyles.split(componentImport).length - 1
  if (hasComponentStyles && componentImportCount !== 1) {
    return yield* Effect.fail(new PackedPackageError({ reason: "Packed styles do not include component CSS once" }))
  }
  if (!hasComponentStyles && componentImportCount !== 0) {
    return yield* Effect.fail(new PackedPackageError({ reason: "Packed styles include undeclared component CSS" }))
  }
  if (hasComponentStyles) {
    const packedComponentStyles = yield* run("tar", ["-xOf", archive, "package/dist/components.css"], temporary)
    if (packedComponentStyles.trim().length === 0) {
      return yield* Effect.fail(new PackedPackageError({ reason: "Packed component CSS is empty" }))
    }
  }

  const consumer = path.join(temporary, "consumer")
  const sourceDirectory = path.join(consumer, "src")
  yield* fs.makeDirectory(sourceDirectory, { recursive: true })
  yield* fs.writeFileString(
    path.join(consumer, "package.json"),
    `${
      JSON.stringify(
        {
          private: true,
          type: "module",
          dependencies: {
            "@knpkv/rly": `file:${archive}`,
            react: "19.2.7",
            "react-dom": "19.2.7"
          },
          devDependencies: { typescript: "6.0.3", vite: "8.1.4" }
        },
        null,
        2
      )
    }\n`
  )
  yield* fs.writeFileString(
    path.join(consumer, "tsconfig.json"),
    `${
      JSON.stringify(
        {
          compilerOptions: {
            jsx: "react-jsx",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            outDir: "dist",
            rootDir: "src",
            skipLibCheck: false,
            strict: true,
            target: "ES2022"
          },
          include: ["src"]
        },
        null,
        2
      )
    }\n`
  )

  const imports = componentManifest.entries.map((entry, index) =>
    `import * as Entry${index} from ${
      JSON.stringify(entry.subpath === "." ? "@knpkv/rly" : `@knpkv/rly/${entry.subpath.slice(2)}`)
    }`
  )
  const references = componentManifest.entries.map((_, index) => `Entry${index}`).join(", ")
  yield* fs.writeFileString(
    path.join(sourceDirectory, "index.tsx"),
    `${imports.join("\n")}
import {
  Icon,
  LinkProvider,
  PortalProvider,
  ThemeProvider,
  type RlyLinkComponent
} from "@knpkv/rly/foundations"
import { Button, Dialog, Field, Select, Sheet, Surface, Tabs, Text } from "@knpkv/rly/primitives"
import {
  AgentContextButton,
  AgentDrawer,
  AgentJob,
  AgentProposal,
  AgentThread,
  CollaboratorGroup,
  EntityShell,
  EntityTable,
  EvidenceStamp,
  FreshnessStamp,
  GovernedActionReview,
  PeopleStrip,
  Person,
  RelationshipChain,
  RelationshipTable,
  ReleasePreview,
  ReleaseRelay,
  ReleaseRow,
  ServiceMark,
  StageRail,
  TimelineRow,
  type RlyAgentProposal,
  type RlyReleasePresentation,
  type RlyRelationship,
  Verdict,
  WorksetCard
} from "@knpkv/rly/patterns"
${renderDiffConsumerImports()}
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

const RouterLink: RlyLinkComponent = (props) => <a {...props} data-router-destination={props.href} />
const packedRelationships = [{
  id: "packed-jira-pr",
  kind: "Implemented by",
  direction: "forward",
  lifecycle: "verified",
  source: {
    state: "present",
    id: "packed-jira",
    title: "RPS-6307",
    reference: "Release candidate",
    service: "jira",
    href: "/jira/RPS-6307"
  },
  target: {
    state: "present",
    id: "packed-pr",
    title: "PR #291",
    reference: "7f4c9b1",
    service: "codecommit",
    href: "/codecommit/pulls/291"
  },
  evidence: "Packed relationship evidence"
}] satisfies ReadonlyArray<RlyRelationship>
const packedRelease: RlyReleasePresentation = {
  algorithm: "relay/v1",
  approver: { id: "packed-approver", name: "Dev Shah", role: "Production approver" },
  codename: "Copper Orbit",
  facts: [
    { id: "commit", label: "Commit", value: "7f4c9b1" },
    { id: "target", label: "Target", value: "production" }
  ],
  freshness: "current",
  freshnessDateTime: "2026-07-13T14:00:00Z",
  freshnessTime: "Observed now",
  id: "packed-release",
  owner: { id: "packed-owner", name: "Avery Diaz", role: "Release owner" },
  reason: "Every required check matches the current head.",
  state: "ready",
  symbolIndices: [6, 3, 7],
  tone: "positive",
  verdict: "Ready to ship.",
  version: "v2.4.0"
}
const packedAgentProposal: RlyAgentProposal = {
  agent: {
    avatarFallback: "AI",
    id: "packed-agent",
    name: "Release Guardian",
    role: "Release-scoped agent"
  },
  capability: "Update Jira release description",
  context: "Release v2.4.0 Copper Orbit",
  evidence: [{ id: "packed-evidence", label: "Jira revision", reference: "RPS-6307@17" }],
  expectedRevision: "17",
  id: "packed-proposal",
  impact: "Replace the Jira issue description only",
  target: "Jira RPS-6307"
}
${renderDiffConsumerFixture()}
const markup = renderToStaticMarkup(
  <ThemeProvider theme="dark">
    <Icon decorative name="check" />
    <LinkProvider component={RouterLink}><span>Link bridge</span></LinkProvider>
    <PortalProvider container={null}>
      <Field controlId="packed-name" label="Release name">
        {(controlProps) => createElement("input", controlProps)}
      </Field>
      <Field controlId="packed-environment" label="Environment">
        {(controlProps) => createElement(Select, {
          ...controlProps,
          options: [{ label: "Staging", value: "staging" }]
        })}
      </Field>
      <Dialog.Root>
        <Dialog.Trigger>Open packed dialog</Dialog.Trigger>
        <Dialog.Content title="Packed dialog"><Dialog.Close>Close packed dialog</Dialog.Close></Dialog.Content>
      </Dialog.Root>
      <Sheet.Root>
        <Sheet.Trigger>Open packed sheet</Sheet.Trigger>
        <Sheet.Content title="Packed sheet"><Sheet.Body>Packed sheet body</Sheet.Body></Sheet.Content>
      </Sheet.Root>
    </PortalProvider>
    <Surface><Text>Packed primitive</Text><Button>Continue</Button></Surface>
    ${renderDiffConsumerMarkup()}
    <ServiceMark service="jira" />
    <FreshnessStamp dateTime="2026-07-13T14:00:00Z" state="current" time="Observed now" />
    <EvidenceStamp freshness="current" reference="evidence/jira/OPS-428/revision/17" service="jira" />
    <Person person={{ id: "avery", name: "Avery Diaz", role: "Release owner" }} />
    <PeopleStrip
      aria-label="Packed reviewers"
      expanded={false}
      onExpandedChange={() => undefined}
      people={[{ id: "casey", name: "Casey Singh", role: "Code reviewer" }]}
    />
    <CollaboratorGroup
      expandedCategories={[]}
      heading="Packed collaborators"
      onCategoryExpandedChange={() => undefined}
      owners={[{ id: "blake", name: "Blake Kim", role: "Release owner" }]}
    />
    <StageRail
      heading="Packed pipeline stages"
      stages={[{ id: "build", name: "Build", state: "Passed", tone: "positive" }]}
    />
    <RelationshipChain heading="Packed relationship chain" relationships={packedRelationships} />
    <RelationshipTable heading="Packed relationship table" relationships={packedRelationships} />
    <ReleaseRelay algorithm="relay/v1" codename="Copper Orbit" symbolIndices={[6, 3, 7]} />
    <ReleaseRow onPreview={() => undefined} release={packedRelease} />
    <ReleasePreview
      agentEntry={<span>Packed release agent</span>}
      evidence={<span>Packed release evidence</span>}
      onOpenChange={() => undefined}
      onOpenFullView={() => undefined}
      open={false}
      primaryAction={<Button>Deploy packed release</Button>}
      release={packedRelease}
      stages={<StageRail heading="Packed preview stages" stages={[]} />}
      workset={<span>Packed preview workset</span>}
    />
    <WorksetCard
      gaps={[{
        id: "packed-gap",
        label: "Missing PR relationship",
        reason: "No implementation evidence is linked.",
        service: "codecommit"
      }]}
      heading="Packed release workset"
      jiraItems={[{
        id: "packed-jira-work",
        key: "RPS-6307",
        state: "Candidate",
        title: "Packed Jira release candidate",
        tone: "progress"
      }]}
      pipelines={[{
        id: "packed-pipeline",
        reference: "Execution #42",
        stages: [{ id: "verify", name: "Verify", state: "Passed", tone: "positive" }],
        state: "Passed",
        title: "Packed production pipeline",
        tone: "positive"
      }]}
      pullRequestGroups={[{
        id: "packed-pr-group",
        linkedJiraKeys: ["RPS-6307"],
        reference: "PR #291",
        state: "Approved",
        title: "Packed implementation",
        tone: "positive"
      }]}
    />
    <EntityTable
      columns={[
        { id: "entity", label: "Entity" },
        { id: "state", label: "State", sortable: true, sortDirection: "ascending" }
      ]}
      data={{
        state: "ready",
        rows: [{
          id: "packed-entity",
          cells: [
            { columnId: "entity", content: "Packed Jira issue" },
            { columnId: "state", content: "Ready" }
          ]
        }]
      }}
      heading="Packed entities"
      onSortChange={() => undefined}
    />
    <EntityShell
      actions={<Button>Review entity</Button>}
      agentEntry={<Button>Ask entity agent</Button>}
      collaborators={<span>Packed entity collaborators</span>}
      content={<span>Packed entity content</span>}
      freshness="current"
      reason="The packed entity projection is complete."
      relationships={<RelationshipChain heading="Packed entity relationships" relationships={packedRelationships} />}
      service="jira"
      title="Packed Jira issue"
      tone="positive"
      verdict="Ready"
    />
    <AgentContextButton
      agentName="Release Guardian"
      context="Release v2.4.0 Copper Orbit"
      job={{ count: 1, status: "Review running" }}
    />
    <AgentDrawer
      agentName="Release Guardian"
      capabilities={<span>Packed agent capabilities</span>}
      composer={<span>Packed agent composer</span>}
      context={<span>Packed exact release context</span>}
      contextSummary="Release v2.4.0 Copper Orbit"
      evidence={<span>Packed agent evidence</span>}
      onOpenChange={() => undefined}
      open={false}
      thread={<span>Packed drawer thread</span>}
      title="Packed release agent"
    />
    <AgentThread
      composer={<span>Packed thread composer</span>}
      context={<span>Release v2.4.0 only</span>}
      heading="Packed release thread"
      messages={[
        {
          actor: {
            kind: "human",
            person: { id: "packed-human", name: "Avery Diaz", role: "Release owner" }
          },
          content: createElement("span", null, "Check the current blockers."),
          dateTime: "2026-07-13T14:00:00Z",
          id: "packed-human-message",
          time: "14:00"
        },
        {
          actor: { id: "packed-agent", kind: "agent", name: "Release Guardian", role: "Release agent" },
          content: createElement("span", null, "No current blockers were found."),
          dateTime: "2026-07-13T14:01:00Z",
          id: "packed-agent-message",
          time: "14:01"
        }
      ]}
    />
    <AgentJob
      capability="Sandbox review"
      context={<span>Pull request #291 at 7f4c9b1</span>}
      evidence={<span>Two immutable evidence references</span>}
      heading="Packed sandbox review"
      onCancel={() => undefined}
      progress={42}
      provider="Local Codex"
      revision="7f4c9b1"
      state="running"
    />
    <AgentProposal
      outcome={<span>Awaiting human review</span>}
      proposal={packedAgentProposal}
      state={<span>Proposed</span>}
    />
    <GovernedActionReview
      confirmationLabel="I reviewed this exact target and revision"
      isConfirmed={false}
      onAuthorize={() => undefined}
      onConfirmationChange={() => undefined}
      onReject={() => undefined}
      outcome={<span>No action has been authorized</span>}
      proposal={packedAgentProposal}
      reviewer={{ id: "packed-reviewer", name: "Dev Shah", role: "Human production approver" }}
      state="pending"
    />
    <ol>
      <TimelineRow
        continued={false}
        event={{
          actorKind: "agent",
          dateTime: "2026-07-13T14:00:00Z",
          detail: "The release evidence was checked in a sandbox.",
          id: "packed-event",
          service: "codecommit",
          time: "14:00",
          title: "Packed agent review"
        }}
      />
    </ol>
    <Verdict reason="Every required check matches the current head." tone="positive" verdict="Ready to ship." />
    <Tabs
      aria-label="Packed sections"
      items={[{ content: createElement("span", null, "Packed panel"), label: "Summary", value: "summary" }]}
    />
  </ThemeProvider>
)
if (!markup.includes('data-theme="dark"')) throw new Error("Foundation SSR contract failed")
if (!markup.includes("Packed primitive") || !markup.includes("<button")) throw new Error("Primitive SSR contract failed")
${renderDiffConsumerAssertions()}
if (
  !markup.includes("Jira")
  || !markup.includes("Observed now")
  || !markup.includes("evidence/jira/OPS-428/revision/17")
  || !markup.includes("Avery Diaz")
  || !markup.includes("Casey Singh")
  || !markup.includes("Packed collaborators")
  || !markup.includes("Packed pipeline stages")
  || !markup.includes("Packed relationship chain")
  || !markup.includes("Packed relationship table")
  || !markup.includes("Packed relationship evidence")
  || !markup.includes("Packed release workset")
  || !markup.includes("Packed Jira release candidate")
  || !markup.includes("Packed entities")
  || !markup.includes("Packed entity content")
  || !markup.includes("Packed agent review")
  || !markup.includes("Release Guardian")
  || !markup.includes("Packed release thread")
  || !markup.includes("Packed sandbox review")
  || !markup.includes("This is an agent proposal. It is not human authorization.")
  || !markup.includes("Only the named human reviewer can authorize it.")
  || !markup.includes("I reviewed this exact target and revision")
  || !markup.includes("Release relay, Copper Orbit, symbols bridge, wave, beacon.")
  || !markup.includes("Identity algorithm: relay/v1")
  || !markup.includes("Ready to ship.")
  || !markup.includes("Every required check matches the current head.")
) {
  throw new Error("Pattern SSR contract failed")
}
if (
  !markup.includes("packed-name")
  || !markup.includes('role="combobox"')
  || !markup.includes('role="tablist"')
  || !markup.includes("Open packed dialog")
  || !markup.includes("Open packed sheet")
) {
  throw new Error("Controlled primitive SSR contract failed")
}
void [${references}]
`
  )

  yield* run("pnpm", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], consumer)
  yield* run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], consumer)
  yield* run("node", ["dist/index.js"], consumer)
  yield* fs.writeFileString(
    path.join(sourceDirectory, "field-only.js"),
    `import { Field } from "@knpkv/rly/primitives"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
const markup = renderToStaticMarkup(
  createElement(
    Field,
    { controlId: "tree-shaken-field", description: "Packed description", label: "Packed label" },
    (controlProps) => createElement("input", controlProps)
  )
)
if (!markup.includes('id="tree-shaken-field"') || !markup.includes('aria-describedby="tree-shaken-field-description"')) {
  throw new Error("Field-only bundled SSR contract failed")
}
`
  )
  yield* fs.writeFileString(
    path.join(consumer, "vite.field.config.mjs"),
    `const root = new URL(".", import.meta.url).pathname
export default {
  build: {
    lib: {
      entry: new URL("src/field-only.js", import.meta.url).pathname,
      fileName: "field-only",
      formats: ["es"]
    },
    minify: false,
    outDir: new URL("dist-field", import.meta.url).pathname,
    rollupOptions: { external: ["react", "react/jsx-runtime", "react-dom/server"] }
  },
  logLevel: "silent",
  root
}
`
  )
  const fieldBundleOutput = yield* run(
    "pnpm",
    ["exec", "vite", "build", "--config", "vite.field.config.mjs"],
    consumer
  )
  const fieldBundleDirectory = path.join(consumer, "dist-field")
  if (!(yield* fs.exists(fieldBundleDirectory))) {
    return yield* Effect.fail(
      new PackedPackageError({ reason: `Field-only bundle directory is missing: ${fieldBundleOutput}` })
    )
  }
  const fieldBundleFile = (yield* fs.readDirectory(fieldBundleDirectory))
    .find((file) => file.endsWith(".js") || file.endsWith(".mjs"))
  if (fieldBundleFile === undefined) {
    return yield* Effect.fail(new PackedPackageError({ reason: "Field-only bundle emitted no JavaScript" }))
  }
  const fieldOnlyBundle = yield* fs.readFileString(path.join(fieldBundleDirectory, fieldBundleFile))
  for (
    const leakedImplementation of [
      "Select options must contain",
      "radix-ui",
      "lucide",
      ".add("
    ]
  ) {
    if (fieldOnlyBundle.includes(leakedImplementation)) {
      return yield* Effect.fail(
        new PackedPackageError({
          reason: `Field-only bundle retained unrelated implementation: ${leakedImplementation}`
        })
      )
    }
  }
  yield* run("node", [path.join(fieldBundleDirectory, fieldBundleFile)], consumer)
  yield* fs.writeFileString(path.join(sourceDirectory, "normal-entries.js"), renderNormalEntryConsumer())
  yield* fs.writeFileString(path.join(consumer, "vite.normal.config.mjs"), renderNormalEntryViteConfig())
  yield* run("pnpm", ["exec", "vite", "build", "--config", "vite.normal.config.mjs"], consumer)
  const normalBundleDirectory = path.join(consumer, "dist-normal")
  const normalBundleFiles = (yield* fs.readDirectory(normalBundleDirectory))
    .filter((file) => file.endsWith(".js") || file.endsWith(".mjs"))
  const normalBundleEntry = normalBundleFiles.find((file) => file.startsWith("normal-entries"))
  if (normalBundleEntry === undefined) {
    return yield* Effect.fail(new PackedPackageError({ reason: "Normal-entry bundle has no executable entry" }))
  }
  const normalBundleSources = yield* Effect.forEach(
    normalBundleFiles,
    (file) => fs.readFileString(path.join(normalBundleDirectory, file))
  )
  const leakedDiffImplementation = findLeakedDiffImplementation(normalBundleSources.join("\n"))
  if (leakedDiffImplementation !== undefined) {
    return yield* Effect.fail(
      new PackedPackageError({
        reason: `Normal package entries retained diff implementation: ${leakedDiffImplementation}`
      })
    )
  }
  yield* run("node", [path.join(normalBundleDirectory, normalBundleEntry)], consumer)
  for (const entry of componentManifest.entries) {
    const specifier = entry.subpath === "." ? "@knpkv/rly" : `@knpkv/rly/${entry.subpath.slice(2)}`
    yield* run("node", ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`], consumer)
  }
  yield* run(
    "node",
    [
      "--input-type=module",
      "-e",
      `const resolved = import.meta.resolve("@knpkv/rly/styles.css"); if (!resolved.endsWith("/dist/styles.css")) throw new Error(resolved)`
    ],
    consumer
  )
  for (
    const specifier of [
      "@knpkv/rly/src/index.js",
      "@knpkv/rly/dist/index.js",
      "@knpkv/rly/components/button"
    ]
  ) {
    const deepImportCheck =
      `try { await import(${JSON.stringify(specifier)}); throw new Error('deep import succeeded') } `
      + "catch (error) { if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error }"
    yield* run("node", ["--input-type=module", "-e", deepImportCheck], consumer)
  }

  yield* Console.log(`packed consumer verified ${componentManifest.entries.length} public entries`)
}))

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
