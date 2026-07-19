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
  client: { gzipBytes: 70_000, rawBytes: 235_000 },
  server: { gzipBytes: 290_000, rawBytes: 1_650_000 }
} satisfies Readonly<Record<ControlCenterBuildTarget, JavaScriptArtifactBudget>>

/** Select runtime JavaScript artifacts while excluding maps and build metadata. */
export const javaScriptArtifactPaths = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
  files.filter((file) => file.endsWith(".js")).sort()

/** Return raw and compressed per-artifact budget violations for one build target. */
export const inspectJavaScriptArtifactBudgets = (
  target: ControlCenterBuildTarget,
  artifacts: ReadonlyArray<JavaScriptArtifactMeasurement>
): ReadonlyArray<string> => {
  const budget = CONTROL_CENTER_JAVASCRIPT_ARTIFACT_BUDGETS[target]
  const violations: Array<string> = []

  for (const artifact of [...artifacts].sort((left, right) => left.artifact.localeCompare(right.artifact))) {
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
