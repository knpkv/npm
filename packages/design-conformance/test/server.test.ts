import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"

import { serveFiles } from "../src/server.js"

layer(Layer.merge(NodeServices.layer, NodeHttpClient.layerUndici))("reference asset responses", (it) => {
  it.effect("both JavaScript module extensions have executable MIME while binary files stay binary", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const client = yield* HttpClient.HttpClient
      const root = yield* fs.makeTempDirectoryScoped()
      const files = { "/module.js": "module.js", "/module.mjs": "module.mjs", "/fixture.bin": "fixture.bin" }
      for (const file of Object.values(files)) yield* fs.writeFileString(path.join(root, file), "fixture bytes")
      const origin = yield* serveFiles(root, files)
      for (
        const [file, type] of [["module.js", "text/javascript"], ["module.mjs", "text/javascript"], [
          "fixture.bin",
          "application/octet-stream"
        ]]
      ) {
        const response = yield* client.get(`${origin}/${file}?cache=fixture`)
        expect(response.status).toBe(200)
        expect(response.headers["content-type"]?.split(";")[0]).toBe(type)
        expect(yield* response.text).toBe("fixture bytes")
      }
    }))
})
