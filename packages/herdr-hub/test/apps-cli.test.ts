import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AppId, type AppManifest, type AppState, type InstalledApp } from "@knpkv/hub-app"
import { Console, Duration, Effect, type Exit, FileSystem, Option } from "effect"
import { Command } from "effect/cli"
import { tmpdir } from "node:os"
import {
  AppsCli,
  type AppsCliEnvironment,
  appsCommand,
  type HubClient,
  HubNotRunning,
  splitSpec
} from "../src/apps/cli.js"
import type { AppInstaller, InstallerOptions } from "../src/apps/installer.js"
import { emptyAppsConfig, makeAppsStore } from "../src/apps/store.js"

const usage: InstalledApp = {
  id: AppId.make("usage"),
  package: "@knpkv/herdr-usage",
  version: "1.0.0",
  dir: "/data/hub-apps/usage/1.0.0",
  bin: "node_modules/@knpkv/herdr-usage/dist/bin.js",
  enabled: true,
  memoryMb: 256,
  allowScripts: false
}

const manifest = (version: string): AppManifest => ({
  contract: 1,
  id: AppId.make("usage"),
  package: "@knpkv/herdr-usage",
  version,
  module: {
    id: "usage",
    label: "Usage",
    defaultPage: "overview",
    pages: [{ id: "overview", label: "Overview" }],
    listeners: ["serve", "local"],
    requires: ["read"]
  },
  client: { entry: "client.js", css: [] },
  services: [],
  nav: { order: 1, primary: false, mobile: false },
  standalone: { defaultPort: 3199 }
})

const hubDown: HubClient = {
  states: Effect.succeed(Option.none()),
  restart: () => Effect.die("restart is not expected")
}

/** An installer that asks `confirm` once for add and update, as the real one does, then reports `updated`. */
const stubInstaller = (updated: { from: string; to: string } | null) => (confirm: InstallerOptions["confirm"]) =>
  Effect.succeed<AppInstaller>({
    add: () => confirm(["Trust line"]).pipe(Effect.as(usage)),
    update: () => confirm(["Trust line"]).pipe(Effect.as(updated)),
    rollback: () => Effect.succeed({ from: "1.1.0", to: "1.0.0" }),
    remove: () => Effect.void
  })

/** Runs `herdr-hub apps <args>` against `environment`, with what it printed. */
const run = (args: ReadonlyArray<string>, environment: Partial<AppsCliEnvironment> & { readonly root: string }) =>
  Effect.gen(function*() {
    const store = yield* makeAppsStore({
      configPath: `${environment.root}/config/apps.json`,
      lockPath: `${environment.root}/data/hub-apps/.lock`,
      self: { pid: 1, host: "test" },
      processAlive: () => Effect.succeed(true)
    })
    const lines: Array<string> = []
    const original = yield* Console.Console
    const cli = Command.runWith(Command.make("herdr-hub").pipe(Command.withSubcommands([appsCommand])), {
      version: "0.0.0-test"
    })
    const exit = yield* cli(["apps", ...args]).pipe(
      Effect.provideService(AppsCli, {
        store,
        installer: stubInstaller(null),
        hub: hubDown,
        logsDirectory: `${environment.root}/logs`,
        interactive: false,
        ...environment
      }),
      Effect.provideService(Console.Console, {
        ...original,
        log: (...parts: ReadonlyArray<unknown>) => {
          lines.push(parts.join(" "))
        }
      }),
      Effect.exit
    )
    return { exit, output: lines.join("\n"), store }
  })

const tempRoot = Effect.flatMap(
  FileSystem.FileSystem,
  (fileSystem) => fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "apps-cli-" })
)

const failure = <A, E>(exit: Exit.Exit<A, E>) => exit._tag === "Failure" ? JSON.stringify(exit.cause) : "success"

