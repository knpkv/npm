import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Path } from "effect"
import { win32 } from "node:path"
import { HubPaths, hubPathTable } from "../src/paths.js"
import { sameRealPath } from "../src/sqlite.js"

const linux = { windows: false, home: "/home/owner", hostname: "atlas" }
const windows = { windows: true, home: "C:\\Users\\owner", hostname: "DESKTOP-1" }

describe("hub path table", () => {
  // No running host moves: these are the paths POSIX hosts used before the table existed.
  it("keeps the POSIX paths hosts already use", () => {
    expect(hubPathTable({ ...linux, env: {} })).toEqual({
      home: "/home/owner",
      hostname: "atlas",
      fleetConfig: "/home/owner/.config/fleet/config.json",
      fleetState: "/home/owner/.local/state/fleet",
      appsConfig: "/home/owner/.config/herdr/apps.json",
      hubData: "/home/owner/.local/share/herdr-hub",
      hubState: "/home/owner/.local/state/herdr-hub",
      hubRuntime: "/home/owner/.local/state/herdr-hub/run"
    })
    // XDG_STATE_HOME already moved the fleet state; XDG_CONFIG_HOME never moved anything on POSIX.
    expect(hubPathTable({ ...linux, env: { XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "/config" } })).toMatchObject({
      fleetConfig: "/home/owner/.config/fleet/config.json",
      fleetState: "/state/fleet",
      appsConfig: "/home/owner/.config/herdr/apps.json"
    })
  })

  it("puts Windows configuration under APPDATA and state under LOCALAPPDATA", () => {
    const env = { APPDATA: "C:\\Users\\owner\\AppData\\Roaming", LOCALAPPDATA: "D:\\Local" }
    expect(hubPathTable({ ...windows, env })).toEqual({
      home: "C:\\Users\\owner",
      hostname: "DESKTOP-1",
      fleetConfig: "C:\\Users\\owner\\AppData\\Roaming\\fleet\\config.json",
      fleetState: "D:\\Local\\fleet",
      appsConfig: "C:\\Users\\owner\\AppData\\Roaming\\herdr-hub\\apps.json",
      hubData: "D:\\Local\\herdr-hub",
      hubState: "D:\\Local\\herdr-hub",
      // Apps listen on named pipes there: no runtime directory.
      hubRuntime: null
    })
  })

  // A profile without the variables still has its folders where Windows always puts them.
  it("finds the Windows profile folders when APPDATA and LOCALAPPDATA are unset or empty", () => {
    for (const env of [{}, { APPDATA: "", LOCALAPPDATA: "" }]) {
      expect(hubPathTable({ ...windows, env })).toMatchObject({
        fleetConfig: "C:\\Users\\owner\\AppData\\Roaming\\fleet\\config.json",
        fleetState: "C:\\Users\\owner\\AppData\\Local\\fleet",
        appsConfig: "C:\\Users\\owner\\AppData\\Roaming\\herdr-hub\\apps.json"
      })
    }
  })

  it("lets XDG directories win on Windows when they are set", () => {
    expect(hubPathTable({ ...windows, env: { XDG_CONFIG_HOME: "E:\\config", XDG_STATE_HOME: "E:\\state" } }))
      .toMatchObject({
        fleetConfig: "E:\\config\\fleet\\config.json",
        fleetState: "E:\\state\\fleet",
        appsConfig: "E:\\config\\herdr\\apps.json"
      })
  })

  // The hub's own apps: prefixes under data, logs under state, sockets under the runtime directory.
  it("puts the hub's app files under the XDG data, state and runtime directories", () => {
    expect(
      hubPathTable({
        ...linux,
        env: { XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/user/1000" }
      })
    ).toMatchObject({
      hubData: "/data/herdr-hub",
      hubState: "/state/herdr-hub",
      hubRuntime: "/run/user/1000/herdr-hub"
    })
    expect(hubPathTable({ ...windows, env: { XDG_DATA_HOME: "E:\\data", XDG_RUNTIME_DIR: "E:\\run" } }))
      .toMatchObject({ hubData: "E:\\data\\herdr-hub", hubRuntime: null })
  })

  it("puts everything under HERDR_HUB_HOME, on any OS", () => {
    expect(hubPathTable({ ...linux, env: { HERDR_HUB_HOME: "/srv/hub", XDG_STATE_HOME: "/state" } })).toMatchObject({
      fleetConfig: "/srv/hub/config/fleet/config.json",
      fleetState: "/srv/hub/state/fleet",
      appsConfig: "/srv/hub/config/apps.json",
      hubData: "/srv/hub/data",
      hubState: "/srv/hub/state/herdr-hub",
      hubRuntime: "/srv/hub/run"
    })
    expect(hubPathTable({ ...windows, env: { HERDR_HUB_HOME: "E:\\hub" } })).toMatchObject({
      fleetConfig: "E:\\hub\\config\\fleet\\config.json",
      fleetState: "E:\\hub\\state\\fleet",
      appsConfig: "E:\\hub\\config\\apps.json",
      hubData: "E:\\hub\\data",
      hubRuntime: null
    })
  })

  // Nix keeps apps.json where it writes it, whatever the OS default becomes.
  it("reads apps.json from HERDR_HUB_CONFIG over every default", () => {
    expect(hubPathTable({ ...linux, env: { HERDR_HUB_CONFIG: "/etc/herdr", HERDR_HUB_HOME: "/srv/hub" } }).appsConfig)
      .toBe("/etc/herdr/apps.json")
    expect(hubPathTable({ ...windows, env: { HERDR_HUB_CONFIG: "E:\\herdr" } }).appsConfig).toBe("E:\\herdr\\apps.json")
  })
})

// The live table reads the environment through Config, so a test's provider decides it.
describe("live hub paths", () => {
  const environment = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ XDG_STATE_HOME: "/state", HERDR_HUB_CONFIG: "/etc/herdr" })
  )
  it.layer(Layer.mergeAll(Path.layer, environment))((it) => {
    it.effect("builds the table from the environment and the path separator", () =>
      Effect.gen(function*() {
        const table = yield* HubPaths.fromSystem
        expect(table.fleetState).toBe("/state/fleet")
        expect(table.appsConfig).toBe("/etc/herdr/apps.json")
      }))
  })
})

