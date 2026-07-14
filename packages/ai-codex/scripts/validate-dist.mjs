import { URL } from "node:url"

const publicEntry = await import(new URL("../dist/index.js", import.meta.url))
const exportedNames = Object.keys(publicEntry).sort()

if (exportedNames.length !== 1 || exportedNames[0] !== "model") {
  throw new Error(`Unexpected public exports: ${exportedNames.join(", ")}`)
}