describe("apps CLI", () => {
  it("splits a package from its spec, keeping a scope's leading @", () => {
    expect(["@knpkv/herdr-usage@^1", "@knpkv/herdr-usage", "left-pad@1.3.0", "left-pad"].map(splitSpec)).toEqual([
      { name: "@knpkv/herdr-usage", spec: "^1" },
      { name: "@knpkv/herdr-usage", spec: null },
      { name: "left-pad", spec: "1.3.0" },
      { name: "left-pad", spec: null }
    ])
  })

  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    // A script can't widen trust: only a person at a terminal can.
    it.effect("refuses trust add without a terminal and records it with one", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const refused = yield* run(["trust", "add", "@elsewhere"], { root })
        expect(failure(refused.exit)).toContain("AppsNeedTerminal")
        expect((yield* refused.store.read).trust.scopes).toEqual(emptyAppsConfig.trust.scopes)
        const added = yield* run(["trust", "add", "@elsewhere"], { root, interactive: true })
        expect(added.exit._tag).toBe("Success")
        expect((yield* added.store.read).trust.scopes).toEqual(["@knpkv", "@elsewhere"])
      }).pipe(Effect.scoped))

    it.effect("shows the trust lines, then refuses to answer for you without a terminal or --yes", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const unattended = yield* run(["add", "@knpkv/herdr-usage"], { root })
        expect(unattended.output).toContain("Trust line")
        expect(failure(unattended.exit)).toContain("AppsNeedTerminal")
        const yes = yield* run(["add", "@knpkv/herdr-usage", "--yes"], { root })
        expect(yes.exit._tag).toBe("Success")
        expect(yes.output).toContain("Installed usage (@knpkv/herdr-usage@1.0.0).")
      }).pipe(Effect.scoped))

    it.effect("prints an app's log, the rotated file first, with the hub down", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.makeDirectory(`${root}/logs`)
        yield* fileSystem.writeFileString(`${root}/logs/usage.log.1`, "older\n")
        yield* fileSystem.writeFileString(`${root}/logs/usage.log`, "newer\n")
        const printed = yield* run(["logs", "usage"], { root })
        expect(printed.output).toBe("older\nnewer")
        const none = yield* run(["logs", "other"], { root })
        expect(none.output).toBe("No log for other yet.")
      }).pipe(Effect.scoped))

    it.effect("says the hub isn't running when restart can't reach it", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const down = yield* run(["restart", "usage"], {
          root,
          hub: { ...hubDown, restart: () => Effect.fail(new HubNotRunning()) }
        })
        expect(failure(down.exit)).toContain("HubNotRunning")
        const restarted = yield* run(["restart", "usage"], {
          root,
          hub: { ...hubDown, restart: () => Effect.succeed(true) }
        })
        expect(restarted.output).toBe("Restarting usage.")
      }).pipe(Effect.scoped))

    // With --wait the CLI watches the swap: a crashloop of the new version fails with the rollback hint.
    it.effect("reports an update whose new version crashloops, and finishes when it comes up", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.makeDirectory(`${root}/config`, { recursive: true })
        yield* fileSystem.writeFileString(
          `${root}/config/apps.json`,
          JSON.stringify({ ...emptyAppsConfig, apps: [usage] })
        )
        const hubSaying = (state: AppState): HubClient => ({ ...hubDown, states: Effect.succeed(Option.some([state])) })
        const crashing = yield* run(["update", "usage", "--yes"], {
          root,
          installer: stubInstaller({ from: "1.0.0", to: "1.1.0" }),
          hub: hubSaying({
            _tag: "Unavailable",
            id: AppId.make("usage"),
            manifest: null,
            reason: "crashloop",
            detail: ""
          }),
          settleTimeout: Duration.seconds(5)
        })
        expect(failure(crashing.exit)).toContain("AppUpdateCrashloop")
        const healthy = yield* run(["update", "usage", "--yes"], {
          root,
          installer: stubInstaller({ from: "1.0.0", to: "1.1.0" }),
          hub: hubSaying({ _tag: "Ready", manifest: manifest("1.1.0") }),
          settleTimeout: Duration.seconds(5)
        })
        expect(healthy.exit._tag).toBe("Success")
        expect(healthy.output).toContain("Updated usage from 1.0.0 to 1.1.0.")
      }).pipe(Effect.scoped))

    it.effect("disables and enables an installed app, refusing an unknown one", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.makeDirectory(`${root}/config`, { recursive: true })
        yield* fileSystem.writeFileString(
          `${root}/config/apps.json`,
          JSON.stringify({ ...emptyAppsConfig, apps: [usage] })
        )
        const off = yield* run(["disable", "usage"], { root })
        expect((yield* off.store.read).apps.map((app) => app.enabled)).toEqual([false])
        const on = yield* run(["enable", "usage"], { root })
        expect((yield* on.store.read).apps.map((app) => app.enabled)).toEqual([true])
        const unknown = yield* run(["enable", "absent"], { root })
        expect(failure(unknown.exit)).toContain("AppNotInstalled")
      }).pipe(Effect.scoped))
  })
})
