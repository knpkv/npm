#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import {
  boundedResponseText,
  FleetOperationError,
  FleetValidationError,
  type HostConfiguration,
  HostStatus,
  JobPayload,
  type JobPayload as JobPayloadType,
  JobRecord,
  type JobRequest as JobRequestType,
  loadConfiguration
} from "@knpkv/herdr-fleet"
import { make as makeTailscale, nodeIpv4, resolveFleetNode, type TailscaleClient } from "@knpkv/herdr-tailscale"
import { WorkGoalCheckpoint, type WorkGoalCheckpoint as WorkGoalCheckpointType } from "@knpkv/herdr-work/model"
import { Console, Effect, Layer, Schema, Stdio } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { resolveApprovalPage } from "./approval-url.js"
import { submitToHost } from "./fleetctl-submission.js"
import { fleetConfigPath } from "./internal/config-path.js"
import { followJob } from "./internal/fleet-follow.js"
import { withFleetRequestTimeout } from "./internal/fleet-request.js"
import { workCheckpointFromJson, workCheckpointHubUrl } from "./work-checkpoint.js"

const operationError = (operation: string) => (cause: unknown) =>
  new FleetOperationError({ cause, detail: String(cause), operation })

const endpoint = Effect.fn("Fleetctl.endpoint")(function*(
  config: HostConfiguration,
  tailscale: TailscaleClient,
  target: string
) {
  const known = config.machines.find(({ host }) => host.toLowerCase() === target.toLowerCase())
  if (known === undefined) return yield* new FleetValidationError({ detail: `unknown host: ${target}` })
  if (known.host.toLowerCase() === config.host.toLowerCase()) return `http://127.0.0.1:${config.localPort}`
  if (!config.crossHost) {
    return yield* new FleetValidationError({
      detail: "cross-host fleet control is disabled on this machine"
    })
  }
  const status = yield* tailscale.status.pipe(Effect.mapError(operationError("tailscale.status")))
  const node = yield* resolveFleetNode(status, known).pipe(
    Effect.mapError(operationError("fleet.resolve_host.identity"))
  )
  const address = nodeIpv4(node)
  if (address === undefined || !node.Online) {
    return yield* new FleetOperationError({
      cause: known.host,
      detail: `${known.host} is not online in Tailscale status`,
      operation: "fleet.resolve_host"
    })
  }
  return `http://${address}:${config.port}`
})

const requestAt = Effect.fn("Fleetctl.requestAt")(function*<A>(
  url: string,
  schema: Schema.Codec<A, unknown, never, never>,
  body?: JobRequestType | WorkGoalCheckpointType
) {
  const client = yield* HttpClient.HttpClient
  const httpRequest = body === undefined
    ? HttpClientRequest.get(url)
    : yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.mapError(operationError("fleet.request.encode"))
    )
  return yield* withFleetRequestTimeout(
    Effect.gen(function*() {
      const response = yield* client.execute(httpRequest).pipe(
        Effect.mapError(operationError("fleet.request"))
      )
      const text = yield* boundedResponseText(response).pipe(
        Effect.mapError(operationError("fleet.response"))
      )
      if (response.status < 200 || response.status >= 300) {
        return yield* new FleetOperationError({
          cause: text,
          detail: `HTTP ${response.status}: ${text.trim()}`,
          operation: "fleet.response"
        })
      }
      return yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(schema)
      )(text).pipe(
        Effect.mapError(operationError("fleet.response.decode"))
      )
    })
  )
})

const request = Effect.fn("Fleetctl.request")(function*<A>(
  config: HostConfiguration,
  tailscale: TailscaleClient,
  target: string,
  path: string,
  schema: Schema.Codec<A, unknown, never, never>,
  body?: JobRequestType
) {
  const base = yield* endpoint(config, tailscale, target)
  return yield* requestAt(`${base}${path}`, schema, body)
})

