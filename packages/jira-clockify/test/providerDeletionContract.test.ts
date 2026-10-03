import { expect, it } from "@effect/vitest"
import { ClockifyApi } from "@knpkv/clockify-api-client"
import { JiraApi } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { readJiraDeletionEvidence } from "../src/services/ProviderDeletion.js"

/** Exercise the pinned generated decoder, not a hand-written deletion DTO. */
const clientWith = (body: Schema.Json, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
      })
    ))
  ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://synthetic.invalid")))

it.effect("Jira's deleted-worklog response identifies an ID but not its issue or author", () =>
  Effect.gen(function*() {
    const client = JiraApi.make(clientWith({
      since: 0,
      until: 1_780_000_000_000,
      lastPage: true,
      values: [{ worklogId: 12345, updatedTime: 1_780_000_000_000 }]
    }))
    const page = yield* client.getIdsOfWorklogsDeletedSince({ params: { since: 0 } })
    expect(page.values).toEqual([{ worklogId: 12345, updatedTime: 1_780_000_000_000 }])
    expect(page.values?.[0]).not.toHaveProperty("issueId")
    expect(page.values?.[0]).not.toHaveProperty("author")
  }))

it.effect("a complete exact Jira deletion event after the provider-created checkpoint is positive evidence", () =>
  Effect.gen(function*() {
    const client = JiraApi.make(clientWith({
      since: 1_780_000_000_100,
      until: 1_780_000_000_200,
      lastPage: false,
      nextPage: "https://synthetic.invalid/rest/api/3/worklog/deleted?since=1780000000200",
      values: [{ worklogId: 12345, updatedTime: 1_780_000_000_200 }]
    }))
    expect(yield* readJiraDeletionEvidence(client, "12345", 1_780_000_000_100)).toEqual({
      _tag: "DeletedAfterCreation",
      updatedTime: 1_780_000_000_200
    })
  }))

it.effect("old, unrelated, or incomplete Jira events cannot release a bound entry", () =>
  Effect.gen(function*() {
    const createdAtMs = 1_780_000_000_100
    for (
      const { id, timestamp } of [
        { id: 12345, timestamp: createdAtMs },
        { id: 54321, timestamp: createdAtMs + 100 }
      ]
    ) {
      const client = JiraApi.make(clientWith({
        since: createdAtMs,
        until: timestamp,
        lastPage: true,
        values: [{ worklogId: id, updatedTime: timestamp }]
      }))
      expect(yield* readJiraDeletionEvidence(client, "12345", createdAtMs)).toEqual({ _tag: "Unproved" })
    }
    const malformed = JiraApi.make(clientWith({ values: [{ worklogId: 12345, updatedTime: createdAtMs + 100 }] }))
    expect((yield* Effect.result(readJiraDeletionEvidence(malformed, "12345", createdAtMs)))._tag)
      .toBe("Failure")
  }))

it.effect("lossy IDs, permission loss, and invalid feed order remain unproved", () =>
  Effect.gen(function*() {
    const createdAtMs = 1_780_000_000_100
    const complete = {
      since: createdAtMs,
      until: createdAtMs + 200,
      lastPage: true,
      values: [{ worklogId: 12345, updatedTime: createdAtMs + 100 }]
    }
    const client = JiraApi.make(clientWith(complete))
    for (const entryId of ["012345", `${Number.MAX_SAFE_INTEGER + 1}`, "not-numeric"]) {
      expect((yield* Effect.result(readJiraDeletionEvidence(client, entryId, createdAtMs)))._tag).toBe("Failure")
    }
    const denied = JiraApi.make(clientWith({ errorMessages: ["synthetic denied"] }, 401))
    expect((yield* Effect.result(readJiraDeletionEvidence(denied, "12345", createdAtMs)))._tag).toBe("Failure")
    const reversed = JiraApi.make(clientWith({
      ...complete,
      values: [
        { worklogId: 54321, updatedTime: createdAtMs + 200 },
        { worklogId: 12345, updatedTime: createdAtMs + 100 }
      ]
    }))
    expect((yield* Effect.result(readJiraDeletionEvidence(reversed, "12345", createdAtMs)))._tag).toBe("Failure")
  }))

it.effect("Jira gives the same typed 404 status for a deleted or inaccessible bound worklog", () =>
  Effect.gen(function*() {
    for (const errorMessages of [["Worklog not found"], ["Access denied"]]) {
      const client = JiraApi.make(clientWith({ errorMessages }, 404))
      const result = yield* Effect.result(client.getWorklog("PROJ-9", "12345", undefined))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("GetWorklog404")
    }
  }))

it.effect("Jira's generated page permits missing completeness but rejects unsafe int64 IDs", () =>
  Effect.gen(function*() {
    const incomplete = JiraApi.make(clientWith({}))
    expect(yield* incomplete.getIdsOfWorklogsDeletedSince({ params: { since: 0 } })).toEqual({})

    const imprecise = JiraApi.make(clientWith({
      lastPage: true,
      values: [{ worklogId: Number.MAX_SAFE_INTEGER + 1, updatedTime: 1_780_000_000_000 }]
    }))
    const result = yield* Effect.result(imprecise.getIdsOfWorklogsDeletedSince({ params: { since: 0 } }))
    expect(result._tag).toBe("Failure")
  }))

it.effect("Jira's exact worklog decoder retains the provider creation time and author", () =>
  Effect.gen(function*() {
    const client = JiraApi.make(clientWith({
      id: "12345",
      created: "2026-07-02T10:00:00.000+0000",
      author: { accountId: "synthetic-account" },
      started: "2026-07-01T12:00:00.000+0000",
      timeSpentSeconds: 1800
    }))
    const value = yield* client.getWorklog("SYNTH-9", "12345", undefined)
    expect(value).toMatchObject({
      id: "12345",
      created: "2026-07-02T10:00:00.000+0000",
      author: { accountId: "synthetic-account" }
    })
  }))

it.effect("Clockify's TIME_ENTRY deletion response does not identify the original entry", () =>
  Effect.gen(function*() {
    const client = ClockifyApi.make(clientWith({
      response: [{
        id: "synthetic-deletion-record",
        documentCode: "TIME_ENTRY",
        deletedAt: "2026-07-02T10:00:00Z",
        document: {}
      }]
    }))
    const page = yield* client.getDeletedEntityInfo("synthetic-workspace", {
      params: { type: ["TIME_ENTRY"], page: "0", limit: "50" }
    })
    expect(page.response).toEqual([{
      id: "synthetic-deletion-record",
      documentCode: "TIME_ENTRY",
      deletedAt: "2026-07-02T10:00:00Z",
      document: {}
    }])
    expect(page.response?.[0]?.document).not.toHaveProperty("timeEntryId")
    expect(page).not.toHaveProperty("lastPage")
  }))

it.effect("Clockify's documented omission decodes like an empty deletion window", () =>
  Effect.gen(function*() {
    const client = ClockifyApi.make(clientWith({ response: [] }))
    const page = yield* client.getDeletedEntityInfo("synthetic-workspace", {
      params: {
        type: ["TIME_ENTRY"],
        start: "2026-07-01T00:00:00Z",
        end: "2026-07-02T00:00:00Z"
      }
    })
    expect(page.response).toEqual([])
  }))

it.effect("Clockify's generated response does not require a page or any deletion rows", () =>
  Effect.gen(function*() {
    const client = ClockifyApi.make(clientWith({}))
    const page = yield* client.getDeletedEntityInfo("synthetic-workspace", {
      params: { type: ["TIME_ENTRY"] }
    })
    expect(page).toEqual({})
  }))
