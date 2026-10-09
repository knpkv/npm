/**
 * The published `@knpkv/relay` carries Pi inside its bundle and nothing of Pi's install weight.
 *
 * Packs the package with `pnpm pack` (so `files` applies as on npm) and checks the tarball:
 * - it ships the bundle, its declarations, the README and the third-party notices, and no other JavaScript;
 * - every static import in `dist/index.js` is a declared dependency (or a subpath of one) or a Node built-in,
 *   so no Pi package, provider SDK or esbuild is imported;
 * - every dynamic import can only reach a Node built-in;
 * - no declaration names a Pi package;
 * - `dist/wire.js` (`@knpkv/relay/wire`) imports only `effect` and `@knpkv/capability`, and a browser consumer
 *   that imports `@knpkv/relay/wire` by package name bundles for the browser.
 */
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import console from "node:console"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { BROWSER_TARGET } from "../../../browser-target.ts"

const forbidden = [
  /^@earendil-works\//u,
  /^@anthropic-ai\//u,
  /^openai$/u,
  /^@google\/genai/u,
  /^@aws-sdk\//u,
  /^esbuild/u
]
const failures = []
const fail = (message) => failures.push(message)

const temporary = mkdtempSync(join(tmpdir(), "relay-packed-"))
try {
  execFileSync("pnpm", ["pack", "--pack-destination", temporary], { stdio: "ignore" })
  const tarball = readdirSync(temporary).find((file) => file.endsWith(".tgz"))
  if (tarball === undefined) throw new Error("pnpm pack wrote nothing")
  execFileSync("tar", ["-xzf", join(temporary, tarball), "-C", temporary])
  const root = join(temporary, "package")
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]

  for (const file of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/wire.js",
    "dist/wire.d.ts",
    "README.md",
    "LICENSE-THIRD-PARTY.md"
  ]) {
    if (!existsSync(join(root, file))) fail(`missing ${file}`)
  }
  const dist = readdirSync(join(root, "dist"))
  const strayJs = dist.filter((file) => file.endsWith(".js") && file !== "index.js" && file !== "wire.js")
  if (strayJs.length > 0) fail(`JavaScript outside the bundle: ${strayJs.join(", ")}`)

  const bundle = readFileSync(join(root, "dist", "index.js"), "utf8")
  const specifiers = [
    ...bundle.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"|^\s*import\s*"([^"]+)"/gmu)
  ].map((match) => match[1] ?? match[2])
  for (const specifier of new Set(specifiers)) {
    const isDeclared = declared.some((name) => specifier === name || specifier.startsWith(`${name}/`))
    if (forbidden.some((pattern) => pattern.test(specifier))) fail(`imports forbidden ${specifier}`)
    else if (!specifier.startsWith("node:") && !isDeclared) fail(`imports undeclared ${specifier}`)
  }

  // A dynamic import is a literal Node built-in, or pi-ai's `importNodeModule` wrapper, whose every call
  // passes a literal Node built-in.
  for (const [call] of bundle.matchAll(/\bimport\(([^)]*)\)/gu)) {
    const literalBuiltin = /^import\("node:[a-z_/]+"\)$/u.test(call)
    const wrapper = call === "import(__rewriteRelativeImportExtension(specifier)"
    if (!literalBuiltin && !wrapper) fail(`dynamic import that can escape the bundle: ${call}`)
  }
  for (const [, argument] of bundle.matchAll(/\bimportNodeModule\(([^)]*)\)/gu)) {
    if (argument !== "specifier" && !/^"node:[a-z_/]+"$/u.test(argument)) {
      fail(`importNodeModule can reach a package: importNodeModule(${argument})`)
    }
  }

  const wire = readFileSync(join(root, "dist", "wire.js"), "utf8")
  const wireSpecifiers = [
    ...wire.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"|^\s*import\s*"([^"]+)"|\bimport\(([^)]*)\)/gmu)
  ].map((match) => match[1] ?? match[2] ?? match[3])
  for (const specifier of new Set(wireSpecifiers)) {
    if (!/^(effect|@knpkv\/capability)(\/|$)/u.test(specifier)) fail(`wire.js imports ${specifier}, not browser-safe`)
  }
  if (wireSpecifiers.length === 0) fail("wire.js imports nothing: the import scan matched no specifier")

  // A page imports the entry by package name, through the tarball's `exports`, and bundles it for the browser.
  // Its dependencies resolve from this package's install; the bundle must take in nothing of the harness.
  const consumer = join(temporary, "consumer")
  mkdirSync(join(consumer, "node_modules", "@knpkv"), { recursive: true })
  symlinkSync(root, join(consumer, "node_modules", "@knpkv", "relay"))
  writeFileSync(
    join(consumer, "entry.js"),
    `import { RelayStreamFrame } from "@knpkv/relay/wire"\nexport const frame = RelayStreamFrame\n`
  )
  const harnessInputs = /@libsql|@earendil-works|ai-claude|ai-codex|ai-runtime|typebox|\/package\/dist\/index\.js$/u
  try {
    const bundled = await build({
      entryPoints: [join(consumer, "entry.js")],
      bundle: true,
      format: "esm",
      logLevel: "silent",
      metafile: true,
      nodePaths: [join(process.cwd(), "node_modules")],
      platform: "browser",
      target: BROWSER_TARGET,
      write: false
    })
    const pulled = Object.keys(bundled.metafile.inputs).filter((input) => harnessInputs.test(input))
    if (pulled.length > 0)
      fail(`a browser bundle of @knpkv/relay/wire takes in the harness: ${pulled.slice(0, 3).join(", ")}`)
    if (!Object.keys(bundled.metafile.inputs).some((input) => input.endsWith("dist/wire.js"))) {
      fail("a browser bundle of @knpkv/relay/wire doesn't contain dist/wire.js")
    }
  } catch (error) {
    fail(`a browser page can't bundle @knpkv/relay/wire: ${error instanceof Error ? error.message : String(error)}`)
  }

  for (const file of dist.filter((name) => name.endsWith(".d.ts"))) {
    if (readFileSync(join(root, "dist", file), "utf8").includes("@earendil-works")) fail(`${file} names a Pi package`)
  }

  if (failures.length > 0) {
    console.error(`@knpkv/relay's package is wrong:\n- ${failures.join("\n- ")}`)
    process.exitCode = 1
  } else {
    console.log(
      `@knpkv/relay packs Pi inside its bundle: ${new Set(specifiers).size} imports, all declared or built in`
    )
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
