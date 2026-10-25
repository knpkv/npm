/**
 * The app supervisor with real child processes: each app is a script in its own install prefix, run with this
 * Node and `--attach`. The happy path is the built fixture app; the failures are small scripts that throw, never
 * listen, or stop answering. Timings are shortened; the backoff and crashloop rules are also checked as pure
 * functions with the real numbers.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AppId, appPaths, hubHeaders, type InstalledApp } from "@knpkv/hub-app"
import { Effect, FileSystem, Logger, Path, Redacted, Schedule, Schema } from "effect"
import { spawn } from "node:child_process"
import { Agent, request as httpRequest } from "node:http"
import { tmpdir, userInfo } from "node:os"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { type AppTokens, makeAppTokens } from "../src/apps/grants.js"
import {
  defaultTiming,
  endpointFor,
  entryScript,
  inCrashloop,
  makeSupervisor,
  restartDelayMillis,
  type SupervisorTiming
} from "../src/apps/supervisor.js"

const appId = Schema.decodeSync(AppId)
const windows = process.platform === "win32"
const fixtureBin = fileURLToPath(import.meta.resolve("@knpkv/hub-app-fixture").replace("/index.js", "/bin.js"))
const fixtureIndex = fileURLToPath(import.meta.resolve("@knpkv/hub-app-fixture"))

const fast: SupervisorTiming = {
  listenMillis: 3_000,
  stopMillis: 5_000,
  probeEveryMillis: 100,
  probeTimeoutMillis: 300,
  misses: 3,
  backoffBaseMillis: 20,
  backoffCapMillis: 100,
  healthyResetMillis: 600_000,
  crashloopExits: 3,
  crashloopWindowMillis: 60_000
}

/** Scripts an app prefix can hold; each writes its pid next to itself first. */
const scripts = {
  ok: `import { writeFileSync } from "node:fs"
writeFileSync(new URL("./pid", import.meta.url), String(process.pid))
await import(${JSON.stringify(pathToFileURL(fixtureBin).href)})
`,
  throws: `throw new Error("the fixture throws at start")
`,
  // Reads stdin and never listens, ignoring its end: only a kill stops it.
  hangs: `import { writeFileSync } from "node:fs"
writeFileSync(new URL("./pid", import.meta.url), String(process.pid))
process.stdin.resume()
setInterval(() => {}, 1000)
`,
  // Listens and answers as the app twice, then never answers again; stops when stdin ends.
  deaf: `import { createServer } from "node:http"
import { fixtureManifest } from ${JSON.stringify(pathToFileURL(fixtureIndex).href)}
let line = ""
let answered = 0
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  if (line.includes("\\n")) return
  line += chunk
  if (!line.includes("\\n")) return
  const handshake = JSON.parse(line.slice(0, line.indexOf("\\n")))
  createServer((request, response) => {
    if (answered >= 2) return
    answered += 1
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ...fixtureManifest("ok", "deaf"), client: { entry: "client.js", css: [] } }))
  }).listen(handshake.endpoint)
})
process.stdin.on("end", () => process.exit(0))
`
}

/** An install prefix for `id` holding `bin.mjs`, as the installer would leave it. */
const installed = (root: string, id: string, script: keyof typeof scripts, overrides: Partial<InstalledApp> = {}) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = path.join(root, "hub-apps", id, "0.0.0")
    yield* fileSystem.makeDirectory(dir, { recursive: true })
    yield* fileSystem.writeFileString(path.join(dir, "bin.mjs"), scripts[script])
    const entry: InstalledApp = {
      id: appId(id),
      package: "@knpkv/hub-app-fixture",
      version: "0.0.0",
      dir,
      bin: "bin.mjs",
      enabled: true,
      memoryMb: 128,
      allowScripts: false,
      ...overrides
    }
    return entry
  })

const supervisorIn = (
  root: string,
  timing: SupervisorTiming = fast,
  runtime: { readonly runtimeDirectory: string | null; readonly shortRuntimeDirectory: string } = {
    runtimeDirectory: windows ? null : `${root}/run`,
    shortRuntimeDirectory: `${root}/short`
  },
  uid: number = userInfo().uid
) =>
  Effect.gen(function*() {
    const tokens = yield* makeAppTokens
    // Every token the supervisor issues, in order.
    const issued: Array<Redacted.Redacted<string>> = []
    const recording: AppTokens = {
      ...tokens,
      issue: (app, spawn) => tokens.issue(app, spawn).pipe(Effect.tap((token) => Effect.sync(() => issued.push(token))))
    }
    const user = userInfo()
    const supervisor = yield* makeSupervisor({
      node: process.execPath,
      ...runtime,
      logsDirectory: `${root}/logs`,
      hubUrl: Effect.succeed("http://127.0.0.1:9"),
      tokens: recording,
      user: { name: user.username, uid },
      timing
    })
    return { supervisor, tokens, issued }
  })

