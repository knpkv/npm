/**
 * The npm the installer runs, and what it learns from `npm view` before anything is downloaded.
 *
 * Mental model:
 * - **Which npm.** `npm-cli.js` beside `process.execPath` (Windows `node_modules/npm`, POSIX
 *   `../lib/node_modules/npm`); else the `npm` first on PATH, accepted only when its real path is a file named
 *   `npm-cli.js` in a `node_modules/npm/bin` directory (nix's `nodejs-slim` keeps npm in another output and links it
 *   so). A `.cmd`, shim or wrapper script that resolves elsewhere is refused, and only the first `npm` on PATH is
 *   looked at. On Windows that branch never succeeds (`npm.cmd` is its own real path), so Windows relies on npm beside
 *   node, which every nodejs.org and mise install has. Either way it runs with
 *   `process.execPath`, shell off, so the spawn is the same on every OS. Neither found: `NpmUnavailable`, naming
 *   both places.
 * - **`npm view` honours `.npmrc`** (scoped registries, auth, proxies), so the trust prompt describes the tarball the
 *   same npm installs next. Its `dist.integrity` is kept: the install must produce exactly that tarball.
 * - **A package is a hub app only with a valid `hubApp` field**; anything else is `NotAHubApp` before a download.
 *
 * @since 0.1.0
 */
import { HubAppPackageField } from "@knpkv/hub-app"
import { Array as Arr, Duration, Effect, FileSystem, Option, Order, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { posix, win32 } from "node:path"
import type { SignatureCheck } from "./trust.js"

/** No usable `npm-cli.js`: `looked` lists every place tried, in order. */
export class NpmUnavailable extends Schema.TaggedError<NpmUnavailable>()("NpmUnavailable", {
  looked: Schema.Array(Schema.String)
}) {
  override get message() {
    return `npm was not found (looked at ${
      this.looked.join(", ")
    }). Install a Node that ships npm (nodejs.org, mise) or put npm on PATH.`
  }
}

/** The package has no valid `hubApp` field, so it is not installed as an app. */
export class NotAHubApp extends Schema.TaggedError<NotAHubApp>()("NotAHubApp", { package: Schema.String }) {}

/** One install step failed; nothing was written to `apps.json`. */
export class AppInstallFailed extends Schema.TaggedError<AppInstallFailed>()("AppInstallFailed", {
  package: Schema.String,
  stage: Schema.Literals(["resolve", "fetch", "signatures", "probe", "commit"]),
  detail: Schema.String
}) {}

/** `npm-cli.js` for the node at `execPath`, by that OS's layout. */
export const npmCliBeside = (execPath: string, windows: boolean): string =>
  windows
    ? win32.join(win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : posix.join(posix.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")

export interface NpmLocation {
  /** The node that runs the CLI (`process.execPath`). */
  readonly execPath: string
  readonly windows: boolean
  /** The PATH to search when npm is not beside node. */
  readonly path: string
}

/** Whether a real path is npm's own entry script, not a shim or wrapper. */
const isNpmCli = (realPath: string, windows: boolean) => {
  const parts = realPath.split(windows ? /[\\/]/u : /\//u)
  return parts.slice(-4).join("/") === "node_modules/npm/bin/npm-cli.js"
}

/** Finds `npm-cli.js` by the rule above; the same rule serves the CLI and the tests. */
export const findNpmCli = Effect.fn("Npm.find")(function*(location: NpmLocation) {
  const fileSystem = yield* FileSystem.FileSystem
  const join = location.windows ? win32.join : posix.join
  const beside = npmCliBeside(location.execPath, location.windows)
  // A path we can't stat is a path without npm.
  const exists = (candidate: string) =>
    fileSystem.exists(candidate).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)))
  if (yield* exists(beside)) return beside
  const names = location.windows ? ["npm.cmd", "npm"] : ["npm"]
  const directories = location.path.split(location.windows ? ";" : ":").filter((directory) => directory !== "")
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (!(yield* exists(candidate))) continue
      const real = yield* fileSystem.realPath(candidate).pipe(
        Effect.map(Option.some),
        Effect.catchTag("PlatformError", () => Effect.succeed(Option.none<string>()))
      )
      if (Option.isSome(real) && isNpmCli(real.value, location.windows)) return real.value
      return yield* new NpmUnavailable({ looked: [beside, `${candidate} (not npm-cli.js)`] })
    }
  }
  return yield* new NpmUnavailable({ looked: [beside, "npm on PATH (none)"] })
})

