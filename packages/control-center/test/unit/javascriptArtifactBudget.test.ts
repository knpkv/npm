import { describe, expect, it } from "vitest"

import {
  CONTROL_CENTER_JAVASCRIPT_ARTIFACT_BUDGETS,
  inspectJavaScriptArtifactBudgets,
  javaScriptArtifactPaths
} from "../../scripts/javascriptArtifactBudget.js"

describe("JavaScript artifact budgets", () => {
  it("selects every JavaScript artifact and excludes maps and build metadata", () => {
    expect(
      javaScriptArtifactPaths([
        "dist/client/build-graph.json",
        "dist/client/assets/client.js.map",
        "dist/client/assets/client.js",
        "dist/client/.vite/manifest.json",
        "dist/client/assets/runtime.js"
      ])
    ).toEqual(["dist/client/assets/client.js", "dist/client/assets/runtime.js"])
  })

  it("rejects a fixture artifact over the raw-byte budget", () => {
    const budget = CONTROL_CENTER_JAVASCRIPT_ARTIFACT_BUDGETS.client

    expect(
      inspectJavaScriptArtifactBudgets("client", [
        {
          artifact: "assets/raw-overflow.js",
          gzipBytes: budget.gzipBytes,
          rawBytes: budget.rawBytes + 1
        }
      ])
    ).toEqual([
      `client JavaScript artifact "assets/raw-overflow.js" raw size: actual ${
        budget.rawBytes + 1
      } bytes, budget ${budget.rawBytes} bytes`
    ])
  })

  it("rejects a fixture artifact over the gzip-byte budget", () => {
    const budget = CONTROL_CENTER_JAVASCRIPT_ARTIFACT_BUDGETS.server

    expect(
      inspectJavaScriptArtifactBudgets("server", [
        {
          artifact: "assets/gzip-overflow.js",
          gzipBytes: budget.gzipBytes + 1,
          rawBytes: budget.rawBytes
        }
      ])
    ).toEqual([
      `server JavaScript artifact "assets/gzip-overflow.js" gzip size: actual ${
        budget.gzipBytes + 1
      } bytes, budget ${budget.gzipBytes} bytes`
    ])
  })
})
