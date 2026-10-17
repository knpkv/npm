import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

import { Fixture, InvalidContract, Manifest, ReferenceFailure, Waivers } from "./schema.js"

export const readJson = Effect.fn("DesignConformance.readJson")(
  function*<S extends Schema.Top & { readonly DecodingServices: never }>(file: string, schema: S) {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => new InvalidContract({ file, cause }))
    )
  }
)

/** In-memory bodies are the exact bytes whose hashes passed the manifest boundary. */
export type VerifiedBodies = ReadonlyMap<string, Uint8Array>

export const verifiedBody = (bodies: VerifiedBodies, file: string) => {
  const body = bodies.get(file)
  return body === undefined
    ? Effect.fail(new ReferenceFailure({ file, detail: "Verified reference body is unavailable" }))
    : Effect.succeed(body)
}

export const readVerifiedJson = Effect.fn("DesignConformance.readVerifiedJson")(
  function*<S extends Schema.Top & { readonly DecodingServices: never }>(
    bodies: VerifiedBodies,
    file: string,
    schema: S
  ) {
    const body = yield* verifiedBody(bodies, file)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(body), {
      onExcessProperty: "error"
    }).pipe(Effect.mapError((cause) => new InvalidContract({ file, cause })))
  }
)

/** Reject symlinks, unlisted assets and stale hashes before either renderer starts. */
export const loadReferences = Effect.fn("DesignConformance.loadReferences")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  const requested = path.resolve(directory)
  // Effect stat follows links; readLink inspects the root entry before canonicalization.
  yield* fs.readLink(requested).pipe(Effect.matchEffect({
    onFailure: (error) =>
      Schema.is(Schema.Struct({ code: Schema.Literal("EINVAL") }))(error.cause)
        ? Effect.void
        : Effect.fail(error),
    onSuccess: () => Effect.fail(new ReferenceFailure({ file: requested, detail: "Symlinks are not reference roots" }))
  }))
  const root = yield* fs.realPath(requested)
  if ((yield* fs.realPath(path.join(root, "manifest.json"))) !== path.join(root, "manifest.json")) {
    return yield* new ReferenceFailure({ file: "manifest.json", detail: "Symlinks are not reference files" })
  }
  const manifest = yield* readJson(path.join(root, "manifest.json"), Manifest)
  const files: Array<string> = []
  const pending = [root]
  while (pending.length > 0) {
    const parent = pending.pop()
    if (parent === undefined) break
    for (const name of yield* fs.readDirectory(parent)) {
      const file = path.join(parent, name)
      const relative = path.relative(root, file).split(path.sep).join("/")
      if ((yield* fs.realPath(file)) !== file) {
        return yield* new ReferenceFailure({ file: relative, detail: "Symlinks are not reference files" })
      }
      const info = yield* fs.stat(file)
      if (info.type === "Directory") pending.push(file)
      else if (relative.split("/").some((segment) => segment.toLowerCase() === "uploads")) {
        // Design uploads are source material (prototypes, screenshots) that can hold real names; refs are exports.
        return yield* new ReferenceFailure({ file: relative, detail: "Design uploads are never reference files" })
      } else if (relative !== "manifest.json" && relative !== "waivers.json") files.push(relative)
    }
  }
  const expected = Object.keys(manifest.files).sort()
  if (expected.join("|") !== files.sort().join("|")) {
    return yield* new ReferenceFailure({
      file: "manifest.json",
      detail: "Hash inventory must include every reference file, and only existing files"
    })
  }
  const verified = new Map<string, Uint8Array>()
  for (const file of files) {
    const bytes = yield* fs.readFile(path.join(root, file))
    const digest = yield* cryptoService.digest("SHA-256", bytes)
    const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
    if (hash !== manifest.files[file]) return yield* new ReferenceFailure({ file, detail: "SHA256 mismatch" })
    verified.set(file, bytes)
  }
  const bodies: VerifiedBodies = verified
  const fixture = yield* readVerifiedJson(bodies, manifest.fixture, Fixture)
  const waivers = yield* readJson(path.join(root, "waivers.json"), Waivers)
  return { root, manifest, fixture, waivers, bodies }
})
