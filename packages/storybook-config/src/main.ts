/**
 * The shared Storybook main config. Each package's `.storybook/main.ts` calls this with its own
 * story globs, so rly and every web package get the same addons, framework, and build settings.
 *
 * @example
 * export default defineStorybookMain({ stories: ["../stories/**\/*.stories.@(ts|tsx)"] })
 */
import type { StorybookConfig } from "@storybook/react-vite"
import { mergeConfig } from "vite"

export interface StorybookMainOptions {
  /** Story globs relative to the calling `.storybook` directory. */
  readonly stories: ReadonlyArray<string>
  /** CSS Module class prefix, so stories render class names a reader can trace back. */
  readonly cssModulePrefix: string
}

export const defineStorybookMain = (options: StorybookMainOptions): StorybookConfig => ({
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true
  },
  docs: {
    defaultName: "Documentation"
  },
  framework: {
    name: "@storybook/react-vite",
    options: {}
  },
  stories: [...options.stories],
  viteFinal: (viteConfig) =>
    mergeConfig(viteConfig, {
      build: {
        // Storybook intentionally bundles its renderer and documentation tooling.
        chunkSizeWarningLimit: 1200,
        rolldownOptions: {
          checks: {
            // This diagnostic is timing-dependent; the build-output gate still rejects known warning codes.
            pluginTimings: false
          }
        }
      },
      css: {
        modules: {
          generateScopedName: `${options.cssModulePrefix}_[name]__[local]`
        }
      }
    })
})
