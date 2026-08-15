/**
 * The root barrel is the published surface.
 *
 * The changeset advertises `planRelatedWorkSync` as the reusable planning step,
 * but nothing re-exported it and `package.json` exposed no `VersionService`
 * subpath, so both `import { planRelatedWorkSync } from "@knpkv/jira-cli"` and
 * the natural subpath import would have failed after publication.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Predicate from "effect/Predicate"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as api from "../src/index.js"

const manifestExports = (): ReadonlyArray<string> => {
  const parsed: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
  )
  if (!Predicate.isObject(parsed)) return []
  const exports = parsed["exports"]
  return Predicate.isObject(exports) ? Object.keys(exports) : []
}

describe("@knpkv/jira-cli public API", () => {
  it("exports the related-work planner the changeset advertises", () => {
    expect(Predicate.isFunction(api.planRelatedWorkSync)).toBe(true)
    expect(api.VersionService).toBeDefined()
    expect(api.VersionServiceLayer).toBeDefined()
  })

  it("declares a VersionService subpath alongside the other services", () => {
    expect(manifestExports()).toContain("./VersionService")
  })
})