const Maintainer = Schema.Union([
  Schema.String,
  Schema.Struct({ name: Schema.String, email: Schema.optional(Schema.String) })
])

/** npm lists a maintainer as `"name <email>"` or as `{ name, email }`. */
const isMaintainerName = Schema.is(Schema.String)

/** The part of `npm view <pkg>@<spec> --json` the installer reads; other keys are ignored. */
export const NpmViewVersion = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  time: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  maintainers: Schema.optional(Schema.Array(Maintainer)),
  dist: Schema.Struct({
    integrity: Schema.String,
    tarball: Schema.String,
    attestations: Schema.optional(Schema.Struct({ url: Schema.String }))
  }),
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  hubApp: Schema.optional(Schema.Unknown)
})
export interface NpmViewVersion extends Schema.Schema.Type<typeof NpmViewVersion> {}

/** A range matching several versions comes back as an array, in publish order (not semver order). */
const NpmViewResult = Schema.Union([NpmViewVersion, Schema.Array(NpmViewVersion)])
const decodeView = Schema.decodeUnknownOption(Schema.fromJsonString(NpmViewResult))
const decodeHubApp = Schema.decodeUnknownOption(HubAppPackageField)
const NpmErrorBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.optional(Schema.String), summary: Schema.optional(Schema.String) })
})
const decodeNpmError = Schema.decodeUnknownOption(Schema.fromJsonString(NpmErrorBody))

/** What resolve learned about one exact version, before any download. */
export interface ResolvedApp {
  readonly package: string
  readonly version: string
  readonly integrity: string
  readonly hubApp: HubAppPackageField
  readonly publishedAt: string | null
  readonly maintainers: ReadonlyArray<string>
  readonly provenance: boolean
  /** Lifecycle scripts the package itself declares (dependencies' scripts are listed separately). */
  readonly installScripts: ReadonlyArray<string>
}

const installHooks = ["preinstall", "install", "postinstall", "prepare"]
/** The hooks `npm rebuild` runs for an installed package (`prepare` is not one of them). */
const rebuildHooks = ["preinstall", "install", "postinstall"]

const versionParts = (version: string) => {
  const [core = "", prerelease] = version.split("+", 1)[0]?.split(/-(.*)/su) ?? []
  return {
    core: core.split(".").map(Number),
    prerelease: prerelease === undefined || prerelease === "" ? [] : prerelease.split(".")
  }
}

const isNumeric = (identifier: string) => /^\d+$/u.test(identifier)

/** One prerelease identifier against another: numeric ones by value and below alphanumeric ones, which compare as text. */
const identifierOrder = (left: string, right: string): -1 | 0 | 1 =>
  isNumeric(left) && isNumeric(right)
    ? Order.Number(Number(left), Number(right))
    : isNumeric(left)
    ? -1
    : isNumeric(right)
    ? 1
    : Order.String(left, right)

/**
 * Semver precedence for versions npm has already matched against a range: `major.minor.patch` numerically, then a
 * release above any of its prereleases, then prerelease identifiers field by field (a shorter list first on a tie).
 */
export const versionOrder: Order.Order<string> = (left, right) => {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index++) {
    const by = Order.Number(a.core[index] ?? 0, b.core[index] ?? 0)
    if (by !== 0) return by
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
    const by = identifierOrder(a.prerelease[index] ?? "", b.prerelease[index] ?? "")
    if (by !== 0) return by
  }
  return Order.Number(a.prerelease.length, b.prerelease.length)
}

/** Picks the highest version a view answered with (by semver) and checks its `hubApp` field. */
export const resolvedFrom = (
  pkg: string,
  view: NpmViewVersion | ReadonlyArray<NpmViewVersion>
): Effect.Effect<ResolvedApp, NotAHubApp | AppInstallFailed> => {
  const versions: ReadonlyArray<NpmViewVersion> = Array.isArray(view) ? view : [view]
  const newest = Arr.isReadonlyArrayNonEmpty(versions)
    ? Arr.max(versions, Order.mapInput(versionOrder, (candidate: NpmViewVersion) => candidate.version))
    : undefined
  if (newest === undefined) {
    return Effect.fail(new AppInstallFailed({ package: pkg, stage: "resolve", detail: "no version matched" }))
  }
  return Option.match(decodeHubApp(newest.hubApp), {
    onNone: () => Effect.fail(new NotAHubApp({ package: pkg })),
    onSome: (hubApp) =>
      Effect.succeed({
        package: newest.name,
        version: newest.version,
        integrity: newest.dist.integrity,
        hubApp,
        publishedAt: newest.time?.[newest.version] ?? null,
        maintainers: (newest.maintainers ?? []).map((maintainer) =>
          isMaintainerName(maintainer) ? maintainer : maintainer.name
        ),
        provenance: newest.dist.attestations !== undefined,
        installScripts: installHooks.filter((hook) => newest.scripts?.[hook] !== undefined)
      })
  })
}

