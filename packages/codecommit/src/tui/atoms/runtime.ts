import { Atom } from "@effect-atom/atom-react"
import { FetchHttpClient } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Layer } from "effect"
import {
  AwsClientLive,
  ConfigServiceLive,
  NotificationsServiceLive,
  PRServiceLive
} from "@knpkv/codecommit-core"

// ConfigServiceLive needs FileSystem from BunContext
const ConfigLayer = ConfigServiceLive.pipe(Layer.provide(BunContext.layer))

// PRService layer with its dependencies
const PRLayer = PRServiceLive.pipe(
  Layer.provide(AwsClientLive),
  Layer.provide(ConfigLayer),
  Layer.provide(NotificationsServiceLive)
)

// Merge PRLayer with NotificationsServiceLive so both PRService and notificationsAtom
// can access notifications. Effect automatically memoizes layers.
const MainLayer = Layer.merge(PRLayer, NotificationsServiceLive)

// Also expose AwsClient directly for atoms that need it (listBranchesAtom, etc.)
const MainWithAwsLayer = Layer.merge(MainLayer, AwsClientLive)

// BunContext provides FileSystem, CommandExecutor, Terminal, Path
const AppLayer = Layer.mergeAll(MainWithAwsLayer, BunContext.layer, FetchHttpClient.layer)

/**
 * Runtime atom providing Effect services to other atoms
 * @category atoms
 */
export const runtimeAtom = Atom.runtime(AppLayer)