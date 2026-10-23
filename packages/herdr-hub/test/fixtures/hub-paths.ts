import { HubPaths, hubPathTable } from "@knpkv/herdr-fleet"
import { Layer } from "effect"

/** A POSIX computer for tests: paths come from this table, never from the runner's HOME. */
export const ownerTable = (home = "/home/owner") => hubPathTable({ windows: false, home, hostname: "atlas", env: {} })

/** {@link ownerTable} as a layer, for a test's composed layer. */
export const ownerPaths = (home = "/home/owner") => Layer.succeed(HubPaths, ownerTable(home))
