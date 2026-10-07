import { storybookTest } from "@storybook/addon-vitest/vitest-plugin"
import { playwright } from "@vitest/browser-playwright"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const packageRoot = dirname(fileURLToPath(import.meta.url))

/** A browser viewport for one Storybook test project. */
interface StoryViewport {
  readonly height: number
  readonly width: number
}

/**
 * Every story's play test runs twice, on a desktop and on a phone. A play that only holds at one
 * width (a rail that becomes a sheet, a row that wraps) must branch on the viewport, so CI catches a
 * phone-only failure instead of review shots finding it later. `test:storybook` runs the projects as
 * separate invocations: two browser projects in one run raced Vite's dependency optimiser and left
 * story iframes uninitialised.
 */
const storyProject = (name: string, viewport: StoryViewport) => ({
  extends: true,
  plugins: [
    storybookTest({
      configDir: join(packageRoot, ".storybook")
    })
  ],
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright({}),
      screenshotFailures: false,
      trace: "retain-on-failure",
      viewport
    },
    fileParallelism: false,
    maxConcurrency: 1,
    maxWorkers: 1,
    name,
    sequence: {
      concurrent: false
    }
  }
})

export default defineConfig({
  test: {
    projects: [
      storyProject("storybook", { height: 800, width: 1280 }),
      storyProject("storybook-phone", { height: 844, width: 320 })
    ]
  }
})
