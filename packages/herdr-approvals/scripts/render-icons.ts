/**
 * Renders the hub's PNG icons from `src/relay-icon.ts` with `rsvg-convert` and records, per icon, the
 * hash of the SVG it came from and of the PNG it produced. CI has no rasteriser, so the PNGs are
 * committed; `test/relay-icon.test.ts` fails when either hash no longer matches. Run after changing the
 * icons or rly's mark: `pnpm --filter @knpkv/herdr-approvals render:icons`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ChildProcessSpawner } from "effect/process"
import { relayIconAssets, relayIconSvg } from "../src/relay-icon.js"
import { runPackContractCommand as run } from "./pack-contract-command.js"

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const hashing = yield* Crypto.Crypto
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const packageRoot = path.join(import.meta.dirname, "..")
  const iconsDirectory = path.join(packageRoot, "icons")
  const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "relay-icons-" })
  const sha256 = (bytes: Uint8Array) => hashing.digest("SHA-256", bytes).pipe(Effect.map(hex))
  const entries: Record<string, { readonly pngSha256: string; readonly size: number; readonly sourceSha256: string }> =
    {}
  for (const asset of relayIconAssets) {
    const svg = relayIconSvg(asset.variant, asset.size)
    const source = path.join(scratch, `${asset.file}.svg`)
    const target = path.join(iconsDirectory, asset.file)
    yield* fileSystem.writeFileString(source, svg)
    yield* run(
      spawner,
      `render ${asset.file}`,
      "rsvg-convert",
      ["--width", String(asset.size), "--height", String(asset.size), "--output", target, source],
      packageRoot
    )
    entries[asset.file] = {
      pngSha256: yield* sha256(yield* fileSystem.readFile(target)),
      size: asset.size,
      sourceSha256: yield* sha256(new TextEncoder().encode(svg))
    }
  }
  yield* fileSystem.writeFileString(path.join(iconsDirectory, "icons.json"), `${JSON.stringify(entries, null, 2)}\n`)
  yield* Console.log(`rendered ${String(relayIconAssets.length)} icons into ${iconsDirectory}`)
}).pipe(Effect.scoped)

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
