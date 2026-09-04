#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { makeHostdProgram } from "./hostd.js"

makeHostdProgram().pipe(
  Effect.scoped,
  // The hostd process owns the Node service layer for its full lifetime.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: false })
)
