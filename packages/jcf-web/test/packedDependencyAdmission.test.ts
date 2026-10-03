import { expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import {
  admitExternalDependency,
  type ExternalDependencyRequest,
  type PackedDependencyAdmissionError
} from "../scripts/packedDependencyAdmission.js"

const PatchHashA = "a".repeat(64)
const PatchHashB = "b".repeat(64)
const PatchKey = "dependency@1.0.0"

const lockSource = (
  version: string,
  options: {
    readonly dependencyPresent?: boolean
    readonly importer?: string
    readonly manifestVersion?: string
    readonly packagePresent?: boolean
    readonly packageMetadata?: unknown
    readonly patchedDependencies?: unknown
    readonly snapshotPresent?: boolean
    readonly snapshotMetadata?: unknown
    readonly specifier?: string
  } = {}
) => {
  const manifestVersion = options.manifestVersion ?? "1.0.0"
  const packages = options.packagePresent === false ? {} : {
    [`dependency@${manifestVersion}`]: Object.hasOwn(options, "packageMetadata")
      ? options.packageMetadata
      : { resolution: { integrity: "sha512-synthetic" } }
  }
  const snapshots = options.snapshotPresent === false ? {} : {
    [`dependency@${version}`]: Object.hasOwn(options, "snapshotMetadata") ? options.snapshotMetadata : {}
  }
  const dependencies = options.dependencyPresent === false ? {} : {
    dependency: { specifier: options.specifier ?? "1.0.0", version }
  }
  const lock = {
    importers: {
      [options.importer ?? "packages/app"]: {
        dependencies
      }
    },
    lockfileVersion: "9.0",
    packages,
    snapshots
  }
  return JSON.stringify(
    Object.hasOwn(options, "patchedDependencies")
      ? { ...lock, patchedDependencies: options.patchedDependencies }
      : lock
  )
}

const request = (overrides: Partial<ExternalDependencyRequest> = {}): ExternalDependencyRequest => ({
  dependency: "dependency",
  frozenLockSource: lockSource("1.0.0"),
  importer: "packages/app",
  installedLockSource: lockSource("1.0.0"),
  installedManifestSource: JSON.stringify({ name: "dependency", version: "1.0.0" }),
  previousResolvedPath: undefined,
  requestedSpecifier: "1.0.0",
  resolvedPath: "/store/dependency",
  ...overrides
})

const refusal = Effect.fn("PackedDependencyAdmission.test.refusal")(function*(input: ExternalDependencyRequest) {
  const links = yield* Ref.make(0)
  const failure = yield* admitExternalDependency(
    input,
    () => Ref.update(links, (count) => count + 1)
  ).pipe(Effect.flip)
  return { failure, links: yield* Ref.get(links) }
})

const expectRefusalForNewAndSeenPath = Effect.fn("PackedDependencyAdmission.test.expectRefusalForNewAndSeenPath")(
  function*(input: ExternalDependencyRequest, reason: PackedDependencyAdmissionError["reason"]) {
    for (const previousResolvedPath of [undefined, input.resolvedPath]) {
      const result = yield* refusal({ ...input, previousResolvedPath })
      expect(result.failure.reason).toBe(reason)
      expect(result.links).toBe(0)
    }
  }
)

it.effect("rejects one shared installed 2.0.0 artifact when both requesters lock 1.0.0 before linking", () =>
  Effect.gen(function*() {
    const result = yield* refusal(
      request({ installedManifestSource: JSON.stringify({ name: "dependency", version: "2.0.0" }) })
    )

    expect(result.failure.reason).toBe("manifest-version-mismatch")
    expect(result.links).toBe(0)
  }))

it.effect("links one correctly identified artifact once when two requesters share its real path", () =>
  Effect.gen(function*() {
    const links = yield* Ref.make(0)
    const link = () => Ref.update(links, (count) => count + 1)

    yield* admitExternalDependency(request(), link)
    yield* admitExternalDependency(request({ previousResolvedPath: "/store/dependency" }), link)

    expect(yield* Ref.get(links)).toBe(1)
  }))

it.effect("rejects the wrong installed package name before linking", () =>
  Effect.gen(function*() {
    const result = yield* refusal(
      request({ installedManifestSource: JSON.stringify({ name: "another-package", version: "1.0.0" }) })
    )
    expect(result.failure.reason).toBe("manifest-name-mismatch")
    expect(result.links).toBe(0)
  }))

it.effect("rejects an installed lock resolution that differs from the frozen importer", () =>
  Effect.gen(function*() {
    const result = yield* refusal(request({ installedLockSource: lockSource("1.0.0(peer@2.0.0)") }))
    expect(result.failure.reason).toBe("resolution-mismatch")
    expect(result.links).toBe(0)
  }))

it.effect("rejects missing and malformed lock or manifest evidence before linking", () =>
  Effect.gen(function*() {
    const cases: ReadonlyArray<readonly [ExternalDependencyRequest, PackedDependencyAdmissionError["reason"]]> = [
      [request({ installedLockSource: lockSource("1.0.0", { importer: "packages/other" }) }), "missing-importer"],
      [request({ installedLockSource: lockSource("1.0.0", { dependencyPresent: false }) }), "missing-dependency"],
      [request({ frozenLockSource: lockSource("1.0.0", { specifier: "^1.0.0" }) }), "specifier-mismatch"],
      [request({ frozenLockSource: "not: [valid" }), "invalid-lockfile"],
      [request({ installedManifestSource: "{" }), "invalid-manifest"],
      [request({ frozenLockSource: lockSource("1.0.0", { packagePresent: false }) }), "missing-package-metadata"],
      [request({ frozenLockSource: lockSource("1.0.0", { snapshotPresent: false }) }), "missing-snapshot-metadata"]
    ]
    for (const [input, reason] of cases) {
      const result = yield* refusal(input)
      expect(result.failure.reason).toBe(reason)
      expect(result.links).toBe(0)
    }
  }))

it.effect("rejects installed package and peer metadata that differs from the frozen lock", () =>
  Effect.gen(function*() {
    const packageResult = yield* refusal(request({
      installedLockSource: lockSource("1.0.0", {
        packageMetadata: { resolution: { integrity: "sha512-other" } }
      })
    }))
    expect(packageResult.failure.reason).toBe("package-metadata-mismatch")
    expect(packageResult.links).toBe(0)

    const snapshotResult = yield* refusal(request({
      installedLockSource: lockSource("1.0.0", { snapshotMetadata: { peer: "other" } })
    }))
    expect(snapshotResult.failure.reason).toBe("snapshot-metadata-mismatch")
    expect(snapshotResult.links).toBe(0)
  }))

it.effect("rejects matching unusable selected package and snapshot records before linking", () =>
  Effect.gen(function*() {
    for (const packageMetadata of [null, "scalar", []]) {
      const source = lockSource("1.0.0", { packageMetadata })
      yield* expectRefusalForNewAndSeenPath(
        request({ frozenLockSource: source, installedLockSource: source }),
        "invalid-package-metadata"
      )
    }
    for (const snapshotMetadata of [null, "scalar", []]) {
      const source = lockSource("1.0.0", { snapshotMetadata })
      yield* expectRefusalForNewAndSeenPath(
        request({ frozenLockSource: source, installedLockSource: source }),
        "invalid-snapshot-metadata"
      )
    }
  }))

it.effect("rejects malformed resolutions and unsupported registry declarations before linking", () =>
  Effect.gen(function*() {
    for (const version of ["1.0.0(", "1.0.0(peer@2.0.0"]) {
      const source = lockSource(version)
      yield* expectRefusalForNewAndSeenPath(
        request({ frozenLockSource: source, installedLockSource: source }),
        "invalid-resolution"
      )
    }
    for (const specifier of ["../dependency", " 1.0.0"]) {
      const source = lockSource("1.0.0", { specifier })
      yield* expectRefusalForNewAndSeenPath(
        request({ frozenLockSource: source, installedLockSource: source, requestedSpecifier: specifier }),
        "unsupported-specifier"
      )
    }
  }))

it.effect("accepts empty snapshots, prereleases, ranges, and nested peer contexts", () =>
  Effect.gen(function*() {
    const controls: ReadonlyArray<{
      readonly manifestVersion: string
      readonly source: string
      readonly specifier: string
    }> = [
      {
        manifestVersion: "1.0.0",
        source: lockSource("1.0.0", { specifier: "^1.0.0" }),
        specifier: "^1.0.0"
      },
      {
        manifestVersion: "1.0.0-rc.1",
        source: lockSource("1.0.0-rc.1", {
          manifestVersion: "1.0.0-rc.1",
          specifier: "1.0.0-rc.1"
        }),
        specifier: "1.0.0-rc.1"
      },
      {
        manifestVersion: "1.0.0",
        source: lockSource("1.0.0(peer@2.0.0(other@3.0.0))"),
        specifier: "1.0.0"
      }
    ]
    for (const control of controls) {
      const links = yield* Ref.make(0)
      yield* admitExternalDependency(
        request({
          frozenLockSource: control.source,
          installedLockSource: control.source,
          installedManifestSource: JSON.stringify({ name: "dependency", version: control.manifestVersion }),
          requestedSpecifier: control.specifier
        }),
        () => Ref.update(links, (count) => count + 1)
      )
      expect(yield* Ref.get(links)).toBe(1)
    }
  }))

it.effect("accepts exact patched and peer-context lock metadata", () =>
  Effect.gen(function*() {
    const version = `1.0.0(patch_hash=${PatchHashA})(peer@2.0.0)`
    const source = lockSource(version, {
      patchedDependencies: { [PatchKey]: PatchHashA },
      snapshotMetadata: { peerDependencies: { peer: "2.0.0" } }
    })
    const links = yield* Ref.make(0)
    yield* admitExternalDependency(
      request({ frozenLockSource: source, installedLockSource: source }),
      () => Ref.update(links, (count) => count + 1)
    )
    expect(yield* Ref.get(links)).toBe(1)
  }))

it.effect("rejects missing or conflicting selected patch declarations before linking", () =>
  Effect.gen(function*() {
    const version = `1.0.0(patch_hash=${PatchHashA})(peer@2.0.0)`
    const frozen = lockSource(version, { patchedDependencies: { [PatchKey]: PatchHashA } })
    const cases: ReadonlyArray<readonly [string, PackedDependencyAdmissionError["reason"]]> = [
      [lockSource(version), "missing-patch-metadata"],
      [lockSource(version, { patchedDependencies: { [PatchKey]: PatchHashB } }), "patch-metadata-mismatch"],
      [lockSource(version, { patchedDependencies: { [PatchKey]: null } }), "patch-metadata-mismatch"]
    ]
    for (const [installedLockSource, reason] of cases) {
      yield* expectRefusalForNewAndSeenPath(
        request({ frozenLockSource: frozen, installedLockSource }),
        reason
      )
    }

    const disagreeing = lockSource(version, { patchedDependencies: { [PatchKey]: PatchHashB } })
    yield* expectRefusalForNewAndSeenPath(
      request({ frozenLockSource: disagreeing, installedLockSource: disagreeing }),
      "patch-metadata-mismatch"
    )

    const selectedWithoutSuffix = lockSource("1.0.0", { patchedDependencies: { [PatchKey]: PatchHashA } })
    yield* expectRefusalForNewAndSeenPath(
      request({ frozenLockSource: selectedWithoutSuffix, installedLockSource: selectedWithoutSuffix }),
      "patch-metadata-mismatch"
    )
  }))

it.effect("ignores unrelated patch declarations for an unpatched dependency", () =>
  Effect.gen(function*() {
    const links = yield* Ref.make(0)
    yield* admitExternalDependency(
      request({
        frozenLockSource: lockSource("1.0.0", { patchedDependencies: { "other@2.0.0": PatchHashA } }),
        installedLockSource: lockSource("1.0.0", { patchedDependencies: { "other@2.0.0": PatchHashB } })
      }),
      () => Ref.update(links, (count) => count + 1)
    )
    expect(yield* Ref.get(links)).toBe(1)
  }))

it.effect("refuses unsupported alias, catalog, patch, file, link, and workspace specifiers", () =>
  Effect.gen(function*() {
    for (
      const requestedSpecifier of [
        "npm:other@1.0.0",
        "catalog:default",
        "patch:dependency@npm%3A1.0.0#synthetic.patch",
        "file:../dependency",
        "link:../dependency",
        "workspace:^"
      ]
    ) {
      const result = yield* refusal(request({ requestedSpecifier }))
      expect(result.failure.reason).toBe("unsupported-specifier")
      expect(result.links).toBe(0)
    }
  }))
