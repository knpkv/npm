import { describe, expect, it } from "@effect/vitest"
import { defaultSandboxConfig } from "@knpkv/codecommit-core/ConfigService.js"
import { makeContainerConfig } from "@knpkv/codecommit-core/SandboxService/SandboxService.js"
import { COMMAND_PRESETS, MOUNT_PRESETS, sandboxRuntimeXdgDataHome } from "../src/client/sandbox-presets.js"

describe("sandbox presets", () => {
  it("aligns persistence mounts with the effective code-server data directory", () => {
    const config = makeContainerConfig(
      "/workspace/sbx-1",
      18080,
      "sbx-1",
      "42",
      defaultSandboxConfig,
      "/Users/security-test",
      "1001:1001",
      "password"
    )

    expect(config.Env).toContain(`XDG_DATA_HOME=${sandboxRuntimeXdgDataHome}`)
    for (const preset of MOUNT_PRESETS) {
      expect(preset.mount.containerPath.startsWith(`${sandboxRuntimeXdgDataHome}/code-server/`)).toBe(true)
    }
  })

  it("keeps setup presets compatible with a capability-free non-root container", () => {
    for (const preset of COMMAND_PRESETS) {
      expect(preset.cmd).not.toMatch(/\bsudo\b/u)
    }
  })
})
