import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { terminalCommandMaxPayloadBytes, type TerminalConnector, type TerminalSession } from "@knpkv/herdr-connect"
import {
  FleetAuthorizationError,
  type FleetService,
  FleetValidationError,
  type HostConfiguration,
  type HostOperations,
  JobStore,
  makeFleetService
} from "@knpkv/herdr-fleet"
import type { TailscaleClient } from "@knpkv/herdr-tailscale"
import {
  makeWorkService,
  WorkGoalCheckpoint,
  type WorkGoalCheckpoint as WorkGoalCheckpointType,
  WorkStore
} from "@knpkv/herdr-work"
import { Deferred, Effect, Fiber, Result, Schema, Stream } from "effect"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import WebSocketClient from "ws"
import { resolveApprovalPage } from "../src/approval-url.js"
import { authorize } from "../src/auth.js"
import { makeRunner, recordWorkCheckpointRequest, startHttpServer } from "../src/http.js"
import { relayTerminalCloseCode, terminalBufferCanAccept, terminalBufferLimitBytes } from "../src/internal/websocket.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const config = (stateDirectory: string): HostConfiguration => ({
  allowedUsers: ["andrey@example.com"],
  applyCommand: null,
  browserMcpRecoverCommand: null,
  applyMachines: ["ALPHA", "SER8"],
  approvalHub: {
    host: "SER8",
    nodeId: "node-ser8",
    url: "https://ser8.example.test/"
  },
  approvalNodes: ["node-ser8"],
  approvalPort: 4779,
  checkCommand: ["nix", "flake", "check"],
  coordinatorCommand: ["coordinator"],
  crossHost: false,
  herdrCommand: "herdr",
  host: "ALPHA",
  localPort: 0,
  machines: [
    { host: "ALPHA", nodeId: "node-alpha" },
    { host: "SER8", nodeId: "node-ser8" }
  ],
  port: 0,
  pushAllowedOrigins: ["https://push.example.test"],
  pushSubject: "mailto:andrey@example.com",
  repository: "/repo",
  approvalTls: null,
  stateDirectory,
  tailscaleCommand: "tailscale"
})

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({
      applyConfigured: false,
      branch: "main",
      dirty: false,
      repository: "/repo",
      revision: "abc123"
    }),
  listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
  run: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runLocal: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runCoordinatorChat: () => Effect.succeed("coordinator: ok")
}

const unusedTerminal: TerminalConnector = {
  open: () => Effect.die("terminal test connector must not be opened")
}

const assets = {
  connectScript: "",
  fonts: new Map<string, Uint8Array>(),
  script: "",
  stylesheet: "",
  worker: ""
}

const directTls = {
  certificatePath: join(import.meta.dirname, "fixtures/ser8.example.test.crt"),
  privateKeyPath: join(import.meta.dirname, "fixtures/ser8.example.test.key")
}

const secureRequestStatus = (
  url: string,
  headers: Readonly<Record<string, string>>
): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { headers, rejectUnauthorized: false },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }
    )
    request.once("error", reject)
    request.end()
  })

const workCheckpoint: WorkGoalCheckpointType = {
  eventId: "event-work-created",
  goal: {
    blocker: null,
    connectTarget: null,
    createdAt: 1_000,
    delivery: "local",
    detail: "Durable coordinator-owned goal",
    id: "goal-work",
    owner: { id: "owner-coordinator", name: "Coordinator" },
    repository: { branch: "feat/herdr-npm-packages", repository: "npm" },
    spend: null,
    state: "planned",
    summary: "Record live Work state",
    title: "Wire Work ingestion",
    updatedAt: 1_000
  },
  occurredAt: 1_000,
  version: "herdr.work.event.v1"
}

type WorkCheckpointTestPayload = WorkGoalCheckpointType & {
  readonly command?: ReadonlyArray<string>
}

