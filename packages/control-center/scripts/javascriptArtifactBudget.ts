import type { ControlCenterBuildTarget } from "./build-graph.js"

export interface JavaScriptArtifactBudget {
  readonly gzipBytes: number
  readonly rawBytes: number
}

export interface JavaScriptArtifactMeasurement {
  readonly artifact: string
  readonly gzipBytes: number
  readonly rawBytes: number
}

/** Per-file ceilings for every emitted runtime JavaScript artifact. */
export const CONTROL_CENTER_JAVASCRIPT_ARTIFACT_BUDGETS = {
  client: { gzipBytes: 80_000, rawBytes: 270_000 },
  server: { gzipBytes: 290_000, rawBytes: 1_650_000 }
} satisfies Readonly<Record<ControlCenterBuildTarget, JavaScriptArtifactBudget>>

/** Ceiling for named, deferred syntax-renderer chunks outside the initial application closure. */
export const CONTROL_CENTER_DEFERRED_DIFF_ARTIFACT_BUDGET = {
  gzipBytes: 240_000,
  rawBytes: 800_000
} satisfies JavaScriptArtifactBudget

const DeferredDiffArtifact = /^assets\/(?:cpp|diff|emacs-lisp|wasm|wolfram)-[A-Za-z0-9_-]+\.js$/u

const budgetForArtifact = (
  target: ControlCenterBuildTarget,
  artifact: string
): JavaScriptArtifactBudget =>
  target === "client" && DeferredDiffArtifact.test(artifact)
    ? CONTROL_CENTER_DEFERRED_DIFF_ARTIFACT_BUDGET
    : CONTROL_CENTER_JAVASCRIPT_ARTIFACT_BUDGETS[target]

/** Select runtime JavaScript artifacts while excluding maps and build metadata. */
export const javaScriptArtifactPaths = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
  files.filter((file) => file.endsWith(".js")).sort()

/** Return raw and compressed per-artifact budget violations for one build target. */
export const inspectJavaScriptArtifactBudgets = (
  target: ControlCenterBuildTarget,
  artifacts: ReadonlyArray<JavaScriptArtifactMeasurement>
): ReadonlyArray<string> => {
  const violations: Array<string> = []

  for (const artifact of [...artifacts].sort((left, right) => left.artifact.localeCompare(right.artifact))) {
    const budget = budgetForArtifact(target, artifact.artifact)
    if (artifact.rawBytes > budget.rawBytes) {
      violations.push(
        `${target} JavaScript artifact ${
          JSON.stringify(artifact.artifact)
        } raw size: actual ${artifact.rawBytes} bytes, budget ${budget.rawBytes} bytes`
      )
    }
    if (artifact.gzipBytes > budget.gzipBytes) {
      violations.push(
        `${target} JavaScript artifact ${
          JSON.stringify(artifact.artifact)
        } gzip size: actual ${artifact.gzipBytes} bytes, budget ${budget.gzipBytes} bytes`
      )
    }
  }

  return violations
}
