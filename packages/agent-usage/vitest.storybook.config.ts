import { storybookTest } from "@storybook/addon-vitest/vitest-plugin"
import { playwright } from "@vitest/browser-playwright"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const packageRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    projects: [{
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
          instances: [
            {
              browser: "chromium",
              name: "light-utc",
              provider: playwright({ contextOptions: { colorScheme: "light", timezoneId: "UTC" } })
            },
            {
              browser: "chromium",
              name: "dark-amsterdam",
              provider: playwright({ contextOptions: { colorScheme: "dark", timezoneId: "Europe/Amsterdam" } })
            }
          ],
          provider: playwright({}),
          screenshotFailures: false,
          trace: "retain-on-failure",
          viewport: {
            height: 800,
            width: 1280
          }
        },
        fileParallelism: false,
        maxConcurrency: 1,
        maxWorkers: 1,
        name: "storybook",
        sequence: {
          concurrent: false
        }
      }
    }]
  }
})