/** Wait until `id`'s run matches, polling every 20 ms for up to 10 s. */
const until = <A, R>(read: Effect.Effect<A, never, R>, done: (value: A) => boolean) =>
  read.pipe(
    Effect.filterOrFail(done, () => "not yet"),
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }),
    Effect.orDie
  )

const pidOf = (entry: InstalledApp) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    return Number(yield* fileSystem.readFileString(`${entry.dir}/pid`))
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const tempRoot = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  // Short: socket paths are limited to about 104 bytes.
  return yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "sup-" })
})

describe("supervisor rules", () => {
  it("backs off 1 s, 2 s, 4 s … up to 60 s", () => {
    expect([1, 2, 3, 4, 7, 8, 20].map((failures) => restartDelayMillis(failures, defaultTiming))).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      60_000,
      60_000,
      60_000
    ])
  })

  it("is in crashloop after 5 exits within 10 minutes, not after 5 spread wider", () => {
    const minute = 60_000
    expect(inCrashloop([0, minute, 2 * minute, 3 * minute, 4 * minute], 4 * minute, defaultTiming)).toBe(true)
    expect(inCrashloop([0, 3 * minute, 6 * minute, 9 * minute, 12 * minute], 12 * minute, defaultTiming)).toBe(false)
  })

  // A hand-edited or nix-written apps.json goes straight to spawn: the script must stay inside its prefix.
  it("runs only a script inside an absolute prefix, by the OS's path rules", () => {
    const entry = (dir: string, bin: string): InstalledApp => ({
      id: appId("usage"),
      package: "@knpkv/herdr-usage",
      version: "1.0.0",
      dir,
      bin,
      enabled: true,
      memoryMb: 512,
      allowScripts: false
    })
    expect(entryScript(entry("/data/usage/1.0.0", "node_modules/@knpkv/herdr-usage/dist/bin.js"), false)).toBe(
      "/data/usage/1.0.0/node_modules/@knpkv/herdr-usage/dist/bin.js"
    )
    expect(entryScript(entry("relative/1.0.0", "bin.js"), false)).toBeNull()
    expect(entryScript(entry("/data/usage/1.0.0", "../../other/bin.js"), false)).toBeNull()
    expect(entryScript(entry("/data/usage/1.0.0", "/etc/bin.js"), false)).toBeNull()
    expect(entryScript(entry("C:\\Users\\owner\\usage", "dist\\bin.js"), true)).toBe(
      "C:\\Users\\owner\\usage\\dist\\bin.js"
    )
    expect(entryScript(entry("C:\\Users\\owner\\usage", "..\\..\\bin.js"), true)).toBeNull()
    expect(entryScript(entry("C:\\Users\\owner\\usage", "D:\\bin.js"), true)).toBeNull()
  })

  it("names a Windows pipe with the spawn's nonce, and a socket with the nonce alone", () => {
    const nonce = "0123456789abcdef0123456789abcdef"
    expect(endpointFor({ _tag: "Windows", user: "owner" }, appId("usage"), nonce)).toBe(
      "\\\\.\\pipe\\herdr-hub-owner-usage-0123456789abcdef"
    )
    // The id stays out of a socket's name, so the usual runtime directory fits `sun_path` (51 bytes here).
    expect(endpointFor({ _tag: "Posix", directory: "/run/user/1000/herdr-hub/apps" }, appId("usage"), nonce)).toBe(
      "/run/user/1000/herdr-hub/apps/0123456789abcdef.sock"
    )
  })
})

