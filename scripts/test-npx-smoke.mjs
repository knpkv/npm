#!/usr/bin/env node
/**
 * Runs each app the way `npx <package>` does, from packed tarballs: installs them into an empty project
 * outside the repository, then starts each executable through `npx --no-install` with nothing of the caller's
 * environment but PATH, waits for the line only a loaded program prints and, for servers, for an HTTP 200.
 * Workspace symlinks hide what this catches: a file missing from a tarball, or a dependency range that npm
 * resolves to a version without the import the app needs.
 *
 *   pnpm build && pnpm -r --filter "./packages/*" pack --pack-destination /tmp/packs
 *   node scripts/test-npx-smoke.mjs --tarballs /tmp/packs                 # every @knpkv dependency from the packs
 *   node scripts/test-npx-smoke.mjs --tarballs /tmp/packs --install-through sfw   # CI: through Socket Firewall
 *   node scripts/test-npx-smoke.mjs --tarballs /tmp/packs --registry-for-published
 *
 * `--registry-for-published` takes every version npm already has from the registry and only the rest from the
 * packs, which is what users get right after a release publishes the rest. Repeat `--case <name>` to scope.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { createServer } from "node:net"

class SmokeFailed extends Data.TaggedError("SmokeFailed") {}

/**
 * Each case: the package that owns the executable, its bin name, the arguments, a line only the loaded program
 * prints, and when it serves, the port it was told to use. `prepare` runs first in the same HOME and returns
 * environment to add (herdr-monitor's keys). `port` pins a server that has no port setting (hostd's loopback
 * hub); cases run one at a time, so a fixed port is free. `bodyIncludes` is text the served page must contain.
 */
export const npxSmokeCases = [
  {
    owner: "@knpkv/control-center",
    bin: "control-center",
    args: ["serve"],
    ready: /^Control Center listening at http:\/\/127\.0\.0\.1:\d+/,
    serves: true,
    env: ({ home, port }) => ({ CONTROL_CENTER_PORT: String(port), CONTROL_CENTER_DATA_ROOT: `${home}/data` })
  },
  {
    owner: "@knpkv/alchemy-console",
    bin: "alchemy-console",
    args: ({ port }) => ["serve", "--port", String(port)],
    ready: /^http:\/\/127\.0\.0\.1:\d+\/#bootstrap_token=/,
    serves: true
  },
  {
    owner: "@knpkv/agent-usage",
    bin: "agent-usage",
    args: ["serve"],
    ready: /^agent usage: http:\/\/127\.0\.0\.1:\d+\//,
    serves: true,
    env: ({ port }) => ({ PORT: String(port) })
  },
  {
    owner: "@knpkv/jcf-web",
    bin: "jcf-web",
    args: ["serve"],
    ready: /^jcf week view: http:\/\/127\.0\.0\.1:\d+\//,
    serves: true,
    env: ({ port }) => ({ PORT: String(port) })
  },
  {
    owner: "@knpkv/codecommit",
    bin: "codecommit",
    args: ({ port }) => ["web", "--no-open", "--port", String(port)],
    ready: /^http:\/\/127\.0\.0\.1:\d+\/#bootstrap_token=/,
    serves: true
  },
  {
    owner: "@knpkv/herdr-monitor",
    bin: "herdr-monitor",
    args: ["serve"],
    ready: /^Monitor ready at http:\/\/127\.0\.0\.1:\d+\./,
    serves: true,
    prepare: { args: ["init"], envFile: ".config/herdr-monitor/monitor.env" },
    // The server answers 403 to a Host other than MONITOR_ORIGIN's, so a non-default port moves both.
    env: ({ port }) => ({ MONITOR_PORT: String(port), MONITOR_ORIGIN: `http://127.0.0.1:${port}` })
  },
  // Without a fleet configuration hostd runs standalone: the super-app on its fixed loopback port. Reaching the
  // ready line also proves every module it imports loaded, which published 0.45.0 never did.
  {
    owner: "@knpkv/herdr-hub",
    bin: "hostd",
    args: [],
    ready: /running standalone on http:\/\/127\.0\.0\.1:4778\//,
    serves: true,
    port: 4778,
    bodyIncludes: "fleet-dashboard-data"
  }
]

