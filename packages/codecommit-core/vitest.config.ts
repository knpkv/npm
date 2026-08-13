import { mergeConfig, defineConfig } from "vitest/config"
import shared from "../../vitest.shared.ts"

export default mergeConfig(
  shared,
  defineConfig({})
)
