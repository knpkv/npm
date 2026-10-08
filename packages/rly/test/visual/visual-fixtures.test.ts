import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const visual = join(import.meta.dirname, "../../visual")

// Visual specs must take `test` from visual/fixtures.ts, which pins Geist with font-display: block; a
// spec on Playwright's own `test` measures whichever face happened to load (optional fonts swap late).
describe("visual spec fixtures", () => {
  it("routes every visual spec but the font-swap spec through the Geist-pinning fixture", () => {
    const direct = readdirSync(visual)
      .filter((file) => file.endsWith(".spec.ts"))
      .filter((file) =>
        /^import \{[^}]*\btest\b[^}]*\} from "@playwright\/test"/m.test(readFileSync(join(visual, file), "utf8"))
      )
    expect(direct).toEqual(["font-swap.spec.ts"])
  })
})
