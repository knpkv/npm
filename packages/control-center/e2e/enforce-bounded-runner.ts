import type { FullConfig } from "@playwright/test"

/** Fail when a CLI or environment override makes the browser run unbounded. */
export const enforceBoundedRunner = (workers: number, fullyParallel: boolean): void => {
  if (workers !== 1) throw new Error(`Control Center E2E requires exactly one worker; received ${workers}`)
  if (fullyParallel) throw new Error("Control Center E2E cannot run fully parallel")
}

const enforceResolvedPlaywrightConfig = (config: FullConfig): void => {
  enforceBoundedRunner(config.workers, config.fullyParallel)
}

export default enforceResolvedPlaywrightConfig
