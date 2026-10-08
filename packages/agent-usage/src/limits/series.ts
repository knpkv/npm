import type { Agent } from "../core/Model.js"

/**
 * A limit series' identity on the page, matching the report's: Codex windows by length (a plan
 * change moves a window between slots), Claude windows by name.
 */
export const seriesIdentity = (series: {
  readonly agent: Agent
  readonly label: string
  readonly windowMinutes: number | null
}): string =>
  series.agent === "codex" && series.windowMinutes !== null
    ? `codex:${series.windowMinutes}m`
    : `${series.agent}:${series.label}`
