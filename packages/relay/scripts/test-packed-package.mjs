/**
 * The published `@knpkv/relay` carries Pi inside its bundle and nothing of Pi's install weight.
 *
 * Packs the package with `pnpm pack` (so `files` applies as on npm) and checks the tarball:
 * - it ships the bundle, its declarations, the README and the third-party notices, and no other JavaScript;
 * - every static import in `dist/index.js` is a declared dependency (or a subpath of one) or a Node built-in,
 *   so no Pi package, provider SDK or esbuild is imported;
 * - every dynamic import can only reach a Node built-in;
 * - no declaration names a Pi package.
 */
import { execFileSync } from "node:child_process"
import console from "node:console"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"

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

  for (const file of ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE-THIRD-PARTY.md"]) {
    if (!existsSync(join(root, file))) fail(`missing ${file}`)
  }
  const dist = readdirSync(join(root, "dist"))
  const strayJs = dist.filter((file) => file.endsWith(".js") && file !== "index.js")
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
