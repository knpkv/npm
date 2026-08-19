import { ChildEnv } from "@knpkv/codecommit-core"
import type { Scope } from "effect"
import { Context, Effect, Layer } from "effect"
import * as Atom from "effect/unstable/reactivity/Atom"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"

export class TuiApplicationScope extends Context.Service<TuiApplicationScope, Scope.Scope>()(
  "@knpkv/codecommit/TuiApplicationScope"
) {}

export interface TuiTerminalSessionContract {
  readonly resume: Effect.Effect<void>
  readonly suspend: Effect.Effect<void>
}

/** Owns the alternate-screen transition required by same-terminal child applications. */
export class TuiTerminalSession extends Context.Service<TuiTerminalSession, TuiTerminalSessionContract>()(
  "@knpkv/codecommit/TuiTerminalSession"
) {}

/** Program scope seeded into the atom registry before the TUI root is rendered. @internal */
export const tuiApplicationScopeAtom = Atom.make<Scope.Scope | undefined>(undefined).pipe(
  Atom.keepAlive
)

export const tuiTerminalSessionAtom = Atom.make<TuiTerminalSessionContract | undefined>(undefined).pipe(
  Atom.keepAlive
)

/**
 * Inherited environment seeded from the executable boundary. @internal
 *
 * Profile-scoped spawns must tombstone the ambient AWS variables actually present,
 * which means reading the environment the child will extend. Only the entry point may
 * touch the host process, so it is seeded here rather than read where it is used.
 */
export const tuiHostEnvironmentAtom = Atom.make<Record<string, string | undefined> | undefined>(undefined).pipe(
  Atom.keepAlive
)

/** Creates the atom registry owned by one TUI program invocation. @internal */
export const makeTuiApplicationRegistry = (
  applicationScope: Scope.Scope,
  terminalSession: TuiTerminalSessionContract,
  hostEnvironment: Record<string, string | undefined>
) =>
  AtomRegistry.make({
    initialValues: [
      [tuiApplicationScopeAtom, applicationScope],
      [tuiTerminalSessionAtom, terminalSession],
      [tuiHostEnvironmentAtom, hostEnvironment]
    ]
  })

/** Provides the program lifecycle to action workers evaluated by an atom runtime. @internal */
export const tuiApplicationScopeLayer = (get: Atom.AtomContext) => {
  const applicationScope = get(tuiApplicationScopeAtom)
  return Layer.effect(
    TuiApplicationScope,
    applicationScope === undefined
      ? Effect.die(new Error("The TUI runtime must be rendered inside its program-owned atom registry"))
      : Effect.succeed(applicationScope)
  )
}

/** Provides terminal suspension to interactive child processes evaluated by an atom runtime. @internal */
export const tuiTerminalSessionLayer = (get: Atom.AtomContext) => {
  const terminalSession = get(tuiTerminalSessionAtom)
  return Layer.effect(
    TuiTerminalSession,
    terminalSession === undefined
      ? Effect.die(new Error("The TUI runtime must own a terminal session"))
      : Effect.succeed(TuiTerminalSession.of(terminalSession))
  )
}

/** Provides the inherited environment to profile-scoped spawns evaluated by an atom runtime. @internal */
export const tuiHostEnvironmentLayer = (get: Atom.AtomContext) => {
  const variables = get(tuiHostEnvironmentAtom)
  return Layer.effect(
    ChildEnv.HostEnvironment,
    variables === undefined
      ? Effect.die(new Error("The TUI runtime must own the inherited environment"))
      : Effect.succeed(ChildEnv.HostEnvironment.of({ variables }))
  )
}
