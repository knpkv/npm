#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"

import { defaultScenario } from "./Scenario.js"
import { startCodeCommitMock } from "./Server.js"

const writeLine = (line: string) =>
  Stdio.Stdio.use((stdio) => Stream.make(`${line}\n`).pipe(Stream.run(stdio.stdout())))

const program = Effect.scoped(Effect.gen(function*() {
  const mock = yield* startCodeCommitMock(defaultScenario)
  const repository = defaultScenario.repositories[0]
  const pullRequest = repository.pullRequests[0]
  if (pullRequest === undefined) return yield* Effect.die("default mock scenario has no pull request")
  yield* writeLine(`CodeCommit mock listening at ${mock.origin}`)
  yield* writeLine(`CODECOMMIT_MOCK_ENDPOINT=${mock.origin}`)
  yield* writeLine(mock.consolePullRequestUrl(
    repository.repositoryName,
    pullRequest.pullRequestId
  ))
  return yield* Effect.never
}))

// @effect-diagnostics-next-line strictEffectProvide:off
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
