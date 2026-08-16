import type { StorybookConfig } from "@storybook/react-vite"
import { mergeConfig } from "vite"

const config = {
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
  stories: ["../stories/**/*.stories.@(ts|tsx)"],
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
          generateScopedName: "rly_[name]__[local]"
        }
      }
    })
} satisfies StorybookConfig

export default config
