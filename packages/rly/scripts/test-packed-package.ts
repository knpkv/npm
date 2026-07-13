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
import { Button, Field, Select, Surface, Tabs, Text } from "@knpkv/rly/primitives"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

const RouterLink: RlyLinkComponent = (props) => <a {...props} data-router-destination={props.href} />
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
    </PortalProvider>
    <Surface><Text>Packed primitive</Text><Button>Continue</Button></Surface>
    <Tabs
      aria-label="Packed sections"
      items={[{ content: createElement("span", null, "Packed panel"), label: "Summary", value: "summary" }]}
    />
  </ThemeProvider>
)
if (!markup.includes('data-theme="dark"')) throw new Error("Foundation SSR contract failed")
if (!markup.includes("Packed primitive") || !markup.includes("<button")) throw new Error("Primitive SSR contract failed")
if (!markup.includes("packed-name") || !markup.includes('role="combobox"') || !markup.includes('role="tablist"')) {
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
