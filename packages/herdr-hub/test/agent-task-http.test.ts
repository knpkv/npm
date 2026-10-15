import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { type HostConfiguration, HostStatus, JobStore, makeFleetService } from "@knpkv/herdr-fleet"
import { makeWorkService, WorkPullRequestObservation, WorkStore } from "@knpkv/herdr-work"
import { Clock, Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { makeHostdOperations } from "../src/hostd.js"
import { startHttpServer } from "../src/http.js"
import { copyTaskWorkRegistration, makeTaskWorkSource } from "../src/internal/agent-task-work-source.js"
import { branchTaskFacts } from "../src/internal/agent-task-work.js"
import { makeHostCommand } from "../src/internal/host-command.js"

const assets = {
  connectScript: "",
  fonts: new Map<string, Uint8Array>(),
  icon: () => Promise.resolve(null),
  script: "",
  stylesheet: "",
  worker: ""
}

describe("hostd existing Work task producer", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect("publishes actual stored PR facts through status and detaches them when HTTP closes", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const now = yield* Clock.currentTimeMillis
        const paths = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "task-http-source-" })
        const repo = paths.join(root, "repo")
        yield* fs.makeDirectory(repo)
        expect(yield* spawner.exitCode(makeHostCommand("git", ["init", "-q", "--initial-branch=feat/fixture", repo])))
          .toBe(0)
        expect(
          yield* spawner.exitCode(
            makeHostCommand("git", [
              "-C",
              repo,
              "config",
              "--local",
              "remote.origin.url",
              "https://github.com/fixture/project.git"
            ])
          )
        ).toBe(0)
        const herdrCommand = paths.join(root, "herdr-test")
        const agents = [{ agent: "codex", agent_status: "working", cwd: repo, pane_id: "w1:p1", state_change_seq: 1 }]
        yield* fs.writeFileString(
          herdrCommand,
          `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ result: { agents } })}'\n`
        )
        yield* fs.chmod(herdrCommand, 0o700)
        const configuration: HostConfiguration = {
          allowedUsers: ["owner@example.test"],
          applyCommand: null,
          browserMcpRecoverCommand: null,
          applyMachines: ["fixture-host"],
          approvalHub: { host: "fixture-host", nodeId: "node-fixture", url: "https://fixture.example.test:4779/" },
          approvalNodes: ["node-fixture"],
          approvalPort: 0,
          approvalTls: null,
          checkCommand: ["true"],
          coordinatorCommand: ["true"],
          crossHost: false,
          herdrCommand,
          host: "fixture-host",
          localPort: 0,
          machines: [{ host: "fixture-host", nodeId: "node-fixture" }],
          port: 0,
          pushAllowedOrigins: ["https://push.example.test"],
          pushSubject: "mailto:owner@example.test",
          repository: repo,
          stateDirectory: root,
          tailscaleCommand: "true"
        }
        yield* Effect.acquireUseRelease(
          WorkStore.open(paths.join(root, "approval-app.sqlite")),
          (store) =>
            Effect.gen(function*() {
              const work = yield* makeWorkService(store)
              yield* work.record({
                version: "herdr.work.event.v1",
                eventId: "fixture-created",
                occurredAt: now,
                goal: {
                  id: "fixture-goal",
                  title: "PRIVATE_PR_TITLE_SENTINEL",
                  summary: "fixture",
                  detail: "fixture",
                  state: "review",
                  owner: { id: "fixture-owner", name: "Owner" },
                  repository: { repository: "fixture/project", branch: "feat/fixture" },
                  spend: null,
                  delivery: "pull_request",
                  blocker: null,
                  connectTarget: null,
                  review: {
                    state: "requested",
                    summary: null,
                    updatedAt: now,
                    url: "https://github.com/fixture/project/pull/12"
                  },
                  createdAt: now,
                  updatedAt: now
                }
              })
              yield* work.observe([{
                observedAt: now,
                observation: {
                  _tag: "pull_request",
                  repository: "fixture/project",
                  pullRequest: 12,
                  state: "open",
                  branch: "feat/fixture",
                  head: "a".repeat(40),
                  review: "requested",
                  checks: "failing",
                  closedAt: null
                }
              }])
            }),
          (store) => Effect.sync(() => store.close())
        )
        const operations = yield* makeHostdOperations(configuration, ({ defaultOperations }) =>
          Effect.succeed({
            ...defaultOperations,
            inspect: () =>
              Effect.succeed({
                applyConfigured: false,
                branch: "feat/fixture",
                dirty: false,
                repository: repo,
                revision: "a".repeat(40)
              })
          }))
        const jobs = yield* Effect.acquireRelease(
          JobStore.open(paths.join(root, "jobs.sqlite")),
          (store) => Effect.sync(() => store.close())
        )
        const fleet = yield* makeFleetService({
          host: configuration.host,
          store: jobs,
          operations,
          approvalEnabled: false
        })
        // Same private association used by makeHostdProgram, without changing its public options.
        yield* copyTaskWorkRegistration(operations.listAgents, fleet)
        yield* Effect.acquireUseRelease(
          Effect.promise(() => startHttpServer(configuration, fleet, assets)),
          (server) =>
            Effect.gen(function*() {
              const response = yield* Effect.promise(() => fetch(`${server.url}/v1/status`))
              expect(response.status).toBe(200)
              const body = Schema.decodeUnknownSync(HostStatus)(yield* Effect.promise(() => response.json()))
              expect(body.herdr.agents[0]?.taskKind).toBe("failing")
              expect(JSON.stringify(body)).not.toContain("PRIVATE_PR_TITLE_SENTINEL")
            }),
          (server) => Effect.promise(server.close)
        )
        expect((yield* operations.listAgents()).agents[0]?.taskKind).toBe("unknown")
      }).pipe(Effect.scoped))
  })
})

describe("HTTP Work snapshot completeness", () => {
  for (const counter of ["observedOmitted", "goalsOmitted"]) {
    it.effect(`does not infer a unique PR with ${counter}`, () =>
      Effect.gen(function*() {
        const rows = [{
          unknown: null,
          stale: false,
          pullRequest: {
            observedAt: 1,
            confirmedAt: 1,
            fact: Schema.decodeUnknownSync(WorkPullRequestObservation)({
              _tag: "pull_request",
              repository: "fixture/project",
              branch: "feat/fixture",
              pullRequest: 12,
              head: "a".repeat(40),
              state: "open",
              closedAt: null,
              checks: "failing",
              review: "requested"
            })
          }
        }]
        const target = { repository: "fixture/project", branch: "feat/fixture" }
        const source = yield* makeTaskWorkSource()
        const registration = yield* source.register(Effect.succeed({ observed: rows, [counter]: 1 }))
        yield* Effect.addFinalizer(() => registration.close)
        expect(branchTaskFacts(yield* source.snapshot, target, 1)).toEqual({ ci: "unknown", review: "unknown" })
        expect(branchTaskFacts({ observed: rows }, target, 1)).toEqual({ ci: "failed", review: "pending" })
      }).pipe(Effect.scoped))
  }
})