/**
 * `--tarballs <dir>` (exactly one), `--registry-for-published`, `--install-through <wrapper>` (at most one) and
 * repeated `--case <bin>`; anything else is null.
 */
export const parseSmokeArguments = (args) => {
  const parsed = { tarballs: undefined, registryForPublished: false, installThrough: undefined, cases: [] }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (flag === "--registry-for-published") parsed.registryForPublished = true
    else if (
      (flag === "--tarballs" || flag === "--case" || flag === "--install-through") &&
      value !== undefined &&
      !value.startsWith("--")
    ) {
      if (flag === "--tarballs") {
        if (parsed.tarballs !== undefined) return null
        parsed.tarballs = value
      } else if (flag === "--install-through") {
        if (parsed.installThrough !== undefined) return null
        parsed.installThrough = value
      } else parsed.cases.push(value)
      index += 1
    } else return null
  }
  return parsed.tarballs === undefined ? null : parsed
}

/**
 * The throwaway project's `package.json`. Every app under test is a dependency; every `@knpkv` package whose
 * version npm lacks (or every one, without `registryForPublished`) is pinned to its tarball through `overrides`,
 * so transitive `@knpkv` dependencies resolve to the packs too.
 */
export const smokeManifest = ({ packs, owners, published }) => {
  const local = packs.filter((pack) => !published.has(`${pack.name}@${pack.version}`))
  const tarball = (pack) => `file:${pack.file}`
  const byName = new Map(packs.map((pack) => [pack.name, pack]))
  const dependencies = Object.fromEntries(
    owners.map((owner) => {
      const pack = byName.get(owner)
      if (pack === undefined) throw new SmokeFailed({ reason: `no packed tarball for ${owner}` })
      return [owner, published.has(`${pack.name}@${pack.version}`) ? pack.version : tarball(pack)]
    })
  )
  return {
    name: "npx-smoke",
    version: "0.0.0",
    private: true,
    dependencies,
    overrides: Object.fromEntries(local.map((pack) => [pack.name, tarball(pack)]))
  }
}

/** `KEY=value` lines of an env file, ignoring blanks and comments. */
export const parseEnvFile = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  )

/** `@knpkv-herdr-hub-0.46.0.tgz` (pnpm's pack name) as `{ name, version }`. */
export const packIdentity = (fileName) => {
  const match = /^knpkv-(.+)-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.tgz$/u.exec(fileName)
  return match === null ? undefined : { name: `@knpkv/${match[1]}`, version: match[2] }
}

const npmInstall = ["install", "--no-audit", "--no-fund", "--loglevel=error"]

/**
 * The project install as `[command, args]`. CI names Socket Firewall (`sfw`), which every other dependency
 * install in this repository goes through; without a wrapper it is plain npm, for a local run.
 */
export const installCommand = (installThrough) =>
  installThrough === undefined ? ["npm", npmInstall] : [installThrough, ["npm", ...npmInstall]]

/**
 * What `npm view <name>@<version> version` said. Only npm's own answer for a missing version counts as
 * unpublished (E404 from npm 11; empty output from older npm). Anything else, a timeout, a 5xx or a rate limit,
 * is unknown and fails the run: read as unpublished it would quietly test the tarball instead of what npm serves.
 */
export const classifyNpmView = ({ name, version, exitCode, stdout, stderr }) => {
  const answer = stdout.trim()
  if (exitCode === 0 && answer === version) return { _tag: "Published" }
  if (exitCode === 0 && answer === "") return { _tag: "Unpublished" }
  if (exitCode !== 0 && /\bE404\b/u.test(stderr)) return { _tag: "Unpublished" }
  const said = (stderr.trim() || answer).split("\n")[0]
  return { _tag: "Unknown", reason: `npm view ${name}@${version} gave no clear answer (exit ${exitCode}): ${said}` }
}

