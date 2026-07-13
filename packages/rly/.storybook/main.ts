import type { StorybookConfig } from "@storybook/react-vite"

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
  stories: ["../stories/**/*.stories.@(ts|tsx)"]
} satisfies StorybookConfig

export default config
