import { expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"

import { renderReport, reportSummary } from "../src/report.js"
import { verdict } from "../src/verdict.js"
import { failure, identity, manifest } from "./models.js"

it.effect("failure copy cannot inject report HTML", () =>
  Effect.sync(() => {
    const result = verdict(manifest, [{ ...failure, detail: "<script>alert(\"fixture\")</script>" }], [], [{
      ...identity,
      touched: true,
      touchedRegions: ["content"],
      outsidePixelsChanged: false,
      artifacts: { ref: "ref.png", live: "live.png", "diff-frame": "diff.png" }
    }], DateTime.makeUnsafe("2026-10-19T00:00:00.000Z"))
    const html = renderReport(result)
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    for (const label of ["ref", "live", "diff-frame"]) expect(html).toContain(`<figcaption>${label}</figcaption>`)
  }))

it.effect("reference drift details cannot split CI summary table rows or inject HTML", () =>
  Effect.sync(() => {
    const result = verdict(manifest, [{ ...failure, detail: "nav | 1%\n<script>" }], [], [{
      ...identity,
      touched: false,
      touchedRegions: [],
      outsidePixelsChanged: false,
      artifacts: {}
    }], DateTime.makeUnsafe("2026-10-17T00:00:00.000Z"))
    const report = reportSummary(result)
    expect(report).toContain("report-only (inherited/legacy)")
    expect(report).toContain("nav \\| 1% &lt;script&gt;")
    expect(report).not.toContain("<script>")
    expect(report.split("\n").filter((line) => line.startsWith("|"))).toHaveLength(3)
  }))
