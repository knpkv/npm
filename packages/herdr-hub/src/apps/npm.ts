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
import { Effect, FileSystem, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { posix, win32 } from "node:path"

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

/** A range matching several versions comes back as an array, oldest first. */
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

/** Picks the newest version a view answered with and checks its `hubApp` field. */
export const resolvedFrom = (
  pkg: string,
  view: NpmViewVersion | ReadonlyArray<NpmViewVersion>
): Effect.Effect<ResolvedApp, NotAHubApp | AppInstallFailed> => {
  const versions: ReadonlyArray<NpmViewVersion> = Array.isArray(view) ? view : [view]
  const newest = versions.at(-1)
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
  /** Where npm runs; its `.npmrc` (and the user's) apply. */
  readonly cwd: string
  /** Extra environment for npm (tests point `npm_config_userconfig` at a throwaway `.npmrc`). */
  readonly env?: Readonly<Record<string, string>>
}

export interface Npm {
  /** `npm view <pkg>@<spec> --json`, then the `hubApp` check. */
  readonly resolve: (
    pkg: string,
    spec: string
  ) => Effect.Effect<ResolvedApp, NotAHubApp | AppInstallFailed>
}

export const makeNpm = Effect.fn("Npm.make")(function*(options: NpmOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  /** Runs npm to completion; stdout and the exit code. */
  const run = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function*() {
        const child = yield* spawner.spawn(ChildProcess.make(options.node, [options.npmCli, ...args], {
          cwd: options.cwd,
          shell: false,
          extendEnv: true,
          env: { ...options.env, npm_config_update_notifier: "false", npm_config_fund: "false" }
        }))
        const [stdout, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
          { concurrency: "unbounded" }
        )
        return { stdout, exitCode }
      })
    )

  const resolve: Npm["resolve"] = (pkg, spec) =>
    run(["view", `${pkg}@${spec}`, "--json"]).pipe(
      Effect.mapError((error) => new AppInstallFailed({ package: pkg, stage: "resolve", detail: error.message })),
      Effect.flatMap(({ exitCode, stdout }): Effect.Effect<ResolvedApp, NotAHubApp | AppInstallFailed> => {
        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
          const detail = Option.match(decodeNpmError(stdout), {
            onNone: () => `npm view exited ${exitCode}`,
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
      })
    )

  return { resolve } satisfies Npm
})
