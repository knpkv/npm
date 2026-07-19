#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"

import { AgentProvider } from "../api/agent.js"
import { PersonId, WorkspaceId } from "../domain/identifiers.js"
import { TerminalRecovery, terminalRecoveryLayer } from "./auth/TerminalRecovery.js"
import { classifyControlCenterCliArguments } from "./cliArguments.js"
import {
  decodeControlCenterDataPaths,
  prepareControlCenterDataRoot,
  resolvePreparedControlCenterDataRoot
} from "./cliConfiguration.js"
import { ControlCenterObservabilityLive } from "./observability.js"
import {
  type BackupVerification,
  createOfflineVerifiedBackup,
  restoreBackup,
  verifyBackup
} from "./persistence/backup/index.js"
import { DatabaseInitializationError } from "./persistence/errors.js"
import { WorkspaceName } from "./persistence/repositories/models.js"
import { ControlCenterBootstrap } from "./runtime/Bootstrap.js"
import { makeControlCenterServer } from "./runtime/ControlCenterServer.js"
import { ServerLifecycle } from "./runtime/ServerLifecycle.js"
import { decodeBindConfig } from "./security/BindConfig.js"

const DEFAULT_WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000001")
const DEFAULT_OWNER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000002")

const commaSeparated = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

const dataRootConfiguration = Config.string("CONTROL_CENTER_DATA_ROOT").pipe(Config.withDefault(".control-center"))

const serverConfiguration = Config.all({
  agentClaudeExecutable: Config.string("CONTROL_CENTER_AGENT_CLAUDE_EXECUTABLE").pipe(Config.withDefault("")),
  agentClaudeModel: Config.string("CONTROL_CENTER_AGENT_CLAUDE_MODEL").pipe(Config.withDefault("")),
  agentCodexExecutable: Config.string("CONTROL_CENTER_AGENT_CODEX_EXECUTABLE").pipe(Config.withDefault("")),
  agentCodexModel: Config.string("CONTROL_CENTER_AGENT_CODEX_MODEL").pipe(Config.withDefault("")),
  agentCwd: Config.string("CONTROL_CENTER_AGENT_CWD").pipe(Config.withDefault("")),
  agentProviders: Config.string("CONTROL_CENTER_AGENT_PROVIDERS").pipe(Config.withDefault("")),
  allowedHosts: Config.string("CONTROL_CENTER_ALLOWED_HOSTS").pipe(Config.withDefault("")),
  allowedOrigins: Config.string("CONTROL_CENTER_ALLOWED_ORIGINS").pipe(Config.withDefault("")),
  allowInsecureLan: Config.boolean("CONTROL_CENTER_ALLOW_INSECURE_LAN").pipe(Config.withDefault(false)),
  directTlsCertificateRef: Config.string("CONTROL_CENTER_TLS_CERTIFICATE_REF").pipe(Config.withDefault("")),
  directTlsPrivateKeyRef: Config.string("CONTROL_CENTER_TLS_PRIVATE_KEY_REF").pipe(Config.withDefault("")),
  host: Config.string("CONTROL_CENTER_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.int("CONTROL_CENTER_PORT").pipe(Config.withDefault(4173)),
  publicOrigin: Config.string("CONTROL_CENTER_PUBLIC_ORIGIN").pipe(Config.withDefault("")),
  trustedProxyAddresses: Config.string("CONTROL_CENTER_TRUSTED_PROXY_ADDRESSES").pipe(Config.withDefault(""))
})

const writeStdoutLine = (value: string) =>
  Stdio.Stdio.use((stdio) => Stream.make(`${value}\n`).pipe(Stream.run(stdio.stdout())))

const writeStderrLine = (value: string) =>
  Stdio.Stdio.use((stdio) => Stream.make(`${value}\n`).pipe(Stream.run(stdio.stderr())))

const verificationLine = (complete: string, degraded: string, verification: BackupVerification): string =>
  verification._tag === "Complete"
    ? complete
    : `${degraded} ${verification.reproducibleBlobGaps.length} reproducible cache gaps.`

class ControlCenterCliUsageError extends Schema.TaggedErrorClass<ControlCenterCliUsageError>()(
  "ControlCenterCliUsageError",
  { command: Schema.String }
) {}

const program = Effect.scoped(
  Effect.gen(function*() {
    const path = yield* Path.Path
    const stdio = yield* Stdio.Stdio
    const invocation = classifyControlCenterCliArguments(yield* stdio.args)
    if (invocation._tag === "invalid") {
      yield* writeStderrLine(
        "Usage: control-center [recover-owner | backup <archive> | verify-backup <archive> | restore <archive>]"
      )
      return yield* new ControlCenterCliUsageError({ command: invocation.command })
    }

    if (invocation._tag === "verify-backup") {
      const verification = yield* verifyBackup(invocation.archiveRoot)
      yield* writeStdoutLine(verificationLine("Backup verified.", "Backup verified with", verification))
      return
    }

    const configuredDataRoot = yield* dataRootConfiguration
    if (invocation._tag === "restore") {
      const restored = yield* restoreBackup({
        archiveRoot: invocation.archiveRoot,
        configuredDataRoot
      })
      yield* writeStdoutLine(verificationLine("Backup restored.", "Backup restored with", restored.verification))
      return
    }

    const configuredDataPaths = yield* decodeControlCenterDataPaths(configuredDataRoot)
    if (invocation._tag === "backup") {
      const existingDataPaths = yield* resolvePreparedControlCenterDataRoot(configuredDataPaths)
      const published = yield* createOfflineVerifiedBackup({
        destination: invocation.archiveRoot,
        persistenceConfig: existingDataPaths.persistenceConfig
      })
      yield* writeStdoutLine(verificationLine("Backup created.", "Backup created with", published.verification))
      return
    }

    const dataPaths = yield* prepareControlCenterDataRoot(configuredDataPaths)

    if (invocation._tag === "recover-owner") {
      const recoveryServices = yield* Layer.build(terminalRecoveryLayer(dataPaths.persistenceConfig))
      const recovery = Context.get(recoveryServices, TerminalRecovery)
      const issued = yield* recovery.issueOwnerRecovery({
        workspaceId: DEFAULT_WORKSPACE_ID,
        actor: { _tag: "human", personId: DEFAULT_OWNER_ID },
        revokeExistingOwnerSessions: true
      })
      yield* writeStdoutLine(`Recovery pairing code: ${Redacted.value(issued.pairingCode)}`)
      return
    }

    const configured = yield* serverConfiguration
    const agentProviders = yield* Schema.decodeUnknownEffect(Schema.Array(AgentProvider).check(Schema.isUnique()))(
      commaSeparated(configured.agentProviders)
    )
    const agentCwd = agentProviders.length === 0
      ? null
      : yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()))(
        configured.agentCwd
      )
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
    const services = yield* Layer.build(
      makeControlCenterServer({
        bindConfig,
        firstPartyPluginRuntime: true,
        bootstrap: {
          owner: { _tag: "human", personId: DEFAULT_OWNER_ID },
          workspaceId: DEFAULT_WORKSPACE_ID,
          workspaceName: WorkspaceName.make("Control Center")
        },
        persistenceConfig: dataPaths.persistenceConfig,
        releaseAgent: agentCwd === null
          ? null
          : {
            cwd: agentCwd,
            enabledProviders: agentProviders,
            ...(configured.agentCodexExecutable.length > 0
              ? { codexExecutable: configured.agentCodexExecutable }
              : {}),
            ...(configured.agentCodexModel.length > 0 ? { codexModel: configured.agentCodexModel } : {}),
            ...(configured.agentClaudeExecutable.length > 0
              ? { claudeExecutable: configured.agentClaudeExecutable }
              : {}),
            ...(configured.agentClaudeModel.length > 0 ? { claudeModel: configured.agentClaudeModel } : {})
          },
        secretRoot: dataPaths.secretRoot,
        staticAssets: { root: staticRoot }
      })
    )
    const bootstrap = Context.get(services, ControlCenterBootstrap)
    const lifecycle = Context.get(services, ServerLifecycle)

    yield* writeStdoutLine(`Control Center listening at ${bindConfig.publicOrigin}`)
    if (bootstrap._tag === "pairing-issued") {
      yield* writeStdoutLine(`Pairing code: ${Redacted.value(bootstrap.pairingCode)}`)
    } else if (bootstrap._tag === "already-initialized") {
      yield* writeStdoutLine("Workspace ready. Use an existing paired browser.")
    }
    return yield* Effect.never.pipe(
      Effect.onInterrupt(() =>
        writeStdoutLine("Control Center draining.").pipe(
          Effect.andThen(lifecycle.drainWithin("10 seconds")),
          Effect.flatMap((result) => {
            switch (result._tag) {
              case "Drained":
                return writeStdoutLine("Control Center drained.")
              case "DeadlineExceeded":
                return writeStderrLine("Control Center drain deadline reached.")
              case "HooksFailed":
                return writeStderrLine(`Control Center drain hooks failed: ${result.hookIds.join(", ")}.`)
            }
          })
        )
      )
    )
  })
)

