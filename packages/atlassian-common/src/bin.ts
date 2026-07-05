#!/usr/bin/env node
import { NodeFileSystem, NodeHttpClient, NodePath, NodeRuntime, NodeServices, NodeStdio } from "@effect/platform-node"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stdio from "effect/Stdio"
import { Argument as Args, Command } from "effect/unstable/cli"
import pkg from "../package.json" with { type: "json" }
import {
  HomeDirectoryLive,
  inspectAllToolProfiles,
  migrateLegacyProfiles,
  refreshActiveProfiles,
  type ToolProfileStatus,
  useProfileForAllTools
} from "./config/index.js"

const profileArg = Args.string("profile").pipe(
  Args.withDescription("Profile ID, name, site URL, cloud ID, or account ID")
)

const printStatuses = (statuses: ReadonlyArray<ToolProfileStatus>) =>
  Effect.gen(function*() {
    for (const status of statuses) {
      const active = status.activeProfile
      yield* Console.log(`${status.tool.label} (${status.tool.toolName})`)
      if (status.authStoreName !== status.tool.toolName) {
        yield* Console.log(`  Auth store: ${status.authStoreName}`)
      }
      yield* Console.log(`  Active: ${active ? active.name : "none"}`)
      if (active) {
        yield* Console.log(`  Profile ID: ${active.id}`)
        yield* Console.log(`  Site: ${active.token.site_url}`)
        yield* Console.log(`  Token: ${status.tokenStatus}`)
        yield* Console.log(
          `  Scopes: ${status.missingScopes.length === 0 ? "ok" : `missing ${status.missingScopes.join(", ")}`}`
        )
      }
    }
  })

const profilesList = Command.make("list", {}, () => inspectAllToolProfiles().pipe(Effect.flatMap(printStatuses)))
  .pipe(Command.withDescription("List active Atlassian profiles for all tools"))

const profilesUse = Command.make(
  "use",
  { profile: profileArg },
  ({ profile }) => useProfileForAllTools(profile).pipe(Effect.flatMap(printStatuses))
).pipe(Command.withDescription("Use a profile across Atlassian tools"))

const profilesDoctor = Command.make("doctor", {}, () =>
  inspectAllToolProfiles().pipe(
    Effect.flatMap((statuses) =>
      Effect.gen(function*() {
        yield* printStatuses(statuses)
        for (const status of statuses) {
          if (!status.activeProfile) {
            yield* Console.log(`Suggestion: run '${status.tool.loginHint}' for ${status.tool.label}.`)
          }
          if (status.tokenStatus === "expired") {
            yield* Console.log(
              `Suggestion: run 'atlassian auth refresh' or '${status.tool.loginHint}' for ${status.tool.label}.`
            )
          }
          if (status.missingScopes.length > 0) {
            yield* Console.log(
              `Suggestion: re-login with ${status.tool.label}; missing scopes: ${status.missingScopes.join(", ")}.`
            )
          }
        }
      })
    )
  )).pipe(Command.withDescription("Diagnose tokens, scopes, and active profile usage"))

const profilesMigrate = Command.make("migrate", {}, () => migrateLegacyProfiles().pipe(Effect.flatMap(printStatuses)))
  .pipe(Command.withDescription("Migrate legacy auth.json files into shared profiles.json storage"))

const profiles = Command.make("profiles").pipe(
  Command.withDescription("Manage shared Atlassian auth profiles"),
  Command.withSubcommands([profilesList, profilesUse, profilesDoctor, profilesMigrate])
)

const authRefresh = Command.make("refresh", {}, () => refreshActiveProfiles().pipe(Effect.flatMap(printStatuses)))
  .pipe(Command.withDescription("Refresh expired active OAuth tokens"))

const auth = Command.make("auth").pipe(
  Command.withDescription("Manage Atlassian authentication"),
  Command.withSubcommands([authRefresh])
)

const atlassian = Command.make("atlassian", {}, () => Console.log("Usage: atlassian profiles|auth")).pipe(
  Command.withDescription("Unified Atlassian profile manager"),
  Command.withSubcommands([profiles, auth])
)

const cli = Command.runWith(atlassian, { version: pkg.version })
const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return yield* cli(args)
}).pipe(
  Effect.provide(NodeStdio.layer),
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NodeFileSystem.layer,
      NodePath.layer,
      NodeHttpClient.layerFetch,
      HomeDirectoryLive
    )
  ),
  Effect.catch((error: unknown) => Console.error(String(error)).pipe(Effect.andThen(Effect.fail(error))))
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