const decodeWorkCheckpoint = (input: WorkCheckpointTestPayload) =>
  Schema.decodeUnknownEffect(WorkGoalCheckpoint, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(
      (cause) => new FleetValidationError({ detail: `invalid request: ${String(cause)}` })
    )
  )

const availablePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const reservation = createServer()
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", () => {
      const address = Schema.decodeUnknownResult(
        Schema.Struct({ port: Schema.Number })
      )(reservation.address())
      if (Result.isFailure(address)) {
        reservation.close()
        reject(address.failure)
        return
      }
      reservation.close((error) => {
        if (error === undefined) resolve(address.success.port)
        else reject(error)
      })
    })
  })

const requestStatus = (url: string, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      response.resume()
      response.once("end", () => resolve(response.statusCode ?? 0))
    })
    request.once("error", reject)
    request.end()
  })

const waitForFile = Effect.fn("HostHttpTest.waitForFile")(function*(path: string) {
  while (!existsSync(path)) yield* Effect.yieldNow
})

describe("host HTTP authority", () => {
  it.effect("records only authorized valid Work checkpoints and projects them immediately", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-work-checkpoint-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(root, "approval-app.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const work = yield* makeWorkService(store)

      const unauthorized = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.fail(new FleetAuthorizationError({ actor: "mallory@example.com" })),
          decodeWorkCheckpoint(workCheckpoint),
          work
        )
      )
      expect(unauthorized).toMatchObject({ failure: { _tag: "FleetAuthorizationError" } })

      const malformed = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.succeed("andrey@example.com"),
          decodeWorkCheckpoint({ ...workCheckpoint, command: ["sh", "-c", "id"] }),
          work
        )
      )
      expect(malformed).toMatchObject({ failure: { _tag: "FleetValidationError" } })

      expect(
        yield* recordWorkCheckpointRequest(
          Effect.succeed("andrey@example.com"),
          decodeWorkCheckpoint(workCheckpoint),
          work
        )
      ).toEqual(workCheckpoint)
      const duplicate = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.succeed("andrey@example.com"),
          decodeWorkCheckpoint(workCheckpoint),
          work
        )
      )
      expect(duplicate).toMatchObject({
        failure: { _tag: "WorkCheckpointConflictError", eventId: "event-work-created" }
      })
      expect((yield* work.snapshots(1_000)).now.goals).toEqual([workCheckpoint.goal])
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it("relays only WebSocket status codes valid on the wire", () => {
    expect(relayTerminalCloseCode(1_000)).toBe(1_000)
    expect(relayTerminalCloseCode(3_001)).toBe(3_001)
    for (const invalid of [0, 1_004, 1_005, 1_006, 2_999, 5_000]) {
      expect(relayTerminalCloseCode(invalid)).toBe(4_503)
    }
  })

  it("bounds terminal payload buffering in both directions", () => {
    expect(terminalBufferCanAccept(0, terminalBufferLimitBytes)).toBe(true)
    expect(terminalBufferCanAccept(1, terminalBufferLimitBytes)).toBe(false)
    expect(terminalBufferCanAccept(0, terminalBufferLimitBytes + 1)).toBe(false)
    expect(terminalBufferCanAccept(terminalBufferLimitBytes - 1, 1)).toBe(true)
  })

  it.effect("rejects every forwarded identity", () =>
    Effect.gen(function*() {
      const forged = yield* Effect.result(
        authorize(
          { login: "andrey@example.com", remoteAddress: "127.0.0.1" },
          ["andrey@example.com"],
          false
        )
      )
      expect(Result.isFailure(forged)).toBe(true)
      const socketless = yield* Effect.result(
        authorize(
          { login: "andrey@example.com", remoteAddress: undefined },
          ["andrey@example.com"],
          false
        )
      )
      expect(Result.isFailure(socketless)).toBe(true)
    }))

  it.effect("serves the canonical hub with direct TLS and WhoIs authorization", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-direct-tls-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-phone"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig: HostConfiguration = {
      ...config(root),
      approvalHub: {
        host: "SER8",
        nodeId: "node-ser8",
        url: "https://ser8.example.test:0/"
      },
      approvalPort: 0,
      approvalTls: directTls,
      crossHost: true,
      host: "SER8",
      port: 0,
      tailscaleCommand
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            operations,
            store
          })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          if (server.serveUrl === null || server.approvalUrl === null) {
            return yield* Effect.die("direct TLS listener missing")
          }
          expect(server.serveUrl).toMatch(/^https:\/\//)
          expect(server.approvalUrl).toBe(server.serveUrl)
          expect(
            yield* Effect.promise(() =>
              secureRequestStatus(`${server.serveUrl}/v1/dashboard`, {
                host: "ser8.example.test:0",
                "tailscale-user-login": "attacker@example.com"
              })
            )
          ).toBe(200)
        }).pipe(Effect.scoped),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("interrupts active runner work before close completes", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const runner = yield* makeRunner(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.ignore))
        )
      )
      expect(yield* Effect.promise(() => runner.enqueue("job-1"))).toBe(true)
      yield* Deferred.await(started)
      yield* Effect.promise(runner.close)
      yield* Deferred.await(interrupted)
      expect(yield* Effect.promise(() => runner.enqueue("job-2"))).toBe(false)
    }))

  it.effect("interrupts active HTTP handlers before shutdown completes", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-handler-shutdown-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.scoped(Effect.gen(function*() {
          const entered = yield* Deferred.make<void>()
          const interrupted = yield* Deferred.make<void>()
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: "ALPHA",
            operations,
            store
          })
          const blockedFleet: FleetService = {
            ...fleet,
            status: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.ignore))
              )
          }
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(config(root), blockedFleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const request = yield* Effect.forkChild(
            Effect.tryPromise(() => fetch(`${server.url}/v1/status`))
          )
          yield* Deferred.await(entered)
          const closing = yield* Effect.forkChild(Effect.promise(server.close))
          yield* Deferred.await(interrupted)
          yield* Fiber.join(closing)
          expect(Result.isFailure(yield* Effect.result(Fiber.join(request)))).toBe(true)
        })),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("rejects browser job submission but accepts originless JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-authority-test-"))
    const hostConfig = config(root)
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: hostConfig.host,
            operations,
            store
          })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const html = yield* Effect.promise(() => fetch(`${server.url}/`))
          expect(html.headers.get("content-security-policy")).toContain(
            "frame-ancestors 'none'"
          )
          expect(html.headers.get("x-frame-options")).toBe("DENY")
          const rebound = yield* Effect.promise(() => requestStatus(`${server.url}/v1/history`, "attacker.example"))
          expect(rebound).toBe(403)
          const hostile = yield* Effect.promise(() =>
            fetch(`${server.url}/v1/jobs`, {
              body: JSON.stringify({ payload: { kind: "nix.check" } }),
              headers: {
                "content-type": "text/plain",
                origin: "https://attacker.example"
              },
              method: "POST"
            })
          )
          expect(hostile.status).toBe(403)
          expect(yield* fleet.history(10)).toHaveLength(0)

          const accepted = yield* Effect.promise(() =>
            fetch(`${server.url}/v1/jobs`, {
              body: JSON.stringify({ payload: { kind: "nix.check" } }),
              headers: { "content-type": "application/json" },
              method: "POST"
            })
          )
          expect(accepted.status).toBe(202)
          expect(yield* fleet.history(10)).toHaveLength(1)
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("rejects cross-site approval forms and accepts the listener origin", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-approval-origin-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig = {
      ...config(root),
      approvalPort: 0,
      crossHost: true,
      port: 0,
      tailscaleCommand
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            id: Effect.succeed("job-origin"),
            nonce: Effect.succeed("nonce-origin"),
            now: Effect.succeed(1_000),
            operations,
            store
          })
          const pending = yield* fleet.submit(
            { payload: { kind: "nix.apply", ref: "main" } },
            "submitter@example.com"
          )
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          if (server.approvalUrl === null) {
            return yield* Effect.die("approval listener missing")
          }
          const path = `/v1/jobs/${pending.id}/approve`
          const body = new URLSearchParams({
            hash: pending.hash,
            nonce: pending.approvalNonce ?? ""
          })
          const hostile = yield* Effect.promise(() =>
            fetch(`${server.approvalUrl}${path}`, {
              body,
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: "https://attacker.example"
              },
              method: "POST",
              redirect: "manual"
            })
          )
          expect(hostile.status).toBe(403)
          expect((yield* fleet.get(pending.id)).status).toBe(
            "pending_approval"
          )

          const trusted = yield* Effect.promise(() =>
            fetch(`${server.approvalUrl}${path}`, {
              body: new URLSearchParams({
                hash: pending.hash,
                nonce: pending.approvalNonce ?? ""
              }),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: new URL(server.approvalUrl).origin
              },
              method: "POST",
              redirect: "manual"
            })
          )
          expect(trusted.status).toBe(303)
          expect((yield* fleet.get(pending.id)).status).not.toBe(
            "pending_approval"
          )
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("finishes restart recovery before accepting jobs", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-recovery-test-"))
    return Effect.gen(function*() {
      const localPort = yield* Effect.promise(availablePort)
      const hostConfig = { ...config(root), localPort }
      const recoveryEntered = yield* Deferred.make<void>()
      const releaseRecovery = yield* Deferred.make<void>()
      yield* Effect.acquireUseRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (store) =>
          Effect.gen(function*() {
            const fleet = yield* makeFleetService({
              approvalEnabled: false,
              host: hostConfig.host,
              operations,
              store
            })
            const blockedFleet: FleetService = {
              ...fleet,
              recover: () =>
                Deferred.succeed(recoveryEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRecovery)),
                  Effect.andThen(fleet.recover())
                )
            }
            const startup = yield* Effect.forkChild(
              Effect.promise(() =>
                startHttpServer(hostConfig, blockedFleet, assets, {
                  terminalConnector: unusedTerminal
                })
              )
            )
            yield* Deferred.await(recoveryEntered)
            const beforeRecovery = yield* Effect.result(
              Effect.tryPromise(() =>
                fetch(`http://127.0.0.1:${localPort}/v1/jobs`, {
                  body: JSON.stringify({ payload: { kind: "nix.check" } }),
                  headers: { "content-type": "application/json" },
                  method: "POST"
                })
              )
            )
            expect(Result.isFailure(beforeRecovery)).toBe(true)

            yield* Deferred.succeed(releaseRecovery, undefined)
            const server = yield* Fiber.join(startup)
            yield* Effect.addFinalizer(() => Effect.promise(server.close))
            const accepted = yield* Effect.promise(() =>
              fetch(`${server.url}/v1/jobs`, {
                body: JSON.stringify({ payload: { kind: "nix.check" } }),
                headers: { "content-type": "application/json" },
                method: "POST"
              })
            )
            expect(accepted.status).toBe(202)
          }).pipe(Effect.scoped),
        (store) => Effect.sync(() => store.close())
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("does not run recovered work when listener startup fails", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-listen-failure-test-"))
    return Effect.gen(function*() {
      const localPort = yield* Effect.promise(availablePort)
      const hostConfig = { ...config(root), localPort }
      const operationStarted = yield* Deferred.make<void>()
      let runs = 0
      const recoveryOperations: HostOperations = {
        ...operations,
        run: () =>
          Effect.sync(() => {
            runs += 1
          }).pipe(
            Effect.andThen(Deferred.succeed(operationStarted, undefined)),
            Effect.as("recovered")
          )
      }
      yield* Effect.acquireUseRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (store) =>
          Effect.gen(function*() {
            const fleet = yield* makeFleetService({
              approvalEnabled: false,
              host: hostConfig.host,
              operations: recoveryOperations,
              store
            })
            yield* fleet.submit({ payload: { kind: "nix.check" } }, "local")
            yield* Effect.scoped(
              Effect.gen(function*() {
                const blocker = createServer()
                yield* Effect.promise(
                  () =>
                    new Promise<void>((resolve, reject) => {
                      blocker.once("error", reject)
                      blocker.listen(localPort, "127.0.0.1", resolve)
                    })
                )
                yield* Effect.addFinalizer(() =>
                  Effect.promise(
                    () => new Promise<void>((resolve) => blocker.close(() => resolve()))
                  )
                )
                const failed = yield* Effect.result(
                  Effect.tryPromise(() =>
                    startHttpServer(hostConfig, fleet, assets, {
                      terminalConnector: unusedTerminal
                    })
                  )
                )
                expect(Result.isFailure(failed)).toBe(true)
                expect(yield* Deferred.isDone(operationStarted)).toBe(false)
              })
            )

            const server = yield* Effect.acquireRelease(
              Effect.promise(() =>
                startHttpServer(hostConfig, fleet, assets, {
                  terminalConnector: unusedTerminal
                })
              ),
              (running) => Effect.promise(running.close)
            )
            yield* Deferred.await(operationStarted)
            expect(server.url).toContain(`:${localPort}`)
            expect(runs).toBe(1)
          }).pipe(Effect.scoped),
        (store) => Effect.sync(() => store.close())
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("releases earlier resources when a later store cannot open", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-store-failure-test-"))
    const statePath = join(root, "approval-app.sqlite")
    const poisoned = new DatabaseSync(statePath)
    poisoned.exec("CREATE VIEW agent_activity AS SELECT 1 AS invalid")
    poisoned.close()
    const hostConfig = config(root)
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: hostConfig.host,
            operations,
            store
          })
          const failed = yield* Effect.result(
            Effect.tryPromise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            )
          )
          expect(Result.isFailure(failed)).toBe(true)

          const repaired = new DatabaseSync(statePath)
          repaired.exec("DROP VIEW agent_activity")
          repaired.close()
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const response = yield* Effect.promise(() => fetch(`${server.url}/v1/status`))
          expect(response.status).toBe(200)
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("releases a disconnected terminal open and closes a clean exit", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-terminal-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig = {
      ...config(root),
      approvalPort: 0,
      crossHost: true,
      port: 0,
      tailscaleCommand
    }
    return Effect.gen(function*() {
      const openStarted = yield* Deferred.make<void>()
      const openInterrupted = yield* Deferred.make<void>()
      const sendStarted = yield* Deferred.make<void>()
      const sendInterrupted = yield* Deferred.make<void>()
      const controllerReleaseStarted = yield* Deferred.make<void>()
      const allowControllerRelease = yield* Deferred.make<void>()
      const controllerReleaseFinished = yield* Deferred.make<void>()
      const shutdownReleaseStarted = yield* Deferred.make<void>()
      const allowShutdownRelease = yield* Deferred.make<void>()
      let opens = 0
      let sends = 0
      const connector: TerminalConnector = {
        open: () => {
          opens += 1
          const attempt = opens
          const session: TerminalSession = {
            events: attempt === 2
              ? Stream.empty
              : attempt === 4
              ? Stream.make({
                bytes: Buffer.alloc(terminalBufferLimitBytes + 1).toString("base64"),
                encoding: "ansi",
                full: true,
                height: 30,
                seq: 1,
                type: "terminal.frame",
                width: 100
              })
              : Stream.never,
            send: () =>
              attempt === 3
                ? Effect.sync(() => {
                  sends += 1
                }).pipe(
                  Effect.andThen(Deferred.succeed(sendStarted, undefined)),
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(sendInterrupted, undefined).pipe(
                      Effect.ignore
                    )
                  )
                )
                : Effect.void
          }
          return attempt === 1
            ? Deferred.succeed(openStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(openInterrupted, undefined).pipe(Effect.ignore))
            )
            : attempt === 5
            ? Effect.acquireRelease(
              Effect.succeed(session),
              () =>
                Deferred.succeed(
                  controllerReleaseStarted,
                  undefined
                ).pipe(
                  Effect.andThen(Deferred.await(allowControllerRelease)),
                  Effect.ensuring(
                    Deferred.succeed(
                      controllerReleaseFinished,
                      undefined
                    ).pipe(Effect.ignore)
                  )
                )
            )
            : attempt === 6
            ? Effect.acquireRelease(
              Effect.succeed(session),
              () =>
                Deferred.succeed(shutdownReleaseStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(allowShutdownRelease))
                )
            )
            : Effect.succeed(session)
        }
      }
      yield* Effect.acquireUseRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (store) =>
          Effect.gen(function*() {
            const fleet = yield* makeFleetService({
              approvalEnabled: false,
              host: hostConfig.host,
              operations,
              store
            })
            const server = yield* Effect.acquireRelease(
              Effect.promise(() =>
                startHttpServer(hostConfig, fleet, assets, {
                  terminalConnector: connector
                })
              ),
              (running) => Effect.promise(running.close)
            )
            if (server.tailnetUrl === null) return yield* Effect.die("tailnet listener missing")
            const url = new URL("/v1/connect/terminal", server.tailnetUrl)
            url.protocol = "ws:"
            url.searchParams.set("agent", "agent-1")
            url.searchParams.set("cols", "100")
            url.searchParams.set("host", hostConfig.host)
            url.searchParams.set("rows", "30")

            const first = yield* Effect.promise(
              () =>
                new Promise<WebSocketClient>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("open", () => resolve(socket))
                })
            )
            yield* Deferred.await(openStarted)
            const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()))
            first.send("x".repeat(terminalCommandMaxPayloadBytes + 1))
            yield* Effect.promise(() => firstClosed)
            yield* Deferred.await(openInterrupted)
            expect(
              (yield* Effect.promise(() => fetch(`${server.url}/v1/status`))).status
            ).toBe(200)

            const cleanClose = yield* Effect.promise(
              () =>
                new Promise<number>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("close", (code) => resolve(code))
                })
            )
            expect(cleanClose).toBe(1_000)
            expect(opens).toBe(2)

            const queued = yield* Effect.promise(
              () =>
                new Promise<WebSocketClient>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("message", () => resolve(socket))
                })
            )
            const command = JSON.stringify({
              text: "queued input",
              type: "terminal.input"
            })
            queued.send(command)
            yield* Deferred.await(sendStarted)
            const queuedClosed = new Promise<void>((resolve) => queued.once("close", () => resolve()))
            for (let index = 0; index < 65; index += 1) {
              queued.send(command)
            }
            yield* Effect.promise(() => queuedClosed)
            yield* Deferred.await(sendInterrupted)
            expect(sends).toBe(1)

            let oversizedFrames = 0
            const oversizedClose = yield* Effect.promise(
              () =>
                new Promise<number>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.on("message", (_data, isBinary) => {
                    if (isBinary) oversizedFrames += 1
                  })
                  socket.once("close", (code) => resolve(code))
                })
            )
            expect(oversizedClose).toBe(4_429)
            expect(oversizedFrames).toBe(0)

            const held = yield* Effect.promise(
              () =>
                new Promise<WebSocketClient>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("message", () => resolve(socket))
                })
            )
            held.close()
            yield* Deferred.await(controllerReleaseStarted)
            const blockedDuplicate = yield* Effect.promise(
              () =>
                new Promise<number>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("close", (code) => resolve(code))
                })
            )
            expect(blockedDuplicate).toBe(4_423)
            expect(opens).toBe(5)
            yield* Deferred.succeed(allowControllerRelease, undefined)
            yield* Deferred.await(controllerReleaseFinished)
            yield* Effect.yieldNow

            yield* Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("open", () => resolve())
                })
            )
            const closeFinished = yield* Deferred.make<void>()
            const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
            const closing = server.close().then(() =>
              runPromise(
                Deferred.succeed(closeFinished, undefined).pipe(Effect.ignore)
              )
            )
            yield* Deferred.await(shutdownReleaseStarted)
            expect(yield* Deferred.isDone(closeFinished)).toBe(false)
            yield* Deferred.succeed(allowShutdownRelease, undefined)
            yield* Effect.promise(() => closing)
            expect(yield* Deferred.isDone(closeFinished)).toBe(true)
            expect(opens).toBe(6)
          }).pipe(Effect.scoped),
        (store) => Effect.sync(() => store.close())
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  }, { timeout: 10_000 })

  it.effect("rejects an upgrade whose authorization finishes after shutdown starts", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-upgrade-shutdown-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    const authorizationStarted = join(root, "authorization-started")
    const releaseAuthorization = join(root, "release-authorization")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois)
    : > '${authorizationStarted}'
    while [ ! -e '${releaseAuthorization}' ]; do sleep 0.01; done
    printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}'
    ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig = {
      ...config(root),
      approvalPort: 0,
      crossHost: true,
      port: 0,
      tailscaleCommand
    }
    let opens = 0
    const connector: TerminalConnector = {
      open: () =>
        Effect.sync(() => {
          opens += 1
          return { events: Stream.never, send: () => Effect.void }
        })
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.scoped(Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: hostConfig.host,
            operations,
            store
          })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: connector
              })
            ),
            (running) => Effect.promise(running.close)
          )
          if (server.tailnetUrl === null) return yield* Effect.die("tailnet listener missing")
          const url = new URL("/v1/connect/terminal", server.tailnetUrl)
          url.protocol = "ws:"
          url.searchParams.set("agent", "agent-1")
          url.searchParams.set("cols", "100")
          url.searchParams.set("host", hostConfig.host)
          url.searchParams.set("rows", "30")
          const socket = yield* Effect.acquireRelease(
            Effect.sync(() => new WebSocketClient(url)),
            (client) => Effect.sync(() => client.terminate())
          )
          const rejected = new Promise<string>((resolve) => {
            socket.once("unexpected-response", (_request, response) => {
              response.resume()
              resolve(`status:${response.statusCode}`)
            })
            socket.once("error", (error) => resolve(`error:${String(error)}`))
          })
          yield* waitForFile(authorizationStarted)
          const closing = server.close()
          writeFileSync(releaseAuthorization, "")
          expect(yield* Effect.promise(() => rejected)).toMatch(/^(?:status:503|error:Error: socket hang up)$/)
          yield* Effect.promise(() => closing)
          expect(opens).toBe(0)
        })),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          writeFileSync(releaseAuthorization, "")
          rmSync(root, { force: true, recursive: true })
        })
      ),
      provideNodeServices
    )
  }, { timeout: 10_000 })
})

describe("approval URL resolution", () => {
  it.effect("uses the local node's Tailscale address instead of loopback", () => {
    const tailscale: TailscaleClient = {
      ipv4: Effect.succeed("100.64.0.1"),
      status: Effect.succeed({
        Peer: {
          ser8: {
            DNSName: "ser8.example.test",
            HostName: "SER8",
            ID: "node-ser8",
            Online: true,
            TailscaleIPs: ["100.64.0.8"]
          }
        },
        Self: {
          DNSName: "alpha.example.test",
          HostName: "ALPHA",
          ID: "node-alpha",
          Online: true,
          TailscaleIPs: ["100.64.0.1"]
        }
      }),
      whois: () => Effect.die("unused")
    }
    const hostConfig = { ...config("/state"), crossHost: true }
    return Effect.gen(function*() {
      expect(yield* resolveApprovalPage(hostConfig, tailscale, "ALPHA")).toBe(
        "http://100.64.0.1:4779/"
      )
      expect(yield* resolveApprovalPage(hostConfig, tailscale, "SER8")).toBe(
        "https://ser8.example.test/"
      )
    })
  })
})
