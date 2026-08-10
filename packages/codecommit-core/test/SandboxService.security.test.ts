import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { defaultSandboxConfig, validateSandboxConfig } from "../src/ConfigService/index.js"
import { renderDockerPortBinding } from "../src/SandboxService/DockerService.js"
import { makeContainerConfig } from "../src/SandboxService/SandboxService.js"

const homePath = "/Users/security-test"
const validConfig = {
  ...defaultSandboxConfig,
  volumeMounts: []
}

const validate = (config: typeof validConfig) =>
  validateSandboxConfig(config, homePath).pipe(Effect.provide(NodeServices.layer))

describe("sandbox security boundary", () => {
  it.effect("rejects unpinned images and host-authority mounts", () =>
    Effect.gen(function*() {
      const invalidConfigs = [
        { ...validConfig, image: "codercom/code-server:latest" },
        {
          ...validConfig,
          volumeMounts: [{ hostPath: "/", containerPath: "/home/coder/root", readonly: false }]
        },
        {
          ...validConfig,
          volumeMounts: [{ hostPath: "~/.aws", containerPath: "/home/coder/.aws", readonly: false }]
        },
        {
          ...validConfig,
          volumeMounts: [
            {
              hostPath: "/var/run/docker.sock",
              containerPath: "/home/coder/docker.sock",
              readonly: false
            }
          ]
        }
      ]

      for (const config of invalidConfigs) {
        const error = yield* validate(config).pipe(Effect.flip)
        expect(error._tag).toBe("SandboxConfigurationError")
      }
    }))

  it.effect("accepts a digest-pinned image without host mounts", () =>
    validate(validConfig).pipe(
      Effect.map((config) => expect(config).toEqual(validConfig))
    ))

  it.effect("accepts an existing sandbox-volume child and rejects a symlink escape", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-sandbox-policy-" })
        const scopedHome = path.join(root, "home")
        const allowedRoot = path.join(scopedHome, ".codecommit", "sandbox-volumes")
        const safeMount = path.join(allowedRoot, "extensions")
        const outside = path.join(root, "outside")
        yield* fileSystem.makeDirectory(safeMount, { recursive: true })
        yield* fileSystem.makeDirectory(outside, { recursive: true })

        const safeConfig = {
          ...validConfig,
          volumeMounts: [
            {
              hostPath: safeMount,
              containerPath: "/home/coder/.local/share/code-server/extensions",
              readonly: false
            }
          ]
        }
        yield* validateSandboxConfig(safeConfig, scopedHome)

        const escapedMount = path.join(allowedRoot, "escaped")
        yield* fileSystem.symlink(outside, escapedMount)
        const escaped = yield* validateSandboxConfig({
          ...safeConfig,
          volumeMounts: [{ ...safeConfig.volumeMounts[0], hostPath: escapedMount }]
        }, scopedHome).pipe(Effect.flip)
        expect(escaped._tag).toBe("SandboxConfigurationError")
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it("constructs an authenticated loopback-only code-server container", () => {
    const config = makeContainerConfig(
      "/Users/security-test/.codecommit/sandboxes/sbx-1",
      18080,
      "sbx-1",
      "42",
      validConfig,
      homePath,
      "high-entropy-password"
    )

    expect(config.Cmd).toContain("password")
    expect(config.Cmd).not.toContain("none")
    expect(config.Env).toContain("PASSWORD=high-entropy-password")
    expect(config.User).toBe("1000:1000")
    expect(config.HostConfig.CapDrop).toEqual(["ALL"])
    expect(config.HostConfig.PortBindings["8080/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "18080" }
    ])
    expect(
      renderDockerPortBinding("8080/tcp", { HostIp: "127.0.0.1", HostPort: "18080" })
    ).toBe("127.0.0.1:18080:8080")
  })
})