describe("real path identity on Windows", () => {
  const paths = { resolve: win32.resolve, sep: win32.sep }

  // `realpath` and a joined path can spell the same file differently; refusing it would refuse the job store.
  it("treats drive-letter case and separators as the same path", () => {
    expect(sameRealPath(paths, "C:\\Users\\owner\\fleet\\jobs.sqlite", "c:/users/OWNER/fleet/jobs.sqlite")).toBe(true)
    expect(sameRealPath(paths, "C:\\Users\\owner\\fleet\\", "C:\\Users\\owner\\fleet")).toBe(true)
  })

  it("still tells different files apart", () => {
    expect(sameRealPath(paths, "C:\\Users\\owner\\fleet\\jobs.sqlite", "C:\\Users\\other\\fleet\\jobs.sqlite"))
      .toBe(false)
    expect(sameRealPath(paths, "C:\\fleet\\jobs.sqlite", "D:\\fleet\\jobs.sqlite")).toBe(false)
  })

  // POSIX file systems are case-sensitive by default: no folding there.
  it("compares POSIX paths exactly", () => {
    const posix = { resolve: (value: string) => value, sep: "/" }
    expect(sameRealPath(posix, "/home/owner/jobs.sqlite", "/home/owner/jobs.sqlite")).toBe(true)
    expect(sameRealPath(posix, "/home/owner/jobs.sqlite", "/home/Owner/jobs.sqlite")).toBe(false)
  })
})
