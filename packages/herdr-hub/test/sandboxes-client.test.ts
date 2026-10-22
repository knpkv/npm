// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import { SandboxCard } from "@knpkv/sandbox-pool/host"
import { Effect, Schema } from "effect"
import type { HttpBody } from "effect/http"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { loadSandboxesCaller, loadSandboxRequests, loadSandboxRuns, submitSandboxJob } from "../src/sandboxes-client.js"

const account = Schema.decodeUnknownSync(SandboxCard.fields.accountId)("999999999990")

type Seen = { readonly url: string; readonly method: string; readonly body: HttpBody.HttpBody }

const answering = (status: number, body: Schema.Json, seen?: (request: Seen) => void) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      seen?.({ url: request.url, method: request.method, body: request.body })
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }))
    })
  )

it.effect("posts one order as JSON and returns the queued job", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    const client = answering(202, { jobId: "job-1", status: "queued" }, (request) => seen.push(request))
    const submitted = yield* submitSandboxJob({ _tag: "Extend", accountId: account }).pipe(
      Effect.provideService(HttpClient.HttpClient, client)
    )
    expect(submitted).toEqual({ jobId: "job-1", status: "queued" })
    expect(seen.map(({ method, url }) => [url, method])).toEqual([["/v1/modules/sandboxes/jobs", "POST"]])
    const body = seen[0]?.body
    expect(body?._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : null).toBe(
      JSON.stringify({ _tag: "Extend", accountId: "999999999990" })
    )
  }))

it.effect("names the owner rule, a refused job and an unknown outcome apart", () =>
  Effect.gen(function*() {
    for (
      const [status, reason] of [[403, "unauthorized"], [409, "rejected"], [503, "network"]] satisfies ReadonlyArray<
        readonly [number, "unauthorized" | "rejected" | "network"]
      >
    ) {
      const failure = yield* submitSandboxJob({ _tag: "Lease" }).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(status, { error: "private text" })),
        Effect.flip
      )
      expect(failure.reason).toBe(reason)
    }
    const offline = HttpClient.make((request) =>
      Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))
    )
    const lost = yield* submitSandboxJob({ _tag: "Lease" }).pipe(
      Effect.provideService(HttpClient.HttpClient, offline),
      Effect.flip
    )
    expect(lost.reason).toBe("network")
  }))

it.effect("reads the caller", () =>
  Effect.gen(function*() {
    const caller = yield* loadSandboxesCaller.pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, { login: "viewer@example.test", owner: false }))
    )
    expect(caller).toEqual({ login: "viewer@example.test", owner: false })
  }))

const failedRun = {
  runId: "run-current",
  step: null,
  blocker: { _tag: "NukeFailed", resourceType: "S3Bucket", text: "S3Bucket could not be removed" },
  outcome: "Quarantined",
  reason: "Retry",
  startedAt: "2026-10-16T08:00:00.000Z",
  endedAt: "2026-10-16T08:03:00.000Z",
  failedStep: "nuke"
}

it.effect("reads one account's runs, newest first, by account id", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    const client = answering(
      200,
      { _tag: "Ready", accountId: "999999999990", runs: [failedRun], next: null },
      (request) => seen.push(request)
    )
    const runs = yield* loadSandboxRuns(account).pipe(Effect.provideService(HttpClient.HttpClient, client))
    expect(seen.map(({ url }) => url)).toEqual(["/v1/modules/sandboxes/runs?id=999999999990"])
    if (runs._tag !== "Ready") throw new Error("expected a ready runs page")
    expect(runs.runs.map((run) => [run.runId, run.failedStep, run.reason])).toEqual([["run-current", "nuke", "Retry"]])
  }))

it.effect("names a refused runs read and a body that is not a runs page apart", () =>
  Effect.gen(function*() {
    const missing = yield* loadSandboxRuns(account).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(404, { code: "not_found" })),
      Effect.flip
    )
    expect(missing.detail).toBe("status")
    const garbled = yield* loadSandboxRuns(account).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, { _tag: "Ready", runs: "nope" })),
      Effect.flip
    )
    expect(garbled.detail).toBe("invalid_response")
  }))

it.effect("reads the pending sandbox requests", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    const body = {
      _tag: "Ready",
      requests: [{
        jobId: "job-retry",
        accountId: "999999999990",
        kind: "Retry",
        title: "Retry one quarantined sandbox account",
        requestedBy: "example-requester",
        requestedAt: "2026-10-16T13:05:00.000Z",
        expiresAt: null
      }]
    }
    const requests = yield* loadSandboxRequests.pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, body, (request) => seen.push(request)))
    )
    expect(seen.map(({ url }) => url)).toEqual(["/v1/modules/sandboxes/requests"])
    expect(requests._tag === "Ready" ? requests.requests.map(({ jobId, kind }) => [jobId, kind]) : null).toEqual([
      ["job-retry", "Retry"]
    ])
  }))
