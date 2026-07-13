import { readFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(docsRoot, "../..")
const docsSourcePath = resolve(docsRoot, "src/content/docs/rly.mdx")
const packageJsonPath = resolve(workspaceRoot, "packages/rly/package.json")
const sourceOnly = process.argv.includes("--source-only")

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"))
const docsSource = await readFile(docsSourcePath, "utf8")
const packageJson = await readJson(packageJsonPath)
const publicExports = Object.keys(packageJson.exports ?? {}).map((subpath) =>
  subpath === "." ? "@knpkv/rly" : `@knpkv/rly/${subpath.slice(2)}`
)
const documentedExports = new Set(docsSource.match(/@knpkv\/rly(?:\/[A-Za-z0-9._/-]+)?/g) ?? [])
const failures = []

const sourceBarrelFor = (specifier) => {
  const subpath = specifier === "@knpkv/rly" ? "" : specifier.slice("@knpkv/rly/".length)
  const packageTarget = packageJson.exports?.[subpath === "" ? "." : `./${subpath}`]
  return typeof packageTarget === "object" && packageTarget !== null
    ? resolve(workspaceRoot, "packages/rly/src", subpath, "index.ts")
    : undefined
}

const collectBarrelExports = async (barrelPath, visited = new Set()) => {
  if (visited.has(barrelPath)) return new Set()
  visited.add(barrelPath)
  const source = await readFile(barrelPath, "utf8")
  const names = new Set()

  for (const match of source.matchAll(/export(?:\s+type)?\s*\{([\s\S]*?)\}\s*from\s*"[^"]+"/g)) {
    for (const item of match[1].split(",")) {
      const name = item
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .at(-1)
      if (name) names.add(name)
    }
  }

  for (const match of source.matchAll(/export\s+\*\s+from\s+"([^"]+)"/g)) {
    const target = resolve(dirname(barrelPath), match[1].replace(/\.js$/, ".ts"))
    for (const name of await collectBarrelExports(target, visited)) names.add(name)
  }

  return names
}

for (const exportName of publicExports) {
  if (!documentedExports.has(exportName)) failures.push(`undocumented public export ${exportName}`)
}
for (const exportName of documentedExports) {
  if (!publicExports.includes(exportName)) failures.push(`docs reference unpublished export ${exportName}`)
}

for (const match of docsSource.matchAll(
  /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+"(@knpkv\/rly(?:\/[A-Za-z0-9._/-]+)?)"/g
)) {
  const [, bindings, specifier] = match
  const barrelPath = sourceBarrelFor(specifier)
  if (barrelPath === undefined) {
    failures.push(`named import uses non-JavaScript export ${specifier}`)
    continue
  }
  const availableNames = await collectBarrelExports(barrelPath)
  for (const binding of bindings.split(",")) {
    const importedName = binding
      .trim()
      .replace(/^type\s+/, "")
      .split(/\s+as\s+/)[0]
    if (importedName && !availableNames.has(importedName)) {
      failures.push(`${specifier} does not export example symbol ${importedName}`)
    }
  }
}

for (const heading of ["Install", "Exports", "Tokens", "Themes", "Catalog", "Registry", "Examples"]) {
  if (!docsSource.includes(`## ${heading}`)) failures.push(`missing ${heading} section`)
}
if (!docsSource.includes("](/rly/catalog/)")) failures.push("missing direct /rly/catalog/ link")
if (!/never\s+loaded as data to execute React at runtime/.test(docsSource)) {
  failures.push("registry runtime boundary is not explicit")
}

if (!sourceOnly) {
  const outputFiles = [
    "dist/rly/index.html",
    "dist/rly/catalog/index.html",
    "dist/rly/catalog/iframe.html",
    "dist/rly/catalog/index.json"
  ]
  for (const relativePath of outputFiles) {
    const entry = await stat(resolve(docsRoot, relativePath)).catch(() => undefined)
    if (!entry?.isFile()) failures.push(`missing composed output ${relativePath}`)
  }

  const pageOutput = await readFile(resolve(docsRoot, "dist/rly/index.html"), "utf8").catch(() => "")
  if (!pageOutput.includes('href="/rly/catalog/"')) failures.push("built rly page does not link to composed catalog")

  const catalogIndex = await readJson(resolve(docsRoot, "dist/rly/catalog/index.json")).catch(() => undefined)
  if (catalogIndex?.entries?.["catalog-overview--default"]?.type !== "story") {
    failures.push("composed catalog is missing its overview story")
  }

  for (const file of ["index.html", "iframe.html"]) {
    const catalogHtml = await readFile(resolve(docsRoot, "dist/rly/catalog", file), "utf8").catch(() => "")
    if (/(?:src|href)="\//.test(catalogHtml)) {
      failures.push(`composed catalog ${file} contains root-absolute assets`)
    }
  }
}

if (failures.length > 0) throw new Error(`rly docs validation failed:\n- ${failures.join("\n- ")}`)

console.log(
  `validated rly docs against ${publicExports.length} public exports${sourceOnly ? "" : " and composed catalog"}`
)
