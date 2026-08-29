import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

import {
  CONTROL_CENTER_DEFERRED_DIFF_ARTIFACT_BUDGET,
  CONTROL_CENTER_JAVASCRIPT_ARTIFACT_BUDGETS,
  inspectJavaScriptArtifactBudgets,
  javaScriptArtifactPaths
} from "../../scripts/javascriptArtifactBudget.js"

const matchingDocumentedBudgetRows = (
  source: string,
  target: "client" | "server",
  label: "Client" | "Server"
): ReadonlyArray<string> => {
  const budget = CONTROL_CENTER_JAVASCRIPT_ARTIFACT_BUDGETS[target]
  const budgetPattern = new RegExp(
    `\\|\\s*${budget.rawBytes.toLocaleString("en-US")}\\s*/\\s*${
      budget.gzipBytes.toLocaleString("en-US")
    } bytes\\s*\\|$`,
    "u"
  )
  return source
    .split("\n")
    .filter((line) => line.startsWith(`| ${label} |`) && budgetPattern.test(line))
}

const DOCUMENTED_BUILD_TARGETS: ReadonlyArray<
  readonly [target: "client" | "server", label: "Client" | "Server"]
> = [
  ["client", "Client"],
  ["server", "Server"]
]

describe("JavaScript artifact budgets", () => {
  it.effect("keeps every documented target ceiling synchronized by table row", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageRoot = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))))
      const readme = yield* fileSystem.readFileString(path.join(packageRoot, "README.md"))

      for (const [target, label] of DOCUMENTED_BUILD_TARGETS) {
        expect(matchingDocumentedBudgetRows(readme, target, label)).toHaveLength(1)
      }
    }).pipe(
      // The test runner owns the file-service lifetime for this read-only assertion.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    ))

  it("rejects a stale target row and accepts the configured budget", () => {
    const stale = "| Server | shared chunk | 1 / 1 bytes | 1,650,000 / 290,000 bytes |"
    const current = "| Server | shared chunk | 1 / 1 bytes | 1,650,000 / 292,000 bytes |"

    expect(matchingDocumentedBudgetRows(stale, "server", "Server")).toEqual([])
    expect(matchingDocumentedBudgetRows(current, "server", "Server")).toEqual([current])
  })

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

  it("allows only named deferred diff renderer chunks to use the isolated heavyweight budget", () => {
    const base = CONTROL_CENTER_JAVASCRIPT_ARTIFACT_BUDGETS.client
    const deferred = CONTROL_CENTER_DEFERRED_DIFF_ARTIFACT_BUDGET

    expect(
      inspectJavaScriptArtifactBudgets("client", [
        {
          artifact: "assets/diff-immutable-workbench.js",
          gzipBytes: deferred.gzipBytes,
          rawBytes: deferred.rawBytes
        }
      ])
    ).toEqual([])
    expect(
      inspectJavaScriptArtifactBudgets("client", [
        {
          artifact: "assets/difference-immutable-workbench.js",
          gzipBytes: base.gzipBytes,
          rawBytes: base.rawBytes + 1
        }
      ])
    ).toEqual([
      `client JavaScript artifact "assets/difference-immutable-workbench.js" raw size: actual ${
        base.rawBytes + 1
      } bytes, budget ${base.rawBytes} bytes`
    ])
    expect(
      inspectJavaScriptArtifactBudgets("client", [
        {
          artifact: "assets/wasm-renderer.js",
          gzipBytes: deferred.gzipBytes + 1,
          rawBytes: deferred.rawBytes
        }
      ])
    ).toEqual([
      `client JavaScript artifact "assets/wasm-renderer.js" gzip size: actual ${
        deferred.gzipBytes + 1
      } bytes, budget ${deferred.gzipBytes} bytes`
    ])
  })
})
