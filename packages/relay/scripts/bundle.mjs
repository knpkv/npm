/**
 * Bundle what Relay uses from Pi into `dist/index.js`, so the published package depends on none of it.
 *
 * Pi's packages declare the Anthropic, OpenAI, Google and Bedrock SDKs and esbuild as hard dependencies,
 * though nothing Relay loads imports them. Until upstream makes those optional, Relay ships the Pi modules
 * it reaches (pi-durable, chord, and pi-ai's core) inside its own bundle, under their MIT licence
 * (LICENSE-THIRD-PARTY.md). Everything Relay declares in `dependencies` or `peerDependencies` stays an
 * import; nothing else may.
 *
 * Runs after `tsc`: the bundle replaces `dist/index.js`, and the per-module `.js` files tsc wrote are
 * removed so no published file imports Pi. Declarations stay as tsc wrote them.
 */
import { build } from "esbuild"
import console from "node:console"
import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

const manifest = JSON.parse(await readFile("package.json", "utf8"))
const imported = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]

const result = await build({
  entryPoints: ["dist/index.js"],
  outfile: "dist/index.js",
  allowOverwrite: true,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  sourcemap: "linked",
  metafile: true,
  // A declared package and its subpaths stay imports; Node's built-ins are external on this platform.
  external: imported.flatMap((name) => [name, `${name}/*`]),
  logLevel: "warning"
})

// Only inputs that put bytes in the bundle count: esbuild also lists modules it read and shook out.
const contributing = Object.entries(result.metafile.outputs["dist/index.js"].inputs)
  .filter(([, input]) => input.bytesInOutput > 0)
  .map(([path]) => path)
const bundled = new Set(
  contributing.flatMap((input) => {
    // pnpm nests packages (`node_modules/.pnpm/<id>/node_modules/<name>`): the last segment names the package.
    const match = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//gu)].at(-1)
    return match === undefined ? [] : [match[1]]
  })
)
const allowed = new Set(["@earendil-works/pi-durable", "@earendil-works/chord", "@earendil-works/pi-ai"])
const unexpected = [...bundled].filter((name) => !allowed.has(name))
if (unexpected.length > 0) {
  throw new Error(`Relay's bundle took in undeclared packages: ${unexpected.join(", ")}. Declare them or drop them.`)
}

// tsc's per-module output: the JavaScript is in the bundle now, and the declarations of Pi-facing internals
// (not reachable from index.d.ts) would name Pi's packages.
const piFacing = ["libsqlDatabase", "piProvider", "piTools"]
for (const file of await readdir("dist")) {
  const module = file.replace(/\.(d\.ts|js)(\.map)?$/u, "")
  const isJs = /\.js(\.map)?$/u.test(file) && module !== "index"
  if (isJs || piFacing.includes(module)) await rm(join("dist", file))
}
console.log(`Relay bundle: ${[...bundled].sort().join(", ")} inlined`)
