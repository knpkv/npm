#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { makeHostdProgram } from "./hostd.js"
import * as NodeBin from "./internal/node-bin.js"

makeHostdProgram().pipe(
  Effect.scoped,
  // The hostd process owns the Node service layer for its full lifetime. On Windows its spawner runs
  // npm `.cmd` shims as this Node with their script, never through a shell.
  Effect.provide(Layer.provideMerge(NodeBin.layer(process.execPath), NodeServices.layer)),
  NodeRuntime.runMain({ disableErrorReporting: false })
)
