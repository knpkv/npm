/**
 * A local npm registry for installer tests: packuments and tarballs for packages the test packs itself, with no
 * network. Fake apps have no dependencies, so `npm install` needs nothing else.
 */
import { Effect, FileSystem, Predicate, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"

/** The node and npm a test runs npm with (the test finds npm with the CLI's own rule). */
export interface TestNpm {
  readonly node: string
  readonly npmCli: string
}

/** What a published version's packument says in `hubApp`. */
export interface PublishedHubApp {
  readonly bin: string
  readonly contract: number
  readonly services: ReadonlyArray<string>
}

export interface FakeApp {
  readonly name: string
  readonly version: string
  /** The id its manifest answers with. */
  readonly id: string
  readonly contract?: number
  /** Services its manifest asks for. */
  readonly services?: ReadonlyArray<string>
  /** Services its package.json `hubApp` declares; `services` by default. */
  readonly declared?: ReadonlyArray<string>
  /** `hubApp.bin`; `bin.js` by default. */
  readonly bin?: string
  /** Exit at once instead of serving. */
  readonly crash?: boolean
}

/** A dependency-free app: reads the hub's handshake, serves its manifest to the right secret on the endpoint. */
const binSource = (app: FakeApp) => {
  const manifest = {
    contract: app.contract ?? 1,
    id: app.id,
    package: app.name,
    version: app.version,
    module: {
      id: app.id,
      label: "Fake",
      defaultPage: "overview",
      pages: [{ id: "overview", label: "Overview" }],
      listeners: ["serve", "local"],
      requires: ["read"]
    },
    client: { entry: "client.js", css: [] },
    services: app.services ?? [],
    nav: { order: 100, primary: false, mobile: false },
    standalone: { defaultPort: 3199 }
  }
  return app.crash === true
    ? "process.exit(3)\n"
    : `import { createServer } from "node:http"
import { createInterface } from "node:readline"
const manifest = ${JSON.stringify(manifest)}
let started = false
const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  if (started) return
  started = true
  const handshake = JSON.parse(line)
  createServer((request, response) => {
    if (request.headers["x-hub-app-secret"] !== handshake.appSecret) return response.writeHead(403).end()
    if (request.url === "/app/manifest") {
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(manifest))
    }
    response.writeHead(404).end()
  }).listen(handshake.endpoint)
})
lines.on("close", () => process.exit(0))
`
}

export interface Packed {
  readonly tarball: string
  readonly integrity: string
  /** The tarball's bytes, read once when packed, so the registry serves them without file access. */
  readonly bytes: Uint8Array
}

const PackResult = Schema.Array(Schema.Struct({ filename: Schema.String, integrity: Schema.String }))

/** Writes `app` as a package and packs it with npm. */
export const packFakeApp = Effect.fn("test.packFakeApp")(function*(npm: TestNpm, app: FakeApp) {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "fake-app-" })
  const dir = `${root}/package`
  const bin = app.bin ?? "bin.js"
  yield* fileSystem.makeDirectory(dir)
  yield* fileSystem.writeFileString(
    `${dir}/package.json`,
    JSON.stringify({
      name: app.name,
      version: app.version,
      type: "module",
      hubApp: { bin, contract: app.contract ?? 1, services: app.declared ?? app.services ?? [] }
    })
  )
  yield* fileSystem.writeFileString(`${dir}/bin.js`, binSource(app))
  const child = yield* spawner.spawn(
    ChildProcess.make(npm.node, [npm.npmCli, "pack", "--json", "--pack-destination", root], { cwd: dir })
  )
  const [stdout] = yield* Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode], {
    concurrency: "unbounded"
  })
  const [packed] = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackResult))(stdout)
  if (packed === undefined) return yield* Effect.die("npm pack wrote nothing")
  const tarball = `${root}/${packed.filename}`
  const result: Packed = { tarball, integrity: packed.integrity, bytes: yield* fileSystem.readFile(tarball) }
  return result
})

export interface Registry {
  readonly url: string
  /** Every request path, in order. */
  readonly requests: Array<string>
  /** Serves `packed` for `name@version` from now on (the packument and the tarball). */
  readonly publish: (name: string, version: string, packed: Packed, hubApp: PublishedHubApp) => void
  /** Serves these bytes as the tarball while the packument keeps the old integrity. */
  readonly corrupt: (name: string, version: string) => void
  /** Accepts requests under `prefix` from now on and never answers them. */
  readonly stall: (prefix: string) => void
}

/** A registry on a loopback port for the test's scope. */
export const startRegistry = Effect.acquireRelease(
  Effect.callback<{ server: Server; registry: Registry }>((resume) => {
    const requests: Array<string> = []
    const stalled: Array<string> = []
    const published = new Map<string, Map<string, { packed: Packed; hubApp: PublishedHubApp; corrupt: boolean }>>()
    let base = ""
    const server = createServer((request, response) => {
      const url = decodeURIComponent(request.url ?? "")
      requests.push(url)
      if (stalled.some((prefix) => url.startsWith(prefix))) return
      const tarball = /^\/-\/tarballs\/(.+)\/(\d[^/]*)\.tgz$/u.exec(url)
      if (tarball !== null) {
        const entry = published.get(tarball[1] ?? "")?.get(tarball[2] ?? "")
        if (entry === undefined) return response.writeHead(404).end()
        return response.writeHead(200).end(
          entry.corrupt ? new TextEncoder().encode("not a tarball") : entry.packed.bytes
        )
      }
      const versions = published.get(url.slice(1))
      if (versions === undefined) {
        return response.writeHead(404, { "content-type": "application/json" }).end("{\"error\":\"not found\"}")
      }
      const names = [...versions.keys()]
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        name: url.slice(1),
        "dist-tags": { latest: names.at(-1) },
        versions: Object.fromEntries(names.map((version) => {
          const entry = versions.get(version)
          return [version, {
            name: url.slice(1),
            version,
            hubApp: entry?.hubApp,
            dist: { integrity: entry?.packed.integrity, tarball: `${base}-/tarballs/${url.slice(1)}/${version}.tgz` }
          }]
        })),
        time: Object.fromEntries(names.map((version) => [version, "2026-10-20T10:00:00.000Z"]))
      }))
    })
    server.once("error", (error) => resume(Effect.die(error)))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = address === null || Predicate.isString(address) ? 0 : address.port
      base = `http://127.0.0.1:${port}/`
      resume(Effect.succeed({
        server,
        registry: {
          url: base,
          requests,
          publish: (name, version, packed, hubApp) => {
            const versions = published.get(name) ?? new Map()
            versions.set(version, { packed, hubApp, corrupt: false })
            published.set(name, versions)
          },
          stall: (prefix) => {
            stalled.push(prefix)
          },
          corrupt: (name, version) => {
            const entry = published.get(name)?.get(version)
            if (entry !== undefined) published.get(name)?.set(version, { ...entry, corrupt: true })
          }
        }
      }))
    })
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections()
      server.close(() => resume(Effect.void))
    })
).pipe(Effect.map(({ registry }) => registry))
