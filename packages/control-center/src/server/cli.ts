#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"

import { PersonId, WorkspaceId } from "../domain/identifiers.js"
import { TerminalRecovery, terminalRecoveryLayer } from "./auth/TerminalRecovery.js"
import { BlobRoot, LocalDatabaseUrl, type PersistenceConfig } from "./persistence/PersistenceConfig.js"
import { WorkspaceName } from "./persistence/repositories/models.js"
import { ControlCenterBootstrap } from "./runtime/Bootstrap.js"
import { makeControlCenterServer } from "./runtime/ControlCenterServer.js"
import { SecretRoot } from "./secrets/SecretStore.js"
import { decodeBindConfig } from "./security/BindConfig.js"

const DEFAULT_WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000001")
const DEFAULT_OWNER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000002")

const commaSeparated = (value: string): ReadonlyArray<string> =>
  value.split(",").map((part) => part.trim()).filter((part) => part.length > 0)

const configuration = Config.all({
  allowedHosts: Config.string("CONTROL_CENTER_ALLOWED_HOSTS").pipe(Config.withDefault("")),
  allowedOrigins: Config.string("CONTROL_CENTER_ALLOWED_ORIGINS").pipe(Config.withDefault("")),
  allowInsecureLan: Config.boolean("CONTROL_CENTER_ALLOW_INSECURE_LAN").pipe(Config.withDefault(false)),
  dataRoot: Config.string("CONTROL_CENTER_DATA_ROOT").pipe(Config.withDefault(".control-center")),
  directTlsCertificateRef: Config.string("CONTROL_CENTER_TLS_CERTIFICATE_REF").pipe(Config.withDefault("")),
  directTlsPrivateKeyRef: Config.string("CONTROL_CENTER_TLS_PRIVATE_KEY_REF").pipe(Config.withDefault("")),
  host: Config.string("CONTROL_CENTER_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.int("CONTROL_CENTER_PORT").pipe(Config.withDefault(4173)),
  publicOrigin: Config.string("CONTROL_CENTER_PUBLIC_ORIGIN").pipe(Config.withDefault("")),
  trustedProxyAddresses: Config.string("CONTROL_CENTER_TRUSTED_PROXY_ADDRESSES").pipe(Config.withDefault(""))
})

const writeLine = (value: string) =>
  Stdio.Stdio.use((stdio) => Stream.make(`${value}\n`).pipe(Stream.run(stdio.stdout())))

class ControlCenterCliUsageError extends Schema.TaggedErrorClass<ControlCenterCliUsageError>()(
  "ControlCenterCliUsageError",
  { command: Schema.String }
) {}

const program = Effect.scoped(
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const stdio = yield* Stdio.Stdio
    const configured = yield* configuration
    const dataRoot = path.resolve(configured.dataRoot)
    yield* fileSystem.makeDirectory(dataRoot, { recursive: true, mode: 0o700 })
    yield* fileSystem.chmod(dataRoot, 0o700)

    const persistenceConfig: PersistenceConfig = {
      blobRoot: BlobRoot.make(path.join(dataRoot, "blobs")),
      busyTimeoutMilliseconds: 5_000,
      databaseUrl: LocalDatabaseUrl.make(`file:${path.join(dataRoot, "control-center.db")}`),
      maxConnections: 1
    }
    const [command, ...unexpectedArguments] = yield* stdio.args
    if (command === "recover-owner" && unexpectedArguments.length === 0) {
      const recoveryServices = yield* Layer.build(terminalRecoveryLayer(persistenceConfig))
      const recovery = Context.get(recoveryServices, TerminalRecovery)
      const issued = yield* recovery.issueOwnerRecovery({
        workspaceId: DEFAULT_WORKSPACE_ID,
        actor: { _tag: "human", personId: DEFAULT_OWNER_ID },
        revokeExistingOwnerSessions: true
      })
      yield* writeLine(`Recovery pairing code: ${Redacted.value(issued.pairingCode)}`)
      return
    }
    if (command !== undefined) {
      yield* writeLine("Usage: control-center [recover-owner]")
      return yield* new ControlCenterCliUsageError({ command })
    }

    const allowedHosts = commaSeparated(configured.allowedHosts)
    const allowedOrigins = commaSeparated(configured.allowedOrigins)
    const trustedProxyAddresses = commaSeparated(configured.trustedProxyAddresses)
    const hasDirectTlsInput = configured.directTlsCertificateRef.length > 0 ||
      configured.directTlsPrivateKeyRef.length > 0
    const bindConfig = yield* decodeBindConfig({
      host: configured.host,
      port: configured.port,
      allowInsecureLan: configured.allowInsecureLan,
      ...(configured.publicOrigin.length > 0 ? { publicOrigin: configured.publicOrigin } : {}),
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
      ...(trustedProxyAddresses.length > 0 ? { trustedProxyAddresses } : {}),
      ...(hasDirectTlsInput
        ? {
          directTls: {
            certificateRef: configured.directTlsCertificateRef,
            privateKeyRef: configured.directTlsPrivateKeyRef
          }
        }
        : {})
    })
    const staticRoot = yield* path.fromFileUrl(new URL("../../client", import.meta.url))
    const services = yield* Layer.build(makeControlCenterServer({
      bindConfig,
      bootstrap: {
        owner: { _tag: "human", personId: DEFAULT_OWNER_ID },
        workspaceId: DEFAULT_WORKSPACE_ID,
        workspaceName: WorkspaceName.make("Control Center")
      },
      persistenceConfig,
      secretRoot: SecretRoot.make(path.join(dataRoot, "secrets")),
      staticAssets: { root: staticRoot }
    }))
    const bootstrap = Context.get(services, ControlCenterBootstrap)

    yield* writeLine(`Control Center listening at ${bindConfig.publicOrigin}`)
    if (bootstrap._tag === "pairing-issued") {
      yield* writeLine(`Pairing code: ${Redacted.value(bootstrap.pairingCode)}`)
    } else if (bootstrap._tag === "already-initialized") {
      yield* writeLine("Workspace ready. Use an existing paired browser.")
    }
    return yield* Effect.never
  })
).pipe(Effect.provide(NodeServices.layer))

NodeRuntime.runMain(program)
