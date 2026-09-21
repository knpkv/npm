import { Effect, Schema } from "effect"
import { parse } from "yaml"

const LockDependency = Schema.Struct({
  specifier: Schema.String,
  version: Schema.String
})

const LockImporter = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, LockDependency))
})

const PackedLockfile = Schema.Struct({
  importers: Schema.Record(Schema.String, LockImporter),
  lockfileVersion: Schema.Literal("9.0"),
  packages: Schema.Record(Schema.String, Schema.Json),
  patchedDependencies: Schema.optionalKey(Schema.Json),
  snapshots: Schema.Record(Schema.String, Schema.Json)
})

const InstalledManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String
})

export class PackedDependencyAdmissionError extends Schema.TaggedError<PackedDependencyAdmissionError>()(
  "PackedDependencyAdmissionError",
  {
    dependency: Schema.String,
    importer: Schema.String,
    reason: Schema.Literals([
      "unsupported-specifier",
      "invalid-lockfile",
      "missing-importer",
      "missing-dependency",
      "specifier-mismatch",
      "resolution-mismatch",
      "invalid-resolution",
      "invalid-manifest",
      "manifest-name-mismatch",
      "manifest-version-mismatch",
      "missing-package-metadata",
      "invalid-package-metadata",
      "package-metadata-mismatch",
      "missing-snapshot-metadata",
      "invalid-snapshot-metadata",
      "snapshot-metadata-mismatch",
      "missing-patch-metadata",
      "patch-metadata-mismatch",
      "conflicting-installed-path"
    ])
  }
) {}

export interface ExternalDependencyRequest {
  readonly dependency: string
  readonly importer: string
  readonly installedLockSource: string
  readonly installedManifestSource: string
  readonly frozenLockSource: string
  readonly previousResolvedPath: string | undefined
  readonly requestedSpecifier: string
  readonly resolvedPath: string
}

export interface ExternalDependencyIdentity {
  readonly name: string
  readonly resolvedPath: string
  readonly version: string
}

const failure = (
  request: ExternalDependencyRequest,
  reason: PackedDependencyAdmissionError["reason"]
) =>
  new PackedDependencyAdmissionError({
    dependency: request.dependency,
    importer: request.importer,
    reason
  })

const decodeYaml = Effect.fn("PackedDependencyAdmission.decodeYaml")(function*(
  request: ExternalDependencyRequest,
  source: string
) {
  const input = yield* Effect.try({
    try: () => parse(source),
    catch: () => failure(request, "invalid-lockfile")
  })
  return yield* Schema.decodeUnknownEffect(PackedLockfile)(input).pipe(
    Effect.mapError(() => failure(request, "invalid-lockfile"))
  )
})

const compareJsonKeys = (left: readonly [string, Schema.Json], right: readonly [string, Schema.Json]): number =>
  left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const isJsonObject = Schema.is(JsonObject)

const normalizeJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (!isJsonObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(compareJsonKeys)
      .map(([key, nested]): readonly [string, Schema.Json] => [key, normalizeJson(nested)])
  )
}

const jsonEquals = (left: Schema.Json, right: Schema.Json): boolean =>
  JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right))

const RegistrySpecifier = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9A-Za-z*^~<>=|+._-]+$/))
)
const isRegistrySpecifier = Schema.is(RegistrySpecifier)
const RegistryVersionPrefix =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/
const PackageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PatchContext = /^patch_hash=([0-9a-f]{64})$/
const PatchHash = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)))
const isPatchHash = Schema.is(PatchHash)
const isString = Schema.is(Schema.String)

interface RegistryResolution {
  readonly patchHash: string | undefined
  readonly version: string
}

type SelectedPatch =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "Present"; readonly hash: string }

const splitResolutionContexts = (input: string, start: number): ReadonlyArray<string> | undefined => {
  const contexts: Array<string> = []
  let cursor = start
  while (cursor < input.length) {
    if (input[cursor] !== "(") return undefined
    const bodyStart = cursor + 1
    let depth = 1
    cursor = bodyStart
    while (cursor < input.length && depth > 0) {
      if (input[cursor] === "(") depth++
      if (input[cursor] === ")") depth--
      cursor++
    }
    if (depth !== 0) return undefined
    const body = input.slice(bodyStart, cursor - 1)
    if (body.length === 0) return undefined
    contexts.push(body)
  }
  return contexts
}

const parseRegistryResolution = (input: string, depth = 0): RegistryResolution | undefined => {
  if (depth > 32 || input.length > 4096 || /\s/.test(input)) return undefined
  const versionMatch = RegistryVersionPrefix.exec(input)
  if (versionMatch === null) return undefined
  const version = versionMatch[0]
  if (version.length === input.length) return { patchHash: undefined, version }
  const contexts = splitResolutionContexts(input, version.length)
  if (contexts === undefined) return undefined
  let patchHash: string | undefined
  for (const context of contexts) {
    if (context.startsWith("patch_hash=")) {
      const patchMatch = PatchContext.exec(context)
      if (patchMatch === null || patchHash !== undefined) return undefined
      const matchedHash = patchMatch[1]
      if (matchedHash === undefined) return undefined
      patchHash = matchedHash
      continue
    }
    const nestedStart = context.indexOf("(")
    const peerHead = nestedStart === -1 ? context : context.slice(0, nestedStart)
    const separator = peerHead.lastIndexOf("@")
    if (separator <= 0) return undefined
    const peerName = peerHead.slice(0, separator)
    const peerResolution = peerHead.slice(separator + 1) + (nestedStart === -1 ? "" : context.slice(nestedStart))
    if (!PackageName.test(peerName) || parseRegistryResolution(peerResolution, depth + 1) === undefined) {
      return undefined
    }
  }
  return { patchHash, version }
}

