import type { Scope } from "effect"
import { Context, Effect, Layer } from "effect"
import * as Atom from "effect/unstable/reactivity/Atom"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"

export class TuiApplicationScope extends Context.Service<TuiApplicationScope, Scope.Scope>()(
  "@knpkv/codecommit/TuiApplicationScope"
) {}

export interface TuiTerminalSessionShape {
  readonly resume: Effect.Effect<void>
  readonly suspend: Effect.Effect<void>
}

/** Owns the alternate-screen transition required by same-terminal child applications. */
export class TuiTerminalSession extends Context.Service<TuiTerminalSession, TuiTerminalSessionShape>()(
  "@knpkv/codecommit/TuiTerminalSession"
) {}

/** Program scope seeded into the atom registry before the TUI root is rendered. @internal */
export const tuiApplicationScopeAtom = Atom.make<Scope.Scope | undefined>(undefined).pipe(
  Atom.keepAlive
)

export const tuiTerminalSessionAtom = Atom.make<TuiTerminalSessionShape | undefined>(undefined).pipe(
  Atom.keepAlive
)

/** Creates the atom registry owned by one TUI program invocation. @internal */
export const makeTuiApplicationRegistry = (
  applicationScope: Scope.Scope,
  terminalSession: TuiTerminalSessionShape
) =>
  AtomRegistry.make({
    initialValues: [
      [tuiApplicationScopeAtom, applicationScope],
      [tuiTerminalSessionAtom, terminalSession]
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
