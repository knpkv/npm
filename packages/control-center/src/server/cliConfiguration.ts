import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

import { PersistenceConfigError } from "./persistence/errors.js"
import { decodePersistenceConfig, type PersistenceConfig } from "./persistence/PersistenceConfig.js"
import { SecretRoot } from "./secrets/SecretStore.js"

/** Validated filesystem paths derived from the untrusted data-root environment value. */
export interface ControlCenterDataPaths {
  readonly dataRoot: string
  readonly persistenceConfig: PersistenceConfig
  readonly secretRoot: SecretRoot
}

const configurationError = (): PersistenceConfigError =>
  new PersistenceConfigError({
    message: "Control Center data paths must be absolute, bounded, and free of control characters"
  })

/** Decode every path derived from CONTROL_CENTER_DATA_ROOT into typed configuration failures. */
export const decodeControlCenterDataPaths = Effect.fn("decodeControlCenterDataPaths")(function*(
  configuredDataRoot: string
): Effect.fn.Return<ControlCenterDataPaths, PersistenceConfigError, Path.Path> {
  const path = yield* Path.Path
  const dataRoot = path.resolve(configuredDataRoot)
  const persistenceConfig = yield* decodePersistenceConfig({
    blobRoot: path.join(dataRoot, "blobs"),
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${path.join(dataRoot, "control-center.db")}`,
    maxConnections: 1
  })
  const secretRoot = yield* Schema.decodeUnknownEffect(SecretRoot)(path.join(dataRoot, "secrets")).pipe(
    Effect.mapError(configurationError)
  )
  return { dataRoot, persistenceConfig, secretRoot }
})
