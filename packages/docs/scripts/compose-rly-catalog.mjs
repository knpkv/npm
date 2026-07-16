import { cp, mkdir, rm, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const catalogSource = resolve(docsRoot, "../rly/storybook-static")
const catalogTarget = resolve(docsRoot, "dist/rly/catalog")
const requiredFiles = ["index.html", "iframe.html", "index.json"]

for (const file of requiredFiles) {
  const entry = await stat(resolve(catalogSource, file)).catch(() => undefined)
  if (!entry?.isFile()) {
    throw new Error(`Cannot compose the rly catalog: missing storybook-static/${file}`)
  }
}

await rm(catalogTarget, { force: true, recursive: true })
await mkdir(dirname(catalogTarget), { recursive: true })
await cp(catalogSource, catalogTarget, { recursive: true })

console.log("composed rly catalog at docs/dist/rly/catalog/")
