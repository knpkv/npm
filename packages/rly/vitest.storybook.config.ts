import { storybookTest } from "@storybook/addon-vitest/vitest-plugin"
import { playwright } from "@vitest/browser-playwright"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config"

const packageRoot = dirname(fileURLToPath(import.meta.url))

/** One Storybook test project: its name, browser page size, and the Storybook viewport it selects. */
interface StoryProject {
  readonly name: string
  readonly page: { readonly height: number; readonly width: number }
  /** A key of Storybook's viewport options (MINIMAL_VIEWPORTS), or undefined for the preview default. */
  readonly storyViewport?: string
}

/**
 * Every story's play test runs twice, on a desktop and on a phone. A play that only holds at one
 * width (a rail that becomes a sheet, a row that wraps) must branch on the viewport, so CI catches a
 * phone-only failure instead of review shots finding it later.
 *
 * The phone width comes from Storybook's `viewport` global: the addon resizes the page to the
 * story's viewport global before each play, so a browser viewport alone would be overridden by the
 * preview's desktop default. Stories that pin their own viewport keep it in both projects.
 * `test:storybook` runs the projects as separate invocations, because two browser projects in one
 * run raced Vite's dependency optimiser and left story iframes uninitialised.
 */
const storyProject = ({ name, page, storyViewport }: StoryProject): TestProjectInlineConfiguration => ({
  extends: true,
  plugins: [
    storybookTest(
      storyViewport === undefined
        ? { configDir: join(packageRoot, ".storybook") }
        : {
          configDir: join(packageRoot, ".storybook"),
          initialGlobals: { viewport: { isRotated: false, value: storyViewport } }
        }
    )
  ],
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright({}),
      screenshotFailures: false,
      trace: "retain-on-failure",
      viewport: page
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
      storyProject({ name: "storybook", page: { height: 800, width: 1280 } }),
      // mobile1 is Storybook's 320×568 phone, the visual bar's narrowest width.
      storyProject({ name: "storybook-phone", page: { height: 568, width: 320 }, storyViewport: "mobile1" })
    ]
  }
})
