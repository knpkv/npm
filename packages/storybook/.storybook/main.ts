import type { StorybookConfig } from "@storybook/react-vite";
import path from "path";

// import wasm from "vite-plugin-wasm";
// import topLevelAwait from "vite-plugin-top-level-await";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const config: StorybookConfig = {
  stories: [
    "../../codecommit-tui/src/**/*.stories.@(js|jsx|mjs|ts|tsx)"
  ],
  addons: [
    "@storybook/addon-essentials",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  async viteFinal(config) {
    return {
      ...config,
      assetsInclude: [
        "**/*.scm"
      ],
      plugins: [
        ...(config.plugins ?? []),
        // wasm(),
        // topLevelAwait(),
        nodePolyfills()
      ],
      optimizeDeps: {
        ...config.optimizeDeps,
        exclude: [
          ...(config.optimizeDeps?.exclude ?? []),
          "@effect-atom/atom-react",
          "effect",
          "@effect/platform",
          "@effect/platform-browser",
          "@effect/platform-bun",
          // "@opentui/core", // Mocked
          // "@opentui/react" // Mocked
        ],
      },
      esbuild: {
        ...config.esbuild,
        jsxImportSource: "@knpkv/storybook/runtime",
      },
      resolve: {
        dedupe: ["react", "react-dom", "@effect-atom/atom-react"],
        ...config.resolve,
        alias: {
          ...config.resolve?.alias,
          // Force all scheduler usage to the one inside storybook's node_modules (via react-dom)
          "scheduler": path.resolve(__dirname, "../../../node_modules/.pnpm/scheduler@0.27.0/node_modules/scheduler"),
          "@knpkv/storybook/runtime": path.resolve(__dirname, "../src/runtime"),
          "@knpkv/codecommit-tui": path.resolve(__dirname, "../../codecommit-tui/src"),
          "@mocks": path.resolve(__dirname, "../src/mocks"),
          "@opentui/core": path.resolve(__dirname, "../src/mocks/opentui-core.ts"),
          "@opentui/react": path.resolve(__dirname, "../src/mocks/opentui-react.ts"),
          "fs": path.resolve(__dirname, "../src/mocks/fs.ts"),
          "fs/promises": path.resolve(__dirname, "../src/mocks/fs-promises.ts"),
          "env": path.resolve(__dirname, "../src/mocks/env.ts"),
          "distilled-aws": path.resolve(__dirname, "../src/mocks/distilled-aws"),
          "@aws-sdk/credential-providers": path.resolve(__dirname, "../src/mocks/aws-sdk-credential-providers.ts"),
          [path.resolve(__dirname, "../../codecommit-tui/src/AwsClient.ts")]: path.resolve(__dirname, "../src/mocks/AwsClient.ts"),
          [path.resolve(__dirname, "../../codecommit-tui/src/ConfigService.ts")]: path.resolve(__dirname, "../src/mocks/ConfigService.ts"),
          [path.resolve(__dirname, "../../codecommit-tui/src/tui/atoms/runtime.ts")]: path.resolve(__dirname, "../src/mocks/runtime.ts"),
        },
      },
      build: {
        ...config.build,
        rollupOptions: {
          ...config.build?.rollupOptions,
          external: [
            ...(Array.isArray(config.build?.rollupOptions?.external) ? config.build.rollupOptions.external : []),
            // "env" // Removed env from external because we alias it now
          ]
        }
      },
    };
  },
};
export default config;
