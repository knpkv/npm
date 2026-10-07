import { storybookTest } from "@storybook/addon-vitest/vitest-plugin"
import { playwright } from "@vitest/browser-playwright"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config"
import { COARSE_POINTER_LAUNCH_ARGS } from "./scripts/browser/coarse-pointer.js"

const packageRoot = dirname(fileURLToPath(import.meta.url))

/** One Storybook test project: its name, browser page size, and the Storybook viewport it selects. */
interface StoryProject {
  readonly name: string
  readonly page: { readonly height: number; readonly width: number }
  /** A key of Storybook's viewport options (MINIMAL_VIEWPORTS), or undefined for the preview default. */
  readonly storyViewport?: string
  /** Chromium reports a coarse primary pointer, so `(pointer: coarse)` matches and touch floors apply. */
  readonly coarsePointer?: boolean
}

/**
 * Every story's play test runs three times: on a desktop, on a phone, and with a coarse (touch)
 * pointer. A play that only holds at one width or pointer (a rail that becomes a sheet, a row that
 * wraps, a size floored at 44px under touch) must check what actually rendered, so CI catches the
 * failure instead of review shots finding it later.
 *
 * The phone width comes from Storybook's `viewport` global: the addon resizes the page to the
 * story's viewport global before each play, so a browser viewport alone would be overridden by the
 * preview's desktop default. Stories that pin their own viewport keep it in both projects.
 * `test:storybook` runs the projects as separate invocations, because two browser projects in one
 * run raced Vite's dependency optimiser and left story iframes uninitialised.
 */
const storyProject = (
  { coarsePointer = false, name, page, storyViewport }: StoryProject
): TestProjectInlineConfiguration => ({
  extends: true,
  plugins: [
    storybookTest(
      storyViewport === undefined
        ? { configDir: join(packageRoot, ".storybook") }
        : {
          configDir: join(packageRoot, ".storybook"),
          // rlyPointer marks the touch project for the ThemeSelect environment canary.
          initialGlobals: coarsePointer
            ? { rlyPointer: "coarse", viewport: { isRotated: false, value: storyViewport } }
            : { viewport: { isRotated: false, value: storyViewport } }
        }
    )
  ],
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright(coarsePointer ? { launchOptions: { args: [...COARSE_POINTER_LAUNCH_ARGS] } } : {}),
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
      storyProject({ name: "storybook-phone", page: { height: 568, width: 320 }, storyViewport: "mobile1" }),
      // mobile2 (414×896) with a touch pointer: the 44px coarse-pointer floor, on a larger phone.
      storyProject({
        coarsePointer: true,
        name: "storybook-touch",
        page: { height: 896, width: 414 },
        storyViewport: "mobile2"
      })
    ]
  }
})