const freePort = Effect.callback((resume) => {
  const probe = createServer()
  probe.once("error", (error) => resume(Effect.fail(new SmokeFailed({ reason: `no free port: ${error.message}` }))))
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address()
    probe.close(() =>
      resume(
        address === null || Predicate.isString(address)
          ? Effect.fail(new SmokeFailed({ reason: "the port probe had no address" }))
          : Effect.succeed(address.port)
      )
    )
  })
})

const lines = (bytes) => Stream.splitLines(Stream.decodeText(bytes))

const collect = (handle) =>
  Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode
    ],
    {
      concurrency: "unbounded"
    }
  )

/**
 * Reads `stream` until a line matches `ready`, it ends, or `timeout` passes, and returns every line read either
 * way: `Ready`, `Exited` or `TimedOut`. Each line is recorded as it arrives, so a timeout keeps what came before it.
 */
export const waitForReady = Effect.fn("NpxSmoke.waitForReady")(function* (stream, ready, timeout) {
  const read = yield* Ref.make([])
  const finished = yield* stream.pipe(
    Stream.takeUntil((line) => ready.test(line)),
    Stream.tap((line) => Ref.update(read, (lines) => [...lines, line])),
    Stream.runDrain,
    Effect.timeoutOption(timeout)
  )
  const lines = yield* Ref.get(read)
  if (lines.some((line) => ready.test(line))) return { _tag: "Ready", lines }
  return Option.isNone(finished) ? { _tag: "TimedOut", lines } : { _tag: "Exited", lines }
})

/** Runs one command to completion in `cwd` with only PATH and `env`; fails with its output when it exits non-zero. */
const runToEnd = Effect.fn("NpxSmoke.runToEnd")(function* (command, args, cwd, env) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const searchPath = yield* Config.String("PATH")
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd, env: { PATH: searchPath, ...env }, extendEnv: false })
  )
  const [stdout, stderr, exitCode] = yield* collect(handle)
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new SmokeFailed({ reason: `${command} ${args.join(" ")} exited ${exitCode}:\n${stderr || stdout}` })
  }
  return stdout
})

/** Which `name@version` of the packs npm already serves; fails when npm gives no clear answer for one. */
const publishedVersions = Effect.fn("NpxSmoke.publishedVersions")(function* (packs, cwd) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const searchPath = yield* Config.String("PATH")
  const found = new Set()
  for (const pack of packs) {
    const handle = yield* spawner.spawn(
      ChildProcess.make("npm", ["view", `${pack.name}@${pack.version}`, "version"], {
        cwd,
        env: { PATH: searchPath, HOME: cwd },
        extendEnv: false
      })
    )
    const [stdout, stderr, exitCode] = yield* collect(handle)
    const answer = classifyNpmView({ ...pack, exitCode, stdout, stderr })
    if (answer._tag === "Unknown") return yield* new SmokeFailed({ reason: answer.reason })
    if (answer._tag === "Published") found.add(`${pack.name}@${pack.version}`)
  }
  return found
})

