import { Atom } from "@effect-atom/atom-react"
import { FetchHttpClient } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { AwsClient, AwsClientConfig, ConfigService, NotificationsService, PRService } from "@knpkv/codecommit-core"
import { Layer } from "effect"

// ConfigServiceLive needs FileSystem from BunContext
const ConfigLayer = ConfigService.ConfigServiceLive.pipe(Layer.provide(BunContext.layer))

// PRService layer with its dependencies
const PRLayer = PRService.PRServiceLive.pipe(
  Layer.provide(AwsClient.AwsClientLive),
  Layer.provide(ConfigLayer),
  Layer.provide(NotificationsService.NotificationsServiceLive)
)

// Merge PRLayer with NotificationsServiceLive so both PRService and notificationsAtom
// can access notifications. Effect automatically memoizes layers.
const MainLayer = Layer.merge(PRLayer, NotificationsService.NotificationsServiceLive)

// Also expose AwsClient directly for atoms that need it (listBranchesAtom, etc.)
const MainWithAwsLayer = Layer.merge(MainLayer, AwsClient.AwsClientLive)

// Wire leaf dependencies, then merge BunContext for CommandExecutor/Terminal/Path
const AppLayer = MainWithAwsLayer.pipe(
  Layer.provideMerge(BunContext.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AwsClientConfig.Default)
)

/**
 * Runtime atom providing Effect services to other atoms
 * @category atoms
 */
export const runtimeAtom = Atom.runtime(AppLayer)
