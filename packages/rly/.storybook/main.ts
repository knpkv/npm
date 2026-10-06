import { defineStorybookMain } from "@knpkv/storybook-config/main"

export default defineStorybookMain({ cssModulePrefix: "rly", stories: ["../stories/**/*.stories.@(ts|tsx)"] })