const findDatabaseInitializationError = (
  value: unknown,
  remainingWrapperDepth = 2
): DatabaseInitializationError | null => {
  if (Schema.is(DatabaseInitializationError)(value)) return value
  if (
    remainingWrapperDepth > 0 &&
    Predicate.hasProperty(value, "_tag") &&
    value._tag === "ServeError" &&
    Predicate.hasProperty(value, "cause")
  ) {
    return findDatabaseInitializationError(value.cause, remainingWrapperDepth - 1)
  }
  return null
}

const reportProgramFailure = <E>(cause: Cause.Cause<E>) => {
  const error = Cause.findErrorOption(cause)
  const isUsageError = Option.exists(
    error,
    (value) => Predicate.hasProperty(value, "_tag") && value._tag === "ControlCenterCliUsageError"
  )
  if (isUsageError) return Effect.failCause(cause)
  const databaseInitializationError = Option.flatMap(
    error,
    (value) => Option.fromNullishOr(findDatabaseInitializationError(value))
  )
  if (Option.isSome(databaseInitializationError)) {
    const operation = databaseInitializationError.value.operation
    return writeStderrLine(`Control Center command failed (DatabaseInitializationError: ${operation}).`).pipe(
      Effect.andThen(
        operation === "verify-schema"
          ? writeStderrLine(
            "The database schema does not match this pre-stable build. Back up the data root if needed, " +
              "then explicitly recreate local development data or choose a new CONTROL_CENTER_DATA_ROOT. " +
              "Automatic migrations are disabled until schema stability."
          )
          : Effect.void
      ),
      Effect.andThen(Effect.failCause(cause))
    )
  }
  const errorTag = Option.flatMap(
    error,
    (value) =>
      Predicate.hasProperty(value, "_tag") && typeof value._tag === "string"
        ? Option.some(value._tag)
        : Option.none<string>()
  )
  const message = Option.match(errorTag, {
    onNone: () => "Control Center command failed unexpectedly.",
    onSome: (tag) => `Control Center command failed (${tag}).`
  })
  return writeStderrLine(message).pipe(Effect.andThen(Effect.failCause(cause)))
}

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(ControlCenterObservabilityLive),
    Effect.catchCause(reportProgramFailure),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