const getJob = (config: HostConfiguration, tailscale: TailscaleClient, host: string, id: string) =>
  request(config, tailscale, host, `/v1/jobs/${encodeURIComponent(id)}`, JobRecord)

const submit = (
  config: HostConfiguration,
  tailscale: TailscaleClient,
  host: string,
  payload: JobPayloadType
) => request(config, tailscale, host, "/v1/jobs", JobRecord, { payload })

const recordWorkCheckpoint = (
  config: HostConfiguration,
  host: string,
  checkpoint: WorkGoalCheckpointType
) =>
  Effect.flatMap(
    workCheckpointHubUrl(config, host),
    (url) => requestAt(url, WorkGoalCheckpoint, checkpoint)
  )

export const payloadFrom = Effect.fn("Fleetctl.payloadFrom")(function*(args: ReadonlyArray<string>) {
  const kind = args[0]
  switch (kind) {
    case "nix.check": {
      if (args.length !== 1) return yield* new FleetValidationError({ detail: "nix.check takes no arguments" })
      return { kind } satisfies JobPayloadType
    }
    case "nix.apply": {
      const ref = args[1]
      if (args.length !== 2 || ref === undefined) {
        return yield* new FleetValidationError({ detail: "nix.apply requires one ref" })
      }
      return yield* Schema.decodeUnknownEffect(JobPayload)({ kind, ref }).pipe(
        Effect.mapError(
          (cause) =>
            new FleetValidationError({
              detail: `invalid job: ${String(cause)}`
            })
        )
      )
    }
    case "agent.delegate": {
      const mode = args[1]
      const repository = args[2]
      if (args.length < 4 || mode === undefined || repository === undefined) {
        return yield* new FleetValidationError({
          detail: "agent.delegate requires mode, repository, and prompt"
        })
      }
      return yield* Schema.decodeUnknownEffect(JobPayload)({
        kind,
        mode,
        prompt: args.slice(3).join(" "),
        repository
      }).pipe(
        Effect.mapError((cause) => new FleetValidationError({ detail: `invalid job: ${String(cause)}` }))
      )
    }
    case "agent.message": {
      const session = args[1]
      if (args.length < 3 || session === undefined) {
        return yield* new FleetValidationError({ detail: "agent.message requires session and message" })
      }
      return yield* Schema.decodeUnknownEffect(JobPayload)({
        kind,
        message: args.slice(2).join(" "),
        session
      }).pipe(
        Effect.mapError(
          (cause) =>
            new FleetValidationError({
              detail: `invalid job: ${String(cause)}`
            })
        )
      )
    }
    default:
      return yield* new FleetValidationError({ detail: `unknown job kind: ${kind ?? ""}` })
  }
})

const follow = (config: HostConfiguration, tailscale: TailscaleClient, host: string, id: string) =>
  followJob(getJob(config, tailscale, host, id))

const usage = `fleetctl commands:
  hosts
  status HOST
  history HOST [LIMIT]
  job HOST ID
  follow HOST ID
  submit HOST nix.check
  submit HOST nix.apply REF
  submit HOST agent.delegate MODE REPOSITORY PROMPT...
  submit HOST agent.message SESSION MESSAGE...
  work record HOST CHECKPOINT_JSON
  apply-everywhere REF`

