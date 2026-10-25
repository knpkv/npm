# @knpkv/hub-app

The contract and runner for apps that run on their own and mount in the Relay hub, from one entry point.

An app is always its own process:

- **standalone**: `my-app [serve] [--port <n>] [--no-open]` listens on loopback, prints a one-time sign-in link and
  serves a minimal shell at `/`.
- **attached**: the hub starts `my-app --attach` itself and writes one handshake line on its stdin: the endpoint to
  listen on (a unix socket, or a named pipe on Windows), the hub's URL, a token and a secret, all fresh per start.
  The app answers only requests that carry the secret. The hub authenticates each browser request, proxies it
  there with the caller in `x-hub-caller` and a grant in `x-hub-grant`, and mounts the app's client in its own
  shell. When the hub closes stdin, the app stops.

An app's package.json names its script for the hub: `"hubApp": { "bin": "dist/bin.js", "contract": 1, "services":
[...] }`.

## Write an app

```ts
import { ModuleHandlers, moduleReadRoute } from "@knpkv/hub-app"
import { runApp } from "@knpkv/hub-app/node"
import { Effect, Layer, Schema } from "effect"

const handlers = Layer.succeed(ModuleHandlers, {
  routes: [
    moduleReadRoute("/hello", Schema.fromURLSearchParams(Schema.Struct({})), Schema.String, (_query, caller) =>
      Effect.succeed(`hello ${caller.login}`)
    )
  ]
})

runApp({ manifest, handlers, clientDirectory: new URL("../client", import.meta.url).pathname }, Layer.empty)
```

`manifest` is an `AppManifestInput`: `contract: 1`, the app's `id`, its `module` descriptor (label, pages,
listeners), the shell `services` it uses, its `nav` placement and its standalone `defaultPort`.

The client directory holds `client.js` (an ES module whose default export is an `AppClient`) and, optionally,
`client.css` scoped under `[data-app="<id>"]`. `mount(root, context)` renders into `root` with the app's own
React (or none); `ShellContext` gives it routing, the path and headers for its module routes, the crumb, a header slot and a
portal root.

Fields added after contract 1 shipped are optional, so an app feature-detects them: `headerOutlet` with
`setHeaderMode` (the hub's grouped header), `href(page, search)` (a link to one of the app's pages in the shell's
route shape; without it, build `?<search>#<id>/<page>`) and `host` (the machine the hub runs on). A shell checks a
loaded client module with `AppClientModule` before it mounts it.

## Shell services

`ShellServices` (from `@knpkv/hub-app/hub-client`) is available to every handler once the hub has read the app's manifest:

- `host`: this host, whether it is the hub, and the fleet's hosts.
- `fleetRead(read, query)`: the hub's fleet-wide reads.
- `submitJob(payload)`: a Fleet job for the caller of the request being served. The hub resolves the caller from
  the request's grant, which is spent on use.
- `relayPost(kind, text)`: a Relay post as that caller, or as the app outside a request.

Attached, the hub reads the manifest from the listening app, so a call made while the handler layer is still being
built (before the app listens) is answered `503 unavailable` and fails with `ShellServiceRefused`. Call services from
route handlers, or behind `Effect.cached` on first use, never while building the layer.

Standalone, every service but `host` fails with `ShellServiceUnavailable("standalone")`; a service the manifest
doesn't declare fails with `undeclared`.

## Versioning

`contract` is one integer for the whole shell–app surface. The hub mounts the current contract and the one before
it; an app on any other is listed as unavailable ("needs a different version of the hub") and never mounted.
