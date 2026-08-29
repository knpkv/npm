#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as ChildEnv from "@knpkv/codecommit-core/ChildEnv.js"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"

import { makeCodeCommitGitFixture } from "./GitFixture.js"
import { CODECOMMIT_MOCK_REVIEW_MODEL } from "./ReviewModelFixture.js"
import { makeGitFixtureScenario } from "./Scenario.js"
import { startCodeCommitMock } from "./Server.js"

const writeLine = (line: string) =>
  Stdio.Stdio.use((stdio) => Stream.make(`${line}\n`).pipe(Stream.run(stdio.stdout())))

const program = Effect.scoped(
  Effect.gen(function*() {
    const git = yield* makeCodeCommitGitFixture()
    const scenario = makeGitFixtureScenario(git.revisions)
    const mock = yield* startCodeCommitMock(scenario, {
      cleanReviewHead: git.revisions.secondHead,
      revisionControl: {
        advance: () => git.advance,
        reset: git.reset
      }
    })
    const repository = scenario.repositories[0]
    const pullRequest = repository.pullRequests[0]
    if (pullRequest === undefined) return yield* Effect.die("default mock scenario has no pull request")
    yield* writeLine(`CodeCommit mock listening at ${mock.origin}`)
    yield* writeLine(`CODECOMMIT_MOCK_ENDPOINT=${mock.origin}`)
    yield* writeLine(`CODECOMMIT_MOCK_GIT_REPOSITORY=${git.repositoryName}`)
    yield* writeLine(`CODECOMMIT_MOCK_GIT_REMOTE=${git.cloneUrl}`)
    yield* writeLine(`CONTROL_CENTER_AGENT_OPENAI_API_URL=${mock.origin}/v1`)
    yield* writeLine(`CONTROL_CENTER_AGENT_OPENAI_MODEL=${CODECOMMIT_MOCK_REVIEW_MODEL}`)
    yield* writeLine(mock.consolePullRequestUrl(repository.repositoryName, pullRequest.pullRequestId))
    return yield* Effect.never
  })
)

const runtimeLayer = Layer.merge(NodeServices.layer, ChildEnv.layerHostEnvironment(process.env))

NodeRuntime.runMain(
  program.pipe(
    // The CLI provides one merged runtime layer at its executable boundary.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(runtimeLayer)
  )
)
