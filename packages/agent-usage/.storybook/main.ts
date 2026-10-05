import { defineStorybookMain } from "@knpkv/storybook-config/main"

export default defineStorybookMain({ cssModulePrefix: "usage", stories: ["../stories/**/*.stories.@(ts|tsx)"] })
