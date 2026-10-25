import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const source = join(import.meta.dirname, "..", "src")

/** Every TypeScript file under `directory`, recursively. */
const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : /\.tsx?$/u.test(entry.name)
      ? [join(directory, entry.name)]
      : []
  )

describe("browser runtimes", () => {
  // A browser runtime built on the bare fetch client sends its writes without the session's CSRF token, and
  // the hub refuses every one. Only the session CSRF module may take the browser client; every runtime that
  // writes takes its layer.
  it("build their HTTP client only through the session CSRF layer", () => {
    const bare = sourceFiles(source)
      .filter((file) => relative(source, file) !== "session-csrf.ts")
      .filter((file) => readFileSync(file, "utf8").includes("BrowserHttpClient"))
      .map((file) => relative(source, file))
    expect(bare).toEqual([])
    expect(readFileSync(join(source, "session-csrf.ts"), "utf8")).toContain("BrowserHttpClient.layerFetch")
  })
})