describe("supervisor", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    // An embedding that didn't hand the hub its Node starts no app. One journal line says so and what to do; it repeats
    // only when the set of apps it can't start changes, so the 30 s reload doesn't spam the journal.
    it.effect("warns once in the journal when listed apps can't start for want of a Node path", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const user = userInfo()
        const supervisor = yield* makeSupervisor({
          node: null,
          runtimeDirectory: windows ? null : `${root}/run`,
          shortRuntimeDirectory: `${root}/short`,
          logsDirectory: `${root}/logs`,
          hubUrl: Effect.succeed("http://127.0.0.1:9"),
          tokens: yield* makeAppTokens,
          user: { name: user.username, uid: user.uid },
          timing: fast
        })
        const usage = yield* installed(root, "usage", "ok")
        const notes = yield* installed(root, "notes", "ok", { enabled: false })
        const messages: Array<unknown> = []
        const logger = Logger.make<unknown, void>((entry) => messages.push(entry.message))
        yield* Effect.gen(function*() {
          yield* supervisor.sync([notes])
          yield* supervisor.sync([usage, notes])
          yield* supervisor.sync([usage, notes])
        }).pipe(Effect.withLogger(logger))
        const warnings = messages.flat().filter((message) => String(message).includes("without its Node path"))
        expect(warnings).toEqual([
          "Hub apps are listed but this hub was started without its Node path, so none of them run: usage. " +
          "Pass node (the Node binary's path) to makeHostdProgram, or apps.node to startHttpServer."
        ])
      }).pipe(Effect.scoped))

    it.effect("runs an app, which answers only with its secret, and stops it when its entry goes", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        const { supervisor } = yield* supervisorIn(root)
        const entry = yield* installed(root, "fixture", "ok")
        yield* supervisor.sync([entry])
        const run = yield* until(supervisor.run(entry.id), (value) => value?._tag === "Running")
        if (run?._tag !== "Running") return expect.unreachable()
        if (windows) {
          expect(run.endpoint.startsWith("\\\\.\\pipe\\herdr-hub-")).toBe(true)
        } else {
          expect(run.endpoint).toMatch(new RegExp(`^${root}/run/apps/[0-9a-f]{16}\\.sock$`, "u"))
          // The hub's runtime directories are owner-only.
          for (const directory of [`${root}/run`, `${root}/run/apps`]) {
            expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700)
          }
        }

        const pid = yield* pidOf(entry)
        // A keep-alive connection from the hub's proxy stays open across the stop.
        const agent = new Agent({ keepAlive: true })
        yield* Effect.callback<number>((resume) => {
          const outgoing = httpRequest({
            socketPath: run.endpoint,
            path: appPaths.health,
            agent,
            headers: { [hubHeaders.appSecret]: Redacted.value(run.secret) }
          }, (incoming) => {
            incoming.resume()
            incoming.on("end", () => resume(Effect.succeed(incoming.statusCode ?? 0)))
          })
          outgoing.end()
        }).pipe(Effect.tap((status) => Effect.sync(() => expect(status).toBe(200))))

        const stoppedAt = Date.now()
        yield* supervisor.sync([])
        yield* until(Effect.sync(() => alive(pid)), (running) => !running)
        // stdin's end stopped it, well before the 5 s kill.
        expect(Date.now() - stoppedAt).toBeLessThan(2_000)
        expect(yield* supervisor.run(entry.id)).toBeUndefined()
        agent.destroy()
      }).pipe(Effect.scoped))

    it.effect("a spawn's token dies with it: the next spawn has its own", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const { issued, supervisor, tokens } = yield* supervisorIn(root)
        const entry = yield* installed(root, "fixture", "ok")
        const accepted = (token: Redacted.Redacted<string> | undefined) =>
          tokens.verify(entry.id, `Bearer ${token === undefined ? "" : Redacted.value(token)}`).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false)
          )
        yield* supervisor.sync([entry])
        yield* until(supervisor.run(entry.id), (value) => value?._tag === "Running")
        const first = yield* pidOf(entry)
        expect(yield* accepted(issued[0])).toBe(true)
        yield* supervisor.restart(entry.id)
        yield* until(Effect.sync(() => alive(first)), (running) => !running)
        yield* until(supervisor.run(entry.id), (value) => value?._tag === "Running")
        expect([yield* accepted(issued[0]), yield* accepted(issued[1])]).toEqual([false, true])
        // Removed, with no spawn after it: its last token is revoked, not left valid.
        const second = yield* pidOf(entry)
        yield* supervisor.sync([])
        yield* until(Effect.sync(() => alive(second)), (running) => !running)
        expect(yield* accepted(issued[1])).toBe(false)
      }).pipe(Effect.scoped))

    it.effect("an app that throws at start restarts with backoff, ends in crashloop, and restart clears it", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const { supervisor } = yield* supervisorIn(root)
        const entry = yield* installed(root, "fixture", "throws")
        yield* supervisor.sync([entry])
        yield* until(supervisor.run(entry.id), (value) => value?._tag === "Down" && value.reason === "crashloop")
        expect((yield* supervisor.recentLines(entry.id)).join("\n")).toContain("the fixture throws at start")
        // Fixed on disk, then restarted by hand.
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.writeFileString(`${entry.dir}/bin.mjs`, scripts.ok)
        yield* supervisor.restart(entry.id)
        yield* until(supervisor.run(entry.id), (value) => value?._tag === "Running")
      }).pipe(Effect.scoped))

    it.effect("an app that never listens is killed after the listen timeout", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const { supervisor } = yield* supervisorIn(root, { ...fast, listenMillis: 300, stopMillis: 200 })
        const entry = yield* installed(root, "fixture", "hangs")
        yield* supervisor.sync([entry])
        yield* until(supervisor.run(entry.id), (value) => value?._tag === "Down" && value.reason === "timeout")
        expect(alive(yield* pidOf(entry))).toBe(false)
      }).pipe(Effect.scoped))

    it.effect("an app that stops answering, stdin still open, is restarted for health", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const { supervisor } = yield* supervisorIn(root)
        const entry = yield* installed(root, "deaf", "deaf")
        yield* supervisor.sync([entry])
        yield* until(supervisor.run(entry.id), (value) => value?._tag === "Running")
        yield* until(supervisor.run(entry.id), (value) => value?._tag === "Down" && value.reason === "health")
      }).pipe(Effect.scoped))

    it.effect("an entry whose script escapes its prefix or is missing is install_missing; a disabled one is off", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const { supervisor } = yield* supervisorIn(root)
        const escaping = yield* installed(root, "escaping", "ok", { bin: "../../../bin.mjs" })
        const missing = yield* installed(root, "missing", "ok", { bin: "absent.mjs" })
        const off = yield* installed(root, "off", "ok", { enabled: false })
        yield* supervisor.sync([escaping, missing, off])
        const reasons = yield* until(
          Effect.all([escaping, missing, off].map((entry) => supervisor.run(entry.id))),
          (runs) => runs.every((run) => run?._tag === "Down")
        )
        expect(reasons.map((run) => run?._tag === "Down" ? run.reason : null)).toEqual([
          "install_missing",
          "install_missing",
          "disabled"
        ])
      }).pipe(Effect.scoped))

    // Another local user may own or prepare any path the hub would use; each must be the hub's own.
    it.effect.skipIf(windows)(
      "keeps apps down when a runtime directory is open to others, a link, or inside one that is",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const fileSystem = yield* FileSystem.FileSystem
          const elsewhere = `${root}/elsewhere`
          yield* fileSystem.makeDirectory(elsewhere, { mode: 0o700 })
          const setups: ReadonlyArray<
            { readonly name: string; readonly prepare: (base: string) => Effect.Effect<unknown, unknown> }
          > = [
            {
              name: "mode",
              prepare: (base) =>
                fileSystem.makeDirectory(`${base}/apps`, { recursive: true }).pipe(
                  Effect.andThen(fileSystem.chmod(`${base}/apps`, 0o755))
                )
            },
            {
              name: "mode",
              prepare: (base) => fileSystem.makeDirectory(base).pipe(Effect.andThen(fileSystem.chmod(base, 0o777)))
            },
            { name: "link", prepare: (base) => fileSystem.symlink(elsewhere, base) },
            // An open, non-sticky parent: someone else could swap `base` itself.
            {
              name: "mode",
              prepare: (base) =>
                fileSystem.makeDirectory(base, { recursive: true, mode: 0o700 }).pipe(
                  Effect.andThen(fileSystem.chmod(`${base}/..`, 0o777))
                )
            }
          ]
          for (const [index, setup] of setups.entries()) {
            const base = `${root}/p-${index}/run`
            yield* fileSystem.makeDirectory(`${root}/p-${index}`, { mode: 0o700 })
            yield* setup.prepare(base)
            const { supervisor } = yield* supervisorIn(root, fast, {
              runtimeDirectory: base,
              shortRuntimeDirectory: base
            })
            const entry = yield* installed(root, `fixture-${index}`, "ok")
            yield* supervisor.sync([entry])
            yield* until(supervisor.run(entry.id), (value) => value?._tag === "Down" && value.reason === "not_running")
            expect((yield* supervisor.recentLines(entry.id)).join("\n")).toContain(`unusable (${setup.name})`)
          }
          // Nothing was created inside the open parent or through the link.
          expect(yield* fileSystem.exists(`${root}/p-1/run/apps`)).toBe(false)
          expect(yield* fileSystem.exists(`${root}/p-3/run/apps`)).toBe(false)
          expect(yield* fileSystem.exists(`${elsewhere}/apps`)).toBe(false)
        }).pipe(Effect.scoped)
    )

    // The owner of `base`'s parent can rename `base` away whatever the mode bits, so the parent must be ours or
    // root's. Tests can't chown, so the hub runs as a uid that owns neither the temp root nor anything in it. As
    // root the temp directory is owned by 0, which the rule accepts, so the case can't be built there.
    it.effect.skipIf(windows || userInfo().uid === 0)(
      "keeps apps down, creating nothing, when another user owns the runtime directory's parent",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const fileSystem = yield* FileSystem.FileSystem
          const base = `${root}/theirs/run`
          yield* fileSystem.makeDirectory(`${root}/theirs`, { mode: 0o755 })
          const stranger = userInfo().uid + 4242
          const { supervisor } = yield* supervisorIn(root, fast, {
            runtimeDirectory: base,
            shortRuntimeDirectory: base
          }, stranger)
          const entry = yield* installed(root, "fixture-theirs", "ok")
          yield* supervisor.sync([entry])
          yield* until(supervisor.run(entry.id), (value) => value?._tag === "Down" && value.reason === "not_running")
          expect((yield* supervisor.recentLines(entry.id)).join("\n")).toContain("unusable (owner)")
          expect(yield* fileSystem.exists(base)).toBe(false)
        }).pipe(Effect.scoped)
    )

    // A runtime path too long for socket names uses the short directory, checked the same way.
    it.effect.skipIf(windows)(
      "falls back to the short directory when the runtime path is too long",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const { supervisor } = yield* supervisorIn(root, fast, {
            runtimeDirectory: `${root}/${"r".repeat(90)}`,
            shortRuntimeDirectory: `${root}/short`
          })
          const entry = yield* installed(root, "fixture", "ok")
          yield* supervisor.sync([entry])
          const run = yield* until(supervisor.run(entry.id), (value) => value?._tag === "Running")
          expect(run?._tag === "Running" ? run.endpoint.startsWith(`${root}/short/apps/`) : false).toBe(true)
        }).pipe(Effect.scoped)
    )

    // The hub dying (not stopping) closes the child's stdin too: on Windows this is the one pipe assumption.
    it.effect("a child exits when its hub process dies", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        const entry = yield* installed(root, "fixture", "ok")
        const endpoint = windows
          ? `\\\\.\\pipe\\hub-test-orphan-${Math.random().toString(16).slice(2)}`
          : `${root}/orphan.sock`
        const secret = "0123456789abcdef0123456789abcdef"
        const handshake = JSON.stringify({
          v: 1,
          endpoint,
          hubUrl: "http://127.0.0.1:9",
          hubToken: "t",
          appSecret: secret
        })
        // A stand-in hub: starts the app with the handshake, holds its stdin, and is then killed outright.
        yield* fileSystem.writeFileString(
          `${root}/hub.mjs`,
          `import { spawn } from "node:child_process"
const child = spawn(process.execPath, [${
            JSON.stringify(`${entry.dir}/bin.mjs`)
          }, "--attach"], { stdio: ["pipe", "ignore", "ignore"] })
child.stdin.write(${
            JSON.stringify(`${handshake}
`)
          })
setInterval(() => {}, 1000)
`
        )
        const hub = spawn(process.execPath, [`${root}/hub.mjs`], { stdio: "ignore" })
        yield* Effect.addFinalizer(() => Effect.sync(() => hub.kill("SIGKILL")))
        const child = yield* until(pidOf(entry).pipe(Effect.orElseSucceed(() => 0)), (pid) => pid > 0)
        yield* until(
          Effect.callback<number>((resume) => {
            const outgoing = httpRequest(
              { socketPath: endpoint, path: appPaths.health, headers: { [hubHeaders.appSecret]: secret } },
              (incoming) => {
                incoming.resume()
                resume(Effect.succeed(incoming.statusCode ?? 0))
              }
            )
            outgoing.on("error", () => resume(Effect.succeed(0)))
            outgoing.end()
          }),
          (status) => status === 200
        )
        const killedAt = Date.now()
        hub.kill("SIGKILL")
        yield* until(Effect.sync(() => alive(child)), (running) => !running)
        expect(Date.now() - killedAt).toBeLessThan(2_000)
      }).pipe(Effect.scoped))
  })
})
