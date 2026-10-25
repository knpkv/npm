import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const packages = join(import.meta.dirname, "..", "..")
const hubSource = join(packages, "herdr-hub", "src")
const connectSource = join(packages, "herdr-connect", "src")

interface SourceFile {
  readonly path: string
  readonly text: string
}

/** Every TypeScript file under `root`, named relative to it. */
const sourceFiles = (root: string, directory = root): ReadonlyArray<SourceFile> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(root, join(directory, entry.name))
      : /\.tsx?$/u.test(entry.name)
      ? [{ path: relative(root, join(directory, entry.name)), text: readFileSync(join(directory, entry.name), "utf8") }]
      : []
  )

// The session CSRF layer is built on the browser's fetch client; hostd is the Node host daemon, whose fetch
// client talks to AWS for the sandbox pool, never to the hub's page routes.
const fetchClientOwners: ReadonlySet<string> = new Set(["session-csrf.ts", "hostd.ts"])

/**
 * The files that build an HTTP client on fetch other than through the session CSRF layer.
 * `BrowserHttpClient.layerFetch` is `FetchHttpClient.layer`, so either name is a bare fetch client.
 */
const bareFetchClients = (files: ReadonlyArray<SourceFile>): ReadonlyArray<string> =>
  files
    .filter((file) => !fetchClientOwners.has(file.path) && /\b(?:BrowserHttpClient|FetchHttpClient)\b/u.test(file.text))
    .map((file) => file.path)

/** The files that send anything but a read: a non-GET client method, a built request, a raw fetch or a method. */
const writers = (files: ReadonlyArray<SourceFile>): ReadonlyArray<string> =>
  files
    .filter((file) =>
      /\.(?:post|put|patch|del|options|execute)\(|\bHttpClientRequest\.|\bfetch\(|\bmethod\s*:|\bsendBeacon\b|\bXMLHttpRequest\b/u
        .test(file.text)
    )
    .map((file) => file.path)

describe("browser runtimes", () => {
  // A browser runtime built on a bare fetch client sends its writes without the session's CSRF token, and
  // the hub refuses every one. Only the session CSRF module may take the fetch client; every runtime that
  // writes takes its layer.
  it("build their HTTP client only through the session CSRF layer", () => {
    expect(bareFetchClients(sourceFiles(hubSource))).toEqual([])
    expect(readFileSync(join(hubSource, "session-csrf.ts"), "utf8")).toContain("BrowserHttpClient.layerFetch")
  })

  // Either name is caught in a browser file; hostd keeps its own.
  it("catch a browser runtime on either fetch client name", () => {
    const bare = "const runtime = Atom.runtime(FetchHttpClient.layer)"
    expect(bareFetchClients([{ path: "connect-view.tsx", text: bare }])).toEqual(["connect-view.tsx"])
    expect(bareFetchClients([{ path: "notes.tsx", text: "Atom.runtime(BrowserHttpClient.layerFetch)" }])).toEqual([
      "notes.tsx"
    ])
    expect(bareFetchClients([{ path: "hostd.ts", text: bare }])).toEqual([])
  })

  // herdr-connect's runtimes take the bare fetch client because they only read; a write there would go out
  // without the token.
  it("leave herdr-connect reading only", () => {
    expect(writers(sourceFiles(connectSource))).toEqual([])
    expect(writers([{ path: "mute.ts", text: "client.post(\"/v1/push/mutes\")" }])).toEqual(["mute.ts"])
    expect(writers([{ path: "agents.ts", text: "client.get(\"/v1/connect/agents\")" }])).toEqual([])
  })
})