export interface NpmOptions {
  /** The node that runs npm (the CLI's own `process.execPath`). */
  readonly node: string
  /** `npm-cli.js`, from `findNpmCli`. */
  readonly npmCli: string
  /**
   * Where `npm view` runs. The CLI passes `<hubData>/hub-apps`, which holds no `.npmrc`: `npm install --prefix`
   * reads project config from the prefix, not from here, so a project `.npmrc` here would make view and install ask
   * different registries. With none, both read only the user's and the global config.
   */
  readonly cwd: string
  /** Extra environment for npm (tests point `npm_config_userconfig` at a throwaway `.npmrc`). */
  readonly env?: Readonly<Record<string, string>>
  /** How long `npm view` may take before it is killed; 60 s by default. */
  readonly viewTimeout?: Duration.Duration
  /** How long `npm install` may take before it is killed; 5 min by default. */
  readonly installTimeout?: Duration.Duration
  /** How long `npm audit signatures` may take before it is killed; 60 s by default. */
  readonly auditTimeout?: Duration.Duration
}

export interface Npm {
  /** `npm view <pkg>@<spec> --json`, then the `hubApp` check. */
  readonly resolve: (
    pkg: string,
    spec: string
  ) => Effect.Effect<ResolvedApp, NotAHubApp | AppInstallFailed>
  /**
   * Installs exactly `app` into `prefix` (one exact dependency, no dev dependencies, never running install scripts),
   * then requires the lockfile's integrity for it to be the one `npm view` reported: a registry that served another
   * tarball meanwhile fails with `fetch`.
   */
  readonly install: (prefix: string, app: ResolvedApp) => Effect.Effect<void, AppInstallFailed>
  /**
   * `npm audit signatures` in `prefix`. A registry without signing keys (mirrors, private registries) is reported, not
   * failed; any other failure blocks the install.
   */
  readonly auditSignatures: (prefix: string, pkg: string) => Effect.Effect<SignatureCheck, AppInstallFailed>
  /**
   * Every package in `app`'s tree that declares install scripts, from a lockfile-only resolve in `prefix` (no tarball
   * runs, no script runs). `npm view` shows only the top package's scripts; with `--allow-scripts` all of these run.
   */
  readonly installScripts: (prefix: string, app: ResolvedApp) => Effect.Effect<ReadonlyArray<string>, AppInstallFailed>
  /**
   * The installed packages in `prefix` that have install scripts, read from each unpacked `package.json` (an install
   * hook, or a `binding.gyp`, which npm builds with node-gyp): what `npm rebuild` would run, whatever the registry's
   * metadata said.
   */
  readonly unpackedScripts: (prefix: string, pkg: string) => Effect.Effect<ReadonlyArray<string>, AppInstallFailed>
  /** Runs the install scripts in `prefix` (`npm rebuild`), under the install timeout. */
  readonly runScripts: (prefix: string, pkg: string) => Effect.Effect<void, AppInstallFailed>
}

const PackageLock = Schema.Struct({
  packages: Schema.Record(
    Schema.String,
    Schema.Struct({ integrity: Schema.optional(Schema.String), hasInstallScript: Schema.optional(Schema.Boolean) })
  )
})
const decodeLock = Schema.decodeUnknownOption(Schema.fromJsonString(PackageLock))
const decodeScriptsManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) }))
)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
/** What npm says when no installed package came from a registry that publishes signing keys. */
const noSignaturesSummary = "found no dependencies to audit that were installed from a supported registry"

