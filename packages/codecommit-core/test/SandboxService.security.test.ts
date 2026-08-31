/** @effect-diagnostics strictEffectProvide:skip-file */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Layer, Sink, Stream } from "effect"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { rename as nodeRename, symlink as nodeSymlink } from "node:fs/promises"
import { ensurePrivateDatabasePath } from "../src/CacheService/Database.js"
import {
  makeEnsurePrivateDatabasePath,
  nodePrivateDatabasePathOperations
} from "../src/CacheService/internal/PrivateDatabasePathNode.js"
import { defaultSandboxConfig, validateSandboxConfig } from "../src/ConfigService/index.js"
import type { SandboxConfig } from "../src/ConfigService/internal.js"
import { DockerService, isMissingContainerError, renderDockerPortBinding } from "../src/SandboxService/DockerService.js"
import { makeContainerConfig, sandboxContainerIdentityForWorkspaceOwner } from "../src/SandboxService/SandboxService.js"

const homePath = "/Users/security-test"
const validConfig: SandboxConfig = {
  ...defaultSandboxConfig,
  volumeMounts: []
}

const validate = (config: SandboxConfig) =>
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
        },
        {
          ...validConfig,
          env: { PASSWORD: "must-not-override-server-credential" }
        },
        {
          ...validConfig,
          env: { SAFE_NAME: "value\nPASSWORD=injected" }
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
        yield* validateSandboxConfig({
          ...safeConfig,
          volumeMounts: [{
            ...safeConfig.volumeMounts[0],
            containerPath: "/tmp/.local/share/code-server/extensions"
          }]
        }, scopedHome)

        const broadTemporaryMount = yield* validateSandboxConfig({
          ...safeConfig,
          volumeMounts: [{ ...safeConfig.volumeMounts[0], containerPath: "/tmp/credentials" }]
        }, scopedHome).pipe(Effect.flip)
        expect(broadTemporaryMount._tag).toBe("SandboxConfigurationError")

        const escapedMount = path.join(allowedRoot, "escaped")
        yield* fileSystem.symlink(outside, escapedMount)
        const escaped = yield* validateSandboxConfig({
          ...safeConfig,
          volumeMounts: [{ ...safeConfig.volumeMounts[0], hostPath: escapedMount }]
        }, scopedHome).pipe(Effect.flip)
        expect(escaped._tag).toBe("SandboxConfigurationError")
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a sandbox volume root that redirects through a symlink", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-sandbox-root-" })
        const scopedHome = path.join(root, "home")
        const codecommitDirectory = path.join(scopedHome, ".codecommit")
        const redirectedRoot = path.join(root, "redirected")
        const redirectedMount = path.join(redirectedRoot, "credentials")
        yield* fileSystem.makeDirectory(codecommitDirectory, { recursive: true })
        yield* fileSystem.makeDirectory(redirectedMount, { recursive: true })
        yield* fileSystem.symlink(
          redirectedRoot,
          path.join(codecommitDirectory, "sandbox-volumes")
        )

        const error = yield* validateSandboxConfig({
          ...validConfig,
          volumeMounts: [{
            hostPath: path.join(codecommitDirectory, "sandbox-volumes", "credentials"),
            containerPath: "/home/coder/credentials",
            readonly: true
          }]
        }, scopedHome).pipe(Effect.flip)

        expect(error._tag).toBe("SandboxConfigurationError")
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("creates and repairs the credential-bearing database with owner-only permissions", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-private-database-" })

        const newDirectory = path.join(root, "new", ".codecommit")
        const newDatabase = path.join(newDirectory, "cache.db")
        yield* ensurePrivateDatabasePath(newDirectory, newDatabase)
        expect((yield* fileSystem.stat(newDirectory)).mode & 0o777).toBe(0o700)
        expect((yield* fileSystem.stat(newDatabase)).mode & 0o777).toBe(0o600)

        const existingDirectory = path.join(root, "existing", ".codecommit")
        const existingDatabase = path.join(existingDirectory, "cache.db")
        yield* fileSystem.makeDirectory(existingDirectory, { mode: 0o755, recursive: true })
        yield* fileSystem.chmod(existingDirectory, 0o755)
        yield* fileSystem.writeFile(existingDatabase, Uint8Array.of(42), { mode: 0o644 })
        yield* fileSystem.chmod(existingDatabase, 0o644)

        yield* ensurePrivateDatabasePath(existingDirectory, existingDatabase)
        expect((yield* fileSystem.stat(existingDirectory)).mode & 0o777).toBe(0o700)
        expect((yield* fileSystem.stat(existingDatabase)).mode & 0o777).toBe(0o600)
        expect(Array.from(yield* fileSystem.readFile(existingDatabase))).toEqual([42])
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a symlinked cache directory before changing its target", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-database-directory-link-" })
        const attackerDirectory = path.join(root, "attacker-directory")
        const linkedDirectory = path.join(root, ".codecommit")
        const marker = path.join(attackerDirectory, "marker")

        yield* fileSystem.makeDirectory(attackerDirectory, { mode: 0o755 })
        yield* fileSystem.chmod(attackerDirectory, 0o755)
        yield* fileSystem.writeFile(marker, Uint8Array.of(42), { mode: 0o644 })
        yield* fileSystem.symlink(attackerDirectory, linkedDirectory)

        const result = yield* ensurePrivateDatabasePath(
          linkedDirectory,
          path.join(linkedDirectory, "cache.db")
        ).pipe(Effect.result)

        expect(result._tag).toBe("Failure")
        expect((yield* fileSystem.stat(attackerDirectory)).mode & 0o777).toBe(0o755)
        expect(Array.from(yield* fileSystem.readFile(marker))).toEqual([42])
        expect(yield* fileSystem.exists(path.join(attackerDirectory, "cache.db"))).toBe(false)
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a symlinked database before changing either target mode", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-database-file-link-" })
        const directory = path.join(root, ".codecommit")
        const attackerDatabase = path.join(root, "attacker.db")
        const linkedDatabase = path.join(directory, "cache.db")

        yield* fileSystem.makeDirectory(directory, { mode: 0o755 })
        yield* fileSystem.chmod(directory, 0o755)
        yield* fileSystem.writeFile(attackerDatabase, Uint8Array.of(99), { mode: 0o644 })
        yield* fileSystem.chmod(attackerDatabase, 0o644)
        yield* fileSystem.symlink(attackerDatabase, linkedDatabase)

        const result = yield* ensurePrivateDatabasePath(directory, linkedDatabase).pipe(Effect.result)

        expect(result._tag).toBe("Failure")
        expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o755)
        expect((yield* fileSystem.stat(attackerDatabase)).mode & 0o777).toBe(0o644)
        expect(Array.from(yield* fileSystem.readFile(attackerDatabase))).toEqual([99])
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("retains the cache directory handle if its path is replaced before permission repair", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-database-directory-race-" })
        const directory = path.join(root, ".codecommit")
        const displacedDirectory = path.join(root, "displaced-directory")
        const attackerDirectory = path.join(root, "attacker-directory")
        const marker = path.join(attackerDirectory, "marker")

        yield* fileSystem.makeDirectory(directory, { mode: 0o755 })
        yield* fileSystem.chmod(directory, 0o755)
        yield* fileSystem.makeDirectory(attackerDirectory, { mode: 0o755 })
        yield* fileSystem.chmod(attackerDirectory, 0o755)
        yield* fileSystem.writeFile(marker, Uint8Array.of(42), { mode: 0o644 })

        const racedOperations = {
          ...nodePrivateDatabasePathOperations,
          openDirectory: async (target: string) => {
            const handle = await nodePrivateDatabasePathOperations.openDirectory(target)
            await nodeRename(target, displacedDirectory)
            await nodeSymlink(attackerDirectory, target)
            return handle
          }
        }
        const result = yield* makeEnsurePrivateDatabasePath(racedOperations)(
          directory,
          path.join(directory, "cache.db")
        ).pipe(Effect.result)

        expect(result).toMatchObject({
          failure: { _tag: "CacheError", operation: "ensure-private-database-path" }
        })
        expect((yield* fileSystem.stat(attackerDirectory)).mode & 0o777).toBe(0o755)
        expect(Array.from(yield* fileSystem.readFile(marker))).toEqual([42])
        expect(yield* fileSystem.exists(path.join(attackerDirectory, "cache.db"))).toBe(false)
        expect((yield* fileSystem.stat(displacedDirectory)).mode & 0o777).toBe(0o755)
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("retains the database handle if its path is replaced before permission repair", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-database-file-race-" })
        const directory = path.join(root, ".codecommit")
        const database = path.join(directory, "cache.db")
        const displacedDatabase = path.join(root, "displaced.db")
        const attackerDatabase = path.join(root, "attacker.db")

        yield* fileSystem.makeDirectory(directory, { mode: 0o755 })
        yield* fileSystem.writeFile(database, Uint8Array.of(42), { mode: 0o644 })
        yield* fileSystem.chmod(database, 0o644)
        yield* fileSystem.writeFile(attackerDatabase, Uint8Array.of(99), { mode: 0o644 })
        yield* fileSystem.chmod(attackerDatabase, 0o644)

        const racedOperations = {
          ...nodePrivateDatabasePathOperations,
          openDatabase: async (target: string) => {
            const handle = await nodePrivateDatabasePathOperations.openDatabase(target)
            await nodeRename(target, displacedDatabase)
            await nodeSymlink(attackerDatabase, target)
            return handle
          }
        }
        const result = yield* makeEnsurePrivateDatabasePath(racedOperations)(directory, database).pipe(Effect.result)

        expect(result).toMatchObject({
          failure: { _tag: "CacheError", operation: "ensure-private-database-path" }
        })
        expect((yield* fileSystem.stat(attackerDatabase)).mode & 0o777).toBe(0o644)
        expect(Array.from(yield* fileSystem.readFile(attackerDatabase))).toEqual([99])
        expect((yield* fileSystem.stat(displacedDatabase)).mode & 0o777).toBe(0o644)
        expect(Array.from(yield* fileSystem.readFile(displacedDatabase))).toEqual([42])
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
      "1001:1001",
      "high-entropy-password"
    )

    expect(config.Cmd).toContain("password")
    expect(config.Cmd).not.toContain("none")
    expect(config.Env).toContain("PASSWORD=high-entropy-password")
    expect(config.User).toBe("1001:1001")
    expect(config.Env).toContain("HOME=/tmp")
    expect(config.HostConfig.CapDrop).toEqual(["ALL"])
    expect(config.HostConfig.PortBindings["8080/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "18080" }
    ])
    expect(
      renderDockerPortBinding("8080/tcp", { HostIp: "127.0.0.1", HostPort: "18080" })
    ).toBe("127.0.0.1:18080:8080")
  })

  it.effect("pipes container environment without exposing secrets in process arguments", () =>
    // The fake spawner intentionally supplies the runtime process boundary in this security test.
    // @effect-diagnostics-next-line missingEffectContext:off
    Effect.gen(function*() {
      const commands: Array<ChildProcess.Command> = []
      const output = Stream.make("container-id\n").pipe(Stream.encodeText)
      const processLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          commands.push(command)
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              all: output,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              pid: ChildProcessSpawner.ProcessId(42),
              reref: Effect.void,
              stderr: Stream.empty,
              stdin: Sink.drain,
              stdout: output,
              unref: Effect.succeed(Effect.void)
            })
          )
        })
      )
      const config = makeContainerConfig(
        "/Users/security-test/.codecommit/sandboxes/sbx-1",
        18080,
        "sbx-1",
        "42",
        { ...validConfig, env: { EDITOR_THEME: "dark" } },
        homePath,
        "1001:1001",
        "process-visible-secret"
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const docker = yield* DockerService
          yield* docker.createContainer(config)
        }).pipe(
          Effect.provide(DockerService.Default.pipe(Layer.provide(processLayer)))
        )
      )

      expect(commands).toHaveLength(1)
      const command = commands[0]
      expect(ChildProcess.isStandardCommand(command)).toBe(true)
      if (!ChildProcess.isStandardCommand(command)) return
      const processArguments = [command.command, ...command.args].join("\0")
      expect(processArguments).not.toContain("process-visible-secret")
      expect(processArguments).not.toContain("EDITOR_THEME=dark")
      const stdin = command.options.stdin
      expect(stdin).toBeTypeOf("object")
      if (stdin === null || !Predicate.isObjectOrArray(stdin) || Predicate.isString(stdin.stream)) return
      const chunks = yield* Stream.runCollect(stdin.stream)
      const bytes = Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)))
      const environment = new TextDecoder().decode(bytes)
      expect(environment).toContain("EDITOR_THEME=dark\n")
      expect(environment).toContain("PASSWORD=process-visible-secret\n")
    }))

  it.effect("classifies docker inspect's missing-container output before JSON decoding", () =>
    Effect.gen(function*() {
      const output = Stream.make("Error: No such object: missing-container\n").pipe(Stream.encodeText)
      const processLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              all: output,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              pid: ChildProcessSpawner.ProcessId(44),
              reref: Effect.void,
              stderr: Stream.empty,
              stdin: Sink.drain,
              stdout: output,
              unref: Effect.succeed(Effect.void)
            })
          )
        )
      )

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const docker = yield* DockerService
          return yield* docker.inspectContainer("missing-container").pipe(Effect.result)
        }).pipe(Effect.provide(DockerService.Default.pipe(Layer.provide(processLayer))))
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(isMissingContainerError(result.failure)).toBe(true)
      }
    }))

  it.effect("keeps docker inspect infrastructure failures distinct from missing containers", () =>
    Effect.gen(function*() {
      const output = Stream.make("Cannot connect to the Docker daemon\n").pipe(Stream.encodeText)
      const processLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              all: output,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              pid: ChildProcessSpawner.ProcessId(45),
              reref: Effect.void,
              stderr: Stream.empty,
              stdin: Sink.drain,
              stdout: output,
              unref: Effect.succeed(Effect.void)
            })
          )
        )
      )

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const docker = yield* DockerService
          return yield* docker.inspectContainer("daemon-unavailable").pipe(Effect.result)
        }).pipe(Effect.provide(DockerService.Default.pipe(Layer.provide(processLayer))))
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(isMissingContainerError(result.failure)).toBe(false)
      }
    }))

  it("matches a non-root workspace owner and repairs root-owned workspaces without running as root", () => {
    expect(sandboxContainerIdentityForWorkspaceOwner(1001, 1002)).toEqual({
      user: "1001:1002",
      repairRootOwnedWorkspace: false
    })
    expect(sandboxContainerIdentityForWorkspaceOwner(0, 0)).toEqual({
      user: "1000:1000",
      repairRootOwnedWorkspace: true
    })
    expect(sandboxContainerIdentityForWorkspaceOwner(undefined, undefined)).toEqual({
      user: "1000:1000",
      repairRootOwnedWorkspace: false
    })
  })
})
