import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { SandboxConfigurationError } from "../Errors.js"
import type { SandboxConfig } from "./internal.js"

const digestPinnedImage = /@sha256:[0-9a-f]{64}$/u
const reservedEnvironmentKeys = new Set(["HASHED_PASSWORD", "PASSWORD"])
const permittedContainerRoots = ["/home/coder", "/tmp/.local/share/code-server"]

const reject = (message: string) => new SandboxConfigurationError({ message })

const expandHome = (input: string, homePath: string): string =>
  input === "~" ? homePath : input.startsWith("~/") ? `${homePath}${input.slice(1)}` : input

/** Dedicated host root for explicit sandbox volume sharing. */
export const sandboxVolumeRoot = (homePath: string): string => `${homePath}/.codecommit/sandbox-volumes`

/**
 * Validate all authority-bearing sandbox settings at a persistence or execution boundary.
 */
export const validateSandboxConfig = Effect.fn("SandboxPolicy.validateSandboxConfig")(
  function*(config: SandboxConfig, homePath: string) {
    const path = yield* Path.Path
    const fileSystem = yield* FileSystem.FileSystem
    if (!digestPinnedImage.test(config.image)) {
      return yield* reject("Sandbox image must be pinned to an immutable sha256 digest")
    }
    for (const key of Object.keys(config.env)) {
      if (reservedEnvironmentKeys.has(key.toUpperCase())) {
        return yield* reject(`Sandbox environment variable ${key} is reserved`)
      }
    }

    const resolvedHomePath = path.resolve(homePath)
    const allowedRoot = path.resolve(sandboxVolumeRoot(resolvedHomePath))
    for (const mount of config.volumeMounts) {
      const hostPath = path.resolve(expandHome(mount.hostPath, homePath))
      const relativeHostPath = path.relative(allowedRoot, hostPath)
      if (
        relativeHostPath === "" ||
        relativeHostPath === ".." ||
        relativeHostPath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeHostPath)
      ) {
        return yield* reject(
          `Sandbox mount ${mount.hostPath} must be a child of ~/.codecommit/sandbox-volumes`
        )
      }

      const canonicalRoot = yield* fileSystem.realPath(allowedRoot).pipe(
        Effect.mapError(() => reject("Sandbox volume root must exist before adding mounts"))
      )
      const canonicalHomePath = yield* fileSystem.realPath(resolvedHomePath).pipe(
        Effect.mapError(() => reject("Sandbox home directory must exist before adding mounts"))
      )
      const expectedCanonicalRoot = path.resolve(
        canonicalHomePath,
        ".codecommit",
        "sandbox-volumes"
      )
      if (canonicalRoot !== expectedCanonicalRoot) {
        return yield* reject(
          "Sandbox volume root must not redirect outside ~/.codecommit/sandbox-volumes"
        )
      }
      const canonicalHostPath = yield* fileSystem.realPath(hostPath).pipe(
        Effect.mapError(() => reject(`Sandbox mount ${mount.hostPath} must already exist`))
      )
      const relativeCanonicalPath = path.relative(canonicalRoot, canonicalHostPath)
      if (
        relativeCanonicalPath === "" ||
        relativeCanonicalPath === ".." ||
        relativeCanonicalPath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeCanonicalPath)
      ) {
        return yield* reject(
          `Sandbox mount ${mount.hostPath} must resolve inside ~/.codecommit/sandbox-volumes`
        )
      }

      const containerPath = path.normalize(mount.containerPath)
      const isPermittedContainerChild = permittedContainerRoots.some((root) => {
        const relativeContainerPath = path.relative(root, containerPath)
        return relativeContainerPath !== "" &&
          relativeContainerPath !== ".." &&
          !relativeContainerPath.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeContainerPath)
      })
      if (!isPermittedContainerChild) {
        return yield* reject(
          `Sandbox mount target ${mount.containerPath} must be a child of /home/coder or the code-server runtime data root`
        )
      }
    }
    return config
  }
)
