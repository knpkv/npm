import { expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"

import { renderReport } from "../src/report.js"
import { verdict } from "../src/verdict.js"
import { failure, identity, manifest } from "./models.js"

it.effect("failure copy cannot inject report HTML", () =>
  Effect.sync(() => {
    const result = verdict(manifest, [{ ...failure, detail: "<script>alert(\"fixture\")</script>" }], [], [{
      ...identity,
      touched: true,
      artifacts: { ref: "ref.png", live: "live.png", "diff-frame": "diff.png" }
    }], DateTime.makeUnsafe("2026-10-19T00:00:00.000Z"))
    const html = renderReport(result)
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    for (const label of ["ref", "live", "diff-frame"]) expect(html).toContain(`<figcaption>${label}</figcaption>`)
  }))
