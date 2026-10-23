/** `herdr-usage --port 0` end to end: the page, the manifest, and one read behind the owner's sign-in. */
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { BrowserOpener } from "@knpkv/browser-pairing/launch"
import { FleetLimits } from "@knpkv/herdr-connect/usage"
import { AppManifest } from "@knpkv/hub-app"
import { serveApp } from "@knpkv/hub-app/node"
import { Effect, FileSystem, Layer, Schedule, Schema, Sink, Stdio } from "effect"
import { type IncomingHttpHeaders, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { usageApp } from "../src/app.js"

const overTcp = (url: string, method: string, headers: Record<string, string>) =>
  Effect.callback<{ readonly status: number; readonly body: string; readonly headers: IncomingHttpHeaders }>(
    (resume) => {
      const outgoing = httpRequest(url, { method, headers }, (incoming) => {
        const chunks: Array<Buffer> = []
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
        incoming.on("end", () =>
          resume(Effect.succeed({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: incoming.headers
          })))
      })
      outgoing.end()
    }
  )

describe("herdr-usage standalone", () => {
  // The sign-in link is the only thing a standalone run prints; it names the port it bound.
  const printed: Array<string> = []
  const testLayer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerNodeHttp,
    Layer.succeed(BrowserOpener, BrowserOpener.of({ open: () => Effect.void })),
    Stdio.layerTest({
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.sync(() => {
            printed.push(Buffer.from(chunk).toString())
          })
        )
    })
  )

  it.layer(testLayer, { excludeTestServices: true })((it) => {
    it.effect("serves its page and manifest, and its limits read once the owner signs in", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const client = yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "herdr-usage-" })
        yield* fileSystem.writeFileString(`${client}/client.js`, "export default {}\n")
        yield* fileSystem.writeFileString(`${client}/client.css`, "\n")
        // No limits command: the read answers this host as not configured, without spawning anything.
        yield* serveApp(
          usageApp("0.0.0-test", { limitsCommand: undefined }, client),
          { _tag: "Standalone", port: 0, open: false },
          { _tag: "Skip", reason: "test" }
        ).pipe(Effect.forkScoped)
        const link = yield* Effect.sync(() => printed.join("")).pipe(
          Effect.flatMap((text) => {
            const line = text.split("\n").find((candidate) => candidate.startsWith("http://"))
            return line === undefined ? Effect.fail("not yet") : Effect.succeed(line.trim())
          }),
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 })
        )
        const origin = new URL(link).origin
        const sameSite = { origin, "sec-fetch-site": "same-origin" }

        const page = yield* overTcp(`${origin}/`, "GET", sameSite)
        expect(page.status).toBe(200)
        expect(page.body).toContain("<main id=\"hub-app-root\" data-app=\"usage\">")
        // The shell stylesheet's URL carries a hash of its text, so it is served to be kept for good.
        const shellCss = page.body.match(/<link rel="stylesheet" href="(\/app\/shell\.css\?v=[0-9a-f]{16})">/u)?.[1]
        expect(shellCss).toBeDefined()
        const css = yield* overTcp(`${origin}${shellCss ?? ""}`, "GET", sameSite)
        expect([css.status, css.headers["cache-control"]]).toEqual([200, "public, max-age=31536000, immutable"])

        const manifest = yield* overTcp(`${origin}/app/manifest`, "GET", sameSite)
        const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(AppManifest))(manifest.body)
        expect([decoded.id, decoded.module.pages.map((entry) => entry.id), decoded.client.css]).toEqual([
          "usage",
          ["limits", "tokens", "by-tool"],
          ["client.css"]
        ])

        const limitsPath = `${origin}/api/v1/modules/usage/limits`
        expect((yield* overTcp(limitsPath, "GET", sameSite)).status).toBe(403)
        const code = new URLSearchParams(new URL(link).hash.slice(1)).get("bootstrap_token") ?? ""
        const spent = yield* overTcp(`${origin}/auth/bootstrap`, "POST", {
          ...sameSite,
          authorization: `Bearer ${code}`
        })
        const cookie = [spent.headers["set-cookie"] ?? []].flat()[0]?.split(";")[0] ?? ""
        const limits = yield* overTcp(limitsPath, "GET", { ...sameSite, cookie })
        expect(limits.status).toBe(200)
        const hosts = Schema.decodeUnknownSync(Schema.fromJsonString(FleetLimits))(limits.body).hosts
        expect(hosts.map((host) => host.reading._tag)).toEqual(["Unavailable"])
      }).pipe(Effect.scoped))
  })
})
