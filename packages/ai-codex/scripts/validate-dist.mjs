import { URL } from "node:url"

const publicEntry = await import(new URL("../dist/index.js", import.meta.url))
const exportedNames = Object.keys(publicEntry).sort()

if (exportedNames.join(",") !== "model,streamEvents") {
  throw new Error(`Unexpected public exports: ${exportedNames.join(", ")}`)
}
