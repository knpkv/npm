import { NodeHttpClient } from "@effect/platform-node"
import { make as makeTailscale } from "@knpkv/herdr-tailscale"
import { Effect, Option, Ref, Schedule, Schema } from "effect"
import { HttpClient } from "effect/http"
import type { ResourcePreview } from "../../host-resources-model.js"

export const PreviewHostname = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/i)
)
const decodeHostname = Schema.decodeUnknownOption(PreviewHostname)
export type PreviewOpen = ResourcePreview["open"]
export const previewKey = (preview: ResourcePreview): string => `${preview.port}:${preview.pid}`

/** Requests status headers only. Scope closure aborts the body and never follows redirects. */
export const probePreview = Effect.fn("HostResources.probePreview")(
  function*(client: HttpClient.HttpClient, port: number) {
    for (const scheme of ["https", "http"] satisfies ReadonlyArray<"https" | "http">) {
      const status = yield* Effect.scoped(
        HttpClient.withScope(client).get(`${scheme}://127.0.0.1:${port}/`).pipe(
          Effect.map((response) => response.status),
          Effect.timeout("2 seconds"),
          Effect.option
        )
      )
      if (Option.isSome(status)) return scheme
    }
    return null
  }
)

/** The TLS exception belongs to this loopback-only client and dies with the sampler scope. */
export const startPreviewProbes = Effect.fn("HostResources.startPreviewProbes")(function*(
  tailscaleCommand: string,
  scan: Effect.Effect<ReadonlyArray<ResourcePreview>>
) {
  const tailscale = yield* makeTailscale(tailscaleCommand)
  const agent = yield* NodeHttpClient.makeAgent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 4 })
  const client = yield* NodeHttpClient.makeNodeHttp.pipe(Effect.provideService(NodeHttpClient.HttpAgent, agent))
  const latest = yield* Ref.make<ReadonlyMap<string, PreviewOpen>>(new Map())
  const pass = Effect.gen(function*() {
    const previews = yield* scan
    const status = yield* tailscale.status.pipe(Effect.timeout("3 seconds"), Effect.result)
    const host = status._tag === "Failure"
      ? Option.none()
      : decodeHostname(status.success.Self.DNSName?.replace(/\.$/, ""))
    const entries = yield* Effect.forEach(previews, (preview) =>
      Effect.gen(function*() {
        let open: PreviewOpen
        if (status._tag === "Failure") open = { _tag: "Unavailable", reason: "tailscale_unavailable" }
        else if (!preview.tailnet) open = { _tag: "Unavailable", reason: "not_tailnet" }
        else if (Option.isNone(host)) open = { _tag: "Unavailable", reason: "no_dns_name" }
        else {
          const scheme = yield* probePreview(client, preview.port)
          open = scheme === null
            ? { _tag: "Unavailable", reason: "probe_failed" }
            : { _tag: "Ready", url: `${scheme}://${host.value}:${preview.port}/` }
        }
        return [previewKey(preview), open] satisfies readonly [string, PreviewOpen]
      }), { concurrency: 4 })
    yield* Ref.set(latest, new Map(entries))
  })
  yield* pass.pipe(Effect.repeat(Schedule.spaced("60 seconds")), Effect.forkScoped)
  return { read: Ref.get(latest) }
})
