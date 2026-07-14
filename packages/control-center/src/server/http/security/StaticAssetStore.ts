import { Context, Effect, FileSystem, Layer, Option, Path, Result, Schema } from "effect"

import { DEFAULT_HTTP_SECURITY_LIMITS, HttpByteLimit } from "./HttpLimits.js"

const ManifestAssetPath = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u, { expected: "a relative Vite asset path" }),
  Schema.makeFilter(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0),
    { expected: "a normalized contained Vite asset path" }
  )
)

const ManifestEntry = Schema.Struct({
  file: ManifestAssetPath,
  css: Schema.optionalKey(Schema.Array(ManifestAssetPath)),
  assets: Schema.optionalKey(Schema.Array(ManifestAssetPath)),
  imports: Schema.optionalKey(Schema.Array(Schema.String)),
  dynamicImports: Schema.optionalKey(Schema.Array(Schema.String)),
  isEntry: Schema.optionalKey(Schema.Boolean)
})

const ViteManifest = Schema.Record(Schema.String, ManifestEntry)
const ViteManifestJson = Schema.fromJsonString(ViteManifest)

/** MIME types that the static server is allowed to emit. */
export const StaticAssetMimeType = Schema.Literals([
  "text/html; charset=utf-8",
  "text/css; charset=utf-8",
  "text/javascript; charset=utf-8",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/x-icon",
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "application/wasm",
  "application/manifest+json"
])

/** Decoded closed static MIME type. */
export type StaticAssetMimeType = typeof StaticAssetMimeType.Type

const MIME_BY_EXTENSION: ReadonlyMap<string, StaticAssetMimeType> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json"]
])

/** Static asset initialization failed closed. */
export class StaticAssetStoreError extends Schema.TaggedErrorClass<StaticAssetStoreError>()(
  "StaticAssetStoreError",
  {
    reason: Schema.Literals([
      "invalid-options",
      "manifest-invalid",
      "path-rejected",
      "containment-rejected",
      "file-rejected",
      "mime-rejected",
      "asset-too-large",
      "asset-total-too-large",
      "io-failure"
    ]),
    assetPath: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024)))
  }
) {}

/** Construction options for the immutable startup-loaded asset map. */
export interface StaticAssetStoreOptions {
  readonly root: string
  readonly publicAssets?: ReadonlyArray<string> | undefined
  readonly maximumIndexBytes?: number | undefined
  readonly maximumAssetBytes?: number | undefined
  readonly maximumTotalBytes?: number | undefined
}

/** One immutable static response selected without request-time filesystem access. */
export interface StaticAssetResolution {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mimeType: StaticAssetMimeType
  readonly cacheControl: "no-store" | "public, max-age=31536000, immutable"
  readonly kind: "asset" | "spa"
}

interface StoredStaticAsset {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mimeType: StaticAssetMimeType
  readonly cacheControl: "no-store" | "public, max-age=31536000, immutable"
}

/** Service resolving only assets captured from the validated startup manifest. */
export interface StaticAssetStoreService {
  readonly resolve: (requestPath: string, accept: string | null) => Option.Option<StaticAssetResolution>
  readonly assetCount: number
  readonly totalBytes: number
}

const decodeLimit = (
  input: number,
  assetPath: string | null
): Effect.Effect<HttpByteLimit, StaticAssetStoreError> => {
  const result = Schema.decodeUnknownResult(HttpByteLimit)(input)
  return Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(new StaticAssetStoreError({ reason: "invalid-options", assetPath }))
}

const platformFailure = (assetPath: string | null): StaticAssetStoreError =>
  new StaticAssetStoreError({ reason: "io-failure", assetPath })

const containedRelativePath = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const parseRequestPath = (requestPath: string): string | undefined => {
  if (requestPath.length === 0 || requestPath.length > 8 * 1024 || !requestPath.startsWith("/")) return undefined
  const queryIndex = requestPath.indexOf("?")
  const pathname = queryIndex < 0 ? requestPath : requestPath.slice(0, queryIndex)
  if (
    pathname.includes("%") ||
    pathname.includes("\\") ||
    pathname.includes("\u0000") ||
    pathname.includes("//") ||
    pathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return undefined
  }
  return pathname
}