/** `undefined` once the case is ready (and answers HTTP 200 when it serves), or why it is not. */
const runCase = Effect.fn("NpxSmoke.runCase")(function* (smokeCase, project) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const searchPath = yield* Config.String("PATH")
  const home = yield* fs.makeTempDirectoryScoped({ prefix: `npx-smoke-${smokeCase.bin}-` })
  const port = smokeCase.port ?? (yield* freePort)
  const base = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share")
  }
  const prepared =
    smokeCase.prepare === undefined
      ? {}
      : yield* runToEnd("npx", ["--no-install", smokeCase.bin, ...smokeCase.prepare.args], project, base).pipe(
          Effect.andThen(fs.readFileString(path.join(home, smokeCase.prepare.envFile))),
          Effect.map(parseEnvFile)
        )
  const args = Predicate.isFunction(smokeCase.args) ? smokeCase.args({ port }) : smokeCase.args
  const child = yield* Effect.acquireRelease(
    spawner.spawn(
      ChildProcess.make("npx", ["--no-install", smokeCase.bin, ...args], {
        cwd: project,
        env: { PATH: searchPath, ...base, ...prepared, ...smokeCase.env?.({ home, port }) },
        extendEnv: false,
        stdout: "pipe",
        stderr: "pipe"
      })
    ),
    (handle) => handle.kill().pipe(Effect.ignore)
  )
  const waited = yield* waitForReady(
    Stream.merge(lines(child.stdout), lines(child.stderr)),
    smokeCase.ready,
    "90 seconds"
  )
  if (waited._tag !== "Ready") {
    const reason =
      waited._tag === "TimedOut" ? "printed no ready line within 90 seconds" : "exited before its ready line"
    const shown = waited.lines.filter((line) => !line.startsWith("npm notice")).slice(-8)
    return `${reason} (port ${port}):\n${shown.join("\n")}`
  }
  if (!smokeCase.serves) return undefined
  const client = yield* HttpClient.HttpClient
  const answer = yield* client.get(`http://127.0.0.1:${port}/`).pipe(
    Effect.flatMap((response) => Effect.map(response.text, (body) => ({ status: response.status, body }))),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(500)), times: 20 }),
    Effect.orElseSucceed(() => ({ status: 0, body: "" }))
  )
  if (answer.status !== 200) return `answered HTTP ${answer.status} on port ${port} instead of 200`
  return smokeCase.bodyIncludes === undefined || answer.body.includes(smokeCase.bodyIncludes)
    ? undefined
    : `answered 200 on port ${port}, but the page lacks ${JSON.stringify(smokeCase.bodyIncludes)}`
})

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const options = parseSmokeArguments(yield* stdio.args)
  if (options === null) {
    return yield* new SmokeFailed({
      reason:
        "usage: node scripts/test-npx-smoke.mjs --tarballs <dir> [--registry-for-published] [--install-through <wrapper>] [--case <bin>]..."
    })
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const tarballs = path.resolve(options.tarballs)
  const packs = (yield* fs.readDirectory(tarballs)).flatMap((file) => {
    const identity = packIdentity(file)
    return identity === undefined ? [] : [{ ...identity, file: path.join(tarballs, file) }]
  })
  const cases =
    options.cases.length === 0
      ? npxSmokeCases
      : npxSmokeCases.filter((smokeCase) => options.cases.includes(smokeCase.bin))
  if (cases.length === 0) return yield* new SmokeFailed({ reason: `no case named ${options.cases.join(", ")}` })
  const project = yield* fs.makeTempDirectoryScoped({ prefix: "npx-smoke-project-" })
  const published = options.registryForPublished ? yield* publishedVersions(packs, project) : new Set()
  const manifest = smokeManifest({ packs, owners: [...new Set(cases.map((c) => c.owner))], published })
  yield* fs.writeFileString(path.join(project, "package.json"), JSON.stringify(manifest, null, 2))
  yield* Console.log(
    `installing ${Object.keys(manifest.dependencies).length} apps; ${Object.keys(manifest.overrides).length} @knpkv packages from tarballs`
  )
  const [installer, installArgs] = installCommand(options.installThrough)
  yield* runToEnd(installer, installArgs, project, { HOME: project })
  const failures = []
  for (const smokeCase of cases) {
    const reason = yield* runCase(smokeCase, project).pipe(
      Effect.scoped,
      Effect.catch((error) => Effect.succeed(error.reason ?? error.message ?? String(error)))
    )
    if (reason === undefined) yield* Console.log(`${smokeCase.bin}: runs from its tarball`)
    else failures.push(`${smokeCase.bin} (${smokeCase.owner}) ${reason}`)
  }
  if (failures.length > 0) return yield* new SmokeFailed({ reason: failures.join("\n\n") })
}).pipe(Effect.scoped)

// Failures print their reason alone; a defect (a bug in this script) prints in full, never silently.
const main = program.pipe(
  Effect.tapError((error) => (error._tag === "SmokeFailed" ? Console.error(error.reason) : Console.error(error))),
  Effect.tapDefect((defect) => Console.error(defect)),
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
