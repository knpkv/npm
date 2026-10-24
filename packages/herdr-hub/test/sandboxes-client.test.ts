// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import { SandboxCard, SandboxRunView } from "@knpkv/sandbox-pool/host"
import { Effect, Schema } from "effect"
import type { HttpBody } from "effect/http"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import {
  loadSandboxAwsSession,
  loadSandboxesCaller,
  loadSandboxRequests,
  loadSandboxRunLog,
  loadSandboxRuns,
  startSandboxAwsSignIn,
  submitSandboxJob
} from "../src/sandboxes-client.js"

const account = Schema.decodeUnknownSync(SandboxCard.fields.accountId)("999999999990")
const runId = Schema.decodeUnknownSync(SandboxRunView.fields.runId)("run-current")

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
      Effect.provideService(
        HttpClient.HttpClient,
        answering(200, {
          login: "viewer@example.test",
          owner: false,
          signIn: null,
          poolMode: "observe",
          awsSignedIn: false
        })
      )
    )
    expect(caller).toEqual({
      login: "viewer@example.test",
      owner: false,
      signIn: null,
      poolMode: "observe",
      awsSignedIn: false
    })
  }))

it.effect("reads the hub's AWS sign-in, including why one is required", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    const reasons: ReadonlyArray<"never" | "ended"> = ["never", "ended"]
    for (const reason of reasons) {
      const session = yield* loadSandboxAwsSession.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          answering(200, { _tag: "SignInRequired", reason }, (request) => seen.push(request))
        )
      )
      expect(session).toEqual({ _tag: "SignInRequired", reason })
    }
    expect(seen.map(({ method, url }) => [url, method])).toEqual([
      ["/v1/modules/sandboxes/aws-session", "GET"],
      ["/v1/modules/sandboxes/aws-session", "GET"]
    ])
    const refused = yield* loadSandboxAwsSession.pipe(
      Effect.provideService(HttpClient.HttpClient, answering(403, { error: "owner_only" })),
      Effect.flip
    )
    expect(refused.detail).toBe("status")
  }))

it.effect("refuses a sign-in page that isn't https, so it can never become a script link", () =>
  Effect.gen(function*() {
    for (const verificationUri of ["javascript:alert(1)", "http://portal.example.test/device", "not a url"]) {
      const pending = {
        _tag: "SignInPending",
        verificationUri,
        userCode: "ABCD-EFGH",
        expiresAt: "2026-10-23T13:15:00.000Z"
      }
      const read = yield* loadSandboxAwsSession.pipe(
        Effect.provideService(HttpClient.HttpClient, answering(200, pending)),
        Effect.flip
      )
      expect([verificationUri, read._tag, read.detail]).toEqual([
        verificationUri,
        "SandboxesClientError",
        "invalid_response"
      ])
      const started = yield* startSandboxAwsSignIn.pipe(
        Effect.provideService(HttpClient.HttpClient, answering(200, pending)),
        Effect.flip
      )
      expect([verificationUri, started._tag, started.reason]).toEqual([
        verificationUri,
        "SandboxesWriteFailed",
        "rejected"
      ])
    }
  }))

it.effect("starts an AWS sign-in with an empty body and returns what to approve; another node is refused", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    const pending = {
      _tag: "SignInPending",
      verificationUri: "https://portal.example.test/start/#/device?user_code=ABCD-EFGH",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-10-23T13:15:00.000Z"
    }
    const started = yield* startSandboxAwsSignIn.pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, pending, (request) => seen.push(request)))
    )
    expect(started._tag).toBe("SignInPending")
    expect(started._tag === "SignInPending" ? started.userCode : null).toBe("ABCD-EFGH")
    expect(seen.map(({ method, url }) => [url, method])).toEqual([["/v1/modules/sandboxes/aws-sign-in", "POST"]])
    const body = seen[0]?.body
    expect(body?._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : null).toBe("{}")
    const refused = yield* startSandboxAwsSignIn.pipe(
      Effect.provideService(HttpClient.HttpClient, answering(403, { error: "owner_only" })),
      Effect.flip
    )
    expect(refused.reason).toBe("unauthorized")
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

it.effect("names why Fleet refused a retry or lift from the 409 code, and any other 409 is a refusal", () =>
  Effect.gen(function*() {
    const cases: ReadonlyArray<readonly [Schema.Json, string]> = [
      [{ error: "already_requested" }, "already_requested"],
      [{ error: "not_quarantined" }, "not_quarantined"],
      [{ error: "not_budget_held" }, "not_budget_held"],
      [{ error: "observe_mode" }, "observe_mode"],
      [{ error: "rejected" }, "rejected"],
      [{ error: "something new" }, "rejected"],
      [["not", "an", "object"], "rejected"]
    ]
    for (const [body, reason] of cases) {
      const failure = yield* submitSandboxJob({ _tag: "Retry", accountId: account }).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(409, body)),
        Effect.flip
      )
      expect(failure.reason, JSON.stringify(body)).toBe(reason)
    }
  }))

it.effect("reads one run's log by account and run id; a refusal or a longer log is a failure", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    const line = { at: "2026-10-16T08:02:00.000Z", text: "nuke: S3Bucket example-bucket waiting for objects" }
    const body = { _tag: "Ready", accountId: "999999999990", runId: "run-current", raw: null, lines: [line], total: 1 }
    const log = yield* loadSandboxRunLog(account, runId).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, body, (request) => seen.push(request)))
    )
    expect(seen.map(({ url }) => url)).toEqual(["/v1/modules/sandboxes/run-log?id=999999999990&run=run-current"])
    expect(log._tag === "Ready" ? log.lines.map(({ text }) => text) : null).toEqual([line.text])
    const viewer = yield* loadSandboxRunLog(account, runId).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(403, { error: "owner_only" })),
      Effect.flip
    )
    expect(viewer.detail).toBe("status")
    const tooLong = yield* loadSandboxRunLog(account, runId).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        answering(200, { ...body, lines: Array.from({ length: 31 }, () => line), total: 31 })
      ),
      Effect.flip
    )
    expect(tooLong.detail).toBe("invalid_response")
  }))