/** Construct an immutable asset store from a canonicalized Vite build root. */
export const makeStaticAssetStore = Effect.fn("StaticAssetStore.make")(function*(
  options: StaticAssetStoreOptions
): Effect.fn.Return<StaticAssetStoreService, StaticAssetStoreError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const maximumIndexBytes = yield* decodeLimit(
    options.maximumIndexBytes ?? DEFAULT_HTTP_SECURITY_LIMITS.maximumStaticIndexBytes,
    "index.html"
  )
  const maximumAssetBytes = yield* decodeLimit(
    options.maximumAssetBytes ?? DEFAULT_HTTP_SECURITY_LIMITS.maximumStaticAssetBytes,
    null
  )
  const maximumTotalBytes = yield* decodeLimit(
    options.maximumTotalBytes ?? DEFAULT_HTTP_SECURITY_LIMITS.maximumStaticTotalBytes,
    null
  )
  const configuredRoot = path.resolve(options.root)
  const canonicalRoot = yield* fileSystem.realPath(configuredRoot).pipe(
    Effect.mapError(() => platformFailure(null))
  )
  const rootInfo = yield* fileSystem.stat(canonicalRoot).pipe(Effect.mapError(() => platformFailure(null)))
  if (rootInfo.type !== "Directory") {
    return yield* new StaticAssetStoreError({ reason: "file-rejected", assetPath: null })
  }

  const manifestPath = path.join(canonicalRoot, ".vite", "manifest.json")
  const manifestText = yield* fileSystem.readFileString(manifestPath).pipe(
    Effect.mapError(() => platformFailure(".vite/manifest.json"))
  )
  const manifest = yield* Schema.decodeUnknownEffect(ViteManifestJson)(manifestText).pipe(
    Effect.mapError(() => new StaticAssetStoreError({ reason: "manifest-invalid", assetPath: ".vite/manifest.json" }))
  )

  const assetPaths = new Set<string>(["index.html"])
  for (const entry of Object.values(manifest)) {
    assetPaths.add(entry.file)
    for (const cssPath of entry.css ?? []) assetPaths.add(cssPath)
    for (const assetPath of entry.assets ?? []) assetPaths.add(assetPath)
  }
  for (const publicAsset of options.publicAssets ?? []) {
    const decoded = Schema.decodeUnknownResult(ManifestAssetPath)(publicAsset)
    if (Result.isFailure(decoded)) {
      return yield* new StaticAssetStoreError({ reason: "path-rejected", assetPath: publicAsset.slice(0, 1_024) })
    }
    assetPaths.add(decoded.success)
  }

  const assets = new Map<string, StoredStaticAsset>()
  let totalBytes = 0
  for (const assetPath of assetPaths) {
    const decodedPath = Schema.decodeUnknownResult(ManifestAssetPath)(assetPath)
    if (Result.isFailure(decodedPath)) {
      return yield* new StaticAssetStoreError({ reason: "path-rejected", assetPath })
    }
    const candidate = path.resolve(canonicalRoot, decodedPath.success)
    if (!containedRelativePath(path, canonicalRoot, candidate)) {
      return yield* new StaticAssetStoreError({ reason: "containment-rejected", assetPath })
    }
    const canonicalFile = yield* fileSystem.realPath(candidate).pipe(
      Effect.mapError(() => platformFailure(assetPath))
    )
    if (canonicalFile !== candidate || !containedRelativePath(path, canonicalRoot, canonicalFile)) {
      return yield* new StaticAssetStoreError({ reason: "containment-rejected", assetPath })
    }
    const info = yield* fileSystem.stat(canonicalFile).pipe(Effect.mapError(() => platformFailure(assetPath)))
    if (info.type !== "File") {
      return yield* new StaticAssetStoreError({ reason: "file-rejected", assetPath })
    }
    const sizeBytes = Number(info.size)
    const maximumBytes = assetPath === "index.html" ? maximumIndexBytes : maximumAssetBytes
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maximumBytes) {
      return yield* new StaticAssetStoreError({ reason: "asset-too-large", assetPath })
    }
    const extension = path.extname(assetPath).toLowerCase()
    const mimeType = MIME_BY_EXTENSION.get(extension)
    if (mimeType === undefined || (extension === ".html" && assetPath !== "index.html")) {
      return yield* new StaticAssetStoreError({ reason: "mime-rejected", assetPath })
    }
    const bytes = yield* fileSystem.readFile(canonicalFile).pipe(Effect.mapError(() => platformFailure(assetPath)))
    if (bytes.byteLength !== sizeBytes || bytes.byteLength > maximumBytes) {
      return yield* new StaticAssetStoreError({ reason: "asset-too-large", assetPath })
    }
    totalBytes += bytes.byteLength
    if (totalBytes > maximumTotalBytes) {
      return yield* new StaticAssetStoreError({ reason: "asset-total-too-large", assetPath })
    }
    assets.set(assetPath, {
      path: `/${assetPath}`,
      bytes: Uint8Array.from(bytes),
      mimeType,
      cacheControl: assetPath === "index.html" ? "no-store" : "public, max-age=31536000, immutable"
    })
  }

  const resolve = (requestPath: string, accept: string | null): Option.Option<StaticAssetResolution> => {
    const pathname = parseRequestPath(requestPath)
    if (pathname === undefined) return Option.none()
    const assetPath = pathname === "/" ? "index.html" : pathname.slice(1)
    const exact = assets.get(assetPath)
    if (exact !== undefined) {
      return Option.some({ ...exact, bytes: Uint8Array.from(exact.bytes), kind: "asset" })
    }
    const canUseSpa = !pathname.startsWith("/api/") &&
      pathname !== "/api" &&
      path.extname(pathname).length === 0 &&
      accept?.toLowerCase().includes("text/html") === true
    const index = assets.get("index.html")
    return canUseSpa && index !== undefined
      ? Option.some({ ...index, bytes: Uint8Array.from(index.bytes), kind: "spa" })
      : Option.none()
  }

  return { resolve, assetCount: assets.size, totalBytes }
})

/** Immutable startup static asset store. */
export class StaticAssetStore extends Context.Service<StaticAssetStore, StaticAssetStoreService>()(
  "@knpkv/control-center/server/http/security/StaticAssetStore"
) {
  static readonly layer = (
    options: StaticAssetStoreOptions
  ): Layer.Layer<StaticAssetStore, StaticAssetStoreError, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(StaticAssetStore, makeStaticAssetStore(options))
}