export const makeNpm = Effect.fn("Npm.make")(function*(options: NpmOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  /** Runs npm to completion: stdout, stderr's last line (warnings and progress go there) and the exit code. */
  const run = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function*() {
        const child = yield* spawner.spawn(ChildProcess.make(options.node, [options.npmCli, ...args], {
          cwd: options.cwd,
          shell: false,
          extendEnv: true,
          env: { ...options.env, npm_config_update_notifier: "false", npm_config_fund: "false" }
        }))
        // Both pipes are drained together: a full stderr pipe would block npm.
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.mkString(Stream.decodeText(child.stderr)),
            child.exitCode
          ],
          { concurrency: "unbounded" }
        )
        const lastErrorLine = stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "").at(-1) ??
          null
        return { stdout, lastErrorLine, exitCode }
      })
    )

  const resolve: Npm["resolve"] = (pkg, spec) =>
    run(["view", `${pkg}@${spec}`, "--json"]).pipe(
      Effect.mapError((error) => new AppInstallFailed({ package: pkg, stage: "resolve", detail: error.message })),
      // The scope closing on timeout kills the child.
      Effect.timeoutOrElse({
        duration: options.viewTimeout ?? Duration.seconds(60),
        orElse: () =>
          Effect.fail(new AppInstallFailed({ package: pkg, stage: "resolve", detail: "npm view timed out" }))
      }),
      Effect.flatMap(
        ({ exitCode, lastErrorLine, stdout }): Effect.Effect<ResolvedApp, NotAHubApp | AppInstallFailed> => {
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            const detail = Option.match(decodeNpmError(stdout), {
              onNone: () => lastErrorLine ?? `npm view exited ${exitCode}`,
              onSome: ({ error }) => [error.code, error.summary].filter((part) => part !== undefined).join(": ")
            })
            return Effect.fail(new AppInstallFailed({ package: pkg, stage: "resolve", detail }))
          }
          return Option.match(decodeView(stdout), {
            onNone: (): Effect.Effect<ResolvedApp, NotAHubApp | AppInstallFailed> =>
              Effect.fail(
                new AppInstallFailed({ package: pkg, stage: "resolve", detail: "npm view answered unreadably" })
              ),
            onSome: (view) => resolvedFrom(pkg, view)
          })
        }
      )
    )

  /** The prefix's `package.json`: one exact dependency. */
  const writeManifest = (prefix: string, app: ResolvedApp) =>
    fileSystem.makeDirectory(prefix, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(
        `${prefix}/package.json`,
        `${encodeJson({ name: "herdr-hub-app", private: true, dependencies: { [app.package]: app.version } })}\n`
      )),
      Effect.mapError((error) => new AppInstallFailed({ package: app.package, stage: "commit", detail: error.message }))
    )

  const installScripts = Effect.fn("Npm.installScripts")(function*(prefix: string, app: ResolvedApp) {
    const failed = (detail: string) => new AppInstallFailed({ package: app.package, stage: "fetch", detail })
    yield* writeManifest(prefix, app)
    const result = yield* run([
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--prefix",
      prefix,
      "--omit=dev",
      "--no-fund",
      "--no-audit"
    ]).pipe(
      Effect.mapError((error) => failed(error.message)),
      Effect.timeoutOrElse({
        duration: options.viewTimeout ?? Duration.seconds(60),
        orElse: () => Effect.fail(failed("npm install --package-lock-only timed out"))
      })
    )
    if (result.exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* failed(result.lastErrorLine ?? `npm install --package-lock-only exited ${result.exitCode}`)
    }
    return yield* lockedScripts(prefix, app.package)
  })

  const unpackedScripts = Effect.fn("Npm.unpackedScripts")(function*(prefix: string, pkg: string) {
    const failed = (detail: string) => new AppInstallFailed({ package: pkg, stage: "fetch", detail })
    const lock = yield* fileSystem.readFileString(`${prefix}/package-lock.json`).pipe(
      Effect.map(decodeLock),
      Effect.mapError((error) => failed(error.message))
    )
    const keys = Option.match(lock, {
      onNone: () => [],
      onSome: ({ packages }) => Object.keys(packages).filter((key) => key.startsWith("node_modules/"))
    })
    const found: Array<string> = []
    for (const key of keys) {
      const dir = `${prefix}/${key}`
      // In the lockfile but not installed here (an optional dependency for another platform): nothing of it can run.
      if (!(yield* fileSystem.exists(dir).pipe(Effect.mapError((error) => failed(error.message))))) continue
      const manifest = yield* fileSystem.readFileString(`${dir}/package.json`).pipe(
        Effect.flatMap(decodeScriptsManifest),
        Effect.mapError(() => failed(`${key}/package.json is unreadable`))
      )
      const gyp = yield* fileSystem.exists(`${dir}/binding.gyp`).pipe(Effect.mapError((error) => failed(error.message)))
      if (gyp || rebuildHooks.some((hook) => manifest.scripts?.[hook] !== undefined)) {
        found.push(key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length))
      }
    }
    return found.sort()
  })

  const lockedScripts = Effect.fn("Npm.lockedScripts")(function*(prefix: string, pkg: string) {
    const lock = yield* fileSystem.readFileString(`${prefix}/package-lock.json`).pipe(
      Effect.map(decodeLock),
      Effect.mapError((error) => new AppInstallFailed({ package: pkg, stage: "fetch", detail: error.message }))
    )
    return Option.match(lock, {
      onNone: () => [],
      onSome: ({ packages }) =>
        Object.entries(packages)
          .filter(([, entry]) => entry.hasInstallScript === true)
          .map(([key]) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length))
          .sort()
    })
  })

  const runScripts = Effect.fn("Npm.runScripts")(function*(prefix: string, pkg: string) {
    const failed = (detail: string) => new AppInstallFailed({ package: pkg, stage: "fetch", detail })
    const result = yield* run(["rebuild", "--prefix", prefix, "--ignore-scripts=false"]).pipe(
      Effect.mapError((error) => failed(error.message)),
      Effect.timeoutOrElse({
        duration: options.installTimeout ?? Duration.minutes(5),
        orElse: () => Effect.fail(failed("install scripts timed out"))
      })
    )
    if (result.exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* failed(`install scripts failed: ${result.lastErrorLine ?? `npm rebuild exited ${result.exitCode}`}`)
    }
  })

  const install = Effect.fn("Npm.install")(function*(prefix: string, app: ResolvedApp) {
    const failed = (stage: "fetch" | "commit", detail: string) =>
      new AppInstallFailed({ package: app.package, stage, detail })
    yield* writeManifest(prefix, app)
    const result = yield* run([
      "install",
      "--prefix",
      prefix,
      "--omit=dev",
      "--ignore-scripts",
      "--no-fund",
      "--no-audit"
    ]).pipe(
      Effect.mapError((error) => failed("fetch", error.message)),
      Effect.timeoutOrElse({
        duration: options.installTimeout ?? Duration.minutes(5),
        orElse: () => Effect.fail(failed("fetch", "npm install timed out"))
      })
    )
    if (result.exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* failed("fetch", result.lastErrorLine ?? `npm install exited ${result.exitCode}`)
    }
    const lock = yield* fileSystem.readFileString(`${prefix}/package-lock.json`).pipe(
      Effect.map(decodeLock),
      Effect.mapError((error) => failed("fetch", error.message))
    )
    const installed = Option.flatMap(
      lock,
      ({ packages }) => Option.fromNullishOr(packages[`node_modules/${app.package}`]?.integrity)
    )
    if (Option.isNone(installed) || installed.value !== app.integrity) {
      return yield* failed("fetch", "the registry served a different tarball than the one described")
    }
  })

  const auditSignatures: Npm["auditSignatures"] = (prefix, pkg) =>
    run(["audit", "signatures", "--prefix", prefix, "--json"]).pipe(
      Effect.mapError((error) => new AppInstallFailed({ package: pkg, stage: "signatures", detail: error.message })),
      // It fetches the registry's keys and every package's signatures; a stalled registry must not hold the lock.
      Effect.timeoutOrElse({
        duration: options.auditTimeout ?? Duration.seconds(60),
        orElse: () =>
          Effect.fail(
            new AppInstallFailed({ package: pkg, stage: "signatures", detail: "npm audit signatures timed out" })
          )
      }),
      Effect.flatMap(({ exitCode, lastErrorLine, stdout }): Effect.Effect<SignatureCheck, AppInstallFailed> => {
        if (exitCode === ChildProcessSpawner.ExitCode(0)) return Effect.succeed("verified")
        const summary = Option.flatMap(decodeNpmError(stdout), ({ error }) => Option.fromNullishOr(error.summary))
        if (Option.isSome(summary) && summary.value === noSignaturesSummary) {
          return Effect.succeed("registry_has_no_signatures")
        }
        return Effect.fail(
          new AppInstallFailed({
            package: pkg,
            stage: "signatures",
            detail: Option.getOrElse(summary, () => lastErrorLine ?? `npm audit signatures exited ${exitCode}`)
          })
        )
      })
    )

  return { resolve, install, auditSignatures, installScripts, unpackedScripts, runScripts } satisfies Npm
})