const supportsRegistrySpecifier = (specifier: string): boolean =>
  isRegistrySpecifier(specifier) && !specifier.startsWith(".")

const isUsablePackageMetadata = (value: Schema.Json): boolean => isJsonObject(value) && Object.keys(value).length > 0

const isUsableSnapshotMetadata = (value: Schema.Json): boolean => isJsonObject(value)

const selectedPatch = (lock: typeof PackedLockfile.Type, key: string): SelectedPatch => {
  if (lock.patchedDependencies === undefined) return { _tag: "Missing" }
  if (!isJsonObject(lock.patchedDependencies)) return { _tag: "Invalid" }
  const selected = lock.patchedDependencies[key]
  if (selected === undefined) return { _tag: "Missing" }
  if (!isString(selected) || !isPatchHash(selected)) return { _tag: "Invalid" }
  return { _tag: "Present", hash: selected }
}

/** Admit one requester before the packed consumer creates or reuses its dependency link. */
export const admitExternalDependency = Effect.fn("PackedDependencyAdmission.admit")(function*<E, R>(
  request: ExternalDependencyRequest,
  link: (identity: ExternalDependencyIdentity) => Effect.Effect<void, E, R>
) {
  if (!supportsRegistrySpecifier(request.requestedSpecifier)) {
    return yield* failure(request, "unsupported-specifier")
  }
  const frozenLock = yield* decodeYaml(request, request.frozenLockSource)
  const installedLock = yield* decodeYaml(request, request.installedLockSource)
  const frozenImporter = frozenLock.importers[request.importer]
  const installedImporter = installedLock.importers[request.importer]
  if (frozenImporter === undefined || installedImporter === undefined) {
    return yield* failure(request, "missing-importer")
  }
  const frozenDependency = frozenImporter.dependencies?.[request.dependency]
  const installedDependency = installedImporter.dependencies?.[request.dependency]
  if (frozenDependency === undefined || installedDependency === undefined) {
    return yield* failure(request, "missing-dependency")
  }
  if (
    frozenDependency.specifier !== request.requestedSpecifier ||
    installedDependency.specifier !== request.requestedSpecifier
  ) {
    return yield* failure(request, "specifier-mismatch")
  }
  if (
    frozenDependency.specifier !== installedDependency.specifier ||
    frozenDependency.version !== installedDependency.version
  ) {
    return yield* failure(request, "resolution-mismatch")
  }
  const manifest = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(InstalledManifest)
  )(request.installedManifestSource).pipe(
    Effect.mapError(() => failure(request, "invalid-manifest"))
  )
  if (manifest.name !== request.dependency) {
    return yield* failure(request, "manifest-name-mismatch")
  }
  const resolution = parseRegistryResolution(frozenDependency.version)
  if (resolution === undefined) {
    return yield* failure(request, "invalid-resolution")
  }
  const packageKey = `${request.dependency}@${manifest.version}`
  if (resolution.version !== manifest.version) {
    return yield* failure(request, "manifest-version-mismatch")
  }
  const frozenPatch = selectedPatch(frozenLock, packageKey)
  const installedPatch = selectedPatch(installedLock, packageKey)
  if (resolution.patchHash === undefined) {
    if (frozenPatch._tag !== "Missing" || installedPatch._tag !== "Missing") {
      return yield* failure(request, "patch-metadata-mismatch")
    }
  } else {
    if (frozenPatch._tag === "Missing" || installedPatch._tag === "Missing") {
      return yield* failure(request, "missing-patch-metadata")
    }
    if (
      frozenPatch._tag !== "Present" ||
      installedPatch._tag !== "Present" ||
      frozenPatch.hash !== resolution.patchHash ||
      installedPatch.hash !== resolution.patchHash
    ) {
      return yield* failure(request, "patch-metadata-mismatch")
    }
  }
  const frozenPackage = frozenLock.packages[packageKey]
  const installedPackage = installedLock.packages[packageKey]
  if (frozenPackage === undefined || installedPackage === undefined) {
    return yield* failure(request, "missing-package-metadata")
  }
  if (!isUsablePackageMetadata(frozenPackage) || !isUsablePackageMetadata(installedPackage)) {
    return yield* failure(request, "invalid-package-metadata")
  }
  if (!jsonEquals(frozenPackage, installedPackage)) {
    return yield* failure(request, "package-metadata-mismatch")
  }
  const snapshotKey = `${request.dependency}@${frozenDependency.version}`
  const frozenSnapshot = frozenLock.snapshots[snapshotKey]
  const installedSnapshot = installedLock.snapshots[snapshotKey]
  if (frozenSnapshot === undefined || installedSnapshot === undefined) {
    return yield* failure(request, "missing-snapshot-metadata")
  }
  if (!isUsableSnapshotMetadata(frozenSnapshot) || !isUsableSnapshotMetadata(installedSnapshot)) {
    return yield* failure(request, "invalid-snapshot-metadata")
  }
  if (!jsonEquals(frozenSnapshot, installedSnapshot)) {
    return yield* failure(request, "snapshot-metadata-mismatch")
  }
  if (request.previousResolvedPath !== undefined && request.previousResolvedPath !== request.resolvedPath) {
    return yield* failure(request, "conflicting-installed-path")
  }
  if (request.previousResolvedPath === undefined) {
    yield* link({ name: manifest.name, resolvedPath: request.resolvedPath, version: manifest.version })
  }
})
