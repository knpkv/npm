import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

import { readJson } from "../src/references.js"
import { Manifest, Name, RunnerFailure } from "../src/schema.js"

const Matrix = Schema.Struct({ include: Schema.Array(Schema.Struct({ product: Name, package: Schema.String })) })
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
  const root = path.join(repository, "design-refs")
  const include = []
  for (const name of (yield* fs.readDirectory(root)).sort()) {
    const directory = path.join(root, name)
    if ((yield* fs.stat(directory)).type !== "Directory") continue
    const manifest = yield* readJson(path.join(directory, "manifest.json"), Manifest)
    if (manifest.product !== name) {
      return yield* new RunnerFailure({ detail: "Manifest product differs from directory" })
    }
    include.push({ product: manifest.product, package: manifest.live.package })
  }
  const json = yield* Schema.encodeEffect(Schema.fromJsonString(Matrix))({ include })
  const output = yield* Config.String("GITHUB_OUTPUT")
  yield* fs.writeFileString(output, `matrix=${json}\n`, { flag: "a" })
  yield* Console.log(json)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
