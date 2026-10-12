import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

import { Name } from "../src/schema.js"
import { discoverReferenceManifests, productMatrix } from "./discovery.js"

const Matrix = Schema.Struct({ include: Schema.Array(Schema.Struct({ product: Name, package: Schema.String })) })
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
  const baseRef = yield* Config.String("DESIGN_BASE_REF").pipe(Config.withDefault("origin/main"))
  const manifests = yield* discoverReferenceManifests(repository, baseRef)
  const json = yield* Schema.encodeEffect(Schema.fromJsonString(Matrix))(
    productMatrix(manifests.current, manifests.base)
  )
  const output = yield* Config.String("GITHUB_OUTPUT")
  yield* fs.writeFileString(output, `matrix=${json}\n`, { flag: "a" })
  yield* Console.log(json)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