const main = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const configPath = yield* fleetConfigPath
  const config = yield* loadConfiguration(configPath)
  const tailscale = yield* makeTailscale(config.tailscaleCommand)
  const [command, ...rest] = args

  switch (command) {
    case "hosts": {
      if (!config.crossHost) {
        yield* Console.log(JSON.stringify([{ dnsName: null, host: config.host, online: true }], null, 2))
        return
      }
      const status = yield* tailscale.status.pipe(Effect.mapError(operationError("tailscale.status")))
      const nodes = yield* Effect.forEach(config.machines, (machine) =>
        resolveFleetNode(status, machine).pipe(
          Effect.mapError(operationError("fleet.hosts.identity")),
          Effect.map((node) => ({ machine, node }))
        ))
      yield* Console.log(
        JSON.stringify(
          nodes.map(({ machine, node }) => ({
            dnsName: node.DNSName ?? null,
            host: machine.host,
            online: node.Online
          })),
          null,
          2
        )
      )
      return
    }
    case "status":
    case "history":
    case "job": {
      const host = rest[0] ?? config.host
      const value = command === "status"
        ? yield* request(config, tailscale, host, "/v1/status", HostStatus)
        : command === "history"
        ? yield* request(
          config,
          tailscale,
          host,
          `/v1/history?limit=${encodeURIComponent(rest[1] ?? "50")}`,
          Schema.Array(JobRecord)
        )
        : yield* request(
          config,
          tailscale,
          host,
          `/v1/jobs/${encodeURIComponent(rest[1] ?? "")}`,
          JobRecord
        )
      yield* Console.log(JSON.stringify(value, null, 2))
      return
    }
    case "follow": {
      const host = rest[0]
      const id = rest[1]
      if (host === undefined || id === undefined) return yield* new FleetValidationError({ detail: usage })
      const record = yield* follow(config, tailscale, host, id)
      yield* Console.log(JSON.stringify(record, null, 2))
      return
    }
    case "submit": {
      const host = rest[0]
      if (host === undefined) return yield* new FleetValidationError({ detail: usage })
      const payload = yield* payloadFrom(rest.slice(1))
      const record = yield* submit(config, tailscale, host, payload)
      if (record.status !== "pending_approval") {
        yield* Console.log(JSON.stringify(record, null, 2))
        return
      }
      yield* Console.log(JSON.stringify({ id: record.id, status: record.status }, null, 2))
      const approvalUrl = yield* resolveApprovalPage(config, tailscale, host)
      yield* Console.log(JSON.stringify({ ...record, approvalUrl }, null, 2))
      return
    }
    case "work": {
      const operation = rest[0]
      const host = rest[1]
      const json = rest[2]
      if (operation !== "record" || host === undefined || json === undefined || rest.length !== 3) {
        return yield* new FleetValidationError({ detail: usage })
      }
      const checkpoint = yield* workCheckpointFromJson(json)
      const recorded = yield* recordWorkCheckpoint(config, host, checkpoint)
      yield* Console.log(JSON.stringify(recorded, null, 2))
      return
    }
    case "apply-everywhere": {
      const ref = rest[0]
      if (ref === undefined) return yield* new FleetValidationError({ detail: usage })
      if (!config.crossHost) {
        return yield* new FleetValidationError({ detail: "cross-host fleet control is disabled on this machine" })
      }
      const outcomes = yield* Effect.forEach(
        config.applyMachines,
        (host) =>
          submitToHost(
            host,
            submit(config, tailscale, host, { kind: "nix.apply", ref }),
            resolveApprovalPage(config, tailscale, host)
          ),
        { concurrency: 4 }
      )
      yield* Console.log(
        JSON.stringify(
          outcomes.map((outcome) =>
            outcome.record === null
              ? { error: outcome.error, host: outcome.host, status: "failed" }
              : {
                approvalUrl: outcome.approvalUrl,
                approvalUrlError: outcome.approvalUrlError,
                host: outcome.host,
                id: outcome.record.id,
                status: outcome.record.status
              }
          ),
          null,
          2
        )
      )
      if (
        outcomes.some(
          (outcome) => outcome.record === null || outcome.approvalUrlError !== null
        )
      ) {
        return yield* new FleetOperationError({
          cause: outcomes,
          detail: "one or more hosts failed",
          operation: "fleet.apply_everywhere"
        })
      }
      return
    }
    default:
      return yield* new FleetValidationError({ detail: usage })
  }
})

main.pipe(
  // The fleetctl process owns one composed Node runtime layer.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
  Effect.catch((error) =>
    Console.error(`${error._tag}: ${"detail" in error ? error.detail : String(error)}`).pipe(
      Effect.andThen(Effect.fail(error))
    )
  ),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
