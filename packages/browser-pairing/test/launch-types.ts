import type { Effect, Option, Types } from "effect"
import type { Scope } from "effect/Scope"
import type { Stdio } from "effect/Stdio"
import { type BrowserLaunchOutputError, type BrowserOpener, openOrServe } from "../src/launch.js"

interface LoginFailure {
  readonly _tag: "LoginFailure"
}
interface ServeFailure {
  readonly _tag: "ServeFailure"
}

declare const login: Effect.Effect<Option.Option<string>, LoginFailure, "LoginConfiguration">
declare const serve: (
  onReady: (url: string) => Effect.Effect<void, BrowserLaunchOutputError>
) => Effect.Effect<never, ServeFailure | BrowserLaunchOutputError, "ServeConfiguration" | Scope>

const run = openOrServe({ login, serve, launch: { _tag: "Open" } })
void run

// The launcher owns the server scope while preserving both callers' errors and services.
const errorsExact: Types.Equals<
  Effect.Error<typeof run>,
  LoginFailure | ServeFailure | BrowserLaunchOutputError
> = true
void errorsExact

const servicesExact: Types.Equals<
  Effect.Services<typeof run>,
  "LoginConfiguration" | "ServeConfiguration" | BrowserOpener | Stdio
> = true
void servicesExact
